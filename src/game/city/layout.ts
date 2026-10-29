// マップ：区画の解放、土地用途、自動配置（docs/map-layout-redesign.md）。
// v1 の街は 10×10 固定で発展Lvで区画が開く。v2 の街は銀行の中心が原点で、開拓した区画だけが使える。
import { LINES, type LineId, type Zone } from "../catalog";
import { LEGACY_MAP_SIZE, PLOT_SIZE } from "../config";
import { devLevel } from "../levels";
import type { Building, CityState, Job } from "../types";

export const tileKey = (x: number, y: number) => `${x},${y}`;
export const plotKey = (px: number, py: number) => `${px},${py}`;
export const plotOf = (x: number, y: number) => ({ px: Math.floor(x / PLOT_SIZE), py: Math.floor(y / PLOT_SIZE) });

export const isLegacy = (s: Pick<CityState, "v">) => s.v === 1;
export const isPlaced = (b: Pick<Building, "placed">) => b.placed !== false;

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 画面に出すマスの名前。v1 は 1 から数え、v2 は銀行の中心を (0, 0) とする */
export function tileLabel(s: Pick<CityState, "v">, x: number, y: number): string {
  return isLegacy(s) ? `マス (${x + 1}, ${y + 1})` : `マス (${x}, ${y})`;
}

// ---- 建物の大きさ ----

/** 建物の一辺のマス数 */
export function buildingSize(_s: Pick<CityState, "v">, _b: Pick<Building, "line" | "special" | "tier">): number {
  return 1;
}

/** 占有範囲のマス */
export function footprint(x: number, y: number, size: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) out.push({ x: x + dx, y: y + dy });
  return out;
}

/** 占有範囲の外周に辺で隣り合うマス */
export function perimeter(x: number, y: number, size: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let d = 0; d < size; d++) {
    out.push({ x: x + d, y: y - 1 }, { x: x + d, y: y + size }, { x: x - 1, y: y + d }, { x: x + size, y: y + d });
  }
  return out;
}

export function contains(b: { x: number; y: number }, size: number, x: number, y: number): boolean {
  return x >= b.x && y >= b.y && x < b.x + size && y < b.y + size;
}

// ---- 区画の解放 ----

/** v1：そのマスを使えるようになる発展Lv（中央4×4 → 6×6 → 8×8 → 左右の列 → 上下の行） */
export function tileUnlockLevel(x: number, y: number): number {
  const half = LEGACY_MAP_SIZE / 2;
  const edge = (v: number) => (v < half ? half - 1 - v : v - half);
  const ex = edge(x);
  const ey = edge(y);
  const r = Math.max(ex, ey);
  if (r <= 1) return 1;
  if (r === 2) return 2;
  if (r === 3) return 3;
  return ey === 4 ? 5 : 4;
}

function inLegacyBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < LEGACY_MAP_SIZE && y < LEGACY_MAP_SIZE;
}

const setCache = new WeakMap<string[], { n: number; set: Set<string> }>();
/** 配列を集合として引く（配列は足すか作り直すだけなので、長さが同じ間は作り直さない） */
function asSet(list: string[]): Set<string> {
  const c = setCache.get(list);
  if (c && c.n === list.length) return c.set;
  const set = new Set(list);
  setCache.set(list, { n: list.length, set });
  return set;
}

export function plotSet(s: Pick<CityState, "plots">): Set<string> {
  return asSet(s.plots ?? []);
}

/** 盤面の中か（v1 は 10×10、v2 は座標が整数なら常に中） */
export function inBounds(s: Pick<CityState, "v">, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return isLegacy(s) ? inLegacyBounds(x, y) : true;
}

export function isTileUnlocked(s: Pick<CityState, "v" | "devPoints" | "plots">, x: number, y: number): boolean {
  if (!inBounds(s, x, y)) return false;
  if (isLegacy(s)) return tileUnlockLevel(x, y) <= devLevel(s.devPoints);
  const { px, py } = plotOf(x, y);
  return plotSet(s).has(plotKey(px, py));
}

/** 開いているマス（行優先ではなく、区画ごとの順） */
export function openTiles(s: Pick<CityState, "v" | "devPoints" | "plots">): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (isLegacy(s)) {
    const dev = devLevel(s.devPoints);
    for (let y = 0; y < LEGACY_MAP_SIZE; y++) for (let x = 0; x < LEGACY_MAP_SIZE; x++) if (tileUnlockLevel(x, y) <= dev) out.push({ x, y });
    return out;
  }
  for (const k of s.plots ?? []) {
    const [px, py] = k.split(",").map(Number);
    for (let y = py * PLOT_SIZE; y < (py + 1) * PLOT_SIZE; y++) for (let x = px * PLOT_SIZE; x < (px + 1) * PLOT_SIZE; x++) out.push({ x, y });
  }
  return out;
}

export function unlockedTileCount(s: Pick<CityState, "v" | "devPoints" | "plots">): number {
  return isLegacy(s) ? openTiles(s).length : (s.plots ?? []).length * PLOT_SIZE * PLOT_SIZE;
}

/**
 * 盤面の範囲（マス）。v1 は未開放を含む 10×10、v2 は開拓した区画を囲む矩形。
 * 描画はこれに未開放の帯を足して描く
 */
export function landBounds(s: Pick<CityState, "v" | "plots">): Rect {
  if (isLegacy(s)) return { minX: 0, minY: 0, maxX: LEGACY_MAP_SIZE - 1, maxY: LEGACY_MAP_SIZE - 1 };
  const r: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const k of s.plots ?? []) {
    const [px, py] = k.split(",").map(Number);
    r.minX = Math.min(r.minX, px * PLOT_SIZE);
    r.minY = Math.min(r.minY, py * PLOT_SIZE);
    r.maxX = Math.max(r.maxX, (px + 1) * PLOT_SIZE - 1);
    r.maxY = Math.max(r.maxY, (py + 1) * PLOT_SIZE - 1);
  }
  return r.minX === Infinity ? { minX: 0, minY: 0, maxX: 0, maxY: 0 } : r;
}

export const DISTRICT_NAMES: Record<number, string> = {
  1: "中心部",
  2: "周辺の住宅・農業エリア",
  3: "工業・商業エリア",
  4: "東西の追加区画",
  5: "南北の追加区画",
};

// ---- 土地用途と自動建設の禁止 ----

export function zoneAt(s: Pick<CityState, "zones">, x: number, y: number): Zone {
  return s.zones[tileKey(x, y)] ?? "none";
}

export function isNoAuto(s: Pick<CityState, "noAuto">, x: number, y: number): boolean {
  return asSet(s.noAuto).has(tileKey(x, y));
}

/** v1：初期の土地用途の提案。中央が特殊地区、四象限に住宅・商業・農業・工業 */
export function legacyZones(): Record<string, Zone> {
  const zones: Record<string, Zone> = {};
  const mid = LEGACY_MAP_SIZE / 2;
  for (let y = 0; y < LEGACY_MAP_SIZE; y++) {
    for (let x = 0; x < LEGACY_MAP_SIZE; x++) {
      let z: Zone;
      const centerCol = x === mid - 1 || x === mid;
      if (centerCol && (y === mid - 1 || y === mid)) z = "special";
      else if (centerCol) z = y < mid ? "public" : "none";
      else if (x < mid && y < mid) z = "residential";
      else if (x >= mid && y < mid) z = "commercial";
      else if (x < mid) z = "agricultural";
      else z = "industrial";
      if (z !== "none") zones[tileKey(x, y)] = z;
    }
  }
  return zones;
}

/** v2：初期の土地用途の提案。原点のまわりが特殊地区、四象限に住宅・商業・農業・工業 */
export function initialZones(): Record<string, Zone> {
  const zones: Record<string, Zone> = {};
  for (let y = -PLOT_SIZE; y < PLOT_SIZE; y++)
    for (let x = -PLOT_SIZE; x < PLOT_SIZE; x++) {
      const center = Math.abs(x) <= 1 && Math.abs(y) <= 1;
      zones[tileKey(x, y)] = center ? "special" : y < 0 ? (x < 0 ? "residential" : "commercial") : x < 0 ? "agricultural" : "industrial";
    }
  return zones;
}

/**
 * 古い形（10×10 の行優先配列）で保存された土地用途・自動建設の禁止を、マスのキーの形にする。
 * v1 の街の遊び方は変えない（docs/map-layout-redesign.md §6.5）
 */
export function normalizeCity<T extends Pick<CityState, "v" | "zones" | "noAuto" | "buildings">>(s: T): T {
  if (Array.isArray(s.zones)) {
    const old = s.zones as unknown as Zone[];
    const zones: Record<string, Zone> = {};
    old.forEach((z, i) => {
      if (z && z !== "none") zones[tileKey(i % LEGACY_MAP_SIZE, Math.floor(i / LEGACY_MAP_SIZE))] = z;
    });
    s.zones = zones;
  }
  if (s.noAuto.length && typeof s.noAuto[0] === "boolean") {
    const old = s.noAuto as unknown as boolean[];
    s.noAuto = old.flatMap((on, i) => (on ? [tileKey(i % LEGACY_MAP_SIZE, Math.floor(i / LEGACY_MAP_SIZE))] : []));
  }
  if (isLegacy(s)) for (const b of s.buildings) if (b.x < 0 && b.placed !== false) b.placed = false;
  return s;
}

// ---- 占有と配置 ----

/** 建物と新築の工事が占めているマス（"x,y" → 建物ID） */
export function occupancy(s: CityState): Map<string, string> {
  const occ = new Map<string, string>();
  for (const b of s.buildings) {
    if (!isPlaced(b)) continue;
    for (const t of footprint(b.x, b.y, buildingSize(s, b))) occ.set(tileKey(t.x, t.y), b.id);
  }
  for (const j of s.jobs) {
    if (j.kind !== "build") continue;
    for (const t of footprint(j.x, j.y, jobSize(s, j))) occ.set(tileKey(t.x, t.y), j.buildingId);
  }
  return occ;
}

export function jobSize(s: Pick<CityState, "v">, j: Pick<Job, "line" | "tier">): number {
  return buildingSize(s, { line: j.line, tier: j.tier });
}

/** 占有範囲がすべて開いていて空いているか（ignore の建物は空きとみなす。移動用） */
export function fits(s: CityState, x: number, y: number, size: number, occ = occupancy(s), ignore?: string): boolean {
  for (const t of footprint(x, y, size)) {
    if (!isTileUnlocked(s, t.x, t.y)) return false;
    const o = occ.get(tileKey(t.x, t.y));
    if (o && o !== ignore) return false;
  }
  return true;
}

/** 建てられる場所（左上のマス）。size×size が収まるところ */
export function freeSites(s: CityState, size: number, occ = occupancy(s)): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const t of openTiles(s)) if (fits(s, t.x, t.y, size, occ)) out.push(t);
  return out;
}

/** 盤面の中心（自動配置は中心に近いほど加点する） */
function centerOf(s: Pick<CityState, "v">): { x: number; y: number } {
  return isLegacy(s) ? { x: 4.5, y: 4.5 } : { x: 0, y: 0 };
}

/** 占有範囲に隣り合う建物の系統（特殊施設は "special"） */
function neighborLines(s: CityState, x: number, y: number, size: number, grid: Map<string, LineId | "special">): (LineId | "special")[] {
  const out: (LineId | "special")[] = [];
  for (const t of perimeter(x, y, size)) {
    const n = grid.get(tileKey(t.x, t.y));
    if (n) out.push(n);
  }
  return out;
}

function lineGrid(s: CityState): Map<string, LineId | "special"> {
  const grid = new Map<string, LineId | "special">();
  for (const b of s.buildings) {
    if (!isPlaced(b)) continue;
    for (const t of footprint(b.x, b.y, buildingSize(s, b))) grid.set(tileKey(t.x, t.y), b.line ?? "special");
  }
  for (const j of s.jobs) {
    if (j.kind !== "build") continue;
    for (const t of footprint(j.x, j.y, jobSize(s, j))) grid.set(tileKey(t.x, t.y), j.line);
  }
  return grid;
}

/**
 * 自動配置の場所を選ぶ。用途が一致する土地 → 未指定の土地 の順。
 * 同系統の隣接と道路の隣接を加点し、住宅と工業の隣接を減点する。決定的にタイブレークする。
 */
export function findSite(s: CityState, line: LineId): { x: number; y: number } | null {
  const def = LINES[line];
  const size = buildingSize(s, { line, tier: 0 });
  const grid = lineGrid(s);
  const c = centerOf(s);
  const half = (size - 1) / 2;

  let best: { x: number; y: number; score: number } | null = null;
  for (const { x, y } of freeSites(s, size)) {
    if (footprint(x, y, size).some((t) => isNoAuto(s, t.x, t.y))) continue;
    const zone = zoneAt(s, x, y);
    let score: number;
    if (def.zone === "any") {
      // 交通施設は空き地を優先し、建物の多い場所に引く
      score = zone === "none" ? 20 : zone === "special" ? -100 : 0;
    } else if (zone === def.zone) score = 100;
    else if (zone === "none") score = 40;
    else continue;

    const neighbors = neighborLines(s, x, y, size, grid);
    for (const n of neighbors) {
      if (n === line) score += 3;
      if (n === "road" || n === "rail") score += 2;
      const isHousing = line === "housing" || n === "housing";
      const nCat = n === "special" ? null : LINES[n].category;
      if (isHousing && (def.category === "industry" || nCat === "industry") && line !== n) score -= 6;
    }
    if (def.zone === "any") score += neighbors.length * 4;
    score -= (Math.abs(x + half - c.x) + Math.abs(y + half - c.y)) * 0.5;
    if (!best || score > best.score) best = { x, y, score };
  }
  return best ? { x: best.x, y: best.y } : null;
}

/** 特殊施設（公園・像）の場所：特殊地区 → 未指定 → 任意の空き */
export function findSpecialSite(s: CityState, size: number): { x: number; y: number } | null {
  const free = freeSites(s, size);
  const rank = (z: Zone) => (z === "special" ? 0 : z === "none" ? 1 : 2);
  free.sort((a, b) => rank(zoneAt(s, a.x, a.y)) - rank(zoneAt(s, b.x, b.y)));
  return free[0] ?? null;
}

/** 住宅と工業が隣接している組の数（公害による幸福度の減点） */
export function pollutionPairs(s: CityState): number {
  const owner = new Map<string, Building>();
  for (const b of s.buildings) {
    if (!isPlaced(b) || !b.line) continue;
    for (const t of footprint(b.x, b.y, buildingSize(s, b))) owner.set(tileKey(t.x, t.y), b);
  }
  let pairs = 0;
  for (const b of s.buildings) {
    if (b.line !== "housing" || !isPlaced(b)) continue;
    const size = buildingSize(s, b);
    // v1（1マス）は辺ごとに数える。大きな建物は同じ隣の建物を1回だけ数える
    const seen = new Set<string>();
    for (const t of perimeter(b.x, b.y, size)) {
      const n = owner.get(tileKey(t.x, t.y));
      if (!n?.line || LINES[n.line].category !== "industry") continue;
      if (size > 1 && seen.has(n.id)) continue;
      seen.add(n.id);
      pairs++;
    }
  }
  return pairs;
}
