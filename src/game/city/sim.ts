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
  AUTO_JOBS_PER_DEV,
  AUTO_MAX_WAIT_HOURS,
  BUILDING_LEVEL_CAP,
  DEV_BUILD,
  DEV_EVOLVE,
  DEV_LEVEL_UP,
  DEV_PER_HOUR,
  DEV_POP_STEP,
  GOLD_RESOURCE_VALUE,
  HAPPINESS_EASE_HOUR,
  HOUR,
  HOUSING_VACANCY_TARGET,
  MINUTE,
  TICK_MS,
} from "../config";
import { devLevel } from "../levels";
import { snapBuilding, type Building, type CityEvent, type CityState, type Job, type NeedKey, type Stock } from "../types";
import { computeMetrics, type Metrics } from "./economy";
import { DISTRICT_NAMES, findSite } from "./layout";

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
    if (DISTRICT_NAMES[lv]) {
      events.push({ at, type: "DISTRICT_UNLOCKED", auto: true, important: true, payload: { level: lv, name: DISTRICT_NAMES[lv] } });
    }
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

export function finishJob(s: CityState, job: Job, at: number, events: CityEvent[]) {
  s.jobs = s.jobs.filter((j) => j.id !== job.id);
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

function buildPlan(s: CityState, line: LineId, dev: number): Plan | null {
  const tier = highestUnlockedTier(line, s.techLevel, dev);
  if (tier < 0) return null;
  const site = findSite(s, line, dev);
  if (!site) return null;
  const t = tierDef(line, tier);
  return { kind: "build", line, tier, level: 1, site, cost: t.cost, minutes: t.buildMinutes };
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
function plansFor(need: NeedKey, s: CityState, m: Metrics, dev: number): Plan[] {
  const plans: (Plan | null)[] = [];
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
  for (const need of s.policy.priorities) {
    for (const plan of plansFor(need, s, m, m.devLevel)) {
      const key = plan.kind === "build" ? `build:${plan.line}` : `${plan.kind}:${plan.building!.id}`;
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

export interface CityNeeds {
  /** 必要資源（木材・石材は計画列の不足分、食料は24時間分の不足分） */
  needs: Stock;
  /** 在庫が最初に足りなくなる計画。expansion なら拡張計画 */
  next: { kind: Job["kind"]; line: LineId; tier: number; level: number; name: string; expansion: boolean };
}

/**
 * 計画列（具体的な計画のあとに拡張計画が無限に続く）に在庫を先頭から割り当て、
 * 最初に足りなくなった計画の不足分を木材・石材の必要量とする。街の状態は変えない。
 */
export function cityNeeds(s: CityState, m: Metrics = computeMetrics(s)): CityNeeds {
  let wood = s.stock.wood;
  let stone = s.stock.stone;
  const food = Math.max(0, m.foodUse * 24 - (s.stock.food + m.production.food * 24));
  const name = (line: LineId, tier: number) => tierDef(line, tier).name;
  for (const p of concretePlans(s, m)) {
    if (wood >= p.cost.wood && stone >= p.cost.stone) {
      wood -= p.cost.wood;
      stone -= p.cost.stone;
      continue;
    }
    return {
      needs: { wood: Math.max(0, p.cost.wood - wood), stone: Math.max(0, p.cost.stone - stone), food },
      next: { kind: p.kind, line: p.line, tier: p.tier, level: p.level, name: name(p.line, p.tier), expansion: false },
    };
  }
  // 拡張計画は同じコストが無限に並ぶので、払える件数を割り算で求める
  const x = expansionPlan(s, m.devLevel);
  const fits = [
    [wood, x.cost.wood],
    [stone, x.cost.stone],
  ]
    .filter(([, c]) => c > 0)
    .map(([r, c]) => Math.floor(r / c));
  const k = Math.min(...fits);
  return {
    needs: { wood: Math.max(0, x.cost.wood - (wood - k * x.cost.wood)), stone: Math.max(0, x.cost.stone - (stone - k * x.cost.stone)), food },
    next: { kind: "build", line: x.line, tier: x.tier, level: 1, name: name(x.line, x.tier), expansion: true },
  };
}

/** 1ティックに1件まで、自動開発のジョブを開始する */
export function autoDevelop(s: CityState, m: Metrics, now: number): void {
  const dev = m.devLevel;
  const maxJobs = 1 + Math.floor(dev / AUTO_JOBS_PER_DEV);
  if (s.jobs.filter((j) => j.auto).length >= maxJobs) return;

  for (const need of s.policy.priorities) {
    for (const plan of plansFor(need, s, m, dev)) {
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
    buildingId: plan.building?.id ?? newId(s),
    x: plan.building?.x ?? plan.site!.x,
    y: plan.building?.y ?? plan.site!.y,
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

