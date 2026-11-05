// 特殊施設（公園・像）を家計（サブスク・ほしい物）に合わせる。
// 街の建物の建設・アップグレード・進化・区画の開拓は、街の発展（sim.ts develop）だけが行う。
import { LINES } from "../catalog";
import { statueRank } from "../levels";
import { snapBuilding, type Building, type CityEvent, type CityState } from "../types";
import { buildingSize, canPlace, findSpecialSite, forestSite, isPlaced } from "./layout";
import { buildingName, newId } from "./sim";

/**
 * 特殊施設（公園・像）を置く。開いた区画に置けなければ林を押しのけて置き、
 * 銀行の道路網に接していなければ足りない道路をすぐに敷く。道路の木材は備蓄から引き、足りなくてもマイナスにして記録する。
 * 敷いた道路の数を返す（銀貨は呼び出し側が 1マス FEE_INSTANT_ROAD（config.ts）で払い、足りなければマイナスにする）
 */
function placeSpecial(s: CityState, b: Building, now: number, events: CityEvent[]): number {
  const site = findSpecialSite(s, b);
  if (site) {
    b.x = site.x;
    b.y = site.y;
    delete b.placed;
    return 0;
  }
  const forest = forestSite(s, b);
  if (!forest) {
    b.placed = false;
    return 0;
  }
  b.x = forest.x;
  b.y = forest.y;
  delete b.placed;
  const wood = LINES.road.tiers[0].cost.wood;
  for (const t of forest.roads) {
    const road: Building = { id: newId(s), line: "road", tier: 0, level: 1, x: t.x, y: t.y, builtAt: now };
    s.buildings.push(road);
    s.stock.wood -= wood;
    events.push({ at: now, type: "BUILD", auto: false, important: false, payload: { building: snapBuilding(road), name: buildingName(road) } });
  }
  return forest.roads.length;
}

/** マップ外で待っている公園・像を置く（林を押しのけて置く）。敷いた道路の数を返す */
export function placeOffMapSpecials(s: CityState, now: number, events: CityEvent[]): number {
  let roads = 0;
  for (const b of s.buildings) if (!isPlaced(b) && b.special) roads += placeSpecial(s, b, now, events);
  return roads;
}

// ---- 公園（サブスク） ----

export interface ParkSource {
  id: string;
  name: string;
  monthly: number;
  active: boolean;
}

export function parkSize(monthly: number): number {
  if (monthly >= 3000) return 3;
  if (monthly >= 1500) return 2;
  if (monthly >= 500) return 1;
  return 0;
}

/** 公園を家計のサブスクに合わせる。林を押しのけて敷いた道路の数を返す */
export function syncParks(s: CityState, subs: ParkSource[], now: number, events: CityEvent[]): number {
  let roads = 0;
  const ids = new Set(subs.map((x) => x.id));
  for (const b of s.buildings.filter((b) => b.special === "park" && b.refId && !ids.has(b.refId))) {
    s.buildings = s.buildings.filter((o) => o.id !== b.id);
    events.push({ at: now, type: "DEMOLISH", auto: false, important: true, payload: { buildingId: b.id, name: "公園" } });
  }
  for (const sub of subs) {
    const park = s.buildings.find((b) => b.special === "park" && b.refId === sub.id);
    const tier = parkSize(sub.monthly);
    if (!park) {
      if (!sub.active) continue;
      const b: Building = { id: newId(s), special: "park", refId: sub.id, tier, level: 1, x: 0, y: 0, placed: false, builtAt: now };
      roads += placeSpecial(s, b, now, events);
      s.buildings.push(b);
      events.push({ at: now, type: "PARK_OPENED", auto: false, important: true, payload: { building: snapBuilding(b), name: sub.name } });
      continue;
    }
    if (park.tier !== tier) roads += resizePark(s, park, tier, now, events);
    if (park.closed && sub.active) {
      park.closed = false;
      events.push({ at: now, type: "PARK_OPENED", auto: false, important: true, payload: { building: snapBuilding(park), name: sub.name } });
    } else if (!park.closed && !sub.active) {
      park.closed = true;
      events.push({ at: now, type: "PARK_CLOSED", auto: false, important: true, payload: { building: snapBuilding(park), name: sub.name } });
    }
  }
  return roads;
}

/**
 * 公園の段階を変える。3×3（高額なサブスク）と 2×2 をまたぐ時は置き直す（docs/map-layout-redesign.md §4.4）：
 * 今の場所で収まればそのまま、収まらなければ空きを探し、なければ林を押しのけて置く（placeSpecial）
 */
function resizePark(s: CityState, park: Building, tier: number, now: number, events: CityEvent[]): number {
  const before = buildingSize(park);
  park.tier = tier;
  const size = buildingSize(park);
  if (size === before || !isPlaced(park)) return 0;
  // 公園自身を盤面から外してから空きを調べる（大きくした占有範囲が、隣の建物のマスを上書きしないように）
  park.placed = false;
  if (size < before || canPlace(s, park, park.x, park.y)) {
    delete park.placed;
    return 0;
  }
  return placeSpecial(s, park, now, events);
}

// ---- 像（ほしい物） ----

export interface StatueSource {
  id: string;
  name: string;
  price: number;
  /** 0〜1 */
  progress: number;
  purchased: boolean;
}

const RANKS = ["bronze", "silver", "gold"] as const;

/** 像の level は進捗の段階（0〜4）。5 は購入済みで完成 */
export function statueStage(src: StatueSource): number {
  if (src.purchased) return 5;
  return Math.min(4, Math.floor(src.progress * 4 + 1e-9));
}

/** 像をほしい物に合わせる。林を押しのけて敷いた道路の数を返す */
export function syncStatues(s: CityState, wishes: StatueSource[], now: number, events: CityEvent[]): number {
  let roads = 0;
  const ids = new Set(wishes.map((w) => w.id));
  for (const b of s.buildings.filter((b) => b.special === "statue" && b.refId && !ids.has(b.refId))) {
    s.buildings = s.buildings.filter((o) => o.id !== b.id);
    events.push({ at: now, type: "DEMOLISH", auto: false, important: false, payload: { buildingId: b.id, name: "像" } });
  }
  for (const w of wishes) {
    let statue = s.buildings.find((b) => b.special === "statue" && b.refId === w.id);
    const tier = RANKS.indexOf(statueRank(w.price));
    const stage = statueStage(w);
    if (!statue) {
      statue = { id: newId(s), special: "statue", refId: w.id, tier, level: 0, x: 0, y: 0, placed: false, builtAt: now };
      roads += placeSpecial(s, statue, now, events);
      s.buildings.push(statue);
      events.push({ at: now, type: "STATUE_PROGRESS", auto: false, important: false, payload: { building: snapBuilding(statue), name: w.name, progress: 0 } });
    }
    statue.tier = tier;
    if (stage !== statue.level) {
      const rising = stage > statue.level;
      statue.level = stage;
      if (stage === 5) {
        events.push({ at: now, type: "STATUE_COMPLETED", auto: false, important: true, payload: { building: snapBuilding(statue), name: w.name } });
      } else {
        events.push({
          at: now,
          type: "STATUE_PROGRESS",
          auto: false,
          important: rising && stage === 4,
          payload: { building: snapBuilding(statue), name: w.name, progress: stage * 25 },
        });
      }
    }
  }
  return roads;
}
