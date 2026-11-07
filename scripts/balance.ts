// バランス確認（docs/savings-driven-growth.md の To-Be）：街は貯金だけで計画列を消化して発展する。
// 今のエンジンの街（建物・配置・計画の候補・人口）を使い、お金の流れ・確定・利息・開拓期ボーナス・悪い出来事をここで組み立てる。
//
// 実行: npx tsx scripts/balance.ts                  標準の貯め方で1回分の推移
//       MODE=compare npx tsx scripts/balance.ts     貯め方・記録の有無ごとに節目の日を比べる（§12 の表）
//       MODE=kappa npx tsx scripts/balance.ts       値段の係数 κ（PRC-01）ごとに、節目での街の大きさを比べる
// 条件（環境変数）:
//   M=100000      月間自由予算（円）
//   GOAL=150000   貯金目標額（円）。基準額 ＝ min(M, GOAL)（PRC-06）
//   RATE=0.2      毎月の貯金（M に対する割合）
//   INITIAL=0.05  初日の入金（M に対する割合）
//   LAG=0         確定の遅れ（日）。0＝毎日記録する、7＝記録しない（7日後か収入期間の締めで自動確定。REC-01）
//   KAPPA=0.0002  カタログの相対コスト1あたりの値段（基準額に対する割合。PRC-01）
//   INTEREST=0.003  債券の利息（1日あたり。RSV-02）
//   TECH7=2.0     技術Lv7 の閾値（基準額の倍数。Q5・Q8）
//   EVENTS=1      悪い出来事を起こすか（EVT。停電は電力の計算を変える必要があるので、ここでは起こさない）
//   MOVE_IN=0.25  住宅の空きのうち1時間に移り住む割合（GRW-09）。0 なら今のエンジンの人口の伸び
//   ORDER=shortage,industry,jobs,housing,logistics,efficiency,beautify  計画の優先順（GRW-07）
//   DAYS=180  SEED=1  PICK=1,2,3,7,14,21,30,45,60,90,120,150,180（表示する日）
//   KAPPAS=0.0001,0.0002,0.0003,0.0005（MODE=kappa で比べる κ）
import { createCity } from "../src/game/city/init";
import { computeMetrics, type Metrics } from "../src/game/city/economy";
import { siteCache, type SiteCache } from "../src/game/city/layout";
import { alignTick, applyTechLevel, finishJob, newId, nextPlotIndex, plannedMetrics, plansFor, type Plan } from "../src/game/city/sim";
import { tierDef, type Cost } from "../src/game/catalog";
import {
  DAY,
  DEV_THRESHOLDS,
  GOLD_RESOURCE_VALUE,
  HAPPINESS_EASE_HOUR,
  HOUR,
  MINUTE,
  SILVER_MINE_EXCHANGE_BONUS,
  SILVER_MINE_LEVEL_THRESHOLDS,
  TICK_MS,
} from "../src/game/config";
import { devLevel, levelFrom } from "../src/game/levels";
import type { CityEvent, CityState, Job, NeedKey } from "../src/game/types";

// ---- To-Be の値（docs/savings-driven-growth.md） ----

/** PRC-02：発展Lvの閾値（完成した計画の累計額。基準額の倍数） */
const DEV_AT = [0, 0.03, 0.12, 0.3, 0.7, 1.5];
/** PRC-03：技術Lvの閾値（貯金の最高到達額。基準額の倍数）。Lv7 は TECH7 */
const TECH_AT = [0, 0.05, 0.15, 0.3, 0.6, 1.0];
/** 発展Lv6 を超えた建設 1 基準額あたりの発展pt（区画の上限が増える。layout.ts plotLimit） */
const DEV_POINTS_AFTER_TOP = 1000;
/** GRW-03：同時に進める工事（発展Lv別） */
const CONCURRENCY = [3, 4, 6, 8, 12, 16];
/** GRW-05：木材加工所・石材加工所・工場1棟あたりの割引と上限 */
const DISCOUNT_PER = 0.02;
const DISCOUNT_MAX = 0.4;
/** PRC-04：区画の開拓費の伸び */
const PLOT_GROWTH = 1.1;
/** GRW-07：新産業を生産効率の前にする */
const ORDER: NeedKey[] = (process.env.ORDER ?? "shortage,industry,jobs,housing,logistics,efficiency,beautify").split(",") as NeedKey[];
/** RSV-01：債券の上限（M の倍数） */
const BOND_CAP = 3;
/** RSV-03：備えLv1〜4 の債券残高（M の倍数） */
const RESERVE_AT = [0.5, 1, 2, 3];
/** ERL-01・02：開拓期ボーナスと、増える分の上限（基準額の倍数） */
const early = (day: number) => (day <= 7 ? 2 : day <= 14 ? 1.5 : 1);
const EARLY_CAP = 0.3;
/** REC-02・EVT-05：記録1回の銀貨、修繕の銀貨、自動で再開するまで */
const RECORD_SILVER = 50;
const REPAIR_SILVER = 100;
const AUTO_REOPEN_MS = 72 * HOUR;
/** EVT-01：1日あたりの発生確率（平均 約8日に1回）と、起きない最初の日数 */
const EVENT_P = 0.12;
const EVENT_FROM_DAY = 4;
/** GRW-09：住宅の空きのうち1時間に埋まる割合（人口は時間ではなく住宅で決まる） */
const MOVE_IN_HOUR = Number(process.env.MOVE_IN ?? 0.25);
/** 収入期間（簡略化して30日ごと） */
const PERIOD_MS = 30 * DAY;

type EventKind = "typhoon" | "crop" | "fire" | "surge";
const EVENT_LABELS: Record<EventKind, string> = { typhoon: "台風", crop: "不作", fire: "火事", surge: "資材の値上がり" };

interface Params {
  M: number;
  goal: number;
  rate: number;
  initial: number;
  lag: number;
  kappa: number;
  interest: number;
  tech7: number;
  events: boolean;
  days: number;
  seed: number;
}

interface Pending {
  at: number;
  minedAt: number;
  amount: number;
}

interface World {
  p: Params;
  base: number;
  t0: number;
  city: CityState;
  /** 建設資金（円） */
  fund: number;
  bond: number;
  /** 確定した貯金の累計（円） */
  savings: number;
  /** 完成した計画の累計額（円） */
  completed: number;
  earlyTotal: number;
  interestTotal: number;
  recordTotal: number;
  silver: number;
  records: number;
  pending: Pending[];
  jobPrice: Map<string, number>;
  reopenAt: Map<string, number>;
  pauseUntil: number;
  crop: { until: number; mag: number };
  surge: { until: number; mag: number };
  eventLog: string[];
  eventStats: Record<EventKind, { count: number; prevented: number }>;
  devDay: Record<number, number>;
  techDay: Record<number, number>;
  goalDay: number | null;
  goalDev: number | null;
  /** 建設資金が足りずに待っている計画（FX-03・REC-04 の「あと◯円で◯◯」） */
  waiting: { name: string; price: number } | null;
}

function params(over: Partial<Params> = {}): Params {
  const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
  return {
    M: env("M", 100_000),
    goal: env("GOAL", 150_000),
    rate: env("RATE", 0.2),
    initial: env("INITIAL", 0.05),
    lag: env("LAG", 0),
    kappa: env("KAPPA", 0.0002),
    interest: env("INTEREST", 0.003),
    tech7: env("TECH7", 2.0),
    events: env("EVENTS", 1) !== 0,
    days: env("DAYS", 180),
    seed: env("SEED", 1),
    ...over,
  };
}

/** 決定的な乱数 [0, 1)（EVT-02：シーズンと日付から決める） */
function rand(seed: number, ...keys: number[]): number {
  let h = 2166136261 ^ seed;
  for (const k of keys) h = Math.imul(h ^ Math.floor(k * 1000), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const relCost = (c: Cost) => c.wood / GOLD_RESOURCE_VALUE.wood + c.stone / GOLD_RESOURCE_VALUE.stone + c.treasury / GOLD_RESOURCE_VALUE.treasury;

function devPointsFor(v: number): number {
  for (let i = DEV_AT.length - 1; i >= 0; i--) {
    if (v < DEV_AT[i]) continue;
    if (i === DEV_AT.length - 1) return DEV_THRESHOLDS[i] + (v - DEV_AT[i]) * DEV_POINTS_AFTER_TOP;
    return DEV_THRESHOLDS[i] + ((v - DEV_AT[i]) / (DEV_AT[i + 1] - DEV_AT[i])) * (DEV_THRESHOLDS[i + 1] - DEV_THRESHOLDS[i]);
  }
  return 0;
}

const dayOf = (w: World, t: number) => Math.floor((t - 1 - w.t0) / DAY) + 1;
const reserveLevel = (w: World) => levelFrom([0, ...RESERVE_AT], w.bond / w.p.M) - 1;
const recordBonus = (w: World) => SILVER_MINE_EXCHANGE_BONUS[levelFrom(SILVER_MINE_LEVEL_THRESHOLDS, w.records) - 1] ?? 0;
const discount = (s: CityState) =>
  Math.min(DISCOUNT_MAX, DISCOUNT_PER * s.buildings.filter((b) => b.line === "lumber" || b.line === "quarry" || b.line === "factory").length);

/** PRC-01・PRC-04：計画の値段（円） */
function priceOf(w: World, plan: Plan, now: number): number {
  let rel: number;
  if (plan.kind === "expand") {
    const n = nextPlotIndex(w.city);
    const k = PLOT_GROWTH ** n;
    rel = relCost({ wood: 60 * k, stone: n >= 2 ? 20 * k : 0, treasury: 150 * k });
  } else rel = relCost(plan.cost);
  const surge = w.surge.until > now ? 1 + w.surge.mag : 1;
  return rel * w.p.kappa * w.base * (1 - discount(w.city)) * surge;
}

function newWorld(p: Params): World {
  const t0 = Date.UTC(2026, 9, 1);
  const w: World = {
    p,
    base: Math.min(p.M, p.goal),
    t0,
    city: createCity(t0),
    fund: 0,
    bond: 0,
    savings: 0,
    completed: 0,
    earlyTotal: 0,
    interestTotal: 0,
    recordTotal: 0,
    silver: 0,
    records: 0,
    pending: [],
    jobPrice: new Map(),
    reopenAt: new Map(),
    pauseUntil: 0,
    crop: { until: 0, mag: 0 },
    surge: { until: 0, mag: 0 },
    eventLog: [],
    eventStats: { typhoon: { count: 0, prevented: 0 }, crop: { count: 0, prevented: 0 }, fire: { count: 0, prevented: 0 }, surge: { count: 0, prevented: 0 } },
    devDay: { 1: 0 },
    techDay: { 1: 0 },
    goalDay: null,
    goalDev: null,
    waiting: null,
  };
  if (p.initial > 0) addSavings(w, t0, p.initial * p.M);
  return w;
}

/** 貯金の発生。確定は記録しだい（REC-01：遅れは lag 日か、収入期間の締めの早いほう） */
function addSavings(w: World, minedAt: number, amount: number) {
  const periodEnd = w.t0 + (Math.floor((minedAt - w.t0) / PERIOD_MS) + 1) * PERIOD_MS;
  const at = w.p.lag <= 0 ? minedAt : Math.min(minedAt + w.p.lag * DAY, periodEnd);
  w.pending.push({ at, minedAt, amount });
}

/** RSV-01・ERL-01・REC-03：確定した貯金は債券（上限まで）と建設資金に入る */
function confirm(w: World, now: number, events: CityEvent[]) {
  if (!w.pending.some((x) => x.at <= now)) return;
  const rest: Pending[] = [];
  for (const x of w.pending) {
    if (x.at > now) {
      rest.push(x);
      continue;
    }
    w.savings += x.amount;
    w.bond = Math.min(BOND_CAP * w.p.M, w.bond + x.amount);
    const extra = Math.min(x.amount * (early(dayOf(w, x.minedAt + 1)) - 1), Math.max(0, EARLY_CAP * w.base - w.earlyTotal));
    const rec = x.amount * recordBonus(w);
    w.earlyTotal += extra;
    w.recordTotal += rec;
    w.fund += x.amount + extra + rec;
  }
  w.pending = rest;
  applyTechLevel(w.city, levelFrom([...TECH_AT, w.p.tech7], w.savings / w.base), now, events);
}

/** EVT：悪い出来事。備えLv（RSV-03）と幸福度（EVT-07）で被害が変わる */
function maybeEvent(w: World, now: number) {
  const s = w.city;
  const day = dayOf(w, now);
  const slot = Math.round(((now - w.t0 - (day - 1) * DAY) / TICK_MS) % (DAY / TICK_MS));
  if (day < EVENT_FROM_DAY || slot !== Math.floor(rand(w.p.seed, day, 1) * (DAY / TICK_MS))) return;
  if (rand(w.p.seed, day, 2) >= EVENT_P) return;
  const dev = devLevel(s.devPoints);
  if (dev < 2) return;
  const kinds: EventKind[] = dev >= 3 ? ["typhoon", "crop", "fire", "surge"] : ["typhoon", "crop"];
  const kind = kinds[Math.floor(rand(w.p.seed, day, 3) * kinds.length)];
  const lv = reserveLevel(w);
  const mood = s.happiness >= 70 ? 0.75 : s.happiness < 40 ? 1.25 : 1;
  const f = mood * (lv >= 1 ? 0.5 : 1);
  const stat = w.eventStats[kind];
  stat.count++;
  const prevented = lv >= 4 || (lv >= 2 && (kind === "typhoon" || kind === "surge"));
  const head = `d${day} ${EVENT_LABELS[kind]}（備えLv${lv}）`;
  if (prevented) {
    stat.prevented++;
    w.eventLog.push(`${head}：備えのおかげで被害なし`);
    return;
  }
  if (kind === "typhoon") {
    const ms = Math.round((12 * HOUR * f) / TICK_MS) * TICK_MS;
    for (const j of s.jobs) j.finishAt += ms;
    w.pauseUntil = Math.max(w.pauseUntil, now + ms);
    w.eventLog.push(`${head}：工事が ${(ms / HOUR).toFixed(0)} 時間止まった`);
  } else if (kind === "crop") {
    w.crop = { until: now + 48 * HOUR * f, mag: 0.5 * f };
    w.eventLog.push(`${head}：食料生産 −${Math.round(50 * f)}%（${(48 * f).toFixed(0)}時間）`);
  } else if (kind === "surge") {
    w.surge = { until: now + 24 * HOUR * f, mag: 0.3 * f };
    w.eventLog.push(`${head}：値段 +${Math.round(30 * f)}%（${(24 * f).toFixed(0)}時間）`);
  } else {
    const candidates = s.buildings.filter((b) => b.line && b.line !== "road" && !b.closed);
    const n = Math.min(3, 1 + Math.floor(s.population / 1000), candidates.length);
    const notes: string[] = [];
    for (let i = 0; i < n; i++) {
      const b = candidates.splice(Math.floor(rand(w.p.seed, day, 10 + i) * candidates.length), 1)[0];
      if (lv >= 3) {
        // 修繕費を建設資金（利息）から払う
        w.fund -= Math.min(w.fund, relCost(tierDef(b.line!, b.tier).cost) * w.p.kappa * w.base * 0.3);
        notes.push("自動で修繕");
      } else if (w.silver >= REPAIR_SILVER) {
        w.silver -= REPAIR_SILVER;
        notes.push("銀貨で修繕");
      } else {
        b.closed = true;
        w.reopenAt.set(b.id, now + AUTO_REOPEN_MS);
        notes.push("休業");
      }
    }
    w.eventLog.push(`${head}：${n}棟（${notes.join("・")}）`);
  }
}

function completeJobs(w: World, end: number, events: CityEvent[]) {
  const due = w.city.jobs.filter((j) => j.finishAt <= end).sort((a, b) => a.finishAt - b.finishAt || a.id.localeCompare(b.id));
  for (const job of due) {
    finishJob(w.city, job, Math.max(job.finishAt, end - TICK_MS), events);
    w.completed += w.jobPrice.get(job.id) ?? 0;
    w.jobPrice.delete(job.id);
  }
  for (const [id, at] of w.reopenAt) {
    if (at > end) continue;
    const b = w.city.buildings.find((o) => o.id === id);
    if (b) b.closed = false;
    w.reopenAt.delete(id);
  }
}

/** GRW-08：人口と幸福度（建物も人口も減らさない） */
function residents(w: World, end: number) {
  const s = w.city;
  const m = computeMetrics(s);
  const dtH = TICK_MS / HOUR;
  const food = m.production.food * (w.crop.until > end ? 1 - w.crop.mag : 1);
  const available = s.stock.food + food * dtH;
  const need = m.foodUse * dtH;
  const foodRatio = need > 0 ? Math.min(1, available / need) : 1;
  s.stock.food = Math.max(0, available - need);
  s.happiness += (m.happinessTarget - s.happiness) * Math.min(1, HAPPINESS_EASE_HOUR * dtH);
  if (s.population < m.housingCap) {
    const grow = MOVE_IN_HOUR > 0 ? (m.housingCap - s.population) * Math.min(1, MOVE_IN_HOUR * dtH) : m.growth * dtH;
    s.population = Math.min(m.housingCap, s.population + grow * foodRatio);
  }
  s.peakPopulation = Math.max(s.peakPopulation, s.population);
}

function startJob(w: World, plan: Plan, price: number, now: number) {
  const s = w.city;
  w.fund -= price;
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
  };
  s.jobs.push(job);
  w.jobPrice.set(job.id, price);
}

/**
 * 必要事項ごとの候補。GRW-07 の不足解消はエンジンにまだ入っていないので、ここで並べ替える。
 * - 電力を食料より先にし、電力が足りない間は電力を使う段階への農場の進化をしない
 * - 働き手が足りない間は農場を増やさず（新築・Lvアップ）、住宅を先にする（農場を増やすほど働き手が足りなくなるため）
 */
function candidates(need: NeedKey, s: CityState, pm: Metrics, dev: number, cache: SiteCache): Plan[] {
  const plans = plansFor(need, s, pm, dev, cache);
  if (need !== "shortage") return plans;
  const powerShort = pm.powerDemand > pm.powerSupply + 1e-9;
  const laborShort = pm.laborRatio < 0.95;
  const usesPower = (p: Plan) => p.kind === "evolve" && p.line === "farm" && !!tierDef(p.line, p.tier).power;
  const addsJobs = (p: Plan) => p.line === "farm" && (p.kind === "build" || p.kind === "upgrade");
  const rest = plans.filter((p) => p.line !== "power" && !(powerShort && usesPower(p)) && !(laborShort && addsJobs(p)));
  const housing = laborShort && plans.some((p) => p.line === "farm") ? plansFor("housing", s, pm, dev, cache) : [];
  return [...plans.filter((p) => p.line === "power"), ...housing, ...rest];
}

/** GRW-03：計画列を先頭から消化する。払えない計画があれば、そこで止めて貯める */
function develop(w: World, now: number) {
  const s = w.city;
  if (w.pauseUntil > now) return;
  const dev = devLevel(s.devPoints);
  const limit = CONCURRENCY[dev - 1];
  let cache = siteCache();
  let pm = plannedMetrics(s);
  w.waiting = null;
  for (const need of ORDER) {
    for (let started = true; started; ) {
      started = false;
      for (const plan of candidates(need, s, pm, dev, cache)) {
        if (s.jobs.length >= limit) return;
        const price = priceOf(w, plan, now);
        if (w.fund < price) {
          w.waiting = { name: plan.kind === "expand" ? "区画の開拓" : `${tierDef(plan.line, plan.tier).name}${plan.kind === "upgrade" ? `のLv${plan.level}` : plan.kind === "evolve" ? "への進化" : ""}`, price };
          return;
        }
        startJob(w, plan, price, now);
        cache = siteCache();
        pm = plannedMetrics(s);
        started = true;
        break;
      }
    }
  }
}

/** 1ティック：貯金の発生と確定 → 利息 → 出来事 → 工事の完了 → 住民 → 発展Lv → 計画の消化 */
function step(w: World, end: number, events: CityEvent[]) {
  const s = w.city;
  const dayStart = (end - w.t0) % DAY === TICK_MS;
  if (dayStart && w.p.lag <= 0) {
    w.records++;
    w.silver += RECORD_SILVER;
  }
  addSavings(w, end, (w.p.rate * w.p.M * TICK_MS) / (30 * DAY));
  confirm(w, end, events);
  const interest = Math.max(0, w.bond) * w.p.interest * (TICK_MS / DAY);
  w.fund += interest;
  w.interestTotal += interest;
  if (w.p.events) maybeEvent(w, end);
  completeJobs(w, end, events);
  residents(w, end);
  s.devPoints = devPointsFor(w.completed / w.base);
  develop(w, end);
  s.simTime = end;

  const day = dayOf(w, end);
  const dev = devLevel(s.devPoints);
  for (let lv = 2; lv <= dev; lv++) w.devDay[lv] ??= day;
  for (let lv = 2; lv <= s.techLevel; lv++) w.techDay[lv] ??= day;
  if (w.goalDay === null && w.savings >= w.p.goal) {
    w.goalDay = day;
    w.goalDev = dev;
  }
}

interface Row {
  day: number;
  savings: number;
  bond: number;
  fund: number;
  built: number;
  dev: number;
  tech: number;
  pop: number;
  buildings: number;
  plots: number;
  jobs: number;
  happiness: number;
  housing: number;
  employment: number;
}

function snapshot(w: World, day: number): Row {
  const s = w.city;
  const m = computeMetrics(s);
  return {
    day,
    savings: w.savings,
    bond: w.bond,
    fund: w.fund,
    built: w.completed / w.base,
    dev: devLevel(s.devPoints),
    tech: s.techLevel,
    pop: s.population,
    buildings: s.buildings.filter((b) => b.line && b.line !== "road").length,
    plots: s.plots.length,
    jobs: s.jobs.length,
    happiness: s.happiness,
    housing: m.housingCap,
    employment: m.employment,
  };
}

function simulate(p: Params, onDay?: (w: World, day: number) => void): World {
  const w = newWorld(p);
  const events: CityEvent[] = [];
  for (let day = 1; day <= p.days; day++) {
    const until = alignTick(w.t0 + day * DAY);
    while (w.city.simTime < until) step(w, w.city.simTime + TICK_MS, events);
    onDay?.(w, day);
  }
  return w;
}

// ---- 表示 ----

const yen = (v: number) => `${Math.round(v).toLocaleString("ja-JP")}円`;
const days = (rec: Record<number, number>, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => (rec[from + i] === undefined ? "—" : `${rec[from + i]}日目`));

function describe(p: Params): string {
  const base = Math.min(p.M, p.goal);
  return [
    `M ${yen(p.M)}・目標 ${yen(p.goal)}・基準額 ${yen(base)}`,
    `毎月 M の ${Math.round(p.rate * 100)}%・初日 ${yen(p.initial * p.M)}`,
    p.lag <= 0 ? "毎日記録" : `記録しない（${p.lag}日後に確定）`,
    `κ ${p.kappa}・利息 ${(p.interest * 100).toFixed(1)}%/日・技術Lv7 ${p.tech7}基準額`,
    p.events ? `出来事あり（seed ${p.seed}）` : "出来事なし",
  ].join(" / ");
}

function runOne() {
  const p = params();
  const pick = new Set((process.env.PICK ?? "1,2,3,7,14,21,30,45,60,90,120,150,180").split(",").map(Number));
  console.log(describe(p));
  console.log("日目 | 貯金 | 債券 | 建設資金 | 完成/基準額 | 発展 | 技術 | 人口/住宅 | 雇用 | 建物 | 区画 | 工事 | 幸福度 | 貯めている計画");
  const w = simulate(p, (w, day) => {
    if (!pick.has(day)) return;
    const r = snapshot(w, day);
    console.log(
      [
        `d${r.day}`,
        yen(r.savings),
        yen(r.bond),
        yen(r.fund),
        r.built.toFixed(2),
        `Lv${r.dev}`,
        `Lv${r.tech}`,
        `${Math.round(r.pop)}/${Math.round(r.housing)}`,
        r.employment.toFixed(2),
        r.buildings,
        r.plots,
        r.jobs,
        Math.round(r.happiness),
        w.waiting ? `${w.waiting.name}（${yen(w.waiting.price)}）` : "—",
      ].join(" | "),
    );
  });
  console.log(`発展Lv2〜6：${days(w.devDay, 2, 6).join(" / ")}`);
  console.log(`技術Lv2〜7：${days(w.techDay, 2, 7).join(" / ")}`);
  console.log(w.goalDay === null ? "目標：未達" : `目標：${w.goalDay}日目（そのときの発展Lv${w.goalDev}）`);
  console.log(`建設資金の内訳：貯金 ${yen(w.savings)}・開拓期ボーナス ${yen(w.earlyTotal)}・記録Lv ${yen(w.recordTotal)}・利息 ${yen(w.interestTotal)}`);
  if (p.events) {
    const st = Object.entries(w.eventStats).map(([k, v]) => `${EVENT_LABELS[k as EventKind]} ${v.count}回（防いだ ${v.prevented}）`);
    console.log(`出来事：${st.join("・")}`);
    for (const line of w.eventLog) console.log(`  ${line}`);
  }
  const lines: Record<string, number> = {};
  for (const b of w.city.buildings) if (b.line && b.line !== "road") lines[b.line] = (lines[b.line] ?? 0) + 1;
  console.log("建物：", JSON.stringify(lines));
}

function compare() {
  const rows: [string, Partial<Params>][] = [
    ["控えめ：毎月0.1M", { rate: 0.1, initial: 0 }],
    ["標準：毎月0.2M＋初日0.05M", { rate: 0.2, initial: 0.05 }],
    ["標準・初日の入金なし", { rate: 0.2, initial: 0 }],
    ["標準・記録しない（7日遅れ）", { rate: 0.2, initial: 0.05, lag: 7 }],
    ["積極：毎月0.4M＋初日0.1M", { rate: 0.4, initial: 0.1 }],
  ];
  console.log(describe(params()));
  console.log("条件 | 発展Lv2 | Lv3 | Lv4 | Lv5 | Lv6 | 技術Lv3 | Lv4 | Lv6 | Lv7 | 目標の日（発展Lv） | 人口（最終日）");
  for (const [name, over] of rows) {
    const w = simulate(params(over));
    const goal = w.goalDay === null ? "未達" : `${w.goalDay}日目（Lv${w.goalDev}）`;
    const t = days(w.techDay, 2, 7);
    console.log([name, ...days(w.devDay, 2, 6), t[1], t[2], t[4], t[5], goal, Math.round(w.city.population)].join(" | "));
  }
}

function kappa() {
  const list = (process.env.KAPPAS ?? "0.0001,0.0002,0.0003,0.0005").split(",").map(Number);
  console.log(describe(params()));
  console.log("κ | 発展Lvに届いた日の 人口・建物・区画（上限） | 最終日の人口・建物・区画 | 最終日の建設資金の残り");
  for (const k of list) {
    const at: string[] = [];
    let last = 1;
    const w = simulate(params({ kappa: k }), (w, day) => {
      const dev = devLevel(w.city.devPoints);
      if (dev === last) return;
      last = dev;
      const r = snapshot(w, day);
      at.push(`Lv${dev} d${day}: ${Math.round(r.pop)}人・${r.buildings}棟・${r.plots}区画`);
    });
    const r = snapshot(w, w.p.days);
    console.log(`${k} | ${at.join(" / ")} | ${Math.round(r.pop)}人・${r.buildings}棟・${r.plots}区画 | ${yen(r.fund)}`);
  }
}

const mode = process.env.MODE ?? "run";
if (mode === "compare") compare();
else if (mode === "kappa") kappa();
else runOne();
