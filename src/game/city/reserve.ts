// 備えの施設（docs/savings-driven-growth.md RSV-03）。債券残高で決まる備えLv 1〜4 ごとに、銀行のそばに
// 防災倉庫・消防署・避難公園・銀行の金庫が建ち、備えの厚さが街の景色に出る。
// 建物は壊さない（設計原則4）：備えLvが下がった施設は閉まり（暗く描く）、Lvが戻ると再開する。
import { RESERVE_FACILITIES } from "../catalog";
import { snapBuilding, type Building, type CityEvent, type CityState } from "../types";
import { candidateSites, isPlannedRoad, zoneAt } from "./layout";
import { newId } from "./sim";

/** 備えLv lv の施設の名前（lv は 1〜4） */
export const reserveName = (lv: number) => RESERVE_FACILITIES[lv - 1]?.name ?? "";

/**
 * 施設の場所：銀行のまわりの特殊地区で、手前（x + y が大きい）から選ぶ。特殊地区の奥の列は背の高い銀行に隠れるため、
 * 銀行の左右の角から埋める。特殊地区に空きがなければ、銀行に近い空き地。推奨道路はふさがない
 */
export function reserveSite(s: CityState, b: Building): { x: number; y: number } | null {
  const free = candidateSites(s, b).filter((t) => !isPlannedRoad(t.x, t.y));
  const special = (t: { x: number; y: number }) => zoneAt(s, t.x, t.y) === "special";
  const key = (t: { x: number; y: number }) => (special(t) ? -(t.x + t.y) : 100 + Math.abs(t.x) + Math.abs(t.y));
  free.sort((a, c) => key(a) - key(c) || c.x - a.x);
  return free[0] ?? null;
}

/**
 * 備えLv に合わせて施設を建てる・閉める・再開する（放置計算がティックごとに呼ぶ）。
 * 空きがなければマップ外で待つ（sim.ts の placeWaitingSpecials が置く）
 */
export function syncReserve(s: CityState, lv: number, at: number, events: CityEvent[]) {
  for (let k = 1; k <= RESERVE_FACILITIES.length; k++) {
    const tier = k - 1;
    const name = reserveName(k);
    const b = s.buildings.find((o) => o.special === "reserve" && o.tier === tier);
    if (!b) {
      if (lv < k) continue;
      const built: Building = { id: newId(s), special: "reserve", tier, level: 1, x: 0, y: 0, placed: false, builtAt: at };
      const site = reserveSite(s, built);
      if (site) {
        built.x = site.x;
        built.y = site.y;
        delete built.placed;
      }
      s.buildings.push(built);
      events.push({ at, type: "RESERVE_BUILT", auto: false, important: true, payload: { building: snapBuilding(built), name, level: k } });
      continue;
    }
    const closed = lv < k;
    if (!!b.closed === closed) continue;
    if (closed) b.closed = true;
    else delete b.closed;
    events.push({ at, type: closed ? "RESERVE_CLOSED" : "RESERVE_OPENED", auto: false, important: false, payload: { building: snapBuilding(b), name, level: k } });
  }
}
