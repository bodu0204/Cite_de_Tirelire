// 金鉱：自由予算を時間経過で金貨に変換する。金額は 10^-6 G 単位の bigint で扱う。
import { MICRO_PER_GOLD, MINUTE } from "./config";
import { monthKey, monthRange } from "./time";

export interface MineState {
  /** 未回収の金貨（µG） */
  uncollected: bigint;
  /** 今後の採掘から相殺する購入額（µG）。月をまたいで繰り越さない */
  debt: bigint;
  /** 分単位に揃えた最終採掘時刻 */
  lastAccrualAt: number;
  monthKey: string;
  minedThisMonth: bigint;
  /** 当月に精算した購入額（G） */
  settledThisMonth: number;
  totalCollected: number;
}

export interface SubWindow {
  /** 月額換算（円） */
  monthly: number;
  startAt: number;
  endAt: number | null;
}

export interface Overspend {
  monthKey: string;
  amount: number;
}

export const floorMinute = (t: number) => Math.floor(t / MINUTE) * MINUTE;

export function newMine(startAt: number, tz: string): MineState {
  const t = floorMinute(startAt);
  return {
    uncollected: 0n,
    debt: 0n,
    lastAccrualAt: t,
    monthKey: monthKey(t, tz),
    minedThisMonth: 0n,
    settledThisMonth: 0,
    totalCollected: 0,
  };
}

export function activeSubsTotal(subs: SubWindow[], at: number): number {
  let s = 0;
  for (const w of subs) if (w.startAt <= at && (w.endAt === null || w.endAt > at)) s += w.monthly;
  return s;
}

/** 毎分の採掘量（G/分、表示用） */
export function ratePerMinute(budget: number, subs: SubWindow[], at: number, tz: string): number {
  const { start, end } = monthRange(at, tz);
  const minutes = (end - start) / MINUTE;
  return Math.max(0, budget - activeSubsTotal(subs, at)) / minutes;
}

/**
 * until まで採掘を進める。採掘速度は「月の境界」と「サブスクの開始・解約」で区切って計算する。
 * 月が変わる時点で残っている採掘負債は、その月の予算超過として返し、繰り越さない。
 */
export function accrue(
  mine: MineState,
  opts: { budget: number; subs: SubWindow[]; tz: string; until: number },
): { mine: MineState; overspends: Overspend[] } {
  const m: MineState = { ...mine };
  const overspends: Overspend[] = [];
  const until = floorMinute(opts.until);
  const changes = opts.subs
    .flatMap((w) => [w.startAt, w.endAt ?? Infinity])
    .map((t) => (Number.isFinite(t) ? floorMinute(t) : t))
    .sort((a, b) => a - b);

  let t = m.lastAccrualAt;
  while (t < until) {
    const key = monthKey(t, opts.tz);
    if (key !== m.monthKey) {
      closeMonth(m, overspends);
      m.monthKey = key;
    }
    const { start, end } = monthRange(t, opts.tz);
    let segEnd = Math.min(until, end);
    for (const c of changes) {
      if (c > t && c < segEnd) {
        segEnd = c;
        break;
      }
    }
    const net = Math.max(0, opts.budget - activeSubsTotal(opts.subs, t));
    let mined = (BigInt(net) * MICRO_PER_GOLD * BigInt(segEnd - t)) / BigInt(end - start);
    m.minedThisMonth += mined;
    if (m.debt > 0n) {
      const pay = mined < m.debt ? mined : m.debt;
      m.debt -= pay;
      mined -= pay;
    }
    m.uncollected += mined;
    t = segEnd;
  }
  // until が月の境界ちょうどの場合も月を締める
  const key = monthKey(until, opts.tz);
  if (key !== m.monthKey) {
    closeMonth(m, overspends);
    m.monthKey = key;
  }
  m.lastAccrualAt = Math.max(m.lastAccrualAt, until);
  return { mine: m, overspends };
}

function closeMonth(m: MineState, overspends: Overspend[]) {
  if (m.debt > 0n) {
    overspends.push({ monthKey: m.monthKey, amount: Number((m.debt + MICRO_PER_GOLD - 1n) / MICRO_PER_GOLD) });
  }
  m.debt = 0n;
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
 * 購入額の精算：未回収 → 所持金貨 → 今後の採掘（負債）の順に差し引く。
 * 戻り値の fromHeld を所持金貨から引くのは呼び出し側の責任。
 */
export function settlePurchase(
  mine: MineState,
  heldGold: number,
  amount: number,
): { mine: MineState; fromHeld: number; toDebt: number } {
  const m: MineState = { ...mine, settledThisMonth: mine.settledThisMonth + amount };
  let rest = BigInt(amount) * MICRO_PER_GOLD;
  const fromUncollected = m.uncollected < rest ? m.uncollected : rest;
  m.uncollected -= fromUncollected;
  rest -= fromUncollected;
  // 所持金貨は整数単位で差し引く。端数の差額は未回収へ戻す
  const needWhole = Number((rest + MICRO_PER_GOLD - 1n) / MICRO_PER_GOLD);
  const fromHeld = Math.min(Math.max(0, heldGold), needWhole);
  rest -= BigInt(fromHeld) * MICRO_PER_GOLD;
  if (rest < 0n) {
    m.uncollected += -rest;
    rest = 0n;
  }
  m.debt += rest;
  return { mine: m, fromHeld, toDebt: Number(rest / MICRO_PER_GOLD) };
}

/** 購入額を減額修正・削除した場合の払い戻し：負債を先に減らし、残りを所持金貨へ戻す */
export function refundPurchase(mine: MineState, amount: number): { mine: MineState; toHeld: number } {
  const m: MineState = { ...mine, settledThisMonth: Math.max(0, mine.settledThisMonth - amount) };
  let rest = BigInt(amount) * MICRO_PER_GOLD;
  const fromDebt = m.debt < rest ? m.debt : rest;
  m.debt -= fromDebt;
  rest -= fromDebt;
  return { mine: m, toHeld: Number(rest / MICRO_PER_GOLD) };
}

/**
 * 所持金貨（表示）＝ 手持ちの金貨 − 採掘負債。
 * 購入が所持金貨を超えると、超えた分が負債になりマイナスで表示される。負債は今後の採掘から返済される。
 */
export function goldBalance(held: number, mine: MineState): number {
  return held - Number((mine.debt + MICRO_PER_GOLD - 1n) / MICRO_PER_GOLD);
}

/** 手持ちの金貨があれば採掘負債の返済に充てる（マイナスの間は手持ちを0に保つ） */
export function repayDebtFromHeld(mine: MineState, held: number): { mine: MineState; used: number } {
  if (mine.debt <= 0n || held <= 0) return { mine, used: 0 };
  const m: MineState = { ...mine };
  const used = Math.min(held, Number((m.debt + MICRO_PER_GOLD - 1n) / MICRO_PER_GOLD));
  m.debt -= BigInt(used) * MICRO_PER_GOLD;
  if (m.debt < 0n) {
    // 端数の払いすぎは未回収へ戻す
    m.uncollected += -m.debt;
    m.debt = 0n;
  }
  return { mine: m, used };
}

export const microToGold = (v: bigint) => Number(v) / Number(MICRO_PER_GOLD);
