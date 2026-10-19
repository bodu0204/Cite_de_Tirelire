// 金鉱：自由予算を時間経過で金貨に変換する。金額は 10^-6 G 単位の bigint で扱う。
// 採掘の一部は債券に回せる（債券化率）。債券がマイナスの間は強制的に回す（docs/bond-and-custom-currency.md §4.3）。
import { bondShare } from "./bond";
import { MICRO_PER_GOLD, MINUTE } from "./config";
import { monthKey, monthRange } from "./time";

export interface MineState {
  /** 未回収の金貨（µG） */
  uncollected: bigint;
  /** 債券化した採掘の端数（µG） */
  bondFraction: bigint;
  /** 分単位に揃えた最終採掘時刻 */
  lastAccrualAt: number;
  monthKey: string;
  minedThisMonth: bigint;
  /** 当月に精算した購入額（G） */
  settledThisMonth: number;
  /** 回収した金貨＋債券化した採掘（金鉱Lvの経験値） */
  totalCollected: number;
}

export interface SubWindow {
  /** 月額換算（円） */
  monthly: number;
  startAt: number;
  endAt: number | null;
}

/** 採掘量を決めるもの（月あたりの採掘額と、それが変わる時刻）。実体は currency.ts の BudgetPlan */
export interface MinePlan {
  netAt(t: number): number;
  changePoints(): number[];
}

export interface BondSplit {
  /** 債券の残高（整数） */
  balance: number;
  /** 債券化率（%） */
  rate: number;
  /** 債券化が止まる額 */
  cap: number;
}

export const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE;

export function newMine(startAt: number, tz: string): MineState {
  const t = floorMinute(startAt);
  return {
    uncollected: 0n,
    bondFraction: 0n,
    lastAccrualAt: t,
    monthKey: monthKey(t, tz),
    minedThisMonth: 0n,
    settledThisMonth: 0,
    totalCollected: 0,
  };
}

/** 毎分の採掘量（G/分、表示用） */
export function ratePerMinute(plan: MinePlan, at: number, tz: string): number {
  const { start, end } = monthRange(at, tz);
  return plan.netAt(at) / ((end - start) / MINUTE);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * until まで採掘を進める。採掘速度は「月の境界」と「サブスク・毎分ルールの開始・終了」で区切り、
 * 債券化の割合は債券が 0 や上限に達する時刻でさらに区切る。
 * 戻り値の bond は債券の新しい残高、toBond はそのうち採掘から入った額。
 */
export function accrue(
  mine: MineState,
  opts: { plan: MinePlan; tz: string; until: number; bond?: BondSplit },
): { mine: MineState; bond: number; toBond: number } {
  const m: MineState = { ...mine };
  const until = floorMinute(opts.until);
  const changes = opts.plan.changePoints();
  const rate = opts.bond?.rate ?? 0;
  const cap = opts.bond?.cap ?? 0;
  let bond = opts.bond?.balance ?? 0;
  let toBond = 0;

  let t = m.lastAccrualAt;
  while (t < until) {
    const key = monthKey(t, opts.tz);
    if (key !== m.monthKey) closeMonth(m, key);
    const { start, end } = monthRange(t, opts.tz);
    let segEnd = Math.min(until, end);
    for (const c of changes) {
      if (c > t && c < segEnd) {
        segEnd = c;
        break;
      }
    }
    const net = BigInt(opts.plan.netAt(t));
    const len = BigInt(end - start);
    while (t < segEnd) {
      const share = BigInt(bondShare(bond, rate, cap));
      let stepEnd = segEnd;
      // 債券が 0（マイナスの返済）か上限に届くまでの残り（µG）
      let need: bigint | null = null;
      if (share > 0n && net > 0n) {
        need = BigInt((bond < 0 ? 0 : cap) - bond) * MICRO_PER_GOLD - m.bondFraction;
        const ms = ceilDiv(need * 100n * len, net * MICRO_PER_GOLD * share);
        stepEnd = Math.min(segEnd, t + Number(ceilDiv(ms, BigInt(MINUTE))) * MINUTE);
      }
      const mined = (net * MICRO_PER_GOLD * BigInt(stepEnd - t)) / len;
      let part = (mined * share) / 100n;
      if (need !== null && bond >= 0 && part > need) part = need;
      m.bondFraction += part;
      const whole = Number(m.bondFraction / MICRO_PER_GOLD);
      m.bondFraction %= MICRO_PER_GOLD;
      bond += whole;
      toBond += whole;
      m.totalCollected += whole;
      m.uncollected += mined - part;
      m.minedThisMonth += mined;
      t = stepEnd;
    }
  }
  // until が月の境界ちょうどの場合も月を締める
  const key = monthKey(until, opts.tz);
  if (key !== m.monthKey) closeMonth(m, key);
  m.lastAccrualAt = Math.max(m.lastAccrualAt, until);
  return { mine: m, bond, toBond };
}

function closeMonth(m: MineState, next: string) {
  m.monthKey = next;
  m.minedThisMonth = 0n;
  m.settledThisMonth = 0;
}

/** 回収：整数部分だけを所持金貨へ移す */
export function collect(mine: MineState): { mine: MineState; gold: number } {
  const gold = mine.uncollected / MICRO_PER_GOLD;
  return {
    mine: { ...mine, uncollected: mine.uncollected % MICRO_PER_GOLD, totalCollected: mine.totalCollected + Number(gold) },
    gold: Number(gold),
  };
}

/**
 * 購入の金貨での支払い：未回収 → 所持金貨 の順に整数単位で差し引く。足りない分は rest として返す。
 * 所持金貨から引くのは呼び出し側の責任。
 */
export function payWithGold(mine: MineState, heldGold: number, amount: number): { mine: MineState; fromUncollected: number; fromHeld: number; rest: number } {
  const fromUncollected = Math.min(amount, Number(mine.uncollected / MICRO_PER_GOLD));
  const fromHeld = Math.min(Math.max(0, heldGold), amount - fromUncollected);
  return {
    mine: { ...mine, uncollected: mine.uncollected - BigInt(fromUncollected) * MICRO_PER_GOLD },
    fromUncollected,
    fromHeld,
    rest: amount - fromUncollected - fromHeld,
  };
}

export const microToGold = (v: bigint) => Number(v) / Number(MICRO_PER_GOLD);
