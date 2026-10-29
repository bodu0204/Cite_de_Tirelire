import { describe, expect, it } from "vitest";
import { tierDef } from "../catalog";
import { DAY, HOUR, TICK_MS } from "../config";
import { demolish, manualBuild, manualUpgrade, moveBuilding, placeOffMapSpecials, rushJob, syncParks } from "../city/actions";
import { computeMetrics } from "../city/economy";
import { createCity } from "../city/init";
import { buildingSize, connected, findSite, footprint, isPlaced, isPlannedRoad, isTileUnlocked, normalizeCity, occupancy, placementFor, roadNetwork, tileKey, tileUnlockLevel } from "../city/layout";
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
    // 住宅を1棟どけて、その敷地に建てる
    const house = s.buildings.find((b) => b.line === "housing" && !s.jobs.some((j) => j.buildingId === b.id))!;
    s.buildings = s.buildings.filter((b) => b !== house);
    expect(() => manualBuild(s, { line: "factory", tier: 1, x: house.x, y: house.y }, s.simTime, 1000)).not.toThrow();
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
    // TODO(S4)：開拓が入るまで v2 の街は 2×2 の建物で土地が埋まり、発電所が建たなくなるので、v1 の街で確かめる
    const s = createCity(T0, "balanced", 1);
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

describe("建物の大きさ（docs/map-layout-redesign.md §4）", () => {
  it("道路・像は1×1、銀行と高額なサブスクの公園は3×3、ほかは2×2。v1 はすべて1マス", () => {
    const v2 = { v: 2 as const };
    expect(buildingSize(v2, { line: "road", tier: 0 })).toBe(1);
    expect(buildingSize(v2, { special: "statue", tier: 2 })).toBe(1);
    expect(buildingSize(v2, { special: "bank", tier: 0 })).toBe(3);
    expect(buildingSize(v2, { special: "park", tier: 3 })).toBe(3);
    expect(buildingSize(v2, { special: "park", tier: 2 })).toBe(2);
    expect(buildingSize(v2, { line: "rail", tier: 0 })).toBe(2);
    expect(buildingSize(v2, { special: "gold_mine", tier: 0 })).toBe(2);
    expect(buildingSize(v2, { line: "housing", tier: 5 })).toBe(2);
    expect(buildingSize({ v: 1 }, { special: "bank", tier: 0 })).toBe(1);
  });

  it("初期の街：銀行は原点を中心にした3×3。建物の占有範囲は重ならない", () => {
    const s = createCity(T0);
    const bank = s.buildings.find((b) => b.special === "bank")!;
    expect({ x: bank.x, y: bank.y }).toEqual({ x: -1, y: -1 });
    const tiles = s.buildings.reduce((n, b) => n + buildingSize(s, b) ** 2, 0);
    expect(occupancy(s).size).toBe(tiles);
  });

  it("2×2 は選んだマスを含む空きに置く", () => {
    const s = createCity(T0);
    s.stock.wood = 1000;
    // 土地の南東の角のマスを選ぶと、左上に寄せて (3, 3)〜(4, 4) に置く
    manualBuild(s, { line: "housing", x: 4, y: 4 }, T0, 100);
    expect(s.jobs.at(-1)).toMatchObject({ x: 3, y: 3 });
    expect(placementFor(s, { line: "housing", tier: 0 }, 4, 4)).toBeNull();
    expect(() => manualBuild(s, { line: "housing", x: 4, y: 4 }, T0, 100)).toThrow(/使用中/);
    expect(() => manualBuild(s, { line: "housing", x: 0, y: 0 }, T0, 100)).toThrow(/使用中/);
  });

  it("移動は占有範囲ごと。銀行は動かせない", () => {
    const s = createCity(T0);
    const house = s.buildings.find((b) => b.id === "b1")!;
    moveBuilding(s, house.id, 4, 4, T0, 100, []);
    expect({ x: house.x, y: house.y }).toEqual({ x: 3, y: 3 });
    expect(() => moveBuilding(s, "bank", -5, -5, T0, 100, [])).toThrow(/銀行/);
  });

  it("公園は高額（月3,000円以上）になると3×3 にし、場所がなければ空き待ちになる", () => {
    const s = createCity(T0);
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, []);
    const park = s.buildings.find((b) => b.special === "park")!;
    expect(buildingSize(s, park)).toBe(2);
    expect(isPlaced(park)).toBe(true);
    // 中心の 10×10 は推奨道路で 2×2 の敷地に分かれていて、3×3 は入らない
    syncParks(s, [{ id: "a", name: "A", monthly: 5000, active: true }], T0, []);
    expect(buildingSize(s, park)).toBe(3);
    expect(isPlaced(park)).toBe(false);
    // 安くなれば、空き待ちから 2×2 で置かれる
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, []);
    placeOffMapSpecials(s);
    expect(isPlaced(park)).toBe(true);
    expect(occupancy(s).size).toBe(s.buildings.filter(isPlaced).reduce((n, b) => n + buildingSize(s, b) ** 2, 0));
  });
});

describe("道路網（docs/map-layout-redesign.md §5）", () => {
  /** すべての建物と工事が、銀行まで道路でつながった道路に接している */
  function expectConnected(s: CityState) {
    const net = roadNetwork(s);
    for (const b of s.buildings.filter(isPlaced)) {
      if (b.line === "road") expect(net.tiles.has(tileKey(b.x, b.y)), `道路 ${b.x},${b.y}`).toBe(true);
      else expect(connected(s, net, b, b.x, b.y), `${b.line ?? b.special} ${b.x},${b.y}`).toBe(true);
    }
    for (const j of s.jobs.filter((j) => j.kind === "build")) expect(connected(s, net, j, j.x, j.y), `工事 ${j.line} ${j.x},${j.y}`).toBe(true);
  }

  it("初期の街：推奨道路が銀行を囲み、すべての建物がつながっている", () => {
    const s = createCity(T0);
    const roads = s.buildings.filter((b) => b.line === "road");
    expect(roads.length).toBe(36);
    expect(roads.every((r) => isPlannedRoad(r.x, r.y))).toBe(true);
    expect(roadNetwork(s).tiles.size).toBe(36);
    expectConnected(s);
  });

  it("道路に接しない場所には建てられない。道路は道路網の隣にだけ延ばせる", () => {
    const s = createCity(T0);
    s.stock.wood = 1000;
    // 北西の区画の、道路の十字で区切られた (−5, −5) の敷地から道路を外すと、その敷地は道路に接しない
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && ((b.x === -3 && b.y <= -4) || (b.y === -3 && b.x <= -4))));
    expectConnected(s);
    expect(() => manualBuild(s, { line: "housing", x: -5, y: -5 }, T0, 100)).toThrow(/道路に接していません/);
    expect(() => manualBuild(s, { line: "road", x: -5, y: -3 }, T0, 100)).toThrow(/道路は/);
    manualBuild(s, { line: "road", x: -4, y: -3 }, T0, 100);
    // 建設中の道路も道路網に入るので、続けて延ばせて、建物も建てられる
    manualBuild(s, { line: "road", x: -5, y: -3 }, T0, 100);
    manualBuild(s, { line: "housing", x: -5, y: -5 }, T0, 100);
    expect(s.jobs.at(-1)).toMatchObject({ line: "housing", x: -5, y: -5 });
  });

  it("銀行とのつながりを切る道路は撤去・移動できない。行き止まりの道路は撤去できる", () => {
    const s = createCity(T0);
    // 銀行の東の (2, 0) は、金鉱・製材所の脇を通る道
    const east = s.buildings.find((b) => b.line === "road" && b.x === 2 && b.y === -3)!;
    expect(() => demolish(s, east.id, T0, [])).toThrow(/つながらなくなります/);
    expect(() => moveBuilding(s, east.id, -2, -2, T0, 100, [])).toThrow(/つながらなくなります/);
    // 外周の行き止まり (4, −3) は、どの建物もこれだけに頼っていない
    const end = s.buildings.find((b) => b.line === "road" && b.x === 4 && b.y === -3)!;
    demolish(s, end.id, T0, []);
    expectConnected(s);
  });

  it("推奨道路の上には、自動開発は道路しか建てない。放置しても全部つながったまま", () => {
    const s = createCity(T0);
    applyTechLevel(s, 3, T0, []);
    run(s, 5 * DAY);
    for (const b of s.buildings.filter((o) => isPlaced(o) && o.line !== "road" && !o.manual && !o.special))
      expect(footprint(b.x, b.y, buildingSize(s, b)).some((t) => isPlannedRoad(t.x, t.y)), `${b.line} ${b.x},${b.y}`).toBe(false);
    expectConnected(s);
  });

  it("v1 の街には道路のきまりがない", () => {
    const s = createCity(T0, "balanced", 1);
    s.buildings = s.buildings.filter((b) => b.line !== "road");
    expect(() => manualBuild(s, { line: "housing", x: 4, y: 3 }, T0, 100)).not.toThrow();
  });
});

describe("自動開発の道路計画（docs/map-layout-redesign.md §5.3）", () => {
  it("置き場所がない時は、欠けた推奨道路を道路網の端から延ばす", () => {
    const s = createCity(T0);
    // 北西の区画の十字の外側の端（-3, -5）〜（-3, -4）と（-5, -3）〜（-4, -3）を外すと、(-5, -5) の敷地が使えなくなる
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && ((b.x === -3 && b.y <= -4) || (b.y === -3 && b.x <= -4))));
    // ほかの空き地は埋めておく
    for (const [x, y] of [[0, -5], [3, -5], [-5, 3], [0, 3], [3, 3]]) s.buildings.push({ id: `f${x},${y}`, line: "housing", tier: 0, level: 1, x, y, locked: true, manual: true, builtAt: T0 });
    expect(findSite(s, "housing")).toBeNull();
    s.stock.wood = 1000;
    s.treasury = 1000;
    s.population = 30;
    const events = run(s, 6 * HOUR);
    const roads = events.filter((e) => e.type === "BUILD" && (e.payload.building as { line: string }).line === "road").map((e) => e.payload.building as { x: number; y: number });
    expect(roads.length).toBeGreaterThan(0);
    expect(roads.every((r) => isPlannedRoad(r.x, r.y))).toBe(true);
  });
});
