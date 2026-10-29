import { describe, expect, it } from "vitest";
import { tierDef } from "../catalog";
import { DAY, HOUR, TICK_MS } from "../config";
import { manualBuild, manualUpgrade, rushJob, syncParks } from "../city/actions";
import { computeMetrics } from "../city/economy";
import { createCity } from "../city/init";
import { findSite, isTileUnlocked, normalizeCity, occupancy, tileKey, tileUnlockLevel } from "../city/layout";
import { applyTechLevel, simulate } from "../city/sim";
import { devLevel } from "../levels";
import type { CityEvent, CityState } from "../types";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);

function run(s: CityState, ms: number) {
  const events: CityEvent[] = [];
  simulate(s, s.simTime + ms, events);
  return events;
}

const clone = (s: CityState): CityState => structuredClone(s);

describe("AT-009 無操作での街の発展", () => {
  it("24時間で資源・発展ptが増え、自動で建物が増える", () => {
    const s = createCity(T0);
    const before = clone(s);
    const events = run(s, DAY);
    expect(s.devPoints).toBeGreaterThan(before.devPoints);
    expect(s.population).toBeGreaterThan(before.population);
    const built = events.filter((e) => e.type === "BUILD" || e.type === "UPGRADE");
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((e) => e.auto)).toBe(true);
  });
});

describe("AT-012 長期間の放置", () => {
  it("7日間で時系列のイベント、資源は負にならない", () => {
    const s = createCity(T0);
    applyTechLevel(s, 2, T0, []);
    const events = run(s, 7 * DAY);
    for (let i = 1; i < events.length; i++) expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
    expect(s.stock.wood).toBeGreaterThanOrEqual(0);
    expect(s.stock.stone).toBeGreaterThanOrEqual(0);
    expect(s.stock.food).toBeGreaterThanOrEqual(0);
    expect(s.treasury).toBeGreaterThanOrEqual(0);
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    // 発展Lvで区画が開くのは v1 の街だけ（v2 は資源で開拓する）
    expect(events.some((e) => e.type === "DISTRICT_UNLOCKED")).toBe(false);
  });

  it("決定的：まとめて計算しても小分けにしても同じ結果になる", () => {
    const a = createCity(T0);
    const b = createCity(T0);
    run(a, 3 * DAY);
    const eb: CityEvent[] = [];
    // 不規則な時刻にアクセスしてもティックは絶対時刻に揃う
    let t = T0;
    for (const step of [7 * 60_000, 3 * HOUR + 123, 11 * HOUR, 5 * 60_000, DAY, 3 * DAY]) {
      t = Math.min(T0 + 3 * DAY, t + step);
      simulate(b, t, eb);
    }
    simulate(b, T0 + 3 * DAY, eb);
    expect(b).toEqual(a);
  });

  it("同じ時刻で再計算しても二重計上しない", () => {
    const s = createCity(T0);
    run(s, DAY);
    const snapshot = clone(s);
    simulate(s, s.simTime + TICK_MS - 1, []);
    expect(s).toEqual(snapshot);
  });
});

describe("AT-010 貯金による技術解放", () => {
  it("技術Lv3で工業系が建設可能になり、既存建物に技術ボーナス。発展ptは付与しない", () => {
    const s = createCity(T0);
    run(s, 3 * DAY); // 発展Lv2 へ
    const dev = s.devPoints;
    const prodBefore = computeMetrics(s).production.wood;
    const events: CityEvent[] = [];
    applyTechLevel(s, 3, s.simTime, events);
    expect(events.map((e) => e.payload.level)).toEqual([2, 3]);
    expect(s.devPoints).toBe(dev);
    expect(computeMetrics(s).production.wood).toBeGreaterThan(prodBefore);
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    // 工場（工業系 段階1）が手動で建てられる
    s.stock.wood = 1000;
    s.stock.stone = 1000;
    const free = findSite(s, "factory")!;
    expect(free).not.toBeNull();
    expect(() => manualBuild(s, { line: "factory", tier: 1, ...free }, s.simTime, 1000)).not.toThrow();
  });
});

describe("AT-011 技術が高く発展度が低い場合", () => {
  it("発展Lvが足りない施設は建設されず、放置で発展Lvが上がる", () => {
    const s = createCity(T0);
    applyTechLevel(s, 5, T0, []);
    expect(devLevel(s.devPoints)).toBe(1);
    expect(() => manualBuild(s, { line: "office", ...findSite(s, "office")! }, T0, 1000)).toThrow(/解放/);
    const events = run(s, 2 * DAY);
    const levelOf = new Map<string, number>();
    for (const e of events) if (e.type === "DEV_LEVEL") levelOf.set(String(e.at), e.payload.level as number);
    // 建った建物はすべて、その時点の発展Lvの条件を満たしている
    let lv = 1;
    for (const e of events) {
      if (e.type === "DEV_LEVEL") lv = e.payload.level as number;
      if (e.type === "BUILD") {
        const b = e.payload.building as { line: never; tier: number };
        expect(tierDef(b.line, b.tier).dev).toBeLessThanOrEqual(lv);
      }
    }
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
  });
});

describe("AT-013 銀貨が0の場合", () => {
  it("自動発展は続き、銀貨が必要な手動操作だけ制限される", () => {
    const s = createCity(T0);
    const events = run(s, DAY);
    expect(events.some((e) => e.type === "BUILD" || e.type === "UPGRADE")).toBe(true);
    const fresh = createCity(T0);
    expect(() => manualUpgrade(fresh, "b3", T0, 0)).toThrow(/銀貨/);
    expect(() => manualBuild(fresh, { line: "housing", ...findSite(fresh, "housing")! }, T0, 0)).toThrow(/銀貨/);
  });
});

describe("AT-014 技術解放後の建物進化", () => {
  it("技術Lv2の農場が、技術Lv3で機械化農場へ自動進化する", () => {
    const s = createCity(T0);
    applyTechLevel(s, 2, T0, []);
    run(s, 4 * DAY);
    const farm = s.buildings.find((b) => b.line === "farm" && b.tier === 1);
    expect(farm, "技術Lv2の農場が存在する").toBeDefined();
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    const foodBefore = computeMetrics(s).production.food;

    applyTechLevel(s, 3, s.simTime, []);
    const events = run(s, 5 * DAY);
    const evolved = events.find((e) => e.type === "EVOLVE" && (e.payload.to as string) === "機械化農場");
    expect(evolved, "機械化農場への進化イベント").toBeDefined();
    expect(evolved!.auto).toBe(true);
    expect(computeMetrics(s).production.food).toBeGreaterThan(foodBefore);
  });

  it("技術Lvが上がっても一瞬で全部は置き換わらない", () => {
    const s = createCity(T0);
    applyTechLevel(s, 2, T0, []);
    const events = run(s, HOUR);
    expect(events.filter((e) => e.type === "EVOLVE").length).toBeLessThanOrEqual(1);
  });
});

describe("手動操作", () => {
  it("手動建設は資材と銀貨で払い、都市資金を使わない。即時完了できる", () => {
    const s = createCity(T0);
    const treasury = s.treasury;
    const site = findSite(s, "housing")!;
    const r = manualBuild(s, { line: "housing", ...site }, T0, 100);
    expect(r.silverFee).toBeGreaterThan(0);
    expect(s.treasury).toBe(treasury);
    const events: CityEvent[] = [];
    rushJob(s, s.jobs[0].id, T0, 100, events);
    expect(events[0].type).toBe("BUILD");
    expect(events[0].auto).toBe(false);
    expect(s.buildings.find((b) => b.x === site.x && b.y === site.y)?.manual).toBe(true);
  });

  it("建設・撤去を繰り返しても発展ptは重複計上しない", () => {
    const s = createCity(T0);
    s.stock.wood = 1000;
    const pts: number[] = [];
    const site = findSite(s, "housing")!;
    for (let i = 0; i < 3; i++) {
      manualBuild(s, { line: "housing", ...site }, T0, 100);
      rushJob(s, s.jobs[s.jobs.length - 1].id, T0, 100, []);
      pts.push(s.devPoints);
      s.buildings = s.buildings.filter((b) => !(b.x === site.x && b.y === site.y));
    }
    expect(pts[1]).toBe(pts[0]);
    expect(pts[2]).toBe(pts[0]);
  });

  it("開拓していない区画には建てられない", () => {
    const s = createCity(T0);
    expect(isTileUnlocked(s, 4, 4)).toBe(true);
    expect(isTileUnlocked(s, 5, 0)).toBe(false);
    expect(isTileUnlocked(s, -6, -5)).toBe(false);
    expect(() => manualBuild(s, { line: "housing", x: 5, y: 0 }, T0, 100)).toThrow(/解放/);
  });
});

describe("v1 の街（2026-10 までに始めたシーズン）", () => {
  it("10×10 のまま、発展Lvで区画が開く", () => {
    const s = createCity(T0, "balanced", 1);
    expect(s.v).toBe(1);
    expect(tileUnlockLevel(0, 0)).toBe(5);
    expect(isTileUnlocked(s, 2, 2)).toBe(false);
    expect(() => manualBuild(s, { line: "housing", x: 2, y: 2 }, T0, 100)).toThrow(/解放/);
    expect(() => manualBuild(s, { line: "housing", x: -1, y: 4 }, T0, 100)).toThrow(/マップの外/);
    applyTechLevel(s, 2, T0, []);
    const events = run(s, 7 * DAY);
    expect(events.some((e) => e.type === "DISTRICT_UNLOCKED")).toBe(true);
    for (const b of s.buildings) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThan(10);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeLessThan(10);
    }
    expect(occupancy(s).size).toBe(s.buildings.length + s.jobs.filter((j) => j.kind === "build").length);
  });

  it("古い形で保存した土地用途・自動建設の禁止・マップ外を読み替える", () => {
    const s = createCity(T0, "balanced", 1);
    const zones = Array.from({ length: 100 }, (_, i) => (i === 13 ? "industrial" : "none"));
    const noAuto = Array.from({ length: 100 }, (_, i) => i === 25);
    const old = { ...s, zones, noAuto, buildings: [...s.buildings, { ...s.buildings[0], id: "p", special: "park" as const, x: -1, y: -1 }] } as unknown as CityState;
    const n = normalizeCity(old);
    expect(n.zones).toEqual({ [tileKey(3, 1)]: "industrial" });
    expect(n.noAuto).toEqual([tileKey(5, 2)]);
    expect(n.buildings.find((b) => b.id === "p")?.placed).toBe(false);
  });
});

describe("公園", () => {
  it("サブスクの公園は幸福度を上げ、効果は逓減する", () => {
    const s = createCity(T0);
    const h0 = computeMetrics(s).happinessTarget;
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, []);
    const h1 = computeMetrics(s).happinessTarget;
    syncParks(
      s,
      [
        { id: "a", name: "A", monthly: 1000, active: true },
        { id: "b", name: "B", monthly: 1000, active: true },
      ],
      T0,
      [],
    );
    const h2 = computeMetrics(s).happinessTarget;
    expect(h1).toBeGreaterThan(h0);
    expect(h2 - h1).toBeLessThan(h1 - h0);
  });

  it("解約すると閉園になる", () => {
    const s = createCity(T0);
    const ev: CityEvent[] = [];
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, ev);
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: false }], T0, ev);
    expect(ev.map((e) => e.type)).toEqual(["PARK_OPENED", "PARK_CLOSED"]);
    expect(s.buildings.find((b) => b.special === "park")?.closed).toBe(true);
  });
});
