import { describe, expect, it } from "vitest";
import { MAP_SIZE } from "@/game/config";
import { defaultZones, tileUnlockLevel } from "@/game/city/layout";
import { buildingKey, cityToIso } from "../toIso";

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
