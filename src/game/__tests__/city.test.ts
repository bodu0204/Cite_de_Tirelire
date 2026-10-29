import { describe, expect, it } from "vitest";
import { tierDef } from "../catalog";
import { DAY, HOUR, TICK_MS } from "../config";
import { demolish, expandQuote, manualBuild, manualExpand, manualUpgrade, moveBuilding, rushJob, setPolicy, syncParks, syncStatues } from "../city/actions";
import { computeMetrics } from "../city/economy";
import { createCity } from "../city/init";
import { buildingSize, connected, expandablePlots, expansionError, findSite, footprint, isPlaced, isPlannedRoad, isTileUnlocked, occupancy, placementFor, plotCross, plotLimit, roadNetwork, tileKey } from "../city/layout";
import { applyTechLevel, simulate } from "../city/sim";
import { devLevel } from "../levels";
import { createReplay } from "../replay";
import { snapBuilding, type CityEvent, type CityState } from "../types";

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
    const s = createCity(T0);
    applyTechLevel(s, 2, T0, []);
    run(s, 4 * DAY);
    const farm = s.buildings.find((b) => b.line === "farm" && b.tier === 1);
    expect(farm, "技術Lv2の農場が存在する").toBeDefined();
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    const foodBefore = computeMetrics(s).production.food;

    applyTechLevel(s, 3, s.simTime, []);
    // v2 は開拓で土地が増えるので、都市資金が先に新築へ回り、進化は6日目ごろになる
    const events = run(s, 7 * DAY);
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
  it("道路・像は1×1、銀行と高額なサブスクの公園は3×3、ほかは2×2", () => {
    expect(buildingSize({ line: "road", tier: 0 })).toBe(1);
    expect(buildingSize({ special: "statue", tier: 2 })).toBe(1);
    expect(buildingSize({ special: "bank", tier: 0 })).toBe(3);
    expect(buildingSize({ special: "park", tier: 3 })).toBe(3);
    expect(buildingSize({ special: "park", tier: 2 })).toBe(2);
    expect(buildingSize({ line: "rail", tier: 0 })).toBe(2);
    expect(buildingSize({ special: "gold_mine", tier: 0 })).toBe(2);
    expect(buildingSize({ line: "housing", tier: 5 })).toBe(2);
  });

  it("初期の街：銀行は原点を中心にした3×3。建物の占有範囲は重ならない", () => {
    const s = createCity(T0);
    const bank = s.buildings.find((b) => b.special === "bank")!;
    expect({ x: bank.x, y: bank.y }).toEqual({ x: -1, y: -1 });
    const tiles = s.buildings.reduce((n, b) => n + buildingSize(b) ** 2, 0);
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

  it("公園は高額（月3,000円以上）になると3×3 にし、場所がなければ林を押しのけて置く", () => {
    const s = createCity(T0);
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, []);
    const park = s.buildings.find((b) => b.special === "park")!;
    expect(buildingSize(park)).toBe(2);
    expect(isPlaced(park)).toBe(true);
    // 中心の 10×10 は推奨道路で 2×2 の敷地に分かれていて、3×3 は入らないので、林を押しのけて置く
    const wood = s.stock.wood;
    const events: CityEvent[] = [];
    const roads = syncParks(s, [{ id: "a", name: "A", monthly: 5000, active: true }], T0, events);
    expect(buildingSize(park)).toBe(3);
    expect(isPlaced(park)).toBe(true);
    expect(footprint(park.x, park.y, 3).some((t) => !isTileUnlocked(s, t.x, t.y))).toBe(true);
    expect(footprint(park.x, park.y, 3).some((t) => isPlannedRoad(t.x, t.y))).toBe(false);
    expect(connected(s, roadNetwork(s), park, park.x, park.y)).toBe(true);
    // 敷いた道路は木材を使い、建設として記録する
    expect(s.stock.wood).toBe(wood - roads * tierDef("road", 0).cost.wood);
    expect(events.filter((e) => e.type === "BUILD")).toHaveLength(roads);
    expect(occupancy(s).size).toBe(s.buildings.filter(isPlaced).reduce((n, b) => n + buildingSize(b) ** 2, 0));
  });

  it("像は土地が埋まっていても林を押しのけて置き、足りない木材はマイナスにする", () => {
    const s = createCity(T0);
    s.stock.wood = 0;
    const wishes = Array.from({ length: 60 }, (_, i) => ({ id: `w${i}`, name: `W${i}`, price: 1000, progress: 0, purchased: false }));
    const roads = syncStatues(s, wishes, T0, []);
    const statues = s.buildings.filter((b) => b.special === "statue");
    expect(statues).toHaveLength(60);
    const net = roadNetwork(s);
    for (const b of statues) {
      expect(isPlaced(b)).toBe(true);
      expect(connected(s, net, b, b.x, b.y)).toBe(true);
    }
    expect(roads).toBeGreaterThan(0);
    expect(s.stock.wood).toBe(-roads * tierDef("road", 0).cost.wood);
    expect(occupancy(s).size).toBe(s.buildings.filter(isPlaced).reduce((n, b) => n + buildingSize(b) ** 2, 0));
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
      expect(footprint(b.x, b.y, buildingSize(b)).some((t) => isPlannedRoad(t.x, t.y)), `${b.line} ${b.x},${b.y}`).toBe(false);
    expectConnected(s);
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

describe("開拓（docs/map-layout-redesign.md §7）", () => {
  /** 発展Lv を lv にする（発展pt を閾値にそろえる） */
  const atDev = (s: CityState, lv: number) => {
    s.devPoints = [0, 50, 150, 350, 700, 1200][lv - 1];
    return s;
  };

  it("開拓できる区画の数は発展Lvで決まる。Lv6 からは発展ptで増え、400 で止まる", () => {
    expect([1, 2, 3, 4, 5, 6].map((lv) => plotLimit([0, 50, 150, 350, 700, 1200][lv - 1]))).toEqual([4, 8, 14, 22, 30, 40]);
    expect(plotLimit(1200 + 150 * 10)).toBe(80);
    expect(plotLimit(1e9)).toBe(400);
  });

  it("手動の開拓：資材と銀貨で払い、終わると区画の十字に道路が通る", () => {
    const s = atDev(createCity(T0), 2);
    s.stock.wood = 1000;
    const treasury = s.treasury;
    expect(expandablePlots(s).sort()).toEqual(["-1,-2", "-1,1", "-2,-1", "-2,0", "0,-2", "0,1", "1,-1", "1,0"].sort());
    const q = expandQuote(s);
    const r = manualExpand(s, 7, 3, T0, 100);
    expect(r.silverFee).toBe(q.fee);
    expect(s.stock.wood).toBe(1000 - q.cost.wood);
    expect(s.treasury).toBe(treasury);
    expect(s.jobs.at(-1)).toMatchObject({ kind: "expand", plot: "1,0", x: 5, y: 0 });
    expect(() => manualExpand(s, 5, 0, T0, 100)).toThrow(/開拓中/);
    // 開拓中の区画も上限に数え、費用は次の区画の分に上がる
    expect(expandQuote(s).cost.wood).toBeGreaterThan(q.cost.wood);
    const events: CityEvent[] = [];
    rushJob(s, s.jobs.at(-1)!.id, T0, 100, events);
    expect(events.map((e) => e.type)).toEqual(["PLOT_EXPANDED"]);
    expect(s.plots).toContain("1,0");
    expect(isTileUnlocked(s, 9, 4)).toBe(true);
    const roads = (events[0].payload.roads as { x: number; y: number }[]).map((t) => tileKey(t.x, t.y)).sort();
    expect(roads).toEqual(["7,0", "7,1", "7,2", "7,3", "7,4", "5,2", "6,2", "8,2", "9,2"].sort());
    expect(roadNetwork(s).tiles.size).toBe(36 + 9);
    // 新しい区画の 2×2 の敷地に建てられる
    expect(() => manualBuild(s, { line: "housing", x: 5, y: 0 }, T0, 100)).not.toThrow();
  });

  it("開拓できない区画：隣でない・上限", () => {
    const s = createCity(T0);
    s.stock.wood = 1000;
    expect(() => manualExpand(s, 5, 0, T0, 100)).toThrow(/4 までです/);
    atDev(s, 2);
    expect(() => manualExpand(s, 12, 0, T0, 100)).toThrow(/隣から/);
    expect(() => manualExpand(s, 0, 0, T0, 100)).toThrow(/開拓済み/);
  });

  it("銀行までつながった道路が境目まで届いていない区画は開拓できない", () => {
    const s = atDev(createCity(T0), 2);
    // 東の端の道路（4, −3）・（4, 2）を外すと、区画 (1, −1)・(1, 0) の十字に道路網が届かない
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && b.x === 4 && (b.y === -3 || b.y === 2)));
    expect(expandablePlots(s)).not.toContain("1,0");
    expect(() => manualExpand(s, 5, 0, T0, 100)).toThrow(/届いていません/);
  });

  it("自動開発は、建てる場所がなくなると区画を開拓する。止めることもできる", () => {
    const s = createCity(T0);
    applyTechLevel(s, 3, T0, []);
    const events = run(s, 7 * DAY);
    const expanded = events.filter((e) => e.type === "PLOT_EXPANDED");
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded.every((e) => e.auto)).toBe(true);
    expect(s.plots!.length).toBeLessThanOrEqual(plotLimit(s.devPoints));
    // 開いた区画はどれも、ほかの区画の隣
    for (const k of s.plots!) {
      const [px, py] = k.split(",").map(Number);
      expect([`${px + 1},${py}`, `${px - 1},${py}`, `${px},${py + 1}`, `${px},${py - 1}`].some((n) => s.plots!.includes(n))).toBe(true);
    }
    // 方針で開拓を止める
    const off = createCity(T0);
    applyTechLevel(off, 3, T0, []);
    setPolicy(off, { autoExpand: false });
    expect(run(off, 7 * DAY).some((e) => e.type === "PLOT_EXPANDED")).toBe(false);
    expect(off.plots).toHaveLength(4);
  });

  it("林を押しのけて置いた公園は、まわりを開拓しても動かず、区画の十字の道路もふさがない", () => {
    const s = atDev(createCity(T0), 3);
    s.stock.wood = 10_000;
    s.stock.stone = 10_000;
    syncParks(s, [{ id: "a", name: "A", monthly: 5000, active: true }], T0, []);
    const park = s.buildings.find((b) => b.special === "park")!;
    const at = { x: park.x, y: park.y };
    for (const [x, y] of [[5, 0], [0, 5], [5, 5], [-10, 0], [0, -10]]) {
      if (expansionError(s, Math.floor(x / 5), Math.floor(y / 5))) continue;
      manualExpand(s, x, y, T0, 1000);
      rushJob(s, s.jobs.at(-1)!.id, T0, 1000, []);
    }
    expect({ x: park.x, y: park.y }).toEqual(at);
    expect(connected(s, roadNetwork(s), park, park.x, park.y)).toBe(true);
    const roads = new Set(s.buildings.filter((b) => b.line === "road").map((b) => tileKey(b.x, b.y)));
    for (const k of s.plots) {
      const [px, py] = k.split(",").map(Number);
      for (const t of plotCross(px, py)) expect(roads.has(tileKey(t.x, t.y))).toBe(true);
    }
  });
});

describe("タイムラプス（v2）", () => {
  it("開拓のイベントで区画と道路が増える", () => {
    const s = createCity(T0);
    s.devPoints = 50;
    s.stock.wood = 1000;
    const start = structuredClone(s);
    manualExpand(s, 5, 0, T0, 100);
    const events: CityEvent[] = [];
    rushJob(s, s.jobs.at(-1)!.id, T0 + 1000, 100, events);
    const replay = createReplay({ plots: start.plots, buildings: start.buildings.map(snapBuilding), zones: start.zones, techLevel: 1 }, events);
    expect(replay.at(T0).plots).toHaveLength(4);
    const after = replay.at(T0 + 1000);
    expect(after.plots).toContain("1,0");
    expect([...after.buildings.values()].filter((b) => b.line === "road")).toHaveLength(45);
  });
});
