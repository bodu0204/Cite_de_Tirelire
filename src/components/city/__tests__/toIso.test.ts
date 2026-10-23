import { describe, expect, it } from "vitest";
import { MAP_SIZE } from "@/game/config";
import { defaultZones, tileUnlockLevel } from "@/game/city/layout";
import { MAX_CARS, MAX_PEOPLE, agentCounts, buildingKey, cityToIso, goldStage, hourIn, lightRatio, nightLevel, troubleIcons } from "../toIso";

const b = (over: Partial<Parameters<typeof buildingKey>[0]>) => ({ id: "b", tier: 0, level: 1, x: 4, y: 4, ...over });

describe("建物の絵のキー", () => {
  it("系統と段階。Lv2 以上は小物を重ねる @lv（Lv6 で頭打ち）", () => {
    expect(buildingKey(b({ line: "housing", tier: 2 }), 1)).toBe("building/housing/2");
    expect(buildingKey(b({ line: "housing", tier: 2, level: 3 }), 1)).toBe("building/housing/2@lv3");
    expect(buildingKey(b({ line: "factory", tier: 0, level: 9 }), 1)).toBe("building/factory/0@lv6");
  });

  it("特殊施設：銀行は銀行Lv、公園は段階と閉園、像は完成まで建設途中", () => {
    expect(buildingKey(b({ special: "bank" }), 0)).toBe("special/bank/1");
    expect(buildingKey(b({ special: "bank" }), 9)).toBe("special/bank/6");
    expect(buildingKey(b({ special: "park", tier: 2, closed: true }), 1)).toBe("special/park/2@closed");
    expect(buildingKey(b({ special: "statue", tier: 2, level: 3 }), 1)).toBe("special/statue/gold@stage3");
    expect(buildingKey(b({ special: "statue", tier: 1, level: 5 }), 1)).toBe("special/statue/silver");
    expect(buildingKey(b({ special: "gold_mine", level: 2 }), 1)).toBe("special/gold_mine@lv2");
  });
});

describe("盤面の変換", () => {
  const zones = defaultZones();

  it("道路は地面に、建物は絵に、マップ外（x < 0）は描かない", () => {
    const { map } = cityToIso({
      buildings: [b({ id: "r", line: "road", tier: 1, x: 3, y: 4 }), b({ id: "h", line: "housing" }), b({ id: "s", special: "statue", x: -1, y: -1 })],
      zones,
      devLevel: 6,
      bankLevel: 1,
    });
    expect(map.width).toBe(MAP_SIZE);
    expect(map.road[4 * MAP_SIZE + 3]).toBe(2);
    expect(map.objects.map((o) => o.id)).toEqual(["h"]);
  });

  it("未開放の区画は覆い（林・岩・看板）を置く", () => {
    const { map } = cityToIso({ buildings: [], zones, devLevel: 1, bankLevel: 1 });
    let lockedTiles = 0;
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) if (tileUnlockLevel(x, y) > 1) lockedTiles++;
    expect(map.objects.length).toBe(lockedTiles);
    expect(map.objects.every((o) => o.key.startsWith("locked/"))).toBe(true);
    expect(map.locked.reduce((a, v) => a + v, 0)).toBe(lockedTiles);
  });

  it("工事：新築は足場、改築は覆いを手前に。バーは重ね描きに渡す", () => {
    const jobs = [
      { x: 1, y: 1, kind: "build", startedAt: 0, finishAt: 10 },
      { x: 4, y: 4, kind: "upgrade", startedAt: 0, finishAt: 10 },
    ];
    const { map, overlay } = cityToIso({ buildings: [b({ id: "h", line: "housing" })], jobs, zones, devLevel: 6, bankLevel: 1, showZones: true, highlights: new Set(["4,4"]) });
    expect(map.objects.find((o) => o.id === "job:1,1")?.key).toBe("fx/scaffold");
    expect(map.objects.find((o) => o.id === "job:4,4")).toMatchObject({ key: "fx/cover", dz: 0.25 });
    expect(overlay.jobs).toHaveLength(2);
    expect(overlay.highlights).toEqual(["4,4"]);
    expect(overlay.showZones).toBe(true);
  });
});

describe("OBJ-14 昼夜", () => {
  it("昼は 0、夜は 1、夕方と明け方は2時間かけて変わる", () => {
    expect(nightLevel(12)).toBe(0);
    expect(nightLevel(17)).toBe(0);
    expect(nightLevel(18)).toBe(0.5);
    expect(nightLevel(19)).toBe(1);
    expect(nightLevel(0)).toBe(1);
    expect(nightLevel(6)).toBe(0.5);
    expect(nightLevel(7)).toBe(0);
    expect(nightLevel(24 + 18)).toBe(0.5);
  });

  it("灯る窓の割合は人口に比例し、0.2〜1 に収まる", () => {
    expect(lightRatio(0)).toBeCloseTo(0.2);
    expect(lightRatio(0.5)).toBeCloseTo(0.6);
    expect(lightRatio(1)).toBe(1);
    expect(lightRatio(3)).toBe(1);
  });

  it("タイムゾーンの時刻", () => {
    // 2026-10-23 12:30 UTC は東京で 21:30
    expect(hourIn("Asia/Tokyo", Date.UTC(2026, 9, 23, 12, 30))).toBe(21.5);
    expect(hourIn("UTC", Date.UTC(2026, 9, 23, 0, 15))).toBe(0.25);
  });

  it("時刻がなければ昼のまま", () => {
    const { overlay } = cityToIso({ buildings: [], zones: defaultZones(), devLevel: 6, bankLevel: 1 });
    expect(overlay.night).toBe(0);
    expect(cityToIso({ buildings: [], zones: defaultZones(), devLevel: 6, bankLevel: 1, hour: 22 }).overlay.night).toBe(1);
  });
});

describe("M3 にぎわい", () => {
  it("OBJ-11 人と車の数は人口と物流に比例し、上限と道路の長さで頭打ち", () => {
    expect(agentCounts(100, 1, 500)).toEqual({ people: 40, cars: 12 });
    expect(agentCounts(100, 0.6, 500).cars).toBeLessThan(12);
    expect(agentCounts(100000, 1, 10000)).toEqual({ people: MAX_PEOPLE, cars: MAX_CARS });
    expect(agentCounts(1000, 1, 10)).toEqual({ people: 10, cars: 3 });
    expect(agentCounts(0, 1, 100)).toEqual({ people: 0, cars: 0 });
  });

  it("A4 金貨の山は未回収が採掘の何分ぶんかで3段階", () => {
    expect(goldStage(0.5, 1)).toBe(0);
    expect(goldStage(30, 1)).toBe(1);
    expect(goldStage(300, 1)).toBe(2);
    expect(goldStage(1000, 1)).toBe(3);
    expect(goldStage(5, 0)).toBe(3);
  });

  it("A4 金鉱の前に金貨の山を置く", () => {
    const zones = defaultZones();
    const mine = { id: "m", special: "gold_mine" as const, tier: 0, level: 1, x: 3, y: 3 };
    const { map } = cityToIso({ buildings: [mine], zones, devLevel: 9, bankLevel: 1, gold: { uncollected: 120, ratePerMinute: 1 } });
    expect(map.objects.find((o) => o.id === "gold")).toMatchObject({ x: 3, y: 3, key: "props/gold/2" });
    const none = cityToIso({ buildings: [mine], zones, devLevel: 9, bankLevel: 1, gold: { uncollected: 0, ratePerMinute: 1 } });
    expect(none.map.objects.find((o) => o.id === "gold")).toBeUndefined();
  });

  it("A3 困りごと：足りない割合だけ、その資源を使う建物に出す", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, line: "factory" as const, tier: 1, level: 1, x: i % 20, y: Math.floor(i / 20) }));
    expect(troubleIcons(many, { power: 1, workers: 1, food: 1 })).toEqual([]);
    const half = troubleIcons(many, { power: 0.5, workers: 1, food: 1 });
    expect(half.length).toBeGreaterThan(70);
    expect(half.length).toBeLessThan(130);
    expect(half.every((t) => t.kind === "power" && t.dark)).toBe(true);
    // 電気を使わない建物（工房）には電気のアイコンを出さない
    const workshops = many.map((b) => ({ ...b, tier: 0 }));
    expect(troubleIcons(workshops, { power: 0, workers: 1, food: 1 })).toEqual([]);
    expect(troubleIcons(workshops, { power: 1, workers: 0, food: 1 })).toHaveLength(200);
    // 食料は住宅に出す
    const homes = many.map((b) => ({ ...b, line: "housing" as const, tier: 0 }));
    expect(troubleIcons(homes, { power: 1, workers: 1, food: 0 }).every((t) => t.kind === "food")).toBe(true);
  });
});
