// 内部経済：人口 → 労働力 → 生産 → 供給 → 消費 → 都市資金 → 建設 → 人口増加
import { levelMultiplier, LINES, tierDef, type TierDef } from "../catalog";
import {
  expandCost,
  FOOD_PER_RESIDENT_HOUR,
  INITIAL_PLOTS,
  LABOR_PARTICIPATION,
  LOGISTICS_FLOOR,
  MARKET_PRICE,
  MARKET_RESERVE_BASE,
  MARKET_RESERVE_PLOTS,
  MARKET_SELL_PER_HOUR,
  OPERATION_FLOOR,
  PARK_HAPPINESS_BY_TIER,
  PARK_HAPPINESS_CAP,
  PARK_HAPPINESS_DECAY,
  POP_GROWTH_BASE_HOUR,
  POP_GROWTH_PER_RESIDENT_HOUR,
  POWER_FLOOR,
  TAX_PER_RESIDENT_HOUR,
  TECH_MULTIPLIER,
} from "../config";
import { devLevel } from "../levels";
import type { Building, CityState } from "../types";
import { plotsUsed, pollutionPairs } from "./layout";

export interface Production {
  food: number;
  wood: number;
  stone: number;
  /** 都市資金（税収を含む） */
  treasury: number;
}

export interface Metrics {
  devLevel: number;
  techMultiplier: number;
  /** 技術活用率（公共施設による技術倍率の発揮度） */
  techUtilization: number;
  population: number;
  housingCap: number;
  labor: number;
  jobSlots: number;
  /** 建物が必要とする労働力の充足率 */
  laborRatio: number;
  /** 雇用充足率（住民にとって仕事があるか） */
  employment: number;
  powerSupply: number;
  powerDemand: number;
  powerRatio: number;
  logisticsCap: number;
  /** 物流の需要（通常建物を Lv 倍率で数えた棟数。インフラは除く） */
  logisticsDemand: number;
  logistics: number;
  commerceCap: number;
  publicCap: number;
  production: Production;
  /** 資材の売却（1時間あたり。売る木材・石材と、得る都市資金。都市資金は production.treasury に含む） */
  market: Production;
  tax: number;
  foodUse: number;
  /** 備蓄を考慮しない構造的な食料充足 */
  foodRatio: number;
  happinessTarget: number;
  /** 都市稼働係数（発展速度） */
  operation: number;
  /** 1時間あたりの人口増加（食料充足を掛ける前） */
  growth: number;
}

/** 稼働中の通常建物（建設中は buildings に入っていない） */
function active(b: Building): b is Building & { line: NonNullable<Building["line"]> } {
  return !!b.line && !b.closed;
}

/**
 * 開園中の公園の幸福度。1つずつは段階（月額）で決まり、効果の大きい順に 2つ目からは前の PARK_HAPPINESS_DECAY 倍、合計は上限まで。
 * tiers は開園中の公園の段階（parkSize）
 */
export function parkHappiness(tiers: number[]): number {
  let total = 0;
  let k = 1;
  for (const v of tiers.map((t) => PARK_HAPPINESS_BY_TIER[t] ?? 0).sort((a, b) => b - a)) {
    total += v * k;
    k *= PARK_HAPPINESS_DECAY;
  }
  return Math.min(PARK_HAPPINESS_CAP, total);
}

/** 資材の売却で残しておく木材・石材（基本 ＋ 次の区画の開拓費 × 区画数）。これを超えた分を少しずつ売る */
export function materialReserve(s: Pick<CityState, "plots" | "jobs">): { wood: number; stone: number } {
  const c = expandCost(Math.max(0, plotsUsed(s) - INITIAL_PLOTS.length), true);
  return { wood: MARKET_RESERVE_BASE + MARKET_RESERVE_PLOTS * c.wood, stone: MARKET_RESERVE_BASE + MARKET_RESERVE_PLOTS * c.stone };
}

export function computeMetrics(s: CityState): Metrics {
  const dev = devLevel(s.devPoints);
  const pop = s.population;
  const normals = s.buildings.filter(active);

  let housingCap = 0;
  let jobSlots = 0;
  let powerDemand = 0;
  let powerSupplyRaw = 0;
  let logisticsCap = 0;
  let commerceCap = 0;
  let publicCap = 0;
  let publicHappiness = 0;
  let logisticsDemand = 0;
  for (const b of normals) {
    const t = tierDef(b.line, b.tier);
    const lm = levelMultiplier(b.level);
    housingCap += (t.housing ?? 0) * lm;
    jobSlots += (t.workers ?? 0) * lm;
    powerDemand += (t.power ?? 0) * lm;
    powerSupplyRaw += (t.powerSupply ?? 0) * lm;
    logisticsCap += (t.logistics ?? 0) * lm;
    commerceCap += (t.customers ?? 0) * lm;
    publicCap += (t.serve ?? 0) * lm;
    publicHappiness += (t.happiness ?? 0) * lm;
    if (LINES[b.line].category !== "infra") logisticsDemand += lm;
  }

  const labor = pop * LABOR_PARTICIPATION;
  const laborRatio = jobSlots > 0 ? Math.min(1, labor / jobSlots) : 1;
  const employment = labor > 0 ? Math.min(1, jobSlots / labor) : 1;
  const powerSupply = powerSupplyRaw * laborRatio;
  const powerRatio = powerDemand > 0 ? Math.min(1, powerSupply / powerDemand) : 1;
  const logistics = logisticsDemand > 0 ? LOGISTICS_FLOOR + (1 - LOGISTICS_FLOOR) * Math.min(1, logisticsCap / logisticsDemand) : 1;

  const coverage = pop > 0 ? Math.min(1, publicCap / pop) : 1;
  const techUtilization = 0.7 + 0.3 * coverage;
  const techMultiplier = 1 + (TECH_MULTIPLIER[s.techLevel - 1] - 1) * techUtilization;
  const demandRatio = commerceCap > 0 ? Math.min(1, pop / commerceCap) : 0;

  const production: Production = { food: 0, wood: 0, stone: 0, treasury: 0 };
  const factors = { laborRatio, powerRatio, logistics, techMultiplier, demandRatio };
  for (const b of normals) {
    const out = buildingOutput(tierDef(b.line, b.tier), b.level, factors);
    production.food += out.food;
    production.wood += out.wood;
    production.stone += out.stone;
    production.treasury += out.treasury;
  }

  const foodUse = pop * FOOD_PER_RESIDENT_HOUR;
  const foodRatio = s.stock.food > 0 || foodUse === 0 ? 1 : Math.min(1, production.food / foodUse);

  const openParks = s.buildings.filter((b) => b.special === "park" && !b.closed).map((b) => b.tier);
  let h = 40;
  h += foodRatio >= 1 ? 10 : -25 * (1 - foodRatio);
  h += 12 * employment - 6;
  h += pop > 0 ? 12 * Math.min(1, commerceCap / pop) : 0;
  h += Math.min(20, publicHappiness) * coverage;
  h += ((logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR)) * 6;
  h += parkHappiness(openParks);
  h -= Math.min(15, pollutionPairs(s) * 3);
  const happinessTarget = Math.max(0, Math.min(100, h));

  const tax = pop * TAX_PER_RESIDENT_HOUR * (0.5 + s.happiness / 100);
  production.treasury += tax;

  // 残しておく量を超えた木材・石材を売る（あふれた資材を都市資金に替える）
  const reserve = materialReserve(s);
  const sellWood = Math.max(0, s.stock.wood - reserve.wood) * MARKET_SELL_PER_HOUR;
  const sellStone = Math.max(0, s.stock.stone - reserve.stone) * MARKET_SELL_PER_HOUR;
  const market: Production = { food: 0, wood: sellWood, stone: sellStone, treasury: sellWood * MARKET_PRICE.wood + sellStone * MARKET_PRICE.stone };
  production.treasury += market.treasury;

  const logisticsNorm = (logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR);
  const worst = Math.min(foodRatio, powerRatio, employment, logisticsNorm);
  const operation = worst >= 0.95 ? 1 : worst >= 0.6 ? 0.7 : OPERATION_FLOOR;

  const room = housingCap > 0 ? Math.max(0, Math.min(1, (housingCap - pop) / (housingCap * 0.25))) : 0;
  const growth =
    (POP_GROWTH_BASE_HOUR + POP_GROWTH_PER_RESIDENT_HOUR * pop) * room * (0.3 + 0.7 * employment) * (0.5 + s.happiness / 100);

  return {
    devLevel: dev,
    techMultiplier,
    techUtilization,
    population: pop,
    housingCap,
    labor,
    jobSlots,
    laborRatio,
    employment,
    powerSupply,
    powerDemand,
    powerRatio,
    logisticsCap,
    logisticsDemand,
    logistics,
    commerceCap,
    publicCap,
    production,
    market,
    tax,
    foodUse,
    foodRatio,
    happinessTarget,
    operation,
    growth,
  };
}

/**
 * 建物1棟の1時間あたりの生産。
 * 実生産 = 基本生産 × 建物Lv倍率 × 技術倍率 × 労働充足率 × 電力充足率 × 物流効率
 * 電力充足率は、足りなくても POWER_FLOOR までは動く（電力0で生産が0にならない）
 */
export function buildingOutput(
  t: TierDef,
  level: number,
  f: { laborRatio: number; powerRatio: number; logistics: number; techMultiplier: number; demandRatio: number },
): Production {
  const k =
    levelMultiplier(level) *
    f.techMultiplier *
    (t.workers ? f.laborRatio : 1) *
    (t.power ? POWER_FLOOR + (1 - POWER_FLOOR) * f.powerRatio : 1) *
    f.logistics;
  const commerceFactor = t.customers ? f.demandRatio : 1;
  return {
    food: (t.food ?? 0) * k,
    wood: (t.wood ?? 0) * k,
    stone: (t.stone ?? 0) * k,
    treasury: (t.revenue ?? 0) * k * commerceFactor,
  };
}
