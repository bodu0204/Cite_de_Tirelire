// 通貨と資源の交換（種類を選ぶ交換と、都市の必要資源の割合で振り分ける「おまかせ」交換）。金貨→銀貨→資源 の経路が 金貨→資源 より有利にならないことをテストで保証する。
// 都市資金も資源と同じく金貨・銀貨で交換できる。
import { CITY_EXCHANGE_POP, FEE_EXCHANGE, GOLD_RESOURCE_VALUE, SILVER_VALUE_RATIO } from "./config";
import { bankBonus, goldMineBonus, silverMineBonus } from "./levels";
import { PLAN_KEYS, type NeedsTarget, type PlanStock } from "./planQueue";
import type { GainKey, Gains } from "./types";

export type Currency = "gold" | "silver";

export interface FacilityLevels {
  bank: number;
  goldMine: number;
  silverMine: number;
  /** 街の規模による倍率（cityScale。省略すると 1） */
  city?: number;
}

/** 街の規模による交換量の倍率：1 ＋ 人口 ÷ CITY_EXCHANGE_POP（GB-05） */
export const cityScale = (population: number) => 1 + Math.max(0, population) / CITY_EXCHANGE_POP;

/** 通貨1枚あたりの資源獲得量（金貨・銀貨とも街の規模の倍率が同じだけ掛かるので、金貨→銀貨→資源が有利になることはない） */
export function exchangeRate(currency: Currency, resource: GainKey, lv: FacilityLevels): number {
  const base = GOLD_RESOURCE_VALUE[resource] * (lv.city ?? 1);
  if (currency === "gold") return base * (1 + bankBonus(lv.bank) + goldMineBonus(lv.goldMine));
  return base * SILVER_VALUE_RATIO * (1 + bankBonus(lv.bank) + silverMineBonus(lv.silverMine));
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

/**
 * 債券に入った分（0〜上限の範囲）につく資源：同じ量の金貨を手数料なしで交換したのと同じ量。
 * resource が "auto" ならおまかせ（必要割合で振り分け）、それ以外はその種類だけ。
 */
export function quoteBondGains(eligible: number, resource: GainKey | "auto", needs: Gains | NeedsTarget, lv: FacilityLevels): Gains {
  if (resource === "auto") return quoteNeedsExchange("gold", eligible, needs, lv, { fee: false }).gains;
  return { ...ZERO_GAINS, [resource]: quoteResourceExchange("gold", resource, eligible, lv).gain };
}

export const GAIN_KEYS: GainKey[] = ["wood", "stone", "food", "treasury"];

export const ZERO_GAINS: Gains = { wood: 0, stone: 0, food: 0, treasury: 0 };

const isTarget = (n: Gains | NeedsTarget): n is NeedsTarget => "queue" in n;

/**
 * 計画列を先頭から順に満たす振り分け（GB-11）。amount（通貨の枚数）を、まず食料の不足に、次に計画列の計画を1件ずつ
 * 「在庫と前の計画の残りで足りない分」に割り当てる。拡張計画は無限に続くので、amount はいつも使い切る。
 * rate は通貨1枚あたりの獲得量。戻り値は資源ごとに振り分けた通貨の枚数（小数）
 */
export function fillNeeds(target: NeedsTarget, amount: number, rate: Gains): Gains {
  const split = { ...ZERO_GAINS };
  let left = Math.max(0, amount);
  /** 不足分（資源の単位）を満たす。足りなければ通貨の価値の比で配り、使い切ったら false */
  const give = (short: Gains): boolean => {
    const cost = GAIN_KEYS.reduce((a, k) => a + (short[k] > 0 ? short[k] / rate[k] : 0), 0);
    if (cost <= 0) return true;
    const f = Math.min(1, left / cost);
    for (const k of GAIN_KEYS) if (short[k] > 0) split[k] += (short[k] / rate[k]) * f;
    left -= cost * f;
    return f >= 1 && left > 1e-12;
  };
  if (!give({ ...ZERO_GAINS, food: target.food })) return split;
  const stock: PlanStock = { ...target.stock };
  /** 計画1件：足りない分を満たして、そのコストを在庫から払う */
  const plan = (cost: PlanStock): boolean => {
    const short = { ...ZERO_GAINS };
    for (const k of PLAN_KEYS) short[k] = Math.max(0, cost[k] - stock[k]);
    const ok = give(short);
    for (const k of PLAN_KEYS) stock[k] = Math.max(0, stock[k] + short[k] - cost[k]);
    return ok;
  };
  for (const p of target.queue.plans) if (!plan(p.cost)) return split;
  // 拡張計画：在庫の残りを使い切るまでは1件ずつ、そのあとは同じ割合で残りを全部
  const x = target.queue.expansion.cost;
  for (let i = 0; i < 1000 && left > 1e-12; i++) {
    if (PLAN_KEYS.every((k) => x[k] <= 0 || stock[k] <= 0)) break;
    if (!plan(x)) return split;
  }
  if (left > 1e-12) {
    // 在庫がまだ残っている資源は当分いらないので除く（すべて残っていれば拡張計画の割合のまま）
    const rest = PLAN_KEYS.filter((k) => x[k] > 0 && stock[k] <= 0);
    const keys = rest.length ? rest : PLAN_KEYS;
    const per = { ...ZERO_GAINS };
    for (const k of keys) per[k] = x[k];
    const cost = GAIN_KEYS.reduce((a, k) => a + per[k] / rate[k], 0);
    for (const k of GAIN_KEYS) split[k] += cost > 0 ? (per[k] / rate[k] / cost) * left : left / GAIN_KEYS.length;
  }
  return split;
}

/** 必要割合：必要資源を金貨に換算した額の比。合計は1（すべて0なら均等。計画列が無限に続くので通常は起きない） */
export function needShares(needs: Gains): Gains {
  const value = GAIN_KEYS.map((k) => Math.max(0, needs[k]) / GOLD_RESOURCE_VALUE[k]);
  const total = value.reduce((a, b) => a + b, 0);
  const shares = { ...ZERO_GAINS };
  GAIN_KEYS.forEach((k, i) => (shares[k] = total > 0 ? value[i] / total : 1 / GAIN_KEYS.length));
  return shares;
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
 * おまかせで振り分けて交換する。needs が計画列（NeedsTarget）なら先頭から順に満たし（fillNeeds）、
 * 必要資源（Gains）なら必要割合で振り分ける。
 * fee：手数料を取るか（債券化につく資源は取らない）、floor：通貨を整数に振り分けて獲得量を切り捨てるか
 * （放置中の債券化は少額が毎ティック入るので、小数のまま在庫に加える）。
 */
export function quoteNeedsExchange(
  currency: Currency,
  amount: number,
  needs: Gains | NeedsTarget,
  lv: FacilityLevels,
  opts: { fee?: boolean; floor?: boolean } = {},
): NeedsQuote {
  const { fee = true, floor = true } = opts;
  const rate = Object.fromEntries(GAIN_KEYS.map((k) => [k, exchangeRate(currency, k, lv)])) as unknown as Gains;
  const filled = isTarget(needs) && amount > 0 ? fillNeeds(needs, amount, rate) : null;
  const shares = filled ? (Object.fromEntries(GAIN_KEYS.map((k) => [k, filled[k] / amount])) as unknown as Gains) : needShares(isTarget(needs) ? ZERO_GAINS : needs);
  const split = floor
    ? splitAmount(amount, shares)
    : { wood: amount * shares.wood, stone: amount * shares.stone, food: amount * shares.food, treasury: amount * shares.treasury };
  const gain = (k: GainKey) => {
    const g = split[k] * rate[k];
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
