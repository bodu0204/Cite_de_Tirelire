// マップ：区画の解放、土地用途、自動配置。
import { LINES, type LineId, type Zone } from "../catalog";
import { MAP_SIZE } from "../config";
import type { CityState } from "../types";

export const idx = (x: number, y: number) => y * MAP_SIZE + x;
const edge = (v: number) => (v < MAP_SIZE / 2 ? MAP_SIZE / 2 - 1 - v : v - MAP_SIZE / 2);

/** そのマスを使えるようになる発展Lv */
export function tileUnlockLevel(x: number, y: number): number {
  const ex = edge(x);
  const ey = edge(y);
  const r = Math.max(ex, ey);
  if (r <= 1) return 1;
  if (r === 2) return 2;
  if (r === 3) return 3;
  return ey === 4 ? 5 : 4;
}

export function isTileUnlocked(x: number, y: number, dev: number): boolean {
  return inBounds(x, y) && tileUnlockLevel(x, y) <= dev;
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE && Number.isInteger(x) && Number.isInteger(y);
}

export function unlockedTileCount(dev: number): number {
  let n = 0;
  for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) if (tileUnlockLevel(x, y) <= dev) n++;
  return n;
}

export const DISTRICT_NAMES: Record<number, string> = {
  1: "中心部",
  2: "周辺の住宅・農業エリア",
  3: "工業・商業エリア",
  4: "東西の追加区画",
  5: "南北の追加区画",
};

/** 初期の土地用途の提案：中央が特殊地区、四象限に住宅・商業・農業・工業 */
export function defaultZones(): Zone[] {
  const zones: Zone[] = [];
  const mid = MAP_SIZE / 2;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      let z: Zone;
      const centerCol = x === mid - 1 || x === mid;
      if (centerCol && (y === mid - 1 || y === mid)) z = "special";
      else if (centerCol) z = y < mid ? "public" : "none";
      else if (x < mid && y < mid) z = "residential";
      else if (x >= mid && y < mid) z = "commercial";
      else if (x < mid) z = "agricultural";
      else z = "industrial";
      zones.push(z);
    }
  }
  return zones;
}

/** 建物と建設中ジョブが占有しているマス */
export function occupancy(state: CityState): (string | null)[] {
  const occ: (string | null)[] = new Array(MAP_SIZE * MAP_SIZE).fill(null);
  for (const b of state.buildings) if (b.x >= 0) occ[idx(b.x, b.y)] = b.id;
  for (const j of state.jobs) if (j.kind === "build") occ[idx(j.x, j.y)] = j.buildingId;
  return occ;
}

export function freeTiles(state: CityState, dev: number): { x: number; y: number }[] {
  const occ = occupancy(state);
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < MAP_SIZE; y++)
    for (let x = 0; x < MAP_SIZE; x++) if (!occ[idx(x, y)] && isTileUnlocked(x, y, dev)) out.push({ x, y });
  return out;
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 自動配置の場所を選ぶ。用途が一致する土地 → 未指定の土地 の順。
 * 同系統の隣接と道路の隣接を加点し、住宅と工業の隣接を減点する。決定的にタイブレークする。
 */
export function findSite(state: CityState, line: LineId, dev: number): { x: number; y: number } | null {
  const def = LINES[line];
  const grid = new Map<number, LineId | "special">();
  for (const b of state.buildings) if (b.x >= 0) grid.set(idx(b.x, b.y), b.line ?? "special");
  for (const j of state.jobs) if (j.kind === "build") grid.set(idx(j.x, j.y), j.line);

  let best: { x: number; y: number; score: number } | null = null;
  for (const { x, y } of freeTiles(state, dev)) {
    const i = idx(x, y);
    if (state.noAuto[i]) continue;
    const zone = state.zones[i];
    let score: number;
    if (def.zone === "any") {
      // 交通施設は空き地を優先し、建物の多い場所に引く
      score = zone === "none" ? 20 : zone === "special" ? -100 : 0;
    } else if (zone === def.zone) score = 100;
    else if (zone === "none") score = 40;
    else continue;

    let neighbors = 0;
    for (const [dx, dy] of NEIGHBORS) {
      const n = grid.get(idx(x + dx, y + dy));
      if (!inBounds(x + dx, y + dy) || !n) continue;
      neighbors++;
      if (n === line) score += 3;
      if (n === "road" || n === "rail") score += 2;
      const isHousing = line === "housing" || n === "housing";
      const nCat = n === "special" ? null : LINES[n].category;
      if (isHousing && (def.category === "industry" || nCat === "industry") && line !== n) score -= 6;
    }
    if (def.zone === "any") score += neighbors * 4;
    score -= (Math.abs(x - 4.5) + Math.abs(y - 4.5)) * 0.5;
    if (!best || score > best.score) best = { x, y, score };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** 特殊施設（公園・像）の場所：特殊地区 → 未指定 → 任意の空き */
export function findSpecialSite(state: CityState, dev: number): { x: number; y: number } | null {
  const free = freeTiles(state, dev);
  const rank = (z: Zone) => (z === "special" ? 0 : z === "none" ? 1 : 2);
  free.sort((a, b) => rank(state.zones[idx(a.x, a.y)]) - rank(state.zones[idx(b.x, b.y)]));
  return free[0] ?? null;
}

/** 住宅と工業が隣接している組の数（公害による幸福度の減点） */
export function pollutionPairs(state: CityState): number {
  const grid = new Map<number, LineId>();
  for (const b of state.buildings) if (b.x >= 0 && b.line) grid.set(idx(b.x, b.y), b.line);
  let pairs = 0;
  for (const b of state.buildings) {
    if (b.line !== "housing" || b.x < 0) continue;
    for (const [dx, dy] of NEIGHBORS) {
      const n = grid.get(idx(b.x + dx, b.y + dy));
      if (inBounds(b.x + dx, b.y + dy) && n && LINES[n].category === "industry") pairs++;
    }
  }
  return pairs;
}
