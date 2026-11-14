// 悪い出来事（docs/savings-driven-growth.md §10）
import { describe, expect, it } from "vitest";
import { tierDef } from "../catalog";
import { activeDisasters, disasterOn, maybeDisaster, moodFactor, reopenDue, type DisasterKind } from "../city/disasters";
import { computeMetrics } from "../city/economy";
import { createCity } from "../city/init";
import { applyTechLevel, priceOf, simulate } from "../city/sim";
import { CROP_FAILURE, DAY, DEV_THRESHOLDS, FIRE_REOPEN_HOURS, HOUR, TICK_MS, TYPHOON_HOURS } from "../config";
import { disastersAt } from "../replay";
import type { CityEvent, CityState } from "../types";

const T0 = Date.UTC(2026, 9, 1);
const BASE = 100_000;

/** 発展Lv3・技術Lv3 の街（出来事のすべての種類が起きうる） */
function city(): CityState {
  const s = createCity(T0, BASE);
  s.devPoints = DEV_THRESHOLDS[2];
  applyTechLevel(s, 3, T0, []);
  return s;
}

/** その種類の出来事が起きる最初の日と、そのティックの終わりの時刻 */
function firstOf(s: CityState, kind: DisasterKind): { day: number; end: number } {
  for (let day = 1; day < 400; day++) {
    const d = disasterOn(s, day);
    if (d?.kind === kind) return { day, end: s.startedAt + (day - 1) * DAY + (d.slot + 1) * TICK_MS };
  }
  throw new Error(`${kind} が起きない`);
}

const price = (c: CityState, b: { line?: string; tier: number }) => priceOf(c, tierDef(b.line as never, b.tier).cost);

describe("EVT-01・02 いつ起きるか", () => {
  it("シーズンと日付から決定的に決まり、最初の3日間と発展Lv1 の間は起きない", () => {
    const s = city();
    for (let day = 1; day < 4; day++) expect(disasterOn(s, day)).toBeNull();
    const a = Array.from({ length: 60 }, (_, i) => disasterOn(s, i + 4));
    const b = Array.from({ length: 60 }, (_, i) => disasterOn(city(), i + 4));
    expect(a).toEqual(b);
    const low = createCity(T0, BASE);
    expect(Array.from({ length: 60 }, (_, i) => disasterOn(low, i + 4)).every((d) => d === null)).toBe(true);
  });

  it("平均 7〜10日に1回くらい起きる", () => {
    const s = city();
    const n = Array.from({ length: 365 }, (_, i) => disasterOn(s, i + 4)).filter(Boolean).length;
    expect(365 / n).toBeGreaterThan(5);
    expect(365 / n).toBeLessThan(13);
  });
});

describe("EVT-03・04 被害と備え", () => {
  it("台風：工事が止まり、終わる時刻がずれる。備えLv2 なら防ぐ", () => {
    const s = city();
    const { end } = firstOf(s, "typhoon");
    s.jobs.push({ id: "j1", kind: "build", line: "housing", tier: 0, level: 1, buildingId: "bx", x: 0, y: -5, startedAt: end - HOUR, finishAt: end + HOUR, price: 100 });
    const events: CityEvent[] = [];
    s.happiness = 50;
    maybeDisaster(s, end, events, price);
    expect(events[0]).toMatchObject({ type: "DISASTER", payload: { kind: "typhoon", prevented: false, hours: TYPHOON_HOURS } });
    expect(s.jobs[0].finishAt).toBe(end + HOUR + TYPHOON_HOURS * HOUR);
    expect(s.effects?.pauseUntil).toBe(end + TYPHOON_HOURS * HOUR);

    const t = city();
    t.reserveLevel = 2;
    const ev: CityEvent[] = [];
    maybeDisaster(t, end, ev, price);
    expect(ev[0].payload).toMatchObject({ kind: "typhoon", prevented: true });
    expect(t.effects).toBeUndefined();
  });

  it("備えLv1 と幸福度で被害が軽くなる（時間・割合が半分 × 0.75）", () => {
    const s = city();
    const { end } = firstOf(s, "crop");
    s.reserveLevel = 1;
    s.happiness = 80;
    maybeDisaster(s, end, [], price);
    const f = 0.5 * moodFactor(80);
    expect(s.effects?.crop).toEqual({ until: end + CROP_FAILURE.hours * HOUR * f, rate: CROP_FAILURE.rate * f });
  });

  it("不作の間は食料の生産が減り、資材の値上がりの間は値段が上がる", () => {
    const s = city();
    const before = computeMetrics(s).production.food;
    s.effects = { crop: { until: s.simTime + HOUR, rate: 0.5 } };
    expect(computeMetrics(s).production.food).toBeCloseTo(before * 0.5, 6);
    const cost = tierDef("housing", 1).cost;
    const p = priceOf(s, cost);
    s.effects = { surge: { until: s.simTime + HOUR, rate: 0.3 } };
    expect(priceOf(s, cost)).toBeGreaterThanOrEqual(Math.floor(p * 1.3));
  });

  it("火事：建物は壊さず休業し、人口も減らさない。3日で自動で再開する", () => {
    const s = city();
    const { end } = firstOf(s, "fire");
    const pop = (s.population = 6);
    const count = s.buildings.length;
    const events: CityEvent[] = [];
    maybeDisaster(s, end, events, price);
    const closed = s.buildings.filter((b) => b.closed);
    expect(closed).toHaveLength(1);
    expect(s.buildings).toHaveLength(count);
    simulate(s, end + HOUR, events);
    expect(s.population).toBeGreaterThanOrEqual(pop);
    reopenDue(s, end + FIRE_REOPEN_HOURS * HOUR, events);
    expect(closed[0].closed).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "REPAIRED", payload: { by: "auto" } });
  });

  it("火事：備えLv3 なら建設資金から修繕費を払ってすぐ修繕する", () => {
    const s = city();
    const { end } = firstOf(s, "fire");
    s.reserveLevel = 3;
    s.treasury = 10_000;
    const events: CityEvent[] = [];
    maybeDisaster(s, end, events, price);
    expect(s.buildings.some((b) => b.closed)).toBe(false);
    expect(events[0].payload).toMatchObject({ kind: "fire", repaired: true });
    expect(s.treasury).toBeLessThan(10_000);
  });

  it("備えLv4 ならすべて防ぐ", () => {
    for (const kind of ["typhoon", "crop", "fire", "surge", "blackout"] as const) {
      const s = city();
      s.reserveLevel = 4;
      const ev: CityEvent[] = [];
      maybeDisaster(s, firstOf(s, kind).end, ev, price);
      expect(ev[0].payload).toMatchObject({ kind, prevented: true });
    }
  });
});

describe("EVT-03 街の見た目に出す、続いている悪い出来事", () => {
  it("今の効果から求める（終わった効果は出さない）", () => {
    const at = T0 + DAY;
    expect(activeDisasters(undefined, at)).toEqual({ typhoon: false, crop: false, surge: false, blackout: false });
    const fx = { pauseUntil: at + HOUR, crop: { until: at + HOUR, rate: 0.5 }, surge: { until: at - 1, rate: 0.3 } };
    expect(activeDisasters(fx, at)).toEqual({ typhoon: true, crop: true, surge: false, blackout: false });
  });

  it("タイムラプスでは出来事の時刻と続く時間から求める。防いだ出来事と火事は出さない", () => {
    const events = [
      { at: 100, type: "DISASTER", payload: { kind: "typhoon", prevented: false, hours: 12 } },
      { at: 200, type: "DISASTER", payload: { kind: "surge", prevented: true } },
      { at: 300, type: "DISASTER", payload: { kind: "fire", prevented: false, repaired: false } },
      { at: 400, type: "DISASTER", payload: { kind: "crop", prevented: false, hours: 24, percent: 25 } },
    ];
    expect(disastersAt(events, 50)).toEqual({});
    expect(disastersAt(events, 500)).toEqual({ typhoon: true, crop: true });
    expect(disastersAt(events, 100 + 12 * HOUR)).toEqual({ crop: true });
    expect(disastersAt(events, 400 + 24 * HOUR)).toEqual({});
  });
});
