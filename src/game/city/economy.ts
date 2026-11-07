// 街の状態の指標：人口 → 労働力 → 生産（食料・割引施設）→ 幸福度。
// 街は自分では稼がない（建設資金は貯金からだけ入る。docs/savings-driven-growth.md GRW-01）。
// 人口と幸福度は賑わいの表示と悪い出来事の被害の大きさにだけ使う（GRW-08）
import { levelMultiplier, LINES, tierDef, type TierDef } from "../catalog";
import {
  FOOD_PER_RESIDENT_HOUR,
  LABOR_PARTICIPATION,
  LOGISTICS_FLOOR,
  MOVE_IN_PER_HOUR,
  OPERATION_FLOOR,
  PARK_HAPPINESS_CAP,
  PARK_HAPPINESS_DECAY,
  PARK_HAPPINESS_FIRST,
  TECH_MULTIPLIER,
} from "../config";
import { devLevel } from "../levels";
import type { Building, CityState } from "../types";
import { active as effectActive } from "./disasters";
import { pollutionPairs } from "./layout";

export interface Production {
  food: number;
  /** 木材・石材は在庫に入らない（割引施設が動いているかの目安。GRW-02・GRW-05） */
  wood: number;
  stone: number;
  /** 街は自分では稼がないので常に0（GRW-01） */
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
  logistics: number;
  commerceCap: number;
  publicCap: number;
  production: Production;
  foodUse: number;
  /** 備蓄を考慮しない構造的な食料充足 */
  foodRatio: number;
  happinessTarget: number;
  /** 都市稼働係数（発展速度） */
  operation: number;
  /** 1時間あたりに移り住む人数（食料充足を掛ける前。GRW-09） */
  growth: number;
}

/** 稼働中の通常建物（建設中は buildings に入っていない） */
function active(b: Building): b is Building & { line: NonNullable<Building["line"]> } {
  return !!b.line && !b.closed;
}

export function parkHappiness(openParks: number): number {
  let total = 0;
  let step = PARK_HAPPINESS_FIRST;
  for (let i = 0; i < openParks; i++) {
    total += step;
    step *= PARK_HAPPINESS_DECAY;
  }
  return Math.min(PARK_HAPPINESS_CAP, total);
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
  let nonInfra = 0;
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
    if (LINES[b.line].category !== "infra") nonInfra++;
  }

  const labor = pop * LABOR_PARTICIPATION;
  const laborRatio = jobSlots > 0 ? Math.min(1, labor / jobSlots) : 1;
  const employment = labor > 0 ? Math.min(1, jobSlots / labor) : 1;
  // 停電（docs/savings-driven-growth.md EVT-03）の間は電力の供給が減る
  const blackout = effectActive(s.effects?.blackout, s.simTime) ? s.effects!.blackout!.rate : 0;
  const powerSupply = powerSupplyRaw * laborRatio * (1 - blackout);
  const powerRatio = powerDemand > 0 ? Math.min(1, powerSupply / powerDemand) : 1;
  const logistics = nonInfra > 0 ? LOGISTICS_FLOOR + (1 - LOGISTICS_FLOOR) * Math.min(1, logisticsCap / nonInfra) : 1;

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
  }

  // 不作（EVT-03）の間は食料生産が減る
  if (effectActive(s.effects?.crop, s.simTime)) production.food *= 1 - s.effects!.crop!.rate;
  const foodUse = pop * FOOD_PER_RESIDENT_HOUR;
  const foodRatio = s.stock.food > 0 || foodUse === 0 ? 1 : Math.min(1, production.food / foodUse);

  const openParks = s.buildings.filter((b) => b.special === "park" && !b.closed).length;
  let h = 40;
  h += foodRatio >= 1 ? 10 : -25 * (1 - foodRatio);
  h += 12 * employment - 6;
  h += pop > 0 ? 12 * Math.min(1, commerceCap / pop) : 0;
  h += Math.min(20, publicHappiness) * coverage;
  h += ((logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR)) * 6;
  h += parkHappiness(openParks);
  h -= Math.min(15, pollutionPairs(s) * 3);
  const happinessTarget = Math.max(0, Math.min(100, h));

  const logisticsNorm = (logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR);
  const worst = Math.min(foodRatio, powerRatio, employment, logisticsNorm);
  const operation = worst >= 0.95 ? 1 : worst >= 0.6 ? 0.7 : OPERATION_FLOOR;

  const growth = Math.max(0, housingCap - pop) * MOVE_IN_PER_HOUR;

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
    logistics,
    commerceCap,
    publicCap,
    production,
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
    (t.power ? f.powerRatio : 1) *
    f.logistics;
  return {
    food: (t.food ?? 0) * k,
    wood: (t.wood ?? 0) * k,
    stone: (t.stone ?? 0) * k,
    // 商業・工業の収益はなくした（GRW-01）
    treasury: 0,
  };
}
