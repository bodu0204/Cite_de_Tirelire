// 債券：急な出費に備えるお金。持っているほど時間発展が速くなり、足りない支払いを肩代わりする。
import { BOND_CAP_MONTHS, BOND_FEE_CAP, BOND_FEE_RATE, BOND_FORCED_RATE, BOND_MULTIPLIER_MAX, BOND_MULTIPLIER_MONTHS } from "./config";

/** 債券化が止まる額（3M） */
export const bondCap = (monthlyBudget: number) => Math.max(0, monthlyBudget) * BOND_CAP_MONTHS;

/** 債券倍率：時間発展にだけ掛ける。マイナスでも 1.0 より下げない（設計原則5） */
export function bondMultiplier(bond: number, monthlyBudget: number): number {
  if (bond <= 0 || monthlyBudget <= 0) return 1;
  return Math.min(BOND_MULTIPLIER_MAX, 1 + bond / (monthlyBudget * BOND_MULTIPLIER_MONTHS));
}

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
