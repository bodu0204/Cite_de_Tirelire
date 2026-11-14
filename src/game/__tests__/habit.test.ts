// 貯め方で街の形が変わる（docs/saving-habit-balance.md）：こまめさ → 広さ、貯金額 → 技術、1日に数件の工事
import { describe, expect, it } from "vitest";
import { evolveCost, tierDef } from "../catalog";
import { computeMetrics } from "../city/economy";
import { createCity } from "../city/init";
import { basePlotLimit, findSite, habitPlots, nextHabitPlotIn, plotLimit, savingDaysOf, siteCache } from "../city/layout";
import { applyTechLevel, planPrice, plotCost, priceOf, relCost, renewing, simulate } from "../city/sim";
import { DAY, DEV_THRESHOLDS, FUND_PRICE_ALPHA, FUND_PRICE_KAPPA, HOUR, PLOT_COST_GROWTH, RENEWAL_DAYS, TECH_ERAS } from "../config";
import { countAutoDays, countRecordDay } from "../habit";
import type { CityEvent, CityState } from "../types";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const BASE = 100_000;

function run(s: CityState, ms: number) {
  const events: CityEvent[] = [];
  simulate(s, s.simTime + ms, events);
  return events;
}

describe("AT-078 貯金日（HAB-01）", () => {
  it("記録で貯金を確定した暦日ごとに1つ増え、同じ日に何回記録しても1つ", () => {
    const s = createCity(T0, BASE);
    const events: CityEvent[] = [];
    expect(countRecordDay(s, "2026-10-01", 100, T0, events)).toBe(true);
    expect(countRecordDay(s, "2026-10-01", 100, T0 + HOUR, events)).toBe(false);
    expect(countRecordDay(s, "2026-10-02", 100, T0 + DAY, events)).toBe(true);
    expect(savingDaysOf(s)).toBe(2);
  });

  it("債券がマイナス（使い過ぎ）の日は数えない。支出の記録でも、債券がマイナスでなければ数える", () => {
    const s = createCity(T0, BASE);
    expect(countRecordDay(s, "2026-10-01", -1, T0, [])).toBe(false);
    expect(countRecordDay(s, "2026-10-01", 0, T0 + HOUR, [])).toBe(true);
    expect(savingDaysOf(s)).toBe(1);
  });

  it("自動の確定は7日分で1日。累計なので途切れても減らない", () => {
    const s = createCity(T0, BASE);
    for (let d = 0; d < 6; d++) countAutoDays(s, 1, 100, T0 + d * DAY, []);
    expect(savingDaysOf(s)).toBe(0);
    countAutoDays(s, 1, 100, T0 + 6 * DAY, []);
    expect(savingDaysOf(s)).toBe(1);
    countAutoDays(s, 3, -5, T0 + 7 * DAY, []);
    expect(savingDaysOf(s)).toBe(1);
  });

  it("こまめボーナスの区画が増えたら知らせる（HAB-04）", () => {
    const s = createCity(T0, BASE);
    const events: CityEvent[] = [];
    countRecordDay(s, "2026-10-01", 0, T0, events);
    expect(events.map((e) => e.type)).toEqual(["HABIT_PLOT"]);
    expect(events[0].payload).toMatchObject({ plots: 1, added: 1, savingDays: 1 });
  });
});

describe("AT-079 こまめボーナス（HAB-02）", () => {
  it("区画の上限は、発展Lvの上限 ＋ 貯金日の最初の7日は1日1区画、そのあとは4日ごとに1区画", () => {
    expect([0, 1, 6, 7, 8, 10, 11, 15, 180].map(habitPlots)).toEqual([0, 1, 6, 7, 7, 7, 8, 9, 50]);
    expect(plotLimit(0, 0)).toBe(basePlotLimit(0));
    expect(plotLimit(DEV_THRESHOLDS[3], 11)).toBe(28 + 8);
    // 次の区画まで：最初の7日は毎日、そのあとは4日ごと
    expect([0, 6, 7, 8, 10, 11].map((d) => nextHabitPlotIn(d))).toEqual([1, 1, 4, 3, 1, 4]);
  });

  it("毎日記録する街は、記録しない街より広くなる", () => {
    const daily = createCity(T0, BASE);
    const none = createCity(T0, BASE);
    // 土地が先に足りなくなるよう、建設資金を多めに入れる
    daily.treasury = none.treasury = 100_000;
    applyTechLevel(daily, 3, T0, []);
    applyTechLevel(none, 3, T0, []);
    for (let d = 1; d <= 10; d++) {
      countRecordDay(daily, `2026-10-${String(d).padStart(2, "0")}`, 0, daily.simTime, []);
      run(daily, DAY);
      run(none, DAY);
    }
    expect(daily.plots.length).toBeGreaterThan(none.plots.length);
    expect(daily.plots.length).toBeLessThanOrEqual(plotLimit(daily.devPoints, savingDaysOf(daily)));
  });
});

describe("AT-080 1日に数件の工事（PAC-01・PAC-03）", () => {
  it("値段は 相対コスト^α × 基準額 × κ（α 0.5・κ 0.00025）。高い段階ほど相対的に安い", () => {
    const s = createCity(T0, BASE);
    // 割引（木材加工所1棟 −2%。GRW-05）のない街で比べる
    s.buildings = s.buildings.filter((b) => b.line !== "lumber");
    const price = (line: "housing" | "future", tier: number) => priceOf(s, tierDef(line, tier).cost);
    expect(FUND_PRICE_ALPHA).toBe(0.5);
    expect(price("housing", 1)).toBe(Math.ceil(relCost(tierDef("housing", 1).cost) ** 0.5 * BASE * FUND_PRICE_KAPPA));
    expect(price("housing", 1)).toBe(112);
    expect(price("housing", 5)).toBe(436);
    expect(price("future", 0)).toBe(841);
    // 段階が上がっても1件の値段が上がりにくい（相対コストは約15倍、値段は約4倍）
    expect(price("housing", 5) / price("housing", 1)).toBeLessThan(5);
  });

  it("区画の開拓費は 1.03^n で伸びる", () => {
    expect(PLOT_COST_GROWTH).toBe(1.03);
    const s = createCity(T0, BASE);
    const first = plotCost(s);
    s.plots.push("1,0", "0,1", "-2,0", "0,-2", "1,-1", "-1,1", "-2,-1", "-1,-2", "1,1", "-2,1");
    expect(plotCost(s).treasury / first.treasury).toBeCloseTo(1.03 ** 10, 1);
  });
});

describe("AT-081 技術の更新（TEC-02〜04）", () => {
  /** 技術Lv2 の街を4日育ててから技術Lv3 に上げる */
  function grown() {
    const s = createCity(T0, BASE);
    s.treasury = 20_000;
    s.savingDays = 7;
    applyTechLevel(s, 2, T0, []);
    run(s, 4 * DAY);
    return s;
  }

  it("技術Lvが上がると時代の名前を出し、3日間は建て替えが無料になる", () => {
    const s = grown();
    const events: CityEvent[] = [];
    applyTechLevel(s, 3, s.simTime, events);
    expect(events[0].payload).toMatchObject({ level: 3, era: TECH_ERAS[2], renewalDays: RENEWAL_DAYS, renewalFree: true });
    expect(s.renewal).toMatchObject({ level: 3, from: s.simTime, until: s.simTime + RENEWAL_DAYS * DAY, evolved: 0 });
    const farm = s.buildings.find((b) => b.line === "farm")!;
    const plan = { kind: "evolve" as const, cost: evolveCost("farm", farm.tier + 1) };
    expect(planPrice(s, plan, s.simTime + HOUR)).toBe(0);
    // 3日たつと元の値段に戻る
    expect(renewing(s, s.simTime + RENEWAL_DAYS * DAY)).toBe(false);
    expect(planPrice(s, plan, s.simTime + RENEWAL_DAYS * DAY)).toBe(priceOf(s, plan.cost));
  });

  it("更新の間は建て替えが先に始まり、終わると建て替えた数を知らせる", () => {
    const s = grown();
    const before = s.buildings.filter((b) => b.line === "housing" || b.line === "farm").map((b) => `${b.id}:${b.tier}`);
    applyTechLevel(s, 3, s.simTime, []);
    s.treasury += 5_000;
    const events = run(s, RENEWAL_DAYS * DAY + DAY);
    const evolved = events.filter((e) => e.type === "EVOLVE");
    expect(evolved.length).toBeGreaterThan(0);
    const done = events.find((e) => e.type === "RENEWED");
    expect(done, "技術の更新の終わりの知らせ").toBeDefined();
    expect(done!.payload).toMatchObject({ level: 3, era: TECH_ERAS[2] });
    expect(done!.payload.evolved).toBeGreaterThan(0);
    expect(s.renewal!.reported).toBe(true);
    expect(before.length).toBeGreaterThan(0);
    // 知らせる数は、更新の間に始めた建て替えの数（道路の舗装を含む。更新のあとに始めた分は数えない）
    expect(evolved.length).toBeGreaterThanOrEqual(done!.payload.evolved as number);
  });

  it("電力の余りを超えて、電力を使う段階には建て替えない（発電所がないまま農場が止まらない）", () => {
    const s = grown();
    applyTechLevel(s, 3, s.simTime, []);
    run(s, RENEWAL_DAYS * DAY);
    const m = computeMetrics(s);
    expect(m.powerDemand).toBeLessThanOrEqual(m.powerSupply + 1e-9);
    expect(m.production.food).toBeGreaterThan(0);
  });
});

describe("盤面の情報の使い回し（放置計算の速さ）", () => {
  it("盤面が同じなら同じ入れ物を返し、工事が始まると作り直す。使い回しても選ぶ場所は同じ", () => {
    const s = createCity(T0, BASE);
    const a = siteCache(s);
    expect(siteCache(s)).toBe(a);
    const site = findSite(s, "housing", a);
    expect(site).toEqual(findSite(s, "housing"));
    s.treasury = 1_000;
    run(s, HOUR);
    expect(s.jobs.length + s.buildings.length).toBeGreaterThan(0);
    expect(siteCache(s)).not.toBe(a);
    expect(findSite(s, "housing", siteCache(s))).toEqual(findSite(s, "housing"));
  });
});
