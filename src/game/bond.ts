// 債券：急な出費に備えるお金。足りない支払いを肩代わりし、持っている間は毎日利息（建設資金）が街に入る（fund.ts。RSV-02）。
import { BOND_CAP_MONTHS, BOND_FEE_CAP, BOND_FEE_RATE, BOND_FORCED_RATE } from "./config";

/** 債券化が止まる額（3M） */
export const bondCap = (monthlyBudget: number) => Math.max(0, monthlyBudget) * BOND_CAP_MONTHS;

/** 債券を used 使ったときの銀貨の手数料（500 以下は10%、超えたら一律 50S） */
export function bondFee(used: number): number {
  if (used <= 0) return 0;
  return Math.min(BOND_FEE_CAP, Math.ceil(used * BOND_FEE_RATE));
}

/**
 * 今の債券残高で採掘から債券へ回す割合（%）。
 * carried は持ち込みの備え（docs/season-start-settings.md RC-07・08）：債券が −carried 以上の間は借金として扱わず、強制しない
 */
export function bondShare(bond: number, rate: number, cap: number, carried = 0): number {
  if (bond < -carried) return Math.max(rate, BOND_FORCED_RATE);
  return bond < cap ? rate : 0;
}

/** 金鉱画面の表示用：債券化の状態 */
export function bondMiningStatus(bond: number, rate: number, cap: number, carried = 0): "forced" | "capped" | "active" | "off" {
  if (bond < -carried) return "forced";
  if (rate <= 0) return "off";
  return bond >= cap ? "capped" : "active";
}

/**
 * 債券に amount 入るとき、建設資金をつける分（docs/needs-based-exchange.md §6.2、docs/savings-driven-growth.md RSV-01）。
 * 債券が動く区間 [bond, bond + amount] のうち [0, cap] に入る部分だけ。マイナスを0に戻す分と上限を超える分は対象外。
 */
export function bondResourceEligible(bond: number, amount: number, cap: number): number {
  if (amount <= 0) return 0;
  return Math.max(0, Math.min(bond + amount, cap) - Math.max(bond, 0));
}

/**
 * シーズン開始時に申告した「すでにある貯金」を分ける（docs/season-start-settings.md RC-02）。
 * 債券の上限（3M）までは持ち込みの備え（債券の下に敷くクッション）、超える分は持ち込みの貯金（表示だけ）
 */
export function splitCarried(existing: number, monthlyBudget: number): { reserve: number; savings: number } {
  const total = Math.max(0, Math.floor(existing));
  const reserve = Math.min(total, bondCap(monthlyBudget));
  return { reserve, savings: total - reserve };
}

/** 持ち込みの備えから取り崩している額（債券のマイナスのうち、持ち込みの備えの範囲内。RC-09） */
export function carriedDrawn(bond: number, carried: number): number {
  return bond < 0 ? Math.min(-bond, Math.max(0, carried)) : 0;
}
