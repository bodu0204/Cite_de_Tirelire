// 備えの施設と銀貨の使い道（docs/savings-driven-growth.md RSV-03・REC-06）
import { describe, expect, it } from "vitest";
import { bondCap } from "../bond";
import { buildingLabel, RESERVE_FACILITIES } from "../catalog";
import { createCity } from "../city/init";
import { buildingSize, footprint, isPlaced, tileKey, zoneAt } from "../city/layout";
import { syncReserve } from "../city/reserve";
import { HOUR, MICRO_PER_GOLD, RESERVE_LEVEL_MONTHS } from "../config";
import { BudgetPlan } from "../currency";
import { describeEvent } from "../describe";
import { advance, type World } from "../idle";
import { newMine } from "../mine";
import { createReplay, FIREWORK_FINALE, fireworksAt } from "../replay";
import { zonedTimeToUtc } from "../time";
import { snapBuilding, type CityEvent, type CityState } from "../types";

const TZ = "Asia/Tokyo";
const T0 = zonedTimeToUtc(2026, 10, 1, TZ);
const M = 60_000;

const reserves = (s: CityState) => s.buildings.filter((b) => b.special === "reserve").sort((a, b) => a.tier - b.tier);

describe("RSV-03 備えの施設", () => {
  it("備えLv の数だけ施設が建ち、銀行のまわりの特殊地区にほかの建物と重ならずに置かれる", () => {
    const s = createCity(T0, M);
    const events: CityEvent[] = [];
    syncReserve(s, 2, T0, events);
    const r = reserves(s);
    expect(r.map((b) => buildingLabel(b))).toEqual([RESERVE_FACILITIES[0].name, RESERVE_FACILITIES[1].name]);
    for (const b of r) {
      expect(isPlaced(b)).toBe(true);
      expect(buildingSize(b)).toBe(1);
      expect(zoneAt(s, b.x, b.y)).toBe("special");
    }
    const tiles = s.buildings.filter(isPlaced).flatMap((b) => footprint(b.x, b.y, buildingSize(b)).map((t) => tileKey(t.x, t.y)));
    expect(new Set(tiles).size).toBe(tiles.length);
    // 銀行（−1〜1）に隠れない、手前の左右の角から埋める
    expect(r.map((b) => [b.x, b.y])).toEqual([
      [1, -2],
      [-2, 1],
    ]);
    expect(events.map((e) => e.type)).toEqual(["RESERVE_BUILT", "RESERVE_BUILT"]);
    expect(describeEvent(events[1])).toBe(`備えLv2：${RESERVE_FACILITIES[1].name}が建ちました`);
  });

  it("備えLv が下がると施設は閉まり（壊さない）、戻ると再開する。変わらなければ何もしない", () => {
    const s = createCity(T0, M);
    syncReserve(s, 4, T0, []);
    const down: CityEvent[] = [];
    syncReserve(s, 1, T0 + HOUR, down);
    expect(reserves(s)).toHaveLength(4);
    expect(reserves(s).map((b) => !!b.closed)).toEqual([false, true, true, true]);
    expect(down.map((e) => e.type)).toEqual(["RESERVE_CLOSED", "RESERVE_CLOSED", "RESERVE_CLOSED"]);
    const same: CityEvent[] = [];
    syncReserve(s, 1, T0 + 2 * HOUR, same);
    expect(same).toEqual([]);
    const up: CityEvent[] = [];
    syncReserve(s, 3, T0 + 3 * HOUR, up);
    expect(reserves(s).map((b) => !!b.closed)).toEqual([false, false, false, true]);
    expect(up.map((e) => e.type)).toEqual(["RESERVE_OPENED", "RESERVE_OPENED"]);
  });

  it("放置計算が債券残高から備えLv を決めて施設を建てる。1回で計算しても1時間ごとでも同じ", () => {
    const plan = new BudgetPlan(M, [], [], TZ);
    const make = (): World => {
      const mine = newMine(T0, TZ);
      mine.uncollected = 0n * MICRO_PER_GOLD;
      return {
        purse: { mine, gold: 0, silver: 100, bond: RESERVE_LEVEL_MONTHS[2] * M, bondCap: bondCap(M), moves: [], overspend: 0 },
        city: createCity(T0, M),
        lots: [],
        accruals: new Map(),
      };
    };
    const a = make();
    const b = make();
    const opts = { plan, bondRate: 0, newId: () => "l", estimatePerDay: 1e9 };
    const ev: CityEvent[] = [];
    advance(a, { ...opts, until: T0 + 6 * HOUR }, ev);
    for (let t = T0 + HOUR; t <= T0 + 6 * HOUR; t += HOUR) advance(b, { ...opts, until: t }, []);
    expect(a.city.reserveLevel).toBe(3);
    expect(reserves(a.city)).toHaveLength(3);
    expect(ev.filter((e) => e.type === "RESERVE_BUILT")).toHaveLength(3);
    expect(reserves(b.city)).toEqual(reserves(a.city));
  });

  it("タイムラプスでも施設が建ち、閉まった姿で描ける", () => {
    const s = createCity(T0, M);
    const start = { plots: s.plots, buildings: s.buildings.map(snapBuilding), zones: s.zones, techLevel: s.techLevel };
    const events: CityEvent[] = [];
    syncReserve(s, 2, T0 + HOUR, events);
    syncReserve(s, 1, T0 + 2 * HOUR, events);
    const replay = createReplay(start, events);
    expect([...replay.at(T0).buildings.values()].some((b) => b.special === "reserve")).toBe(false);
    const late = [...replay.at(T0 + 2 * HOUR).buildings.values()].filter((b) => b.special === "reserve");
    expect(late.map((b) => !!b.closed)).toEqual([false, true]);
  });
});

describe("REC-06 タイムラプスの花火", () => {
  it("節目の数だけ花火が増え、再生が終わると完成の花火を足す", () => {
    const events = [
      { at: 10, type: "DEV_LEVEL" },
      { at: 20, type: "BUILD" },
      { at: 30, type: "TECH_UNLOCKED" },
      { at: 40, type: "SAVINGS_MILESTONE" },
    ];
    expect(fireworksAt(events, 5)).toBe(0);
    expect(fireworksAt(events, 25)).toBe(2);
    expect(fireworksAt(events, 35)).toBe(3);
    expect(fireworksAt(events, 50)).toBe(5);
    expect(fireworksAt(events, 50, true)).toBe(5 + FIREWORK_FINALE);
  });

  it("名前があれば表示名は名前、なければ種類の名前", () => {
    expect(buildingLabel({ line: "housing", tier: 0 })).toBe("小屋");
    expect(buildingLabel({ line: "housing", tier: 0, name: "ひだまり荘" })).toBe("ひだまり荘");
    expect(buildingLabel({ special: "reserve", tier: 3 })).toBe(RESERVE_FACILITIES[3].name);
    expect(buildingLabel({ special: "bank", tier: 0 })).toBe("銀行");
  });
});
