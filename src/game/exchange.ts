// 通貨と資源の交換。金貨→銀貨→資源 の経路が 金貨→資源 より有利にならないことをテストで保証する。
import { FEE_EXCHANGE, GOLD_RESOURCE_VALUE, SILVER_VALUE_RATIO } from "./config";
import { bankBonus, goldMineBonus, silverMineBonus } from "./levels";
import type { StockKey } from "./types";

export type Currency = "gold" | "silver";

export interface FacilityLevels {
  bank: number;
  goldMine: number;
  silverMine: number;
}

/** 通貨1枚あたりの資源獲得量 */
export function exchangeRate(currency: Currency, resource: StockKey, lv: FacilityLevels): number {
  const base = GOLD_RESOURCE_VALUE[resource];
  if (currency === "gold") return base * (1 + bankBonus(lv.bank) + goldMineBonus(lv.goldMine));
  return base * SILVER_VALUE_RATIO * (1 + bankBonus(lv.bank) + silverMineBonus(lv.silverMine));
}

export interface ExchangeQuote {
  currency: Currency;
  resource: StockKey;
  amount: number;
  gain: number;
  rate: number;
  /** 必要な銀貨（手数料、銀貨払いなら代金も含む） */
  silverCost: number;
  goldCost: number;
}

export function quoteResourceExchange(
  currency: Currency,
  resource: StockKey,
  amount: number,
  lv: FacilityLevels,
): ExchangeQuote {
  const rate = exchangeRate(currency, resource, lv);
  return {
    currency,
    resource,
    amount,
    rate,
    gain: Math.floor(amount * rate + 1e-9),
    silverCost: FEE_EXCHANGE + (currency === "silver" ? amount : 0),
    goldCost: currency === "gold" ? amount : 0,
  };
}
