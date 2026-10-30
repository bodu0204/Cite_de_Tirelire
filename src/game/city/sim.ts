// 放置シミュレーションと自律型開発システム。
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
  AUTO_MAX_WAIT_HOURS,
  BUILDING_LEVEL_CAP,
  DEV_BUILD,
  DEV_EVOLVE,
  DEV_LEVEL_UP,
  DEV_PER_HOUR,
  DEV_POP_STEP,
  expandCost,
  expandMinutes,
  GOLD_RESOURCE_VALUE,
  HAPPINESS_EASE_HOUR,
  HOUR,
  HOUSING_VACANCY_TARGET,
  INITIAL_PLOTS,
  MINUTE,
  PLOT_SIZE,
  TICK_MS,
} from "../config";
import { devLevel } from "../levels";
import { coverPlans, firstShort, type PlanQueue, type QueuePlan } from "../planQueue";
import type { Zone } from "../catalog";
import { snapBuilding, type Building, type CityEvent, type CityState, type Gains, type Job, type NeedKey } from "../types";
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
 * 1ティック進める。devMultiplier（債券倍率）は時間発展にだけ掛ける。
 * 建設時間・人口増加・建設完了などの発展ptは変えない。
 */
export function tick(s: CityState, end: number, events: CityEvent[], devMultiplier = 1) {
  completeJobs(s, end, events);

  const m = computeMetrics(s);
  const dtH = TICK_MS / HOUR;

  const available = s.stock.food + m.production.food * dtH;
  const need = m.foodUse * dtH;
  const foodRatio = need > 0 ? Math.min(1, available / need) : 1;
  s.stock.food = Math.max(0, available - need);
  s.stock.wood += m.production.wood * dtH;
  s.stock.stone += m.production.stone * dtH;
  s.treasury += m.production.treasury * dtH;

  s.happiness += (m.happinessTarget - s.happiness) * Math.min(1, HAPPINESS_EASE_HOUR * dtH);

  // 人口は減らさない（街を壊さない）。住宅が減った場合のみ上限に合わせる
  s.population = Math.min(m.housingCap, s.population + m.growth * foodRatio * dtH);
  s.population = Math.max(0, s.population);
  if (s.population > s.peakPopulation) {
    const before = s.peakPopulation;
    s.peakPopulation = s.population;
    s.devPoints += Math.floor(s.population / DEV_POP_STEP) - Math.floor(before / DEV_POP_STEP);
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

  const devBefore = devLevel(s.devPoints);
  s.devPoints += DEV_PER_HOUR * dtH * m.operation * devMultiplier;
  emitDevLevel(s, devBefore, end, events);

  const foodShort = foodRatio < 1;
  const powerShort = m.powerRatio < 1;
  shortageEvent(s, "food", foodShort, end, events);
  shortageEvent(s, "power", powerShort, end, events);

  if (s.policy.autoEnabled) autoDevelop(s, computeMetrics(s), end);
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

/** 実績の最高記録を超えたときだけ発展ポイントを加算する（建設・撤去の繰り返し対策） */
export function creditBuild(s: CityState, b: Building, kind: "build" | "upgrade" | "evolve") {
  if (!b.line) return;
  const same = s.buildings.filter((o) => o.line === b.line);
  const before = devLevel(s.devPoints);
  if (kind === "build" && bump(s, `n:${b.line}`, same.length)) s.devPoints += DEV_BUILD;
  if (kind === "evolve" && bump(s, `t:${b.line}:${b.tier}`, same.filter((o) => o.tier === b.tier).length))
    s.devPoints += DEV_EVOLVE;
  if (kind === "upgrade" && bump(s, `lv:${b.line}`, same.reduce((a, o) => a + o.level, 0))) s.devPoints += DEV_LEVEL_UP;
  return before;
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
    const road: Building = { id: newId(s), line: "road", tier: job.tier, level: 1, x: t.x, y: t.y, locked: false, manual: !job.auto, builtAt: at };
    s.buildings.push(road);
    roads.push(road);
  }
  const count = s.buildings.filter((b) => b.line === "road").length;
  s.peaks["n:road"] = Math.max(s.peaks["n:road"] ?? 0, count);
  events.push({ at, type: "PLOT_EXPANDED", auto: job.auto, important: true, payload: { plot, zone: job.zone ?? null, roads: roads.map(snapBuilding) } });
  // 場所が足りずにマップ外で待っていた公園・像を置く
  placeWaitingSpecials(s);
}

export function finishJob(s: CityState, job: Job, at: number, events: CityEvent[]) {
  s.jobs = s.jobs.filter((j) => j.id !== job.id);
  if (job.kind === "expand") return openPlot(s, job, at, events);
  let b: Building | undefined;
  let before: number | undefined;
  if (job.kind === "build") {
    b = {
      id: job.buildingId,
      line: job.line,
      tier: job.tier,
      level: 1,
      x: job.x,
      y: job.y,
      locked: false,
      manual: !job.auto,
      builtAt: at,
    };
    s.buildings.push(b);
    before = creditBuild(s, b, "build");
    events.push({ at, type: "BUILD", auto: job.auto, important: true, payload: { building: snapBuilding(b), name: buildingName(b) } });
  } else {
    b = s.buildings.find((o) => o.id === job.buildingId);
    if (!b) return;
    if (job.kind === "upgrade") {
      b.level = job.level;
      before = creditBuild(s, b, "upgrade");
      events.push({
        at,
        type: "UPGRADE",
        auto: job.auto,
        important: true,
        payload: { building: snapBuilding(b), name: buildingName(b), level: b.level },
      });
    } else {
      const from = buildingName(b);
      b.tier = job.tier;
      before = creditBuild(s, b, "evolve");
      events.push({
        at,
        type: "EVOLVE",
        auto: job.auto,
        important: true,
        payload: { building: snapBuilding(b), from, to: buildingName(b) },
      });
    }
  }
  if (before !== undefined) emitDevLevel(s, before, at, events);
}

function completeJobs(s: CityState, end: number, events: CityEvent[]) {
  const due = s.jobs
    .filter((j) => j.finishAt <= end)
    .sort((a, b) => a.finishAt - b.finishAt || a.id.localeCompare(b.id));
  for (const job of due) finishJob(s, job, Math.max(job.finishAt, end - TICK_MS), events);
}

// ---- 自律型開発システム ----

interface Plan {
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

export function canAfford(s: CityState, cost: Cost, useTreasury: boolean): boolean {
  return s.stock.wood >= cost.wood && s.stock.stone >= cost.stone && (!useTreasury || s.treasury >= cost.treasury);
}

/** 不足分を内部生産で貯めるのにかかる時間（時間） */
function waitHours(s: CityState, m: Metrics, cost: Cost): number {
  const parts: [number, number][] = [
    [cost.wood - s.stock.wood, m.production.wood],
    [cost.stone - s.stock.stone, m.production.stone],
    [cost.treasury - s.treasury, m.production.treasury],
  ];
  let h = 0;
  for (const [deficit, rate] of parts) {
    if (deficit <= 0) continue;
    if (rate <= 1e-9) return Infinity;
    h = Math.max(h, deficit / rate);
  }
  return h;
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
 * 区画の開拓の計画（自動開発。Q9）。同時に開拓するのは1区画まで。開く区画には、土地を求めた建物の用途を付ける
 */
function expandPlan(s: CityState, dev: number, zone: Zone | null, cache?: SiteCache): Plan | null {
  if (s.policy.autoExpand === false || s.jobs.some((j) => j.kind === "expand")) return null;
  const plot = choosePlot(s, zone, cache);
  if (!plot) return null;
  const n = nextPlotIndex(s);
  const [px, py] = plot.split(",").map(Number);
  const tier = Math.max(0, highestUnlockedTier("road", s.techLevel, dev));
  return { kind: "expand", line: "road", tier, level: 1, site: { x: px * PLOT_SIZE, y: py * PLOT_SIZE }, plot, zone: zone ?? undefined, cost: expandCost(n), minutes: expandMinutes(n) };
}

function evolvePlans(s: CityState, lines: LineId[], dev: number): Plan[] {
  const out: Plan[] = [];
  const candidates = s.buildings
    .filter((b) => b.line && lines.includes(b.line) && !b.locked && !busy(s, b.id))
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
    .filter((b) => b.line && lines.includes(b.line) && !b.locked && !busy(s, b.id) && b.level < cap)
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

/** 必要事項ごとの候補（上から順に検討する） */
function plansFor(need: NeedKey, s: CityState, m: Metrics, dev: number, cache = siteCache()): Plan[] {
  const plans: (Plan | null)[] = [];
  const buildPlan = (s: CityState, line: LineId, dev: number) => buildPlanAt(s, line, dev, cache);
  const pop = s.population;
  switch (need) {
    case "shortage": {
      const foodLow = m.production.food < m.foodUse * 1.05 && s.stock.food < m.foodUse * 24;
      if (foodLow) plans.push(...evolvePlans(s, ["farm"], dev), buildPlan(s, "farm", dev), ...upgradePlans(s, ["farm"], dev));
      if (m.powerDemand > m.powerSupply + 1e-9)
        plans.push(buildPlan(s, "power", dev), ...evolvePlans(s, ["power"], dev), ...upgradePlans(s, ["power"], dev));
      if (m.production.wood < 0.5) plans.push(buildPlan(s, "lumber", dev));
      if (m.production.stone < 0.3 && highestUnlockedTier("quarry", s.techLevel, dev) >= 0) plans.push(buildPlan(s, "quarry", dev));
      break;
    }
    case "jobs": {
      if (m.labor <= m.jobSlots + 0.5) break;
      const commerceFirst = s.policy.preset === "commerce" || m.commerceCap < pop;
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
      const pending = s.jobs.some((j) => j.line === "housing");
      if (vacancy >= HOUSING_VACANCY_TARGET || m.employment < 0.9 || pending) break;
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

/** 計画列の具体的な計画：方針の優先順に全項目の候補を並べ、同じ建物の重複を除く */
function concretePlans(s: CityState, m: Metrics): Plan[] {
  const seen = new Set<string>();
  const out: Plan[] = [];
  const cache = siteCache();
  for (const need of s.policy.priorities) {
    for (const plan of plansFor(need, s, m, m.devLevel, cache)) {
      const key = plan.kind === "build" ? `build:${plan.line}` : plan.kind === "expand" ? "expand" : `${plan.kind}:${plan.building!.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(plan);
    }
  }
  return out;
}

const goldValue = (c: Pick<Cost, "wood" | "stone">) => c.wood / GOLD_RESOURCE_VALUE.wood + c.stone / GOLD_RESOURCE_VALUE.stone;

/** 拡張計画1件：解放済みの新築のうち、木材＋石材の金貨換算が最も高いもの */
export function expansionPlan(s: CityState, dev: number): { line: LineId; tier: number; cost: Cost } {
  let best = { line: "housing" as LineId, tier: 0, cost: tierDef("housing", 0).cost };
  for (const line of LINE_IDS) {
    LINES[line].tiers.forEach((t, tier) => {
      if (isTierUnlocked(line, tier, s.techLevel, dev) && goldValue(t.cost) > goldValue(best.cost)) best = { line, tier, cost: t.cost };
    });
  }
  return best;
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
  return { plans: concretePlans(s, m).map(q), expansion: q({ kind: "build", line: x.line, tier: x.tier, level: 1, cost: x.cost }) };
}

export interface CityNeeds {
  /** 必要資源（木材・石材・都市資金は計画列の不足分、食料は24時間分の不足分） */
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
  const food = Math.max(0, m.foodUse * 24 - (s.stock.food + m.production.food * 24));
  const queue = planQueue(s, m);
  const { coverage, expansion } = firstShort(coverPlans(queue, { wood: s.stock.wood, stone: s.stock.stone, treasury: s.treasury }));
  const p = coverage.plan;
  return {
    needs: { wood: coverage.short.wood, stone: coverage.short.stone, food, treasury: coverage.short.treasury },
    next: { kind: p.kind, line: p.line, tier: p.tier, level: p.level, name: p.name, expansion },
    queue,
  };
}

/** 1ティックに1件まで、自動開発のジョブを開始する */
export function autoDevelop(s: CityState, m: Metrics, now: number): void {
  const dev = m.devLevel;
  const cache = siteCache();
  for (const need of s.policy.priorities) {
    for (const plan of plansFor(need, s, m, dev, cache)) {
      if (canAfford(s, plan.cost, true)) {
        // 景観改善は余剰資金があるときだけ
        if (need === "beautify" && s.treasury - plan.cost.treasury < 500) return;
        startJob(s, plan, now, true);
        return;
      }
      // 近いうちに払えるなら下位の項目に資金を流さずに貯める
      if (need !== "beautify" && waitHours(s, m, plan.cost) <= AUTO_MAX_WAIT_HOURS) return;
    }
  }
}

export function startJob(s: CityState, plan: Plan, now: number, auto: boolean): Job {
  s.stock.wood -= plan.cost.wood;
  s.stock.stone -= plan.cost.stone;
  if (auto) s.treasury -= plan.cost.treasury;
  const job: Job = {
    id: `j${s.nextId++}`,
    kind: plan.kind,
    auto,
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

