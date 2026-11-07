// バランス確認（docs/savings-driven-growth.md）：街は貯金だけで計画列を消化して発展する。
// 街の処理（計画の消化・値段・発展Lv・人口・悪い出来事）と、建設資金・開拓期ボーナス・債券の利息はエンジン（src/game）を使う。
// 貯金の流れは「毎月 M の RATE を毎日均等に使わずに残す」と簡単にし、確定（REC-01）・記録Lvボーナス（REC-03）・
// 火事の銀貨での修繕（EVT-05）だけをここで組み立てる（実際のゲームでは配当・購入の精算・記録から決まる）
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
//   EVENTS=1      悪い出来事の被害を受けるか（0 なら備えLv4 として扱い、すべて防ぐ）
//   DAYS=180  SEED=1（シーズンの開始日を1週間ずつずらし、悪い出来事の起き方を変える）  PICK=1,2,3,7,14,21,30,45,60,90,120,150,180（表示する日）
//   KAPPAS=0.0001,0.0002,0.0003,0.0005（MODE=kappa で比べる κ。ふだんは config.ts の FUND_PRICE_KAPPA）
import { bondCap } from "../src/game/bond";
import { computeMetrics } from "../src/game/city/economy";
import { createCity, seasonBase } from "../src/game/city/init";
import { alignTick, applyTechLevel, cityNeeds, pricing, tick } from "../src/game/city/sim";
import { DAY, FUND_PRICE_KAPPA, REPAIR_SILVER, SILVER_MINE_EXCHANGE_BONUS, SILVER_MINE_LEVEL_THRESHOLDS, TICK_MS } from "../src/game/config";
import { reopen } from "../src/game/city/disasters";
import { describeEvent } from "../src/game/describe";
import { creditFund, reserveLevel } from "../src/game/fund";
import { grantInterest } from "../src/game/idle";
import { devLevel, levelFrom, techLevel } from "../src/game/levels";
import type { CityEvent, CityState } from "../src/game/types";

/** REC-02：記録1回の銀貨 */
const RECORD_SILVER = 50;
/** 収入期間（簡略化して30日ごと） */
const PERIOD_MS = 30 * DAY;

interface Params {
  M: number;
  goal: number;
  rate: number;
  initial: number;
  lag: number;
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
  t0: number;
  city: CityState;
  bond: number;
  cap: number;
  /** 確定した貯金の累計（円） */
  savings: number;
  recordTotal: number;
  silver: number;
  records: number;
  pending: Pending[];
  /** 街のイベント（悪い出来事を含む） */
  events: CityEvent[];
  devDay: Record<number, number>;
  techDay: Record<number, number>;
  goalDay: number | null;
  goalDev: number | null;
}

function params(over: Partial<Params> = {}): Params {
  const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
  return {
    M: env("M", 100_000),
    goal: env("GOAL", 150_000),
    rate: env("RATE", 0.2),
    initial: env("INITIAL", 0.05),
    lag: env("LAG", 0),
    events: env("EVENTS", 1) !== 0,
    days: env("DAYS", 180),
    seed: env("SEED", 1),
    ...over,
  };
}

const dayOf = (w: World, t: number) => Math.floor((t - 1 - w.t0) / DAY) + 1;
const recordBonus = (w: World) => SILVER_MINE_EXCHANGE_BONUS[levelFrom(SILVER_MINE_LEVEL_THRESHOLDS, w.records) - 1] ?? 0;

function newWorld(p: Params): World {
  // 悪い出来事はシーズンの開始時刻から決まるので、SEED ごとに開始日を1週間ずつずらす
  const t0 = Date.UTC(2026, 9, 1) + (p.seed - 1) * 7 * DAY;
  const w: World = {
    p,
    t0,
    city: createCity(t0, seasonBase(p.M, p.goal)),
    bond: 0,
    cap: bondCap(p.M),
    savings: 0,
    recordTotal: 0,
    silver: 0,
    records: 0,
    pending: [],
    events: [],
    devDay: { 1: 0 },
    techDay: { 1: 0 },
    goalDay: null,
    goalDev: null,
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

/** RSV-01・ERL-01・REC-03：確定した貯金は債券（上限まで）と建設資金に入る。開拓期ボーナスは採掘した日で判定する */
function confirm(w: World, now: number, events: CityEvent[]) {
  if (!w.pending.some((x) => x.at <= now)) return;
  const rest: Pending[] = [];
  for (const x of w.pending) {
    if (x.at > now) {
      rest.push(x);
      continue;
    }
    w.savings += x.amount;
    w.bond = Math.min(w.cap, w.bond + x.amount);
    creditFund(w.city, x.amount, x.minedAt);
    const rec = x.amount * recordBonus(w);
    w.city.treasury += rec;
    w.recordTotal += rec;
  }
  w.pending = rest;
  applyTechLevel(w.city, Math.max(w.city.techLevel, techLevel(w.savings, w.city.base)), now, events);
}

/** EVT-05：火事で休業した建物は、銀貨があればすぐ修繕する（記録する人の想定） */
function repairWithSilver(w: World, from: number, end: number) {
  for (const e of w.events.slice(from)) {
    if (e.type !== "DISASTER" || e.payload.kind !== "fire" || e.payload.repaired) continue;
    for (const snap of (e.payload.buildings as { id: string }[] | undefined) ?? []) {
      const b = w.city.buildings.find((o) => o.id === snap.id);
      if (!b?.closed || w.silver < REPAIR_SILVER) continue;
      w.silver -= REPAIR_SILVER;
      reopen(w.city, b, end, w.events, "silver");
    }
  }
}

/** 1ティック：貯金の発生と確定 → 利息 → 街（エンジン。悪い出来事を含む）→ 銀貨での修繕 */
function step(w: World, end: number, events: CityEvent[]) {
  const s = w.city;
  if ((end - w.t0) % DAY === TICK_MS && w.p.lag <= 0) {
    w.records++;
    w.silver += RECORD_SILVER;
  }
  addSavings(w, end, (w.p.rate * w.p.M * TICK_MS) / (30 * DAY));
  confirm(w, end, events);
  grantInterest(s, w.bond, w.cap, end);
  s.reserveLevel = w.p.events ? reserveLevel(w.bond, w.p.M) : 4;
  const from = events.length;
  tick(s, end, events);
  repairWithSilver(w, from, end);

  const day = dayOf(w, end);
  const dev = devLevel(s.devPoints);
  for (let lv = 2; lv <= dev; lv++) w.devDay[lv] ??= day;
  for (let lv = 2; lv <= s.techLevel; lv++) w.techDay[lv] ??= day;
  if (w.goalDay === null && w.savings >= w.p.goal) {
    w.goalDay = day;
    w.goalDev = dev;
  }
}

function simulate(p: Params, onDay?: (w: World, day: number) => void): World {
  const w = newWorld(p);
  const events = w.events;
  for (let day = 1; day <= p.days; day++) {
    const until = alignTick(w.t0 + day * DAY);
    while (w.city.simTime < until) step(w, w.city.simTime + TICK_MS, events);
    onDay?.(w, day);
  }
  return w;
}

// ---- 表示 ----

interface Row {
  pop: number;
  housing: number;
  employment: number;
  buildings: number;
  plots: number;
}

function snapshot(w: World): Row {
  const s = w.city;
  const m = computeMetrics(s);
  return {
    pop: s.population,
    housing: m.housingCap,
    employment: m.employment,
    buildings: s.buildings.filter((b) => b.line && b.line !== "road").length,
    plots: s.plots.length,
  };
}

const yen = (v: number) => `${Math.round(v).toLocaleString("ja-JP")}円`;
const days = (rec: Record<number, number>, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => (rec[from + i] === undefined ? "—" : `${rec[from + i]}日目`));

function describe(p: Params): string {
  return [
    `M ${yen(p.M)}・目標 ${yen(p.goal)}・基準額 ${yen(seasonBase(p.M, p.goal))}`,
    `毎月 M の ${Math.round(p.rate * 100)}%・初日 ${yen(p.initial * p.M)}`,
    p.lag <= 0 ? "毎日記録" : `記録しない（${p.lag}日後に確定）`,
    `κ ${pricing.kappa}`,
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
    const s = w.city;
    const r = snapshot(w);
    const n = cityNeeds(s);
    const waiting = n.needs.treasury > 0 ? `${n.next.name}${n.next.kind === "upgrade" ? `のLv${n.next.level}` : ""}（あと${yen(n.needs.treasury)}）` : "—";
    console.log(
      [
        `d${day}`,
        yen(w.savings),
        yen(w.bond),
        yen(s.treasury),
        (s.completed / s.base).toFixed(2),
        `Lv${devLevel(s.devPoints)}`,
        `Lv${s.techLevel}`,
        `${Math.round(r.pop)}/${Math.round(r.housing)}`,
        r.employment.toFixed(2),
        r.buildings,
        r.plots,
        s.jobs.length,
        Math.round(s.happiness),
        waiting,
      ].join(" | "),
    );
  });
  const s = w.city;
  console.log(`発展Lv2〜6：${days(w.devDay, 2, 6).join(" / ")}`);
  console.log(`技術Lv2〜7：${days(w.techDay, 2, 7).join(" / ")}`);
  console.log(w.goalDay === null ? "目標：未達" : `目標：${w.goalDay}日目（そのときの発展Lv${w.goalDev}）`);
  console.log(`建設資金の内訳：貯金 ${yen(w.savings)}・開拓期ボーナス ${yen(s.earlyBonus)}・記録Lv ${yen(w.recordTotal)}・利息 ${yen(s.interestTotal ?? 0)}`);
  const disasters = w.events.filter((e) => e.type === "DISASTER");
  console.log(`出来事：${disasters.length}回（防いだ ${disasters.filter((e) => e.payload.prevented).length}回）`);
  for (const e of disasters) console.log(`  d${Math.floor((e.at - 1 - w.t0) / DAY) + 1} ${describeEvent(e)}`);
  const lines: Record<string, number> = {};
  for (const b of s.buildings) if (b.line && b.line !== "road") lines[b.line] = (lines[b.line] ?? 0) + 1;
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
  console.log("κ | 発展Lvに届いた日の 人口・建物・区画 | 最終日の人口・建物・区画 | 最終日の建設資金の残り");
  for (const k of list) {
    pricing.kappa = k;
    const at: string[] = [];
    let last = 1;
    const w = simulate(params(), (w, day) => {
      const dev = devLevel(w.city.devPoints);
      if (dev === last) return;
      last = dev;
      const r = snapshot(w);
      at.push(`Lv${dev} d${day}: ${Math.round(r.pop)}人・${r.buildings}棟・${r.plots}区画`);
    });
    const r = snapshot(w);
    console.log(`${k} | ${at.join(" / ")} | ${Math.round(r.pop)}人・${r.buildings}棟・${r.plots}区画 | ${yen(w.city.treasury)}`);
  }
  pricing.kappa = FUND_PRICE_KAPPA;
}

const mode = process.env.MODE ?? "run";
if (mode === "compare") compare();
else if (mode === "kappa") kappa();
else runOne();
