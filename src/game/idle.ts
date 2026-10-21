// 放置計算（docs/bond-and-custom-currency.md §7）。
// 債券倍率が街の発展に効くため、10分ティックごとに「金鉱（債券化含む）→ ユーザ通貨の発生・期限 → 街の1ティック」を繰り返す。
// 街はティック開始時の債券残高で倍率を決める。債券化でつく資源（docs/needs-based-exchange.md §7）もティックの前に入れる。
// ティック境界は絶対時刻に揃えるので、同じ経過時間なら同じ結果になる。
import { bondCap, bondMultiplier, bondResourceEligible } from "./bond";
import { alignTick, cityNeeds, tick } from "./city/sim";
import { MICRO_PER_GOLD, TICK_MS } from "./config";
import { dayEvents, dayGrid, minuteRule, shiftDays, startOfDay, validWindow, type BudgetPlan, type CurrencyDefLite } from "./currency";
import { GAIN_KEYS, quoteNeedsExchange, ZERO_GAINS } from "./exchange";
import { goldMineLevel } from "./levels";
import { accrue, floorMinute } from "./mine";
import { depositToBond, type Lot, type Purse } from "./settle";
import { periodKey, type PeriodCal } from "./time";
import type { CityEvent, CityState } from "./types";

/**
 * 予約した振り分けの1回分（docs/record-input-redesign.md §5.5）。期日が来たティックで入れる。
 * 即時の振り分けも同じ関数（applyGrant）で入れる。
 */
export interface Grant {
  id: string;
  at: number;
  currency: "GOLD" | "BOND" | "CUSTOM";
  currencyId?: string | null;
  amount: number;
  /** 月の収入の配当か（手元のお金の推測でその月の配当分に数える） */
  dividend: boolean;
  /** 入れた時刻（未実行は null） */
  grantedAt: number | null;
}

/** 月の収入の−差分で、当期のユーザ通貨の未発生分から減らす額 */
export interface CustomCut {
  currencyId: string;
  periodKey: string;
  remaining: number;
}

export interface Accrual {
  currencyId: string;
  lastAccrualAt: number;
  /** 毎分ルールの端数（10^-6 単位） */
  fraction: bigint;
  isNew?: boolean;
}

export interface World {
  purse: Purse;
  city: CityState;
  lots: Lot[];
  /** 通貨ごとの発生の進み具合。plan.defs のすべての通貨について用意しておく */
  accruals: Map<string, Accrual>;
  /** 予約した振り分け（未実行のもの） */
  grants?: Grant[];
  /** ユーザ通貨の未発生分から減らす額 */
  cuts?: CustomCut[];
}

export interface AdvanceOpts {
  plan: BudgetPlan;
  /** 採掘の債券化率（%） */
  bondRate: number;
  until: number;
  newId: () => string;
}

/** 金鉱・ユーザ通貨・街を until まで進める */
export function advance(w: World, opts: AdvanceOpts, events: CityEvent[]): void {
  const { plan, until } = opts;
  const tz = plan.tz;
  const defs = plan.defs;
  w.purse.bondCap = bondCap(plan.budget);

  // 日の発生は区間全体ぶんを先に求めておく（1ティックごとに暦を調べない）
  const from = Math.min(w.purse.mine.lastAccrualAt, ...defs.map((d) => w.accruals.get(d.id)!.lastAccrualAt));
  const queue = defs
    .flatMap((def) => dayEvents(def, w.accruals.get(def.id)!.lastAccrualAt, until, tz).map((e) => ({ ...e, def })))
    .sort((a, b) => a.at - b.at || a.def.sortOrder - b.def.sortOrder);
  const minuteDefs = defs.filter((d) => minuteRule(d) > 0).map((def) => ({ def, window: validWindow(def, tz) }));
  const grid = minuteDefs.length ? dayGrid(from, until, plan.cal) : [];
  const cuts = w.cuts ?? [];
  const grants = (w.grants ?? []).filter((g) => g.grantedAt === null).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  let ni = 0;

  const lotIndex = new Map<string, Lot>();
  for (const lot of w.lots) lotIndex.set(`${lot.currencyId}:${lot.issuedAt}`, lot);
  const issued = new Map<string, number>();

  const lotFor = (def: CurrencyDefLite, dayStart: number): Lot => {
    const key = `${def.id}:${dayStart}`;
    let lot = lotIndex.get(key);
    if (!lot) {
      const expiresAt = def.remainder === "TO_BOND" && def.remainderDays ? shiftDays(dayStart, def.remainderDays, tz) : null;
      lot = { id: opts.newId(), currencyId: def.id, issuedAt: dayStart, expiresAt, amount: 0, remaining: 0, isNew: true };
      w.lots.push(lot);
      lotIndex.set(key, lot);
    }
    return lot;
  };
  /** grant：振り分けで入れる分（−差分で減らさない）。dividend：その月の配当分に数えるか */
  const issue = (def: CurrencyDefLite, dayStart: number, amount: number, o: { grant?: boolean; dividend?: boolean } = {}) => {
    // 月の収入の−差分：当期の未発生分から減らす
    const cut = cuts.length && !o.grant ? cuts.find((c) => c.currencyId === def.id && c.remaining > 0 && c.periodKey === periodKey(dayStart, plan.cal)) : undefined;
    if (cut) {
      const c = Math.min(cut.remaining, amount);
      cut.remaining -= c;
      amount -= c;
    }
    if (amount <= 0) return;
    if (o.dividend !== false && periodKey(dayStart, plan.cal) === w.purse.mine.monthKey) w.purse.mine.dividend = (w.purse.mine.dividend ?? 0n) + BigInt(amount) * MICRO_PER_GOLD;
    const lot = lotFor(def, dayStart);
    lot.amount += amount;
    lot.remaining += amount;
    lot.dirty = true;
    issued.set(def.id, (issued.get(def.id) ?? 0) + amount);
  };

  let gi = 0;
  /** 毎分ルール：その日のロットに整数部分を積む */
  const accrueMinutes = (def: CurrencyDefLite, window: { startAt: number; endAt: number | null }, acc: Accrual, to: number) => {
    const monthly = BigInt(minuteRule(def));
    let t = acc.lastAccrualAt;
    while (gi > 0 && grid[gi].at > t) gi--;
    while (t < to) {
      while (gi + 1 < grid.length && grid[gi + 1].at <= t) gi++;
      const day = grid[gi];
      let segEnd = Math.min(to, grid[gi + 1]?.at ?? Infinity);
      if (t < window.startAt) {
        t = Math.min(segEnd, window.startAt);
        continue;
      }
      if (window.endAt !== null && t >= window.endAt) break;
      if (window.endAt !== null) segEnd = Math.min(segEnd, window.endAt);
      acc.fraction += (monthly * MICRO_PER_GOLD * BigInt(segEnd - t)) / BigInt(day.monthEnd - day.monthStart);
      const whole = Number(acc.fraction / MICRO_PER_GOLD);
      acc.fraction %= MICRO_PER_GOLD;
      issue(def, day.at, whole);
      t = segEnd;
    }
  };

  let qi = 0;
  let toBond = 0;
  /** 採掘の債券化と通貨の発生は、まとめて台帳に書く */
  const flush = () => {
    if (toBond > 0) w.purse.moves.push({ currency: "BOND", delta: toBond, reason: "mine_to_bond" });
    toBond = 0;
    for (const def of defs) {
      const n = issued.get(def.id);
      if (n) w.purse.moves.push({ currency: "CUSTOM", delta: n, reason: "currency_issue", currencyId: def.id });
    }
    issued.clear();
  };
  const advanceMoney = (end: number) => {
    // 金鉱（債券化を含む）
    const r = accrue(w.purse.mine, {
      plan,
      tz: plan.cal,
      until: end,
      bond: { balance: w.purse.bond, rate: opts.bondRate, cap: w.purse.bondCap },
    });
    w.purse.mine = r.mine;
    w.purse.bondResource = (w.purse.bondResource ?? 0) + bondResourceEligible(w.purse.bond, r.toBond, w.purse.bondCap);
    w.purse.bond = r.bond;
    toBond += r.toBond;

    // 予約した振り分け（期日が来たもの）
    while (ni < grants.length && grants[ni].at <= end) {
      flush();
      const g = grants[ni++];
      applyGrant(w.purse, g, defs.find((d) => d.id === g.currencyId), plan.cal, (def, at, amount) => issue(def, startOfDay(at, tz), amount, { grant: true, dividend: g.dividend }));
      g.grantedAt = g.at;
    }

    // ユーザ通貨の発生
    const to = floorMinute(end);
    for (const { def, window } of minuteDefs) {
      const acc = w.accruals.get(def.id)!;
      if (acc.lastAccrualAt < to) accrueMinutes(def, window, acc, to);
    }
    while (qi < queue.length && queue[qi].at <= end) {
      const e = queue[qi++];
      issue(e.def, e.at, e.amount);
    }
    for (const def of defs) {
      const acc = w.accruals.get(def.id)!;
      acc.lastAccrualAt = Math.max(acc.lastAccrualAt, to);
    }

    // 期限を迎えた余りを債券へ（上限を超える分は金貨）
    for (const lot of w.lots) {
      if (lot.expiresAt !== null && lot.expiresAt <= end && lot.remaining > 0) {
        flush();
        w.purse.moves.push({ currency: "CUSTOM", delta: -lot.remaining, reason: "currency_expire_bond", currencyId: lot.currencyId });
        depositToBond(w.purse, lot.remaining, "currency_expire_bond", lot.currencyId);
        lot.remaining = 0;
        lot.dirty = true;
      }
    }
  };

  const target = alignTick(until);
  while (w.city.simTime < target) {
    const end = w.city.simTime + TICK_MS;
    const k = bondMultiplier(w.purse.bond, plan.budget);
    advanceMoney(end);
    holdBondResource(w);
    grantBondResources(w.city, goldMineLevel(w.purse.mine.totalCollected));
    tick(w.city, end, events, k);
  }
  // 最後の端数は金鉱・ユーザ通貨だけ進め、街は次のティックまで待つ（債券化の資源も次のティックの前に入れる）
  advanceMoney(until);
  holdBondResource(w);
  flush();
}

/** 債券化で資源をつける額を街に預ける。資源にするのはティックの前（分け方によらず同じ結果にするため） */
function holdBondResource(w: World) {
  if (!w.purse.bondResource) return;
  w.city.bondResourcePending = (w.city.bondResourcePending ?? 0) + w.purse.bondResource;
  w.purse.bondResource = 0;
}

/**
 * 預けた額を、同じ量の金貨でおまかせ交換したのと同じ資源にして在庫に加える（手数料なし、小数のまま）。
 * 割合はティック開始時の街の必要資源で決める（docs/needs-based-exchange.md §7）。
 */
export function grantBondResources(city: CityState, goldMine: number) {
  const amount = city.bondResourcePending ?? 0;
  if (amount <= 0) return;
  const q = quoteNeedsExchange("gold", amount, cityNeeds(city).needs, { bank: city.bankLevel, goldMine, silverMine: 1 }, { fee: false, floor: false });
  // 都市資金を足す前の記録には treasury が無い
  const total = (city.bondResourceTotal ??= { ...ZERO_GAINS });
  total.treasury ??= 0;
  for (const k of ["wood", "stone", "food"] as const) city.stock[k] += q.gains[k];
  city.treasury += q.gains.treasury;
  for (const k of GAIN_KEYS) total[k] += q.gains[k];
  city.bondResourcePending = 0;
}

/**
 * 振り分けの1回分を通貨に入れる。金貨は所持金貨へ、債券は上限まで（超える分は金貨。資源つき）、ユーザ通貨はその日のロットへ。
 * ユーザ通貨が削除済みなら金貨で入れる。
 */
export function applyGrant(
  purse: Purse,
  g: Pick<Grant, "currency" | "amount" | "dividend" | "at">,
  def: CurrencyDefLite | undefined,
  cal: PeriodCal,
  issueCustom: (def: CurrencyDefLite, at: number, amount: number) => void,
) {
  if (g.amount <= 0) return;
  const own = periodKey(g.at, cal) === purse.mine.monthKey && g.dividend;
  if (g.currency === "CUSTOM" && def) {
    issueCustom(def, g.at, g.amount);
    return;
  }
  if (g.currency === "BOND") {
    const before = purse.gold;
    depositToBond(purse, g.amount, "income_grant");
    if (own && purse.gold > before) purse.mine.dividend = (purse.mine.dividend ?? 0n) + BigInt(purse.gold - before) * MICRO_PER_GOLD;
    return;
  }
  purse.gold += g.amount;
  purse.moves.push({ currency: "GOLD", delta: g.amount, reason: "income_grant" });
  if (own) purse.mine.dividend = (purse.mine.dividend ?? 0n) + BigInt(g.amount) * MICRO_PER_GOLD;
}
