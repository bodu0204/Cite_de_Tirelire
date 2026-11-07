// 放置シミュレーションと街の発展（docs/savings-driven-growth.md：街は貯金だけで計画列を消化して発展する）。
// 10分刻みの絶対時刻に揃えたティックで進めるため、いつアクセスしても同じ経過時間なら同じ結果になる。
import {
  evolveCost,
  highestUnlockedTier,
  isTierUnlocked,
  LINE_IDS,
  LINES,
  tierDef,
  unlocksAtTech,
  upgradeCost,
  upgradeMinutes,
  type Cost,
  type LineId,
} from "../catalog";
import {
  BUILDING_LEVEL_CAP,
  CONCURRENT_JOBS,
  DEV_POINTS_PER_BASE,
  DISCOUNT_MAX,
  DISCOUNT_PER_BUILDING,
  expandCost,
  expandMinutes,
  FUND_PRICE_KAPPA,
  GOLD_RESOURCE_VALUE,
  HAPPINESS_EASE_HOUR,
  HOUR,
  HOUSING_VACANCY_TARGET,
  INITIAL_PLOTS,
  MINUTE,
  MOVE_IN_PER_HOUR,
  PLOT_SIZE,
  TICK_MS,
} from "../config";
import { devLevel } from "../levels";
import { coverPlans, firstShort, type PlanQueue, type QueuePlan } from "../planQueue";
import type { Zone } from "../catalog";
import { NEED_ORDER, snapBuilding, type Building, type CityEvent, type CityState, type Gains, type Job, type NeedKey } from "../types";
import { active, clearEffects, maybeDisaster, reopenDue } from "./disasters";
import { computeMetrics, type Metrics } from "./economy";
import { choosePlot, findSite, occupancy, placeWaitingSpecials, plotCross, plotsUsed, siteCache, tileKey, type SiteCache } from "./layout";

export const alignTick = (t: number) => Math.floor(t / TICK_MS) * TICK_MS;

export function levelCap(dev: number): number {
  return BUILDING_LEVEL_CAP[dev - 1] ?? BUILDING_LEVEL_CAP[BUILDING_LEVEL_CAP.length - 1];
}

export function buildingName(b: Pick<Building, "line" | "tier">): string {
  return b.line ? tierDef(b.line, b.tier).name : "";
}

export function newId(s: CityState): string {
  return `b${s.nextId++}`;
}

/** until（ティックに切り捨て）までシミュレーションを進める。state は直接更新する */
export function simulate(s: CityState, until: number, events: CityEvent[]): void {
  const target = alignTick(until);
  while (s.simTime < target) tick(s, s.simTime + TICK_MS, events);
}

/**
 * 1ティック進める。街は自分では稼がない：建設資金（treasury）は貯金からだけ入り（idle.ts）、
 * ここでは工事の完了・食料・幸福度・人口と、建設資金での計画の消化だけを行う（GRW-01）。
 */
export function tick(s: CityState, end: number, events: CityEvent[]) {
  // 悪い出来事（docs/savings-driven-growth.md §10）：休業の再開 → 今のティックに起きる出来事
  reopenDue(s, end, events);
  maybeDisaster(s, end, events, (c, b) => priceOf(c, tierDef(b.line!, b.tier).cost));
  completeJobs(s, end, events);

  const m = computeMetrics(s);
  const dtH = TICK_MS / HOUR;

  const available = s.stock.food + m.production.food * dtH;
  const need = m.foodUse * dtH;
  const foodRatio = need > 0 ? Math.min(1, available / need) : 1;
  s.stock.food = Math.max(0, available - need);

  s.happiness += (m.happinessTarget - s.happiness) * Math.min(1, HAPPINESS_EASE_HOUR * dtH);

  // 人口は住宅の空きに移り住んで増える（GRW-09）。減らさない（街を壊さない）
  if (s.population < m.housingCap) {
    s.population = Math.min(m.housingCap, s.population + (m.housingCap - s.population) * Math.min(1, MOVE_IN_PER_HOUR * dtH) * foodRatio);
  }
  if (s.population > s.peakPopulation) {
    const before = s.peakPopulation;
    s.peakPopulation = s.population;
    const step = 25;
    if (Math.floor(s.population / step) > Math.floor(before / step)) {
      events.push({
        at: end,
        type: "POPULATION",
        auto: true,
        important: true,
        payload: { population: Math.floor(s.population / step) * step },
      });
    }
  }

  const foodShort = foodRatio < 1;
  const powerShort = m.powerRatio < 1;
  shortageEvent(s, "food", foodShort, end, events);
  shortageEvent(s, "power", powerShort, end, events);

  develop(s, end);
  clearEffects(s, end);
  s.simTime = end;
}

function shortageEvent(s: CityState, kind: "food" | "power", short: boolean, at: number, events: CityEvent[]) {
  const key = kind === "food" ? "foodShort" : "powerShort";
  if (s.flags[key] === short) return;
  s.flags[key] = short;
  events.push({ at, type: short ? "SHORTAGE_STARTED" : "SHORTAGE_RESOLVED", auto: true, important: true, payload: { kind } });
}

export function emitDevLevel(s: CityState, before: number, at: number, events: CityEvent[]) {
  const after = devLevel(s.devPoints);
  for (let lv = before + 1; lv <= after; lv++) {
    events.push({ at, type: "DEV_LEVEL", auto: true, important: true, payload: { level: lv } });
  }
}

// ---- ジョブ完了と建築実績 ----

function bump(s: CityState, key: string, value: number): boolean {
  if (value > (s.peaks[key] ?? 0)) {
    s.peaks[key] = value;
    return true;
  }
  return false;
}

/** 建築実績の最高記録を更新する（タイムラプス・表示用。発展ptは完成した計画の値段で数える：addCompleted） */
export function creditBuild(s: CityState, b: Building, kind: "build" | "upgrade" | "evolve") {
  if (!b.line) return;
  const same = s.buildings.filter((o) => o.line === b.line);
  if (kind === "build") bump(s, `n:${b.line}`, same.length);
  if (kind === "evolve") bump(s, `t:${b.line}:${b.tier}`, same.filter((o) => o.tier === b.tier).length);
  if (kind === "upgrade") bump(s, `lv:${b.line}`, same.reduce((a, o) => a + o.level, 0));
}

/** 完成した計画の値段を累計に足し、発展ptを求め直す（GRW-04） */
export function addCompleted(s: CityState, price: number, at: number, events: CityEvent[]) {
  const before = devLevel(s.devPoints);
  s.completed += price;
  s.devPoints = (s.completed / s.base) * DEV_POINTS_PER_BASE;
  emitDevLevel(s, before, at, events);
}

/**
 * 区画を開く（docs/map-layout-redesign.md §7.2）：区画の十字に道路を敷き、土地用途を決める。
 * 十字は隣の区画の道路網につながっている（開拓できる区画の条件）。敷いた道路は建築実績に数えない
 */
function openPlot(s: CityState, job: Job, at: number, events: CityEvent[]) {
  const plot = job.plot!;
  if (!s.plots.includes(plot)) s.plots.push(plot);
  const [px, py] = plot.split(",").map(Number);
  const cross = plotCross(px, py);
  const onCross = new Set(cross.map((t) => tileKey(t.x, t.y)));
  if (job.zone)
    for (let y = py * PLOT_SIZE; y < (py + 1) * PLOT_SIZE; y++)
      for (let x = px * PLOT_SIZE; x < (px + 1) * PLOT_SIZE; x++) if (!onCross.has(tileKey(x, y)) && !s.zones[tileKey(x, y)]) s.zones[tileKey(x, y)] = job.zone;
  const occ = occupancy(s);
  const roads: Building[] = [];
  for (const t of cross) {
    if (occ.has(tileKey(t.x, t.y))) continue;
    const road: Building = { id: newId(s), line: "road", tier: job.tier, level: 1, x: t.x, y: t.y, builtAt: at };
    s.buildings.push(road);
    roads.push(road);
  }
  const count = s.buildings.filter((b) => b.line === "road").length;
  s.peaks["n:road"] = Math.max(s.peaks["n:road"] ?? 0, count);
  events.push({ at, type: "PLOT_EXPANDED", auto: true, important: true, payload: { plot, zone: job.zone ?? null, roads: roads.map(snapBuilding) } });
  // 場所が足りずにマップ外で待っていた公園・像を置く
  placeWaitingSpecials(s);
}

export function finishJob(s: CityState, job: Job, at: number, events: CityEvent[]) {
  s.jobs = s.jobs.filter((j) => j.id !== job.id);
  if (job.kind === "expand") openPlot(s, job, at, events);
  else completeBuilding(s, job, at, events);
  if (job.price) addCompleted(s, job.price, at, events);
}

function completeBuilding(s: CityState, job: Job, at: number, events: CityEvent[]) {
  let b: Building | undefined;
  if (job.kind === "build") {
    b = {
      id: job.buildingId,
      line: job.line,
      tier: job.tier,
      level: 1,
      x: job.x,
      y: job.y,
      builtAt: at,
    };
    s.buildings.push(b);
    creditBuild(s, b, "build");
    events.push({ at, type: "BUILD", auto: true, important: true, payload: { building: snapBuilding(b), name: buildingName(b) } });
  } else {
    b = s.buildings.find((o) => o.id === job.buildingId);
    if (!b) return;
    if (job.kind === "upgrade") {
      b.level = job.level;
      creditBuild(s, b, "upgrade");
      events.push({
        at,
        type: "UPGRADE",
        auto: true,
        important: true,
        payload: { building: snapBuilding(b), name: buildingName(b), level: b.level },
      });
    } else {
      const from = buildingName(b);
      b.tier = job.tier;
      creditBuild(s, b, "evolve");
      events.push({
        at,
        type: "EVOLVE",
        auto: true,
        important: true,
        payload: { building: snapBuilding(b), from, to: buildingName(b) },
      });
    }
  }
}

function completeJobs(s: CityState, end: number, events: CityEvent[]) {
  const due = s.jobs
    .filter((j) => j.finishAt <= end)
    .sort((a, b) => a.finishAt - b.finishAt || a.id.localeCompare(b.id));
  for (const job of due) finishJob(s, job, Math.max(job.finishAt, end - TICK_MS), events);
}

// ---- 街の発展 ----

export interface Plan {
  kind: Job["kind"];
  line: LineId;
  tier: number;
  level: number;
  building?: Building;
  site?: { x: number; y: number };
  /** expand：開く区画と、その土地用途 */
  plot?: string;
  zone?: Zone;
  cost: Cost;
  minutes: number;
}

// ---- 値段（docs/savings-driven-growth.md §6） ----

/** カタログの相対コスト（木材 ÷10 ＋ 石材 ÷5 ＋ 都市資金 ÷10。以前の金貨1枚あたりの交換量で換算） */
export const relCost = (c: Cost) =>
  c.wood / GOLD_RESOURCE_VALUE.wood + c.stone / GOLD_RESOURCE_VALUE.stone + c.treasury / GOLD_RESOURCE_VALUE.treasury;

/** 建設費の割引：木材加工所・石材加工所・工場1棟あたり DISCOUNT_PER_BUILDING、上限 DISCOUNT_MAX（GRW-05） */
export function discountRate(s: CityState): number {
  const n = s.buildings.filter((b) => !b.closed && (b.line === "lumber" || b.line === "quarry" || b.line === "factory")).length;
  return Math.min(DISCOUNT_MAX, n * DISCOUNT_PER_BUILDING);
}

/** 値段の係数 κ。ふだんは FUND_PRICE_KAPPA のまま（scripts/balance.ts が試算のときだけ変える） */
export const pricing = { kappa: FUND_PRICE_KAPPA };

/** 計画の値段（円）＝ 相対コスト × 基準額 × κ ×（1 − 割引）（PRC-01）。資材の値上がり（EVT-03）の間は上がる。1円以上 */
export function priceOf(s: CityState, cost: Cost): number {
  const surge = active(s.effects?.surge, s.simTime) ? 1 + s.effects!.surge!.rate : 1;
  return Math.max(1, Math.ceil(relCost(cost) * s.base * pricing.kappa * (1 - discountRate(s)) * surge));
}

/**
 * 工事中のジョブがすべて終わったものとした指標。発展の判断と計画列に使う
 * （工事中の分を足りないと数えると、同じ不足に何件も建てて作りすぎる）
 */
export function plannedMetrics(s: CityState): Metrics {
  if (s.jobs.length === 0) return computeMetrics(s);
  const buildings = s.buildings.map((b) => {
    const j = s.jobs.find((j) => j.buildingId === b.id);
    if (!j) return b;
    return j.kind === "upgrade" ? { ...b, level: j.level } : j.kind === "evolve" ? { ...b, tier: j.tier } : b;
  });
  for (const j of s.jobs)
    if (j.kind === "build") buildings.push({ id: j.buildingId, line: j.line, tier: j.tier, level: 1, x: j.x, y: j.y, builtAt: j.finishAt });
  return computeMetrics({ ...s, buildings });
}

const busy = (s: CityState, id: string) => s.jobs.some((j) => j.buildingId === id);
const countLine = (s: CityState, line: LineId) =>
  s.buildings.filter((b) => b.line === line).length + s.jobs.filter((j) => j.kind === "build" && j.line === line).length;

function buildPlanAt(s: CityState, line: LineId, dev: number, cache?: SiteCache): Plan | null {
  const tier = highestUnlockedTier(line, s.techLevel, dev);
  if (tier < 0) return null;
  const site = findSite(s, line, cache);
  if (site) {
    const t = tierDef(line, tier);
    return { kind: "build", line, tier, level: 1, site, cost: t.cost, minutes: t.buildMinutes };
  }
  if (line === "road") return null;
  // 置き場所がなければ、まず欠けた推奨道路を道路網の端から延ばし、それもなければ区画を開拓する（§5.3・§7.2）
  const zone = LINES[line].zone;
  return buildPlanAt(s, "road", dev, cache) ?? expandPlan(s, dev, zone === "any" ? null : zone, cache);
}

/** 開拓の n 番目（初期の区画のあとに開く順、0 から） */
export function nextPlotIndex(s: CityState): number {
  return Math.max(0, plotsUsed(s) - INITIAL_PLOTS.length);
}

/**
 * 次に開く区画の費用。最初の2区画と、石材加工所が解放されるまで（発展Lv2・技術Lv2）は石材を使わない
 * （石材を作れないうちに石材を求めると、交換しない限り開拓が止まる）
 */
export function plotCost(s: CityState): Cost {
  const n = nextPlotIndex(s);
  return expandCost(n, n >= 2 && highestUnlockedTier("quarry", s.techLevel, devLevel(s.devPoints)) >= 0);
}

/**
 * 区画の開拓の計画（Q9）。同時に開拓するのは1区画まで。開く区画には、土地を求めた建物の用途を付ける
 */
function expandPlan(s: CityState, dev: number, zone: Zone | null, cache?: SiteCache): Plan | null {
  if (s.jobs.some((j) => j.kind === "expand")) return null;
  const plot = choosePlot(s, zone, cache);
  if (!plot) return null;
  const n = nextPlotIndex(s);
  const [px, py] = plot.split(",").map(Number);
  const tier = Math.max(0, highestUnlockedTier("road", s.techLevel, dev));
  return { kind: "expand", line: "road", tier, level: 1, site: { x: px * PLOT_SIZE, y: py * PLOT_SIZE }, plot, zone: zone ?? undefined, cost: plotCost(s), minutes: expandMinutes(n) };
}

function evolvePlans(s: CityState, lines: LineId[], dev: number): Plan[] {
  const out: Plan[] = [];
  const candidates = s.buildings
    .filter((b) => b.line && lines.includes(b.line) && !busy(s, b.id))
    .filter((b) => isTierUnlocked(b.line!, b.tier + 1, s.techLevel, dev))
    .sort((a, b) => lines.indexOf(a.line!) - lines.indexOf(b.line!) || a.tier - b.tier || a.builtAt - b.builtAt || a.id.localeCompare(b.id));
  for (const b of candidates) {
    const tier = b.tier + 1;
    out.push({ kind: "evolve", line: b.line!, tier, level: b.level, building: b, cost: evolveCost(b.line!, tier), minutes: tierDef(b.line!, tier).buildMinutes });
  }
  return out;
}

function upgradePlans(s: CityState, lines: LineId[], dev: number): Plan[] {
  const cap = levelCap(dev);
  return s.buildings
    .filter((b) => b.line && lines.includes(b.line) && !busy(s, b.id) && b.level < cap)
    .sort((a, b) => a.level - b.level || lines.indexOf(a.line!) - lines.indexOf(b.line!) || a.id.localeCompare(b.id))
    .map((b) => ({
      kind: "upgrade" as const,
      line: b.line!,
      tier: b.tier,
      level: b.level + 1,
      building: b,
      cost: upgradeCost(b.line!, b.tier, b.level),
      minutes: upgradeMinutes(b.line!, b.tier, b.level),
    }));
}

const PRODUCERS: LineId[] = ["farm", "factory", "commerce", "office", "lumber", "quarry", "power"];
const EVOLVE_ORDER: LineId[] = ["farm", "housing", "factory", "commerce", "power", "road", "school", "culture", "office"];
const NEW_INDUSTRY: LineId[] = ["quarry", "factory", "commerce", "school", "clinic", "culture", "rail", "logistics", "office", "future"];

/** 必要事項ごとの候補（上から順に検討する）。scripts/balance.ts も使う */
export function plansFor(need: NeedKey, s: CityState, m: Metrics, dev: number, cache = siteCache()): Plan[] {
  const plans: (Plan | null)[] = [];
  const buildPlan = (s: CityState, line: LineId, dev: number) => buildPlanAt(s, line, dev, cache);
  const pop = s.population;
  switch (need) {
    case "shortage": {
      // 電力を食料より先にする。電力が足りない間は、電力を使う段階への農場の進化をしない（GRW-07）
      const powerShort = m.powerDemand > m.powerSupply + 1e-9;
      if (powerShort) plans.push(buildPlan(s, "power", dev), ...evolvePlans(s, ["power"], dev), ...upgradePlans(s, ["power"], dev));
      const foodLow = m.production.food < m.foodUse * 1.05 && s.stock.food < m.foodUse * 24;
      if (foodLow) {
        // 働き手が足りない間は農場を増やさず（増やすほど働き手が足りなくなる）、住宅を先にする
        const laborShort = m.laborRatio < 0.95;
        if (laborShort) plans.push(...plansFor("housing", s, m, dev, cache));
        plans.push(...evolvePlans(s, ["farm"], dev).filter((p) => !(powerShort && tierDef(p.line, p.tier).power)));
        if (!laborShort) plans.push(buildPlan(s, "farm", dev), ...upgradePlans(s, ["farm"], dev));
      }
      if (m.production.wood < 0.5) plans.push(buildPlan(s, "lumber", dev));
      if (m.production.stone < 0.3 && highestUnlockedTier("quarry", s.techLevel, dev) >= 0) plans.push(buildPlan(s, "quarry", dev));
      break;
    }
    case "jobs": {
      if (m.labor <= m.jobSlots + 0.5) break;
      const commerceFirst = m.commerceCap < pop;
      const order: LineId[] = commerceFirst
        ? ["commerce", "office", "factory", "quarry", "lumber", "farm"]
        : ["factory", "commerce", "office", "quarry", "lumber", "farm"];
      for (const line of order) {
        // 食料が十分なら雇用のためだけに農場は増やさない
        if (line === "farm" && m.production.food > m.foodUse * 2) continue;
        plans.push(buildPlan(s, line, dev));
      }
      break;
    }
    case "housing": {
      const vacancy = m.housingCap > 0 ? (m.housingCap - pop) / m.housingCap : 0;
      if (vacancy >= HOUSING_VACANCY_TARGET || m.employment < 0.9) break;
      plans.push(buildPlan(s, "housing", dev), ...evolvePlans(s, ["housing"], dev), ...upgradePlans(s, ["housing"], dev));
      break;
    }
    case "logistics": {
      if (m.logistics >= 0.9) break;
      plans.push(buildPlan(s, "road", dev), ...evolvePlans(s, ["road"], dev));
      if (countLine(s, "rail") === 0) plans.push(buildPlan(s, "rail", dev));
      if (countLine(s, "logistics") === 0) plans.push(buildPlan(s, "logistics", dev));
      break;
    }
    case "efficiency": {
      plans.push(...evolvePlans(s, EVOLVE_ORDER, dev));
      plans.push(...upgradePlans(s, PRODUCERS, dev).slice(0, 3));
      break;
    }
    case "industry": {
      for (const line of NEW_INDUSTRY) if (countLine(s, line) === 0) plans.push(buildPlan(s, line, dev));
      break;
    }
    case "beautify": {
      if (pop > m.publicCap) plans.push(buildPlan(s, "school", dev), buildPlan(s, "clinic", dev), buildPlan(s, "culture", dev));
      plans.push(...upgradePlans(s, ["housing", "school", "culture", "clinic"], dev).slice(0, 2));
      break;
    }
  }
  return plans.filter((p): p is Plan => !!p);
}

// ---- 計画列と必要資源（docs/needs-based-exchange.md §4） ----

/** 計画列の具体的な計画：決まった順（NEED_ORDER）に全項目の候補を並べ、同じ建物の重複を除く */
function concretePlans(s: CityState): Plan[] {
  const m = plannedMetrics(s);
  const seen = new Set<string>();
  const out: Plan[] = [];
  const cache = siteCache();
  for (const need of NEED_ORDER) {
    for (const plan of plansFor(need, s, m, m.devLevel, cache)) {
      const key = plan.kind === "build" ? `build:${plan.line}` : plan.kind === "expand" ? "expand" : `${plan.kind}:${plan.building!.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(plan);
    }
  }
  return out;
}

/** 値段（円）を建設資金の列に入れた Cost（木材・石材は使わない） */
const fundCost = (price: number): Cost => ({ wood: 0, stone: 0, treasury: price });

/** 拡張計画1件：解放済みの新築のうち、値段が最も高いもの（cost は値段を建設資金に入れたもの） */
export function expansionPlan(s: CityState, dev: number): { line: LineId; tier: number; cost: Cost } {
  let best = { line: "housing" as LineId, tier: 0, rel: relCost(tierDef("housing", 0).cost) };
  for (const line of LINE_IDS) {
    LINES[line].tiers.forEach((t, tier) => {
      if (isTierUnlocked(line, tier, s.techLevel, dev) && relCost(t.cost) > best.rel) best = { line, tier, rel: relCost(t.cost) };
    });
  }
  return { line: best.line, tier: best.tier, cost: fundCost(priceOf(s, tierDef(best.line, best.tier).cost)) };
}

/** 計画列：具体的な計画と、そのあとに無限に続く拡張計画1件分。街の状態は変えない */
export function planQueue(s: CityState, m: Metrics = computeMetrics(s)): PlanQueue {
  const q = (p: { kind: Job["kind"]; line: LineId; tier: number; level: number; cost: Cost }): QueuePlan => ({
    kind: p.kind,
    line: p.line,
    tier: p.tier,
    level: p.level,
    name: p.kind === "expand" ? "区画の開拓" : tierDef(p.line, p.tier).name,
    cost: p.cost,
  });
  const x = expansionPlan(s, m.devLevel);
  return {
    plans: concretePlans(s).map((p) => q({ ...p, cost: fundCost(priceOf(s, p.cost)) })),
    expansion: q({ kind: "build", line: x.line, tier: x.tier, level: 1, cost: x.cost }),
  };
}

export interface CityNeeds {
  /** 必要な建設資金（計画列の不足分。treasury だけを使う。食料はお金では買わない：GRW-02） */
  needs: Gains;
  /** 在庫が最初に足りなくなる計画。expansion なら拡張計画 */
  next: { kind: Job["kind"]; line: LineId; tier: number; level: number; name: string; expansion: boolean };
  queue: PlanQueue;
}

/**
 * 計画列（具体的な計画のあとに拡張計画が無限に続く）に在庫を先頭から割り当て、
 * 最初に足りなくなった計画の不足分を木材・石材・都市資金の必要量とする。街の状態は変えない。
 */
export function cityNeeds(s: CityState, m: Metrics = computeMetrics(s)): CityNeeds {
  const queue = planQueue(s, m);
  const { coverage, expansion } = firstShort(coverPlans(queue, { wood: 0, stone: 0, treasury: s.treasury }));
  const p = coverage.plan;
  return {
    needs: { wood: 0, stone: 0, food: 0, treasury: coverage.short.treasury },
    next: { kind: p.kind, line: p.line, tier: p.tier, level: p.level, name: p.name, expansion },
    queue,
  };
}

/**
 * 街の工事を開始する。決まった順（NEED_ORDER）の計画列を先頭から建設資金で消化する（GRW-03）。
 * 先頭の計画が払えなければ、そこで止めて貯める（後ろの安い計画に回さない）。同時に進める工事は発展Lvごとに CONCURRENT_JOBS まで。
 * 街はこの1つの手順だけで発展する（プレイヤーが建物を建てたり、方針を決めたりはしない）。
 * 足りないものは工事中の分も終わったものとして判断する（plannedMetrics）
 */
export function develop(s: CityState, now: number): void {
  // 台風の間は工事を始めない（EVT-03）
  if ((s.effects?.pauseUntil ?? 0) > now) return;
  const dev = devLevel(s.devPoints);
  const limit = CONCURRENT_JOBS[dev - 1] ?? CONCURRENT_JOBS[CONCURRENT_JOBS.length - 1];
  let cache = siteCache();
  let pm = plannedMetrics(s);
  for (const need of NEED_ORDER) {
    // 始めたジョブの分だけ候補が変わるので、何も始められなくなるまで候補を出し直す
    for (let started = true; started; ) {
      started = false;
      for (const plan of plansFor(need, s, pm, dev, cache)) {
        if (s.jobs.length >= limit) return;
        const price = priceOf(s, plan.cost);
        if (s.treasury < price) return;
        startJob(s, plan, price, now);
        // 盤面と完成後の指標が変わったので、場所と指標は出し直す
        cache = siteCache();
        pm = plannedMetrics(s);
        started = true;
        break;
      }
    }
  }
}

function startJob(s: CityState, plan: Plan, price: number, now: number): Job {
  s.treasury -= price;
  const job: Job = {
    id: `j${s.nextId++}`,
    kind: plan.kind,
    line: plan.line,
    tier: plan.tier,
    level: plan.level,
    buildingId: plan.building?.id ?? (plan.kind === "expand" ? `plot:${plan.plot}` : newId(s)),
    x: plan.building?.x ?? plan.site!.x,
    y: plan.building?.y ?? plan.site!.y,
    ...(plan.plot ? { plot: plan.plot } : {}),
    ...(plan.zone ? { zone: plan.zone } : {}),
    startedAt: now,
    finishAt: now + plan.minutes * MINUTE,
    price,
  };
  s.jobs.push(job);
  return job;
}

/** 技術Lvの反映。上昇時のみ解放イベントを出す（発展ポイントは付与しない） */
export function applyTechLevel(s: CityState, level: number, at: number, events: CityEvent[]): void {
  if (level > s.techLevel) {
    for (let lv = s.techLevel + 1; lv <= level; lv++) {
      events.push({ at, type: "TECH_UNLOCKED", auto: false, important: true, payload: { level: lv, unlocks: unlocksAtTech(lv) } });
    }
  }
  s.techLevel = level;
}

