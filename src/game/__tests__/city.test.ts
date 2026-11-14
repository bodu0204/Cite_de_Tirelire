import { describe, expect, it } from "vitest";
import { highestUnlockedTier, isTierUnlocked, tierDef, type LineId } from "../catalog";
import { CONCURRENT_JOBS, DAY, DEV_POINTS_PER_BASE, DEV_THRESHOLDS, HOUR, MINUTE, PLOT_SIZE, TICK_MS } from "../config";
import { syncParks, syncStatues } from "../city/actions";
import { computeMetrics } from "../city/economy";
import { createCity, migrateCity, seasonBase } from "../city/init";
import { buildingSize, canPlace, connected, dropLegacyMines, expandablePlots, expansionError, findSite, footprint, isPlaced, isPlannedRoad, isTileUnlocked, occupancy, plotCross, plotLimit, plotOf, roadNetwork, tileKey } from "../city/layout";
import { applyTechLevel, finishJob, plannedMetrics, plotCost, priceOf, simulate } from "../city/sim";
import { devLevel } from "../levels";
import { createReplay } from "../replay";
import { snapBuilding, type Building, type CityEvent, type CityState, type Job } from "../types";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
/** 基準額（月間自由予算と目標額の小さいほう。docs/savings-driven-growth.md PRC-06） */
const BASE = 100_000;

function run(s: CityState, ms: number) {
  const events: CityEvent[] = [];
  simulate(s, s.simTime + ms, events);
  return events;
}

const clone = (s: CityState): CityState => structuredClone(s);

/** 街の工事と同じ形のジョブを、(x, y) を左上にして始める（置けなければ例外） */
function startBuild(s: CityState, line: LineId, x: number, y: number): Job {
  const tier = highestUnlockedTier(line, s.techLevel, devLevel(s.devPoints));
  if (!canPlace(s, { line, tier }, x, y)) throw new Error(`置けません ${line} ${x},${y}`);
  const job: Job = { id: `j${s.nextId++}`, kind: "build", line, tier, level: 1, buildingId: `b${s.nextId++}`, x, y, startedAt: s.simTime, finishAt: s.simTime + tierDef(line, tier).buildMinutes * MINUTE };
  s.jobs.push(job);
  return job;
}

/** 街の開拓と同じ形のジョブを、マス (x, y) を含む区画で始める（開拓できなければ理由の例外） */
function startExpand(s: CityState, x: number, y: number): Job {
  const { px, py } = plotOf(x, y);
  const why = expansionError(s, px, py);
  if (why) throw new Error(why);
  const job: Job = { id: `j${s.nextId++}`, kind: "expand", line: "road", tier: 0, level: 1, buildingId: `plot:${px},${py}`, x: px * PLOT_SIZE, y: py * PLOT_SIZE, plot: `${px},${py}`, startedAt: s.simTime, finishAt: s.simTime + HOUR };
  s.jobs.push(job);
  return job;
}

/** 工事をすぐに終わらせる */
const finish = (s: CityState, job: Job, at: number, events: CityEvent[] = []) => finishJob(s, job, at, events);

/** 建設資金・完成した計画・工事中の計画の値段の合計（入れたお金は消えない） */
const moneyIn = (s: CityState) => s.treasury + s.completed + s.jobs.reduce((a, j) => a + (j.price ?? 0), 0);

describe("AT-009 貯金で育つ街（docs/savings-driven-growth.md GRW-01・GRW-06）", () => {
  it("建設資金がなければ工事は始まらず、建物も人口も減らない", () => {
    const s = createCity(T0, BASE);
    const before = clone(s);
    const events = run(s, DAY);
    expect(events.filter((e) => e.type === "BUILD" || e.type === "UPGRADE" || e.type === "EVOLVE")).toHaveLength(0);
    expect(s.buildings.length).toBe(before.buildings.length);
    expect(s.population).toBeGreaterThanOrEqual(before.population);
    expect(s.treasury).toBe(0);
    expect(s.devPoints).toBe(0);
  });

  it("街は自分では稼がない：税収・商業・工業の収益はない", () => {
    const s = createCity(T0, BASE);
    s.treasury = 20_000;
    run(s, 3 * DAY);
    expect(computeMetrics(s).production.treasury).toBe(0);
    expect(moneyIn(s)).toBeCloseTo(20_000, 6);
  });

  it("建設資金を入れると工事が始まり、完成した計画の値段で発展ptが増える（GRW-04）", () => {
    const s = createCity(T0, BASE);
    s.treasury = 5000;
    const events = run(s, DAY);
    const built = events.filter((e) => e.type === "BUILD" || e.type === "UPGRADE" || e.type === "EVOLVE" || e.type === "PLOT_EXPANDED");
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((e) => e.auto)).toBe(true);
    expect(s.completed).toBeGreaterThan(0);
    expect(s.devPoints).toBeCloseTo((s.completed / BASE) * DEV_POINTS_PER_BASE, 6);
    // 入れたお金は、建設資金・完成した計画・工事中の計画のどれかにある
    expect(moneyIn(s)).toBeCloseTo(5000, 6);
  });

  it("住宅の空きには人が移り住む（GRW-09）", () => {
    const s = createCity(T0, BASE);
    s.treasury = 5000;
    run(s, DAY);
    const m = computeMetrics(s);
    expect(s.population).toBeGreaterThan(4);
    expect(s.population).toBeGreaterThan(m.housingCap * 0.8);
  });
});

describe("基準額と以前の街の移行（docs/savings-driven-growth.md PRC-06）", () => {
  it("基準額は月間自由予算と目標額の小さいほう", () => {
    expect(seasonBase(100_000, 150_000)).toBe(100_000);
    expect(seasonBase(100_000, 30_000)).toBe(30_000);
    expect(seasonBase(0, 30_000)).toBe(1);
  });

  it("以前の街は発展Lvを保ち、木材・石材・都市資金を同じ換算で建設資金にする。2回目は何もしない", () => {
    const s = createCity(T0, BASE);
    // 基準額を持たない以前の街
    Reflect.deleteProperty(s, "base");
    s.devPoints = 400; // 以前の発展Lv4（350〜700pt）
    s.stock.wood = 1000;
    s.stock.stone = 500;
    s.treasury = 2000;
    expect(migrateCity(s, { base: BASE, startedAt: T0 })).toBe(true);
    expect(devLevel(s.devPoints)).toBe(4);
    expect(s.completed).toBeCloseTo(0.3 * BASE, 6);
    // 相対コスト 1000/10 + 500/5 + 2000/10 = 400 → 400 × 10万 × 0.0002 = 8,000円
    expect(s.treasury).toBe(8000);
    expect(s.stock.wood + s.stock.stone).toBe(0);
    expect(migrateCity(s, { base: 50_000, startedAt: T0 })).toBe(false);
    expect(s.base).toBe(BASE);
  });
});

describe("計画列の消化（GRW-03）", () => {
  it("同時に進める工事は発展Lvごとの上限まで", () => {
    const s = createCity(T0, BASE);
    s.treasury = 1_000_000;
    run(s, TICK_MS);
    expect(s.jobs.length).toBeLessThanOrEqual(CONCURRENT_JOBS[devLevel(s.devPoints) - 1]);
    expect(s.jobs.length).toBeGreaterThan(0);
  });

  it("先頭の計画が払えなければ、後ろの安い計画に回さずに貯める", () => {
    const s = createCity(T0, BASE);
    s.treasury = 1;
    const events = run(s, DAY);
    expect(events.filter((e) => e.type === "BUILD" || e.type === "UPGRADE")).toHaveLength(0);
    expect(s.treasury).toBe(1);
  });
});

describe("AT-012 長期間の放置", () => {
  it("7日間で時系列のイベント、資源は負にならない", () => {
    const s = createCity(T0, BASE);
    s.treasury = 20_000;
    applyTechLevel(s, 2, T0, []);
    const events = run(s, 7 * DAY);
    for (let i = 1; i < events.length; i++) expect(events[i].at).toBeGreaterThanOrEqual(events[i - 1].at);
    expect(s.stock.food).toBeGreaterThanOrEqual(0);
    expect(s.treasury).toBeGreaterThanOrEqual(0);
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
  });

  it("決定的：まとめて計算しても小分けにしても同じ結果になる", () => {
    const a = createCity(T0, BASE);
    const b = createCity(T0, BASE);
    a.treasury = b.treasury = 10_000;
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
    const s = createCity(T0, BASE);
    s.treasury = 5000;
    run(s, DAY);
    const snapshot = clone(s);
    simulate(s, s.simTime + TICK_MS - 1, []);
    expect(s).toEqual(snapshot);
  });
});

describe("AT-010 貯金による技術解放", () => {
  it("技術Lv3で工業系が建設可能になり、既存建物に技術ボーナス。発展ptは付与しない", () => {
    const s = createCity(T0, BASE);
    s.treasury = 15_000;
    run(s, 3 * DAY); // 発展Lv2 以上へ
    const dev = s.devPoints;
    const prodBefore = computeMetrics(s).production.food;
    const events: CityEvent[] = [];
    applyTechLevel(s, 3, s.simTime, events);
    expect(events.map((e) => e.payload.level)).toEqual([2, 3]);
    expect(s.devPoints).toBe(dev);
    expect(computeMetrics(s).production.food).toBeGreaterThan(prodBefore);
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    // 工場（工業系 段階1）が建設の候補になる
    expect(isTierUnlocked("factory", 1, s.techLevel, devLevel(s.devPoints))).toBe(true);
  });
});

describe("AT-011 技術が高く発展度が低い場合", () => {
  it("発展Lvが足りない施設は建設されず、貯金で工事が進むと発展Lvが上がる", () => {
    const s = createCity(T0, BASE);
    s.treasury = 10_000;
    applyTechLevel(s, 5, T0, []);
    expect(devLevel(s.devPoints)).toBe(1);
    expect(highestUnlockedTier("office", s.techLevel, devLevel(s.devPoints))).toBeLessThan(0);
    const events = run(s, 2 * DAY);
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
  it("銀貨を使わなくても、貯金（建設資金）だけで街は発展する", () => {
    const s = createCity(T0, BASE);
    s.treasury = 3000;
    const events = run(s, DAY);
    expect(events.some((e) => e.type === "BUILD" || e.type === "UPGRADE")).toBe(true);
  });
});

describe("AT-014 技術解放後の建物進化", () => {
  it("技術Lv2の農場が、技術Lv3で機械化農場へ進化する", () => {
    const s = createCity(T0, BASE);
    s.treasury = 20_000;
    applyTechLevel(s, 2, T0, []);
    run(s, 4 * DAY);
    const farm = s.buildings.find((b) => b.line === "farm" && b.tier === 1);
    expect(farm, "技術Lv2の農場が存在する").toBeDefined();
    expect(devLevel(s.devPoints)).toBeGreaterThanOrEqual(2);
    const foodBefore = computeMetrics(s).production.food;

    applyTechLevel(s, 3, s.simTime, []);
    s.treasury += 30_000;
    const events = run(s, 7 * DAY);
    const evolved = events.find((e) => e.type === "EVOLVE" && (e.payload.to as string) === "機械化農場");
    expect(evolved, "機械化農場への進化イベント").toBeDefined();
    expect(evolved!.auto).toBe(true);
    expect(computeMetrics(s).production.food).toBeGreaterThan(foodBefore);
  });

  it("技術Lvが上がっても一瞬で全部は置き換わらない", () => {
    const s = createCity(T0, BASE);
    s.treasury = 50_000;
    applyTechLevel(s, 2, T0, []);
    const events = run(s, HOUR);
    expect(events.filter((e) => e.type === "EVOLVE").length).toBeLessThanOrEqual(1);
  });
});

describe("建設の実績", () => {
  it("発展ptは完成した計画の値段だけで増える。値段のない工事（以前の工事）では増えない（GRW-04）", () => {
    const s = createCity(T0, BASE);
    const site = findSite(s, "housing")!;
    finish(s, startBuild(s, "housing", site.x, site.y), T0);
    expect(s.devPoints).toBe(0);
    const job = startBuild(s, "farm", findSite(s, "farm")!.x, findSite(s, "farm")!.y);
    job.price = 3000;
    const events: CityEvent[] = [];
    finish(s, job, T0, events);
    expect(s.completed).toBe(3000);
    expect(s.devPoints).toBeCloseTo(30, 10);
    expect(devLevel(s.devPoints)).toBe(2);
    expect(events.some((e) => e.type === "DEV_LEVEL" && e.payload.level === 2)).toBe(true);
  });

  it("開拓していない区画には建てられない", () => {
    const s = createCity(T0, BASE);
    expect(isTileUnlocked(s, 4, 4)).toBe(true);
    expect(isTileUnlocked(s, 5, 0)).toBe(false);
    expect(isTileUnlocked(s, -6, -5)).toBe(false);
    expect(canPlace(s, { line: "housing", tier: 0 }, 5, 0)).toBe(false);
  });
});

describe("公園", () => {
  it("サブスクの公園は幸福度を上げ、効果は逓減する", () => {
    const s = createCity(T0, BASE);
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
    const s = createCity(T0, BASE);
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
    expect(buildingSize({ line: "housing", tier: 5 })).toBe(2);
  });

  it("以前の街の金鉱・銀鉱は取り除き、敷地を最初の土地用途に戻す", () => {
    const s = createCity(T0, BASE);
    const mine = (id: string, x: number, y: number) => ({ ...s.buildings[0], id, special: id, x, y }) as unknown as Building;
    s.buildings.push(mine("gold_mine", 3, -2), mine("silver_mine", -2, 3));
    s.zones["3,-2"] = "special";
    s.zones["-2,3"] = "special";
    expect(dropLegacyMines(s)).toBe(true);
    expect(s.buildings.some((b) => (b.special as string)?.endsWith("_mine"))).toBe(false);
    expect(s.zones["3,-2"]).toBe("commercial");
    expect(s.zones["-2,3"]).toBe("agricultural");
    expect(s.zones["0,0"]).toBe("special");
    expect(dropLegacyMines(s)).toBe(false);
  });

  it("初期の街：銀行は原点を中心にした3×3。建物の占有範囲は重ならない", () => {
    const s = createCity(T0, BASE);
    const bank = s.buildings.find((b) => b.special === "bank")!;
    expect({ x: bank.x, y: bank.y }).toEqual({ x: -1, y: -1 });
    const tiles = s.buildings.reduce((n, b) => n + buildingSize(b) ** 2, 0);
    expect(occupancy(s).size).toBe(tiles);
  });

  it("2×2 は占有範囲がすべて空いている場所にだけ置く。工事中の場所も使用中", () => {
    const s = createCity(T0, BASE);
    const house = { line: "housing" as const, tier: 0 };
    // 土地の南東の角の敷地 (3, 3)〜(4, 4)。(4, 4) を左上にするとはみ出す
    expect(canPlace(s, house, 3, 3)).toBe(true);
    expect(canPlace(s, house, 4, 4)).toBe(false);
    startBuild(s, "housing", 3, 3);
    expect(canPlace(s, house, 3, 3)).toBe(false);
    // 銀行の上
    expect(canPlace(s, house, 0, 0)).toBe(false);
  });

  it("公園は高額（月3,000円以上）になると3×3 にし、場所がなければ林を押しのけて置く", () => {
    const s = createCity(T0, BASE);
    syncParks(s, [{ id: "a", name: "A", monthly: 1000, active: true }], T0, []);
    const park = s.buildings.find((b) => b.special === "park")!;
    expect(buildingSize(park)).toBe(2);
    expect(isPlaced(park)).toBe(true);
    // 中心の 10×10 は推奨道路で 2×2 の敷地に分かれていて、3×3 は入らないので、林を押しのけて置く
    const fund = s.treasury;
    const events: CityEvent[] = [];
    const roads = syncParks(s, [{ id: "a", name: "A", monthly: 5000, active: true }], T0, events);
    expect(buildingSize(park)).toBe(3);
    expect(isPlaced(park)).toBe(true);
    expect(footprint(park.x, park.y, 3).some((t) => !isTileUnlocked(s, t.x, t.y))).toBe(true);
    expect(footprint(park.x, park.y, 3).some((t) => isPlannedRoad(t.x, t.y))).toBe(false);
    expect(connected(s, roadNetwork(s), park, park.x, park.y)).toBe(true);
    // 敷いた道路は建設資金で払い、建設として記録する
    expect(s.treasury).toBe(fund - roads * priceOf(s, tierDef("road", 0).cost));
    expect(events.filter((e) => e.type === "BUILD")).toHaveLength(roads);
    expect(occupancy(s).size).toBe(s.buildings.filter(isPlaced).reduce((n, b) => n + buildingSize(b) ** 2, 0));
  });

  it("像は土地が埋まっていても林を押しのけて置き、足りない建設資金はマイナスにする", () => {
    const s = createCity(T0, BASE);
    s.treasury = 0;
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
    expect(s.treasury).toBe(-roads * priceOf(s, tierDef("road", 0).cost));
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
    const s = createCity(T0, BASE);
    const roads = s.buildings.filter((b) => b.line === "road");
    expect(roads.length).toBe(36);
    expect(roads.every((r) => isPlannedRoad(r.x, r.y))).toBe(true);
    expect(roadNetwork(s).tiles.size).toBe(36);
    expectConnected(s);
  });

  it("道路に接しない場所には建てられない。道路は道路網の隣にだけ延ばせる", () => {
    const s = createCity(T0, BASE);
    // 北西の区画の、道路の十字で区切られた (−5, −5) の敷地から道路を外すと、その敷地は道路に接しない
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && ((b.x === -3 && b.y <= -4) || (b.y === -3 && b.x <= -4))));
    expectConnected(s);
    expect(canPlace(s, { line: "housing", tier: 0 }, -5, -5)).toBe(false);
    expect(canPlace(s, { line: "road", tier: 0 }, -5, -3)).toBe(false);
    startBuild(s, "road", -4, -3);
    // 建設中の道路も道路網に入るので、続けて延ばせて、建物も建てられる
    startBuild(s, "road", -5, -3);
    startBuild(s, "housing", -5, -5);
    expect(s.jobs.at(-1)).toMatchObject({ line: "housing", x: -5, y: -5 });
    expectConnected(s);
  });

  it("推奨道路の上には、道路しか建たない。放置しても全部つながったまま", () => {
    const s = createCity(T0, BASE);
    applyTechLevel(s, 3, T0, []);
    run(s, 5 * DAY);
    for (const b of s.buildings.filter((o) => isPlaced(o) && o.line !== "road" && !o.special))
      expect(footprint(b.x, b.y, buildingSize(b)).some((t) => isPlannedRoad(t.x, t.y)), `${b.line} ${b.x},${b.y}`).toBe(false);
    expectConnected(s);
  });
});

describe("道路計画（docs/map-layout-redesign.md §5.3）", () => {
  it("置き場所がない時は、欠けた推奨道路を道路網の端から延ばす", () => {
    const s = createCity(T0, BASE);
    // 北西の区画の十字の外側の端（-3, -5）〜（-3, -4）と（-5, -3）〜（-4, -3）を外すと、(-5, -5) の敷地が使えなくなる
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && ((b.x === -3 && b.y <= -4) || (b.y === -3 && b.x <= -4))));
    // ほかの空き地は埋めておく
    for (const [x, y] of [[0, -5], [3, -5], [-5, 3], [0, 3], [3, 3]]) s.buildings.push({ id: `f${x},${y}`, line: "housing", tier: 0, level: 1, x, y, builtAt: T0 });
    expect(findSite(s, "housing")).toBeNull();
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
    s.devPoints = DEV_THRESHOLDS[lv - 1];
    return s;
  };

  it("開拓できる区画の数は発展Lvで決まる。Lv6 からは発展ptで増え、400 で止まる", () => {
    expect([1, 2, 3, 4, 5, 6].map((lv) => plotLimit(DEV_THRESHOLDS[lv - 1]))).toEqual([4, 8, 14, 22, 30, 40]);
    expect(plotLimit(DEV_THRESHOLDS[5] + 150 * 10)).toBe(80);
    expect(plotLimit(1e9)).toBe(400);
  });

  it("開拓：終わると区画の十字に道路が通る", () => {
    const s = atDev(createCity(T0, BASE), 2);
    expect(expandablePlots(s).sort()).toEqual(["-1,-2", "-1,1", "-2,-1", "-2,0", "0,-2", "0,1", "1,-1", "1,0"].sort());
    const cost = plotCost(s);
    startExpand(s, 7, 3);
    expect(s.jobs.at(-1)).toMatchObject({ kind: "expand", plot: "1,0", x: 5, y: 0 });
    expect(expansionError(s, 1, 0)).toMatch(/開拓中/);
    // 開拓中の区画も上限に数え、費用は次の区画の分に上がる
    expect(plotCost(s).wood).toBeGreaterThan(cost.wood);
    const events: CityEvent[] = [];
    finish(s, s.jobs.at(-1)!, T0, events);
    expect(events.map((e) => e.type)).toEqual(["PLOT_EXPANDED"]);
    expect(s.plots).toContain("1,0");
    expect(isTileUnlocked(s, 9, 4)).toBe(true);
    const roads = (events[0].payload.roads as { x: number; y: number }[]).map((t) => tileKey(t.x, t.y)).sort();
    expect(roads).toEqual(["7,0", "7,1", "7,2", "7,3", "7,4", "5,2", "6,2", "8,2", "9,2"].sort());
    expect(roadNetwork(s).tiles.size).toBe(36 + 9);
    // 新しい区画の 2×2 の敷地に建てられる
    expect(canPlace(s, { line: "housing", tier: 0 }, 5, 0)).toBe(true);
  });

  it("開拓できない区画：隣でない・上限", () => {
    const s = createCity(T0, BASE);
    expect(expansionError(s, 1, 0)).toMatch(/4 までです/);
    atDev(s, 2);
    expect(expansionError(s, 2, 0)).toMatch(/隣から/);
    expect(expansionError(s, 0, 0)).toMatch(/開拓済み/);
  });

  it("銀行までつながった道路が境目まで届いていない区画は開拓できない", () => {
    const s = atDev(createCity(T0, BASE), 2);
    // 東の端の道路（4, −3）・（4, 2）を外すと、区画 (1, −1)・(1, 0) の十字に道路網が届かない
    s.buildings = s.buildings.filter((b) => !(b.line === "road" && b.x === 4 && (b.y === -3 || b.y === 2)));
    expect(expandablePlots(s)).not.toContain("1,0");
    expect(expansionError(s, 1, 0)).toMatch(/届いていません/);
  });

  it("建てる場所がなくなると区画を開拓する", () => {
    const s = createCity(T0, BASE);
    s.treasury = 30_000;
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
  });

  it("林を押しのけて置いた公園は、まわりを開拓しても動かず、区画の十字の道路もふさがない", () => {
    const s = atDev(createCity(T0, BASE), 3);
    s.stock.wood = 10_000;
    s.stock.stone = 10_000;
    syncParks(s, [{ id: "a", name: "A", monthly: 5000, active: true }], T0, []);
    const park = s.buildings.find((b) => b.special === "park")!;
    const at = { x: park.x, y: park.y };
    for (const [x, y] of [[5, 0], [0, 5], [5, 5], [-10, 0], [0, -10]]) {
      if (expansionError(s, Math.floor(x / 5), Math.floor(y / 5))) continue;
      finish(s, startExpand(s, x, y), T0);
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
    const s = createCity(T0, BASE);
    s.devPoints = DEV_THRESHOLDS[1];
    const start = structuredClone(s);
    const job = startExpand(s, 5, 0);
    const events: CityEvent[] = [];
    finish(s, job, T0 + 1000, events);
    const replay = createReplay({ plots: start.plots, buildings: start.buildings.map(snapBuilding), zones: start.zones, techLevel: 1 }, events);
    expect(replay.at(T0).plots).toHaveLength(4);
    const after = replay.at(T0 + 1000);
    expect(after.plots).toContain("1,0");
    expect([...after.buildings.values()].filter((b) => b.line === "road")).toHaveLength(45);
  });
});

describe("工事中の分を完成したものとして判断する", () => {
  it("新築中の住宅は、完成後の指標には入り、今の指標には入らない", () => {
    const s = createCity(T0, BASE);
    const site = findSite(s, "housing")!;
    const now = computeMetrics(s).housingCap;
    s.jobs.push({ id: "jx", kind: "build", line: "housing", tier: 0, level: 1, buildingId: "bx", x: site.x, y: site.y, startedAt: T0, finishAt: T0 + HOUR });
    expect(computeMetrics(s).housingCap).toBe(now);
    expect(plannedMetrics(s).housingCap).toBeGreaterThan(now);
  });
});

describe("石材を作れないうちの開拓", () => {
  it("3区画目からの石材は、石材加工所が解放されるまでかからない", () => {
    const s = createCity(T0, BASE);
    s.devPoints = DEV_THRESHOLDS[1]; // 発展Lv2
    s.plots.push("1,0", "0,1");
    expect(plotCost(s).stone).toBe(0);
    applyTechLevel(s, 2, T0, []);
    expect(plotCost(s).stone).toBeGreaterThan(0);
  });

  it("技術Lv1のままでも、開拓が止まらない（石材は在庫に持たず、値段に含めて建設資金で払う）", () => {
    const s = createCity(T0, BASE);
    s.treasury = 15_000;
    run(s, 7 * DAY);
    expect(s.plots.length).toBeGreaterThan(6);
  });
});
