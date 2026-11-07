// 通貨から建設資金への交換。金貨→銀貨→建設資金 の経路が 金貨→建設資金 より有利にならないことをテストで保証する。
// 木材・石材・都市資金は建設資金（treasury）1種類にまとめた（docs/savings-driven-growth.md GRW-02）。
// 交換の型（資源の種類・おまかせ）は以前のまま受け付けるが、得られるのはいつも建設資金になる。
import { FEE_EXCHANGE, FUND_PER_GOLD, SILVER_VALUE_RATIO } from "./config";
import { bankBonus, goldMineBonus, silverMineBonus } from "./levels";
import type { GainKey, Gains } from "./types";

export type Currency = "gold" | "silver";

export interface FacilityLevels {
  bank: number;
  goldMine: number;
  silverMine: number;
}

/** 通貨1枚あたりの建設資金（円）。resource は以前の資源の種類で、値には影響しない */
export function exchangeRate(currency: Currency, _resource: GainKey, lv: FacilityLevels): number {
  if (currency === "gold") return FUND_PER_GOLD * (1 + bankBonus(lv.bank) + goldMineBonus(lv.goldMine));
  return FUND_PER_GOLD * SILVER_VALUE_RATIO * (1 + bankBonus(lv.bank) + silverMineBonus(lv.silverMine));
}

export interface ExchangeQuote {
  currency: Currency;
  resource: GainKey;
  amount: number;
  gain: number;
  rate: number;
  /** 必要な銀貨（手数料、銀貨払いなら代金も含む） */
  silverCost: number;
  goldCost: number;
}

export function quoteResourceExchange(
  currency: Currency,
  resource: GainKey,
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

// ---- おまかせ交換（docs/needs-based-exchange.md §5・§6・§13） ----

/** 債券に入った分（0〜上限の範囲）につく建設資金：同じ量の金貨を手数料なしで交換したのと同じ量（RSV-01） */
export function quoteBondGains(eligible: number, _resource: GainKey | "auto", needs: Gains, lv: FacilityLevels): Gains {
  return quoteNeedsExchange("gold", eligible, needs, lv, { fee: false }).gains;
}

export const GAIN_KEYS: GainKey[] = ["wood", "stone", "food", "treasury"];

export const ZERO_GAINS: Gains = { wood: 0, stone: 0, food: 0, treasury: 0 };

/** 必要割合：建設資金1種類にまとめたので、いつも建設資金が1（GRW-02） */
export function needShares(_needs: Gains): Gains {
  return { ...ZERO_GAINS, treasury: 1 };
}

/** amount を割合で整数に振り分ける（最大剰余法。同じ剰余なら木材・石材・食料・都市資金の順） */
export function splitAmount(amount: number, shares: Gains): Gains {
  const raw = GAIN_KEYS.map((k) => amount * shares[k]);
  const base = raw.map((r) => Math.floor(r + 1e-9));
  let rest = amount - base.reduce((a, b) => a + b, 0);
  const order = GAIN_KEYS.map((_, i) => i).sort((a, b) => raw[b] - base[b] - (raw[a] - base[a]) || a - b);
  for (const i of order) {
    if (rest <= 0) break;
    base[i]++;
    rest--;
  }
  return { wood: base[0], stone: base[1], food: base[2], treasury: base[3] };
}

export interface NeedsQuote {
  currency: Currency;
  amount: number;
  shares: Gains;
  /** 資源ごとに振り分けた通貨 */
  split: Gains;
  gains: Gains;
  silverCost: number;
  goldCost: number;
}

/**
 * おまかせ交換：全額を建設資金にする。
 * fee：手数料を取るか（債券化につく建設資金は取らない）、floor：獲得量を切り捨てるか
 * （放置中の債券化は少額が毎ティック入るので、小数のまま加える）。
 */
export function quoteNeedsExchange(
  currency: Currency,
  amount: number,
  needs: Gains,
  lv: FacilityLevels,
  opts: { fee?: boolean; floor?: boolean } = {},
): NeedsQuote {
  const { fee = true, floor = true } = opts;
  const shares = needShares(needs);
  const split = floor
    ? splitAmount(amount, shares)
    : { wood: amount * shares.wood, stone: amount * shares.stone, food: amount * shares.food, treasury: amount * shares.treasury };
  const gain = (k: GainKey) => {
    const g = split[k] * exchangeRate(currency, k, lv);
    return floor ? Math.floor(g + 1e-9) : g;
  };
  return {
    currency,
    amount,
    shares,
    split,
    gains: { wood: gain("wood"), stone: gain("stone"), food: gain("food"), treasury: gain("treasury") },
    silverCost: (fee ? FEE_EXCHANGE : 0) + (currency === "silver" ? amount : 0),
    goldCost: currency === "gold" ? amount : 0,
  };
}

/** 獲得量の合計（資源の単位のまま） */
export const totalGains = (g: Gains) => GAIN_KEYS.reduce((a, k) => a + g[k], 0);
