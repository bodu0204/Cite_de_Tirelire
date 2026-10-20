// 通貨と資源の交換（種類を選ぶ交換と、都市の必要資源の割合で振り分ける「おまかせ」交換）。金貨→銀貨→資源 の経路が 金貨→資源 より有利にならないことをテストで保証する。
import { FEE_EXCHANGE, GOLD_RESOURCE_VALUE, SILVER_VALUE_RATIO } from "./config";
import { bankBonus, goldMineBonus, silverMineBonus } from "./levels";
import type { Stock, StockKey } from "./types";

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

// ---- おまかせ交換（docs/needs-based-exchange.md §5・§6） ----

const KEYS: StockKey[] = ["wood", "stone", "food"];

/** 必要割合：必要資源を金貨に換算した額の比。合計は1（すべて0なら均等。計画列が無限に続くので通常は起きない） */
export function needShares(needs: Stock): Stock {
  const value = KEYS.map((k) => Math.max(0, needs[k]) / GOLD_RESOURCE_VALUE[k]);
  const total = value.reduce((a, b) => a + b, 0);
  const [wood, stone, food] = total > 0 ? value.map((v) => v / total) : [1 / 3, 1 / 3, 1 / 3];
  return { wood, stone, food };
}

/** amount を割合で整数に振り分ける（最大剰余法。同じ剰余なら木材・石材・食料の順） */
export function splitAmount(amount: number, shares: Stock): Stock {
  const raw = KEYS.map((k) => amount * shares[k]);
  const base = raw.map((r) => Math.floor(r + 1e-9));
  let rest = amount - base.reduce((a, b) => a + b, 0);
  const order = KEYS.map((_, i) => i).sort((a, b) => raw[b] - base[b] - (raw[a] - base[a]) || a - b);
  for (const i of order) {
    if (rest <= 0) break;
    base[i]++;
    rest--;
  }
  return { wood: base[0], stone: base[1], food: base[2] };
}

export interface NeedsQuote {
  currency: Currency;
  amount: number;
  shares: Stock;
  /** 資源ごとに振り分けた通貨 */
  split: Stock;
  gains: Stock;
  silverCost: number;
  goldCost: number;
}

/**
 * 必要割合で振り分けて交換する。
 * fee：手数料を取るか（債券化につく資源は取らない）、floor：通貨を整数に振り分けて獲得量を切り捨てるか
 * （放置中の債券化は少額が毎ティック入るので、小数のまま在庫に加える）。
 */
export function quoteNeedsExchange(
  currency: Currency,
  amount: number,
  needs: Stock,
  lv: FacilityLevels,
  opts: { fee?: boolean; floor?: boolean } = {},
): NeedsQuote {
  const { fee = true, floor = true } = opts;
  const shares = needShares(needs);
  const split = floor ? splitAmount(amount, shares) : { wood: amount * shares.wood, stone: amount * shares.stone, food: amount * shares.food };
  const gain = (k: StockKey) => {
    const g = split[k] * exchangeRate(currency, k, lv);
    return floor ? Math.floor(g + 1e-9) : g;
  };
  return {
    currency,
    amount,
    shares,
    split,
    gains: { wood: gain("wood"), stone: gain("stone"), food: gain("food") },
    silverCost: (fee ? FEE_EXCHANGE : 0) + (currency === "silver" ? amount : 0),
    goldCost: currency === "gold" ? amount : 0,
  };
}
