// 記録による貯金の確定（docs/savings-driven-growth.md REC-01・RSV-01）。
// 配当（金貨）は未回収にたまり、購入の精算はそこから先に払う。記録すると、それまでの未回収の金貨（＝使わなかったお金）が
// 「確定」して、債券が上限に届くまで債券に入り（同じ額の建設資金つき）、入りきらない分は建設資金になる。
// 記録のない日の配当は、AUTO_CONFIRM_DAYS 日たつか、その日の収入期間が終わったら、推定の支出を引いて自動で確定する。
// 引いた分は未回収に残り、次に記録したときに（実際の支出を払ったあとで）確定する。
// 同じ期間に確定した債券は、あとの購入で手数料なしで取り崩せる（settle.ts pay の draw）。
import { bondResourceEligible } from "./bond";
import { AUTO_CONFIRM_DAYS, DAY, MICRO_PER_GOLD } from "./config";
import { startOfDay } from "./currency";
import type { MineState } from "./mine";
import type { Purse } from "./settle";
import { periodRange, toCal, type PeriodCal } from "./time";

export interface Confirmed {
  /** 確定した金貨 */
  amount: number;
  /** 債券に入った分（マイナスの返済を含む） */
  toBond: number;
  /** 債券に入った分のうち建設資金をつける分（0〜上限の範囲） */
  eligible: number;
  /** 債券に入りきらず、建設資金になる分（呼び出し側で建設資金にし、ゲーム内で使った金貨に数える） */
  overflow: number;
}

export const NO_CONFIRM: Confirmed = { amount: 0, toBond: 0, eligible: 0, overflow: 0 };

export const addConfirmed = (a: Confirmed, b: Confirmed): Confirmed => ({
  amount: a.amount + b.amount,
  toBond: a.toBond + b.toBond,
  eligible: a.eligible + b.eligible,
  overflow: a.overflow + b.overflow,
});

const heldMicro = (m: MineState) => m.uncollected / MICRO_PER_GOLD;

/** 未回収の金貨のうち amount を確定する（未回収の整数部分まで） */
function confirmAmount(p: Purse, amount: number, reason: string): Confirmed {
  const n = Math.min(Math.floor(amount), Number(heldMicro(p.mine)));
  if (n <= 0) return NO_CONFIRM;
  const toBond = Math.max(0, Math.min(n, p.bondCap - p.bond));
  const eligible = bondResourceEligible(p.bond, toBond, p.bondCap);
  p.mine = {
    ...p.mine,
    uncollected: p.mine.uncollected - BigInt(n) * MICRO_PER_GOLD,
    // 確定した配当も配当Lvの経験値に数える
    totalCollected: p.mine.totalCollected + n,
    freeBond: (p.mine.freeBond ?? 0) + Math.max(0, toBond),
  };
  p.bond += toBond;
  p.bondResource = (p.bondResource ?? 0) + eligible;
  if (toBond !== 0) p.moves.push({ currency: "BOND", delta: toBond, reason });
  return { amount: n, toBond, eligible, overflow: n - toBond };
}

/** 記録したとき：今までの未回収の金貨（使わなかった配当）をすべて確定する */
export function confirmByRecord(p: Purse, at: number): Confirmed {
  const r = confirmAmount(p, Number(heldMicro(p.mine)), "confirm_record");
  p.mine = { ...p.mine, confirmedAt: at, unconfirmed: {} };
  return r;
}

/** 採掘で未回収に入った配当を、その日の分として覚える（自動の確定に使う） */
export function noteMined(m: MineState, at: number, micro: bigint, tz: string): MineState {
  if (micro <= 0n) return m;
  const key = String(startOfDay(at, tz));
  const days = { ...(m.unconfirmed ?? {}) };
  days[key] = (days[key] ?? 0) + Number(micro);
  return { ...m, unconfirmed: days };
}

/**
 * 記録のない日の自動の確定。その日から AUTO_CONFIRM_DAYS 日たつか、その日の収入期間が終わった日の分を、
 * 推定の1日の支出 estimatePerDay を引いて確定する。引いた分は未回収に残る（次の記録で確定する）
 */
export function autoConfirm(p: Purse, now: number, cal: PeriodCal | string, estimatePerDay: number): Confirmed {
  const days = p.mine.unconfirmed;
  if (!days) return NO_CONFIRM;
  const c = toCal(cal);
  let total = NO_CONFIRM;
  const rest: Record<string, number> = {};
  const keys = Object.keys(days).sort((a, b) => Number(a) - Number(b));
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const dayStart = Number(key);
    const due = Math.min(dayStart + (AUTO_CONFIRM_DAYS + 1) * DAY, periodRange(dayStart, c).end);
    if (due > now) {
      // 確定する時刻は日が遅いほど遅い（7日後も期間の終わりも遅くなる）ので、ここから後はまだ確定しない。
      // 毎ティック呼ぶので、残りの日の収入期間は計算しない
      for (const k of keys.slice(i)) rest[k] = days[k];
      break;
    }
    const mined = days[key] / Number(MICRO_PER_GOLD);
    total = addConfirmed(total, confirmAmount(p, Math.max(0, mined - estimatePerDay), "confirm_auto"));
  }
  p.mine = { ...p.mine, unconfirmed: rest };
  return total;
}

/** まだ確定していない配当の合計（G。表示用） */
export function unconfirmedGold(m: MineState): number {
  return Math.floor(Object.values(m.unconfirmed ?? {}).reduce((a, v) => a + v, 0) / Number(MICRO_PER_GOLD));
}
