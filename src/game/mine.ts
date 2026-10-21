// 金鉱：自由予算を時間経過で金貨に変換する。金額は 10^-6 G 単位の bigint で扱う。
// 採掘の一部は債券に回せる（債券化率）。債券がマイナスの間は強制的に回す（docs/bond-and-custom-currency.md §4.3）。
// 「月」は収入日で区切る収入期間（docs/record-input-redesign.md §5.1）。月の収入の差分は、期間に上乗せする区間（windows）と
// 残りの採掘から減らす額（cut）で採掘に入れる（同 §5.3・§5.5）。
import { bondShare } from "./bond";
import { MICRO_PER_GOLD, MINUTE } from "./config";
import { periodKey, periodRange, toCal, type PeriodCal } from "./time";

/** 期間で均等（毎分）に配当する金貨：[start, end) に total（µG）を均等に採掘へ上乗せする */
export interface GoldWindow {
  /** 元の収入記録 */
  incomeId: string;
  /** 月の収入の配当か（臨時の収入は false。その月の配当分に数えない） */
  dividend: boolean;
  start: number;
  end: number;
  total: bigint;
}

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
  /** 採掘への上乗せ（月の収入の差分・臨時の収入の振り分け） */
  windows?: GoldWindow[];
  /** 当期の残りの採掘から減らす額（µG。月の収入の−差分）。期間が替わると0に戻す */
  cut?: bigint;
  /** 当期の配当で所持通貨に入った額（µG。手元のお金の推測 E3a。docs/record-input-redesign.md §8.4） */
  dividend?: bigint;
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

export function newMine(startAt: number, tz: string | PeriodCal): MineState {
  const t = floorMinute(startAt);
  return {
    uncollected: 0n,
    bondFraction: 0n,
    lastAccrualAt: t,
    monthKey: periodKey(t, tz),
    minedThisMonth: 0n,
    settledThisMonth: 0,
    totalCollected: 0,
  };
}

/** 毎分の採掘量（G/分、表示用） */
export function ratePerMinute(plan: MinePlan, at: number, tz: string | PeriodCal): number {
  const { start, end } = periodRange(at, tz);
  return plan.netAt(at) / ((end - start) / MINUTE);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** 区間の t までに上乗せした額（µG）。累積で求めるので、何回に分けて採掘しても合計は同じ */
export function windowMinedBy(w: GoldWindow, t: number): bigint {
  if (t <= w.start) return 0n;
  if (t >= w.end) return w.total;
  return (w.total * BigInt(t - w.start)) / BigInt(w.end - w.start);
}

/**
 * until まで採掘を進める。採掘速度は「月の境界」と「サブスク・毎分ルールの開始・終了」で区切り、
 * 債券化の割合は債券が 0 や上限に達する時刻でさらに区切る。
 * 戻り値の bond は債券の新しい残高、toBond はそのうち採掘から入った額。
 */
export function accrue(
  mine: MineState,
  opts: { plan: MinePlan; tz: string | PeriodCal; until: number; bond?: BondSplit },
): { mine: MineState; bond: number; toBond: number } {
  const m: MineState = { ...mine };
  const cal = toCal(opts.tz);
  const windows = m.windows ?? [];
  const until = floorMinute(opts.until);
  const changes = opts.plan.changePoints();
  const rate = opts.bond?.rate ?? 0;
  const cap = opts.bond?.cap ?? 0;
  let bond = opts.bond?.balance ?? 0;
  let toBond = 0;

  let t = m.lastAccrualAt;
  while (t < until) {
    const key = periodKey(t, cal);
    if (key !== m.monthKey) closeMonth(m, key);
    const { start, end } = periodRange(t, cal);
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
      if (share > 0n) need = BigInt((bond < 0 ? 0 : cap) - bond) * MICRO_PER_GOLD - m.bondFraction;
      if (need !== null && net > 0n) {
        const ms = ceilDiv(need * 100n * len, net * MICRO_PER_GOLD * share);
        stepEnd = Math.min(segEnd, t + Number(ceilDiv(ms, BigInt(MINUTE))) * MINUTE);
      }
      let mined = (net * MICRO_PER_GOLD * BigInt(stepEnd - t)) / len;
      // 上乗せの区間（臨時の収入の分はその月の配当に数えない）
      let other = 0n;
      for (const w of windows) {
        const add = windowMinedBy(w, stepEnd) - windowMinedBy(w, t);
        mined += add;
        if (!w.dividend) other += add;
      }
      // 月の収入の−差分：残りの採掘から減らす
      if (m.cut && m.cut > 0n) {
        const c = m.cut < mined - other ? m.cut : mined - other;
        mined -= c;
        m.cut -= c;
      }
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
      const toHand = mined - part - (other * (100n - share)) / 100n;
      if (toHand > 0n) m.dividend = (m.dividend ?? 0n) + toHand;
      t = stepEnd;
    }
  }
  // until が月の境界ちょうどの場合も月を締める
  const key = periodKey(until, cal);
  if (key !== m.monthKey) closeMonth(m, key);
  m.lastAccrualAt = Math.max(m.lastAccrualAt, until);
  if (windows.length) m.windows = windows.filter((w) => w.end > m.lastAccrualAt);
  return { mine: m, bond, toBond };
}

function closeMonth(m: MineState, next: string) {
  m.monthKey = next;
  m.minedThisMonth = 0n;
  // 減らしきれなかった−差分は持ち越さない（記録の時点で残りの採掘を上限にしている）
  m.cut = 0n;
  m.dividend = 0n;
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

/**
 * 当期の残りの採掘（µG、債券化の分を含む）：from から期間の終わりまでの B − S − C の採掘 ＋ 上乗せの残り − 減らす額。
 * 月の収入の−差分を残りの採掘から減らすときの上限と、手元のお金の推測（E1）に使う。
 * 上乗せは dividend（月の収入の分）か、そうでないかで分けて返す。
 */
export function remainingMining(mine: MineState, plan: MinePlan, cal: PeriodCal, from: number): { natural: bigint; dividendWindows: bigint; otherWindows: bigint } {
  const { start, end } = periodRange(from, cal);
  const len = BigInt(end - start);
  const pts = [from, ...plan.changePoints().filter((p) => p > from && p < end), end];
  let natural = 0n;
  for (let i = 0; i + 1 < pts.length; i++) natural += (BigInt(plan.netAt(pts[i])) * MICRO_PER_GOLD * BigInt(pts[i + 1] - pts[i])) / len;
  natural -= mine.cut ?? 0n;
  if (natural < 0n) natural = 0n;
  let dividendWindows = 0n;
  let otherWindows = 0n;
  for (const w of mine.windows ?? []) {
    const rest = w.total - windowMinedBy(w, from);
    if (w.dividend) dividendWindows += rest;
    else otherWindows += rest;
  }
  return { natural, dividendWindows, otherWindows };
}
