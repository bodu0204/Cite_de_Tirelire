// 放置シミュレーションと自律型開発システム。
// 10分刻みの絶対時刻に揃えたティックで進めるため、いつアクセスしても同じ経過時間なら同じ結果になる。
import {
  evolveCost,
  highestUnlockedTier,
  isTierUnlocked,
  levelMultiplier,
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
  AUTO_EFFICIENCY_JOBS,
  AUTO_MAX_WAIT_HOURS,
  AUTO_SAVE_HOURS,
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
  LABOR_PARTICIPATION,
  LOGISTICS_FLOOR,
  MARKET_BUY_PRICE,
  MATERIAL_TARGET_HOURS,
  MINUTE,
  PLOT_SIZE,
  POWER_RESERVE_MIN,
  POWER_RESERVE_RATE,
  TICK_MS,
} from "../config";
import { devLevel } from "../levels";
import { coverPlans, firstShort, type NeedsTarget, type PlanQueue, type QueuePlan } from "../planQueue";
import type { Zone } from "../catalog";
import { snapBuilding, type Building, type CityEvent, type CityState, type Gains, type Job, type NeedKey } from "../types";
import { computeMetrics, materialReserve, type Metrics } from "./economy";
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
 * 1ティック進める。devMultiplier（債券倍率）は時間発展・人口増加・自動開発の工事の速さに掛ける（GB-07）。
 * 建設完了などの発展ptは変えない。
 */
export function tick(s: CityState, end: number, events: CityEvent[], devMultiplier = 1) {
  completeJobs(s, end, events);

  const m = computeMetrics(s);
  const dtH = TICK_MS / HOUR;

  const available = s.stock.food + m.production.food * dtH;
  const need = m.foodUse * dtH;
  const foodRatio = need > 0 ? Math.min(1, available / need) : 1;
  s.stock.food = Math.max(0, available - need);
  // 残しておく量を超えた資材は売って都市資金にする（都市資金の分は production.treasury に入っている）
  s.stock.wood += (m.production.wood - m.market.wood) * dtH;
  s.stock.stone += (m.production.stone - m.market.stone) * dtH;
  s.treasury += m.production.treasury * dtH;

  s.happiness += (m.happinessTarget - s.happiness) * Math.min(1, HAPPINESS_EASE_HOUR * dtH);

  // 人口は減らさない（街を壊さない）。住宅が減った場合のみ上限に合わせる
  s.population = Math.min(m.housingCap, s.population + m.growth * foodRatio * devMultiplier * dtH);
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

  if (s.policy.autoEnabled) autoDevelop(s, computeMetrics(s), end, devMultiplier);
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

/**
 * 工事中のジョブがすべて終わったものとした指標。自動開発の判断と計画列に使う
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
    if (j.kind === "build") buildings.push({ id: j.buildingId, line: j.line, tier: j.tier, level: 1, x: j.x, y: j.y, locked: false, manual: !j.auto, builtAt: j.finishAt });
  return computeMetrics({ ...s, buildings });
}

const busy = (s: CityState, id: string) => s.jobs.some((j) => j.buildingId === id);
const countLine = (s: CityState, line: LineId) =>
  s.buildings.filter((b) => b.line === line).length + s.jobs.filter((j) => j.kind === "build" && j.line === line).length;

/**
 * 電力の余力（完成後の指標の 供給 − 需要）。計画に電力を使う分を差し引きながら候補を出す（GB-01）。
 * 余力を超える段階へは進化・新築・Lvアップしない（電力が足りないまま進化して生産が落ちないように）
 */
interface PowerBudget {
  room: number;
  /** 電力が足りないために、建てられない・進化できない・下の段階で建てる計画があった */
  blocked: boolean;
}
const powerBudget = (m: Metrics): PowerBudget => ({ room: m.powerSupply - m.powerDemand, blocked: false });
const fits = (budget: PowerBudget | undefined, demand: number) => {
  const ok = !budget || demand <= 0 || demand <= budget.room + 1e-9;
  if (!ok) budget!.blocked = true;
  return ok;
};
const use = (budget: PowerBudget | undefined, demand: number) => {
  if (budget && demand > 0) budget.room -= demand;
};

function buildPlanAt(s: CityState, line: LineId, dev: number, cache?: SiteCache, power?: PowerBudget): Plan | null {
  // 解放済みの段階のうち、電力の余力に収まる最上位（電力が要らない段階まで下げる）
  let tier = highestUnlockedTier(line, s.techLevel, dev);
  while (tier >= 0 && !fits(power, tierDef(line, tier).power ?? 0)) tier--;
  if (tier < 0) return null;
  const site = findSite(s, line, cache);
  if (site) {
    const t = tierDef(line, tier);
    use(power, t.power ?? 0);
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

/** 石材を作る建物（石材加工所・工房など）が建っているか */
export function makesStone(s: Pick<CityState, "buildings">): boolean {
  return s.buildings.some((b) => !!b.line && !b.closed && (tierDef(b.line, b.tier).stone ?? 0) > 0);
}

/**
 * 次に開く区画の費用。最初の2区画と、石材を作る建物が建つまでは石材を使わない
 * （石材を作れないうちに石材を求めると、交換しない限り開拓が止まる。解放されていても置き場がなく建たないことがある。GB-02）
 */
export function plotCost(s: CityState): Cost {
  const n = nextPlotIndex(s);
  return expandCost(n, n >= 2 && makesStone(s));
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
  return { kind: "expand", line: "road", tier, level: 1, site: { x: px * PLOT_SIZE, y: py * PLOT_SIZE }, plot, zone: zone ?? undefined, cost: plotCost(s), minutes: expandMinutes(n) };
}

function evolvePlans(s: CityState, lines: LineId[], dev: number, power?: PowerBudget): Plan[] {
  const out: Plan[] = [];
  const candidates = s.buildings
    .filter((b) => b.line && lines.includes(b.line) && !b.locked && !busy(s, b.id))
    .filter((b) => isTierUnlocked(b.line!, b.tier + 1, s.techLevel, dev))
    .sort((a, b) => lines.indexOf(a.line!) - lines.indexOf(b.line!) || a.tier - b.tier || a.builtAt - b.builtAt || a.id.localeCompare(b.id));
  for (const b of candidates) {
    const tier = b.tier + 1;
    // 進化で増える電力の需要が余力に収まるものだけ
    const added = ((tierDef(b.line!, tier).power ?? 0) - (tierDef(b.line!, b.tier).power ?? 0)) * levelMultiplier(b.level);
    if (!fits(power, added)) continue;
    use(power, added);
    out.push({ kind: "evolve", line: b.line!, tier, level: b.level, building: b, cost: evolveCost(b.line!, tier), minutes: tierDef(b.line!, tier).buildMinutes });
  }
  return out;
}

function upgradePlans(s: CityState, lines: LineId[], dev: number, power?: PowerBudget): Plan[] {
  const cap = levelCap(dev);
  const out: Plan[] = [];
  const candidates = s.buildings
    .filter((b) => b.line && lines.includes(b.line) && !b.locked && !busy(s, b.id) && b.level < cap)
    .sort((a, b) => a.level - b.level || lines.indexOf(a.line!) - lines.indexOf(b.line!) || a.id.localeCompare(b.id));
  for (const b of candidates) {
    // Lv が1上がると電力の需要は基本値の 0.25 倍増える
    const added = (tierDef(b.line!, b.tier).power ?? 0) * 0.25;
    if (!fits(power, added)) continue;
    use(power, added);
    out.push({
      kind: "upgrade",
      line: b.line!,
      tier: b.tier,
      level: b.level + 1,
      building: b,
      cost: upgradeCost(b.line!, b.tier, b.level),
      minutes: upgradeMinutes(b.line!, b.tier, b.level),
    });
  }
  return out;
}

const PRODUCERS: LineId[] = ["farm", "factory", "commerce", "office", "lumber", "quarry", "power"];
const EVOLVE_ORDER: LineId[] = ["farm", "housing", "factory", "commerce", "power", "road", "school", "culture", "office"];
const NEW_INDUSTRY: LineId[] = ["quarry", "factory", "commerce", "school", "clinic", "culture", "rail", "logistics", "office", "future"];

/**
 * 住宅を増やしてよいか：今の雇用充足率と、住宅が埋まったときの雇用充足率（仕事枠 ÷ 住宅の定員の労働力）がどちらも 0.9 以上。
 * 仕事より先に住宅ばかり増えて失業が増えないようにする（GB-09）
 */
const jobsForHousing = (m: Metrics) => m.employment >= 0.9 && (m.housingCap <= 0 || m.jobSlots >= 0.9 * m.housingCap * LABOR_PARTICIPATION);

/** 物流の改善を始める物流効率（物流の容量が需要の 95% を切ったら。都市稼働係数が下がるのと同じ所） */
const LOGISTICS_TARGET = LOGISTICS_FLOOR + (1 - LOGISTICS_FLOOR) * 0.95;

/** 都市資金は余っているのに資材が足りずに進まない（autoDevelop が求めて、不足の解消で加工所を増やす） */
interface Bottleneck {
  wood: boolean;
  stone: boolean;
  /** 最初に足りなくなる計画の、足りない資材の量と、その計画までに払う都市資金 */
  short: { wood: number; stone: number };
  treasury: number;
}

/**
 * 資材が開発の制約になっているか：都市資金が MATERIAL_TARGET_HOURS 分の収入より多く余っていて、
 * 具体的な計画を先頭から払っていくと、最初に足りなくなる計画が都市資金ではなく資材だけ足りない
 */
function materialBottleneck(s: CityState, pm: Metrics): Bottleneck | undefined {
  if (s.treasury <= pm.production.treasury * MATERIAL_TARGET_HOURS) return undefined;
  const rest = { wood: s.stock.wood, stone: s.stock.stone, treasury: s.treasury };
  for (const p of concretePlans(s)) {
    const short = { wood: Math.max(0, p.cost.wood - rest.wood), stone: Math.max(0, p.cost.stone - rest.stone) };
    if (p.cost.treasury > rest.treasury) return undefined;
    if (short.wood > 0 || short.stone > 0) return { wood: short.wood > 0, stone: short.stone > 0, short, treasury: s.treasury - rest.treasury + p.cost.treasury };
    rest.wood -= p.cost.wood;
    rest.stone -= p.cost.stone;
    rest.treasury -= p.cost.treasury;
  }
  return undefined;
}

/**
 * 内部の市場で資材を買う（GB-05）：資材が開発の制約になっていて、MATERIAL_TARGET_HOURS 分の収入を残しても都市資金が余るなら、
 * 先頭の計画に足りない資材を買う。買えたら true
 */
function buyMaterials(s: CityState, pm: Metrics, b: Bottleneck): boolean {
  const price = b.short.wood * MARKET_BUY_PRICE.wood + b.short.stone * MARKET_BUY_PRICE.stone;
  const spare = s.treasury - pm.production.treasury * MATERIAL_TARGET_HOURS - b.treasury;
  if (price <= 0 || spare < price) return false;
  s.treasury -= price;
  s.stock.wood += b.short.wood;
  s.stock.stone += b.short.stone;
  return true;
}

/** 必要事項ごとの候補（上から順に検討する） */
function plansFor(need: NeedKey, s: CityState, m: Metrics, dev: number, cache = siteCache(), bottleneck?: Bottleneck): Plan[] {
  const plans: (Plan | null)[] = [];
  const power = powerBudget(m);
  const buildPlan = (s: CityState, line: LineId, dev: number) => buildPlanAt(s, line, dev, cache, power);
  const pop = s.population;
  switch (need) {
    case "shortage": {
      // 電力を先に見る（GB-01）。電力を使っていて余力が少ないか、電力がないために建物が進化できないなら発電所を増やす
      // （技術Lvが上がったら、電力を使う段階へ進化できるように先に発電所を建てる）
      const reserve = Math.max(POWER_RESERVE_MIN, POWER_RESERVE_RATE * m.powerDemand);
      const probe = powerBudget(m);
      evolvePlans(s, EVOLVE_ORDER, dev, probe);
      if ((m.powerDemand > 0 && m.powerSupply - m.powerDemand < reserve) || probe.blocked) plans.push(...powerPlans(s, dev, cache, power));
      const foodLow = m.production.food < m.foodUse * 1.05 && s.stock.food < m.foodUse * 24;
      if (foodLow) plans.push(...evolvePlans(s, ["farm"], dev, power), buildPlan(s, "farm", dev), ...upgradePlans(s, ["farm"], dev, power));
      // 資材（GB-02）：生産がない・次の区画の開拓に要る分を MATERIAL_TARGET_HOURS で貯められない・
      // 資材が開発の制約になっている（bottleneck。都市資金は余っているのに、先頭の計画がその資材だけ足りない）なら、加工所を増やす
      const next = plotCost(s);
      const building = (line: LineId) => s.jobs.some((j) => j.kind === "build" && j.line === line);
      const short = (k: "wood" | "stone", floor: number, line: LineId) =>
        m.production[k] < floor || m.production[k] * MATERIAL_TARGET_HOURS < next[k] - s.stock[k] || (!!bottleneck?.[k] && !building(line));
      if (short("wood", 0.5, "lumber")) plans.push(buildPlan(s, "lumber", dev));
      if (highestUnlockedTier("quarry", s.techLevel, dev) >= 0 && short("stone", 0.3, "quarry")) plans.push(buildPlan(s, "quarry", dev));
      break;
    }
    case "jobs": {
      if (m.labor <= m.jobSlots + 0.5) break;
      // 資材が余っていれば、資材を作る工業より商業・オフィスで雇う（工場の乱立と資材のあふれを防ぐ。GB-09）
      const reserve = materialReserve(s);
      const surplus = s.stock.wood > reserve.wood && s.stock.stone > reserve.stone;
      const commerceFirst = s.policy.preset === "commerce" || m.commerceCap < pop;
      const order: LineId[] = surplus
        ? ["office", "commerce", "factory", "quarry", "lumber", "farm"]
        : commerceFirst
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
      if (vacancy >= HOUSING_VACANCY_TARGET || !jobsForHousing(m)) break;
      plans.push(buildPlan(s, "housing", dev), ...evolvePlans(s, ["housing"], dev, power), ...upgradePlans(s, ["housing"], dev, power));
      break;
    }
    case "logistics": {
      if (m.logistics >= LOGISTICS_TARGET) break;
      // 道路 → 道路の進化 → 鉄道駅・物流センター（足りなければ何棟でも）とその Lvアップ
      plans.push(buildPlan(s, "road", dev), ...evolvePlans(s, ["road"], dev, power), buildPlan(s, "rail", dev), buildPlan(s, "logistics", dev));
      plans.push(...upgradePlans(s, ["rail", "logistics"], dev, power));
      break;
    }
    case "efficiency": {
      // 仕事が足りないうちは住宅を進化させない（住民ばかり増えて失業が増える。GB-09）
      plans.push(...evolvePlans(s, jobsForHousing(m) ? EVOLVE_ORDER : EVOLVE_ORDER.filter((l) => l !== "housing"), dev, power));
      plans.push(...upgradePlans(s, PRODUCERS, dev, power).slice(0, 3));
      break;
    }
    case "industry": {
      // 働き手が足りないうちは新しい産業を開かない（建てても動かず、住宅に資金が回らなくなる。GB-03）
      if (m.labor < m.jobSlots * 0.9) break;
      for (const line of NEW_INDUSTRY) if (countLine(s, line) === 0) plans.push(buildPlan(s, line, dev));
      break;
    }
    case "beautify": {
      if (pop > m.publicCap) plans.push(buildPlan(s, "school", dev), buildPlan(s, "clinic", dev), buildPlan(s, "culture", dev));
      plans.push(...upgradePlans(s, jobsForHousing(m) ? ["housing", "school", "culture", "clinic"] : ["school", "culture", "clinic"], dev, power).slice(0, 2));
      break;
    }
  }
  // 電力が足りないために進められない計画があれば、電力の要らない計画のあとに発電所を増やす計画も入れる
  if (power.blocked && need !== "shortage") plans.push(...powerPlans(s, dev, cache, { room: Infinity, blocked: false }));
  return plans.filter((p): p is Plan => !!p);
}

/** 電力を増やす計画：発電所の新築（置き場がなければ工業地区の開拓）→ 進化 → Lvアップ。解放前なら空 */
function powerPlans(s: CityState, dev: number, cache: SiteCache, power: PowerBudget): (Plan | null)[] {
  if (highestUnlockedTier("power", s.techLevel, dev) < 0) return [];
  return [buildPlanAt(s, "power", dev, cache, power), ...evolvePlans(s, ["power"], dev, power), ...upgradePlans(s, ["power"], dev, power)];
}

// ---- 計画列と必要資源（docs/needs-based-exchange.md §4） ----

/** 計画列の具体的な計画：方針の優先順に全項目の候補を並べ、同じ建物の重複を除く */
function concretePlans(s: CityState): Plan[] {
  const m = plannedMetrics(s);
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
  return { plans: concretePlans(s).map(q), expansion: q({ kind: "build", line: x.line, tier: x.tier, level: 1, cost: x.cost }) };
}

export interface CityNeeds {
  /** 必要資源（木材・石材・都市資金は計画列の不足分、食料は24時間分の不足分） */
  needs: Gains;
  /** おまかせ交換の振り分けに使う計画列と在庫（食料の不足 → 計画列の先頭から順に満たす。exchange.ts fillNeeds） */
  target: NeedsTarget;
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
    target: { food, queue, stock: { wood: s.stock.wood, stone: s.stock.stone, treasury: s.treasury } },
    next: { kind: p.kind, line: p.line, tier: p.tier, level: p.level, name: p.name, expansion },
    queue,
  };
}

/** 自動の進化・Lvアップの工事の数（「生産効率の改善」の同時の工事の上限に使う） */
const efficiencyJobs = (s: CityState) => s.jobs.filter((j) => j.auto && (j.kind === "upgrade" || j.kind === "evolve")).length;

/**
 * 自動開発のジョブを開始する。1ティックに、方針の優先順で、払える限り何件でも始める。
 * 足りないものは工事中の分も終わったものとして判断する（plannedMetrics）。m は待つ時間の見積もりに使う今の指標。
 * speed（債券倍率）で工事の時間が短くなる。
 *
 * 「生産効率の改善」は候補がいつもあるので、同時の工事が AUTO_EFFICIENCY_JOBS 件に達したら下位の必要事項へ進む。
 * 下位がどれも資金を待っていなければ、最後に上限なしで「生産効率の改善」を進める（GB-03）。
 */
export function autoDevelop(s: CityState, m: Metrics, now: number, speed = 1): void {
  const dev = m.devLevel;
  let cache = siteCache();
  let pm = plannedMetrics(s);
  const found = materialBottleneck(s, pm);
  // 余った都市資金で足りない資材を買えたら、資材は制約ではなくなる
  const bottleneck = found && !buyMaterials(s, pm, found) ? found : undefined;
  /** 上位の計画のために取り置いた資材・都市資金（下位の計画はこれを除いた残りで払う） */
  const held: Cost = { wood: 0, stone: 0, treasury: 0 };
  const plus = (a: Cost, b: Cost): Cost => ({ wood: a.wood + b.wood, stone: a.stone + b.stone, treasury: a.treasury + b.treasury });
  /** "wait"：払えるまで貯める（下位には回さない） */
  const run = (need: NeedKey, limited: boolean): "wait" | "done" => {
    let saving = false;
    // 始めたジョブの分だけ候補が変わるので、何も始められなくなるまで候補を出し直す
    for (let started = true; started; ) {
      started = false;
      if (limited && need === "efficiency" && efficiencyJobs(s) >= AUTO_EFFICIENCY_JOBS) return "done";
      for (const plan of plansFor(need, s, pm, dev, cache, bottleneck)) {
        const total = plus(held, plan.cost);
        if (canAfford(s, total, true)) {
          // 景観改善は余剰資金があるときだけ
          if (need === "beautify" && s.treasury - total.treasury < 500) return "wait";
          startJob(s, plan, now, true, { speed });
          // 盤面と完成後の指標が変わったので、場所と指標は出し直す
          cache = siteCache();
          pm = plannedMetrics(s);
          started = true;
          break;
        }
        if (need === "beautify") continue;
        const wait = waitHours(s, m, total);
        // 近いうちに払えるなら下位の項目に資金を流さずに貯める
        if (wait <= AUTO_MAX_WAIT_HOURS) return "wait";
        // 少し先なら、この必要事項の最初の1件のコストを取り置いて、残りだけを下位に回す
        // （開拓は後半ほど高くなり、取り置くとほかの開発が止まるので取り置かない）
        if (!saving && plan.kind !== "expand" && wait <= AUTO_SAVE_HOURS) {
          saving = true;
          Object.assign(held, total);
        }
      }
    }
    return "done";
  };
  for (const need of developOrder(s.policy.priorities)) if (run(need, true) === "wait") return;
  run("efficiency", false);
}

/** 住宅・雇用・不足・物流（街が回るための必要事項） */
const BASIC_NEEDS: NeedKey[] = ["shortage", "jobs", "housing", "logistics"];

/**
 * 自動開発で検討する順。方針の優先順のまま、ただし「生産効率の改善」は街が回るための必要事項より先にはしない
 * （安い進化・Lvアップに資金が流れ続けて、住宅などが建たなくなるのを防ぐ。GB-03）
 */
export function developOrder(priorities: NeedKey[]): NeedKey[] {
  const i = priorities.indexOf("efficiency");
  const lastBasic = Math.max(...BASIC_NEEDS.map((n) => priorities.indexOf(n)));
  if (i < 0 || i > lastBasic) return priorities;
  const rest: NeedKey[] = priorities.filter((n) => n !== "efficiency");
  rest.splice(rest.indexOf(priorities[lastBasic]) + 1, 0, "efficiency");
  return rest;
}

/**
 * ジョブを始める。資材と都市資金（treasury。省略するとコストの全額）を払う。
 * 手動は都市資金の足りない分を銀貨で払うので、払った都市資金を渡す（actions.ts manualPayment）
 */
export function startJob(s: CityState, plan: Plan, now: number, auto: boolean, o: { treasury?: number; speed?: number } = {}): Job {
  s.stock.wood -= plan.cost.wood;
  s.stock.stone -= plan.cost.stone;
  s.treasury -= o.treasury ?? plan.cost.treasury;
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
    finishAt: now + Math.round((plan.minutes * MINUTE) / Math.max(1, o.speed ?? 1)),
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

