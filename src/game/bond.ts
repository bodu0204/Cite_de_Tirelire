// 債券：急な出費に備えるお金。足りない支払いを肩代わりし、持っている間は毎日利息（建設資金）が街に入る（fund.ts。RSV-02）。
import { BOND_CAP_MONTHS, BOND_FEE_CAP, BOND_FEE_RATE, BOND_FORCED_RATE } from "./config";

/** 債券化が止まる額（3M） */
export const bondCap = (monthlyBudget: number) => Math.max(0, monthlyBudget) * BOND_CAP_MONTHS;

/** 債券を used 使ったときの銀貨の手数料（500 以下は10%、超えたら一律 50S） */
export function bondFee(used: number): number {
  if (used <= 0) return 0;
  return Math.min(BOND_FEE_CAP, Math.ceil(used * BOND_FEE_RATE));
}

/** 今の債券残高で採掘から債券へ回す割合（%） */
export function bondShare(bond: number, rate: number, cap: number): number {
  if (bond < 0) return Math.max(rate, BOND_FORCED_RATE);
  return bond < cap ? rate : 0;
}

/** 金鉱画面の表示用：債券化の状態 */
export function bondMiningStatus(bond: number, rate: number, cap: number): "forced" | "capped" | "active" | "off" {
  if (bond < 0) return "forced";
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
