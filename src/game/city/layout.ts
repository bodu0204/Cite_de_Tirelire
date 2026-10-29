// マップ：区画の解放、土地用途、自動配置（docs/map-layout-redesign.md）。
// v1 の街は 10×10 固定で発展Lvで区画が開く。v2 の街は銀行の中心が原点で、開拓した区画だけが使える。
import { LINES, type LineId, type Zone } from "../catalog";
import { DEV_THRESHOLDS, LEGACY_MAP_SIZE, MAX_PLOTS, PLOT_LIMIT, PLOT_SIZE, PLOT_STEP, PLOT_STEP_POINTS } from "../config";
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

/** 高額なサブスクの公園（3×3）になる公園の段階（月額 3,000円以上。Q1） */
export const BIG_PARK_TIER = 3;

/**
 * 建物の一辺のマス数（docs/map-layout-redesign.md §4.1）。v1 の街はすべて1マス。
 * v2 は道路・像が 1×1、銀行と高額なサブスクの公園が 3×3、それ以外（鉄道・金鉱・銀鉱・ほかの公園を含む）が 2×2
 */
export function buildingSize(s: Pick<CityState, "v">, b: Pick<Building, "line" | "special" | "tier">): number {
  if (isLegacy(s)) return 1;
  if (b.line === "road" || b.special === "statue") return 1;
  if (b.special === "bank") return 3;
  if (b.special === "park") return b.tier >= BIG_PARK_TIER ? 3 : 2;
  return 2;
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

/**
 * v2：初期の土地用途の提案。中心の 10×10 の四つの区画を住宅（北西）・商業（北東）・農業（南西）・工業（南東）にし、
 * 銀行のまわりの街区（−2〜1）と、金鉱・銀鉱の敷地を特殊地区にする
 */
export function initialZones(): Record<string, Zone> {
  const zones: Record<string, Zone> = {};
  const special = (x: number, y: number) =>
    (x >= -2 && x <= 1 && y >= -2 && y <= 1) || (x >= 3 && x <= 4 && y >= -2 && y <= -1) || (x >= -2 && x <= -1 && y >= 3 && y <= 4);
  for (let y = -PLOT_SIZE; y < PLOT_SIZE; y++)
    for (let x = -PLOT_SIZE; x < PLOT_SIZE; x++)
      zones[tileKey(x, y)] = special(x, y) ? "special" : y < 0 ? (x < 0 ? "residential" : "commercial") : x < 0 ? "agricultural" : "industrial";
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

type Kind = Pick<Building, "line" | "special" | "tier">;

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

// ---- 道路網（docs/map-layout-redesign.md §5） ----

const mod = (v: number, n: number) => ((v % n) + n) % n;

/** 推奨道路：区画の真ん中を通る十字（x か y を 5 で割った余りが 2）。2×2 の建物2列と道路1列がそろう */
export function isPlannedRoad(x: number, y: number): boolean {
  return mod(x, PLOT_SIZE) === 2 || mod(y, PLOT_SIZE) === 2;
}

export interface RoadNetwork {
  /** 銀行まで道路だけでつながった道路のマス */
  tiles: Set<string>;
  /** 銀行の占有範囲（道路は銀行の隣から延ばせる） */
  bank: Set<string>;
}

/**
 * 道路網：銀行に接する道路から、辺で隣り合う道路をたどって行ける道路（Q4）。建設中の道路も含める。
 * without の道路は無いものとして作る（撤去・移動の確かめ）
 */
export function roadNetwork(s: CityState, without?: string): RoadNetwork {
  const roads = new Set<string>();
  for (const b of s.buildings) if (b.line === "road" && isPlaced(b) && b.id !== without) roads.add(tileKey(b.x, b.y));
  for (const j of s.jobs) if (j.kind === "build" && j.line === "road" && j.buildingId !== without) roads.add(tileKey(j.x, j.y));
  const bank = new Set<string>();
  const b = s.buildings.find((o) => o.special === "bank" && isPlaced(o));
  const tiles = new Set<string>();
  if (!b) return { tiles, bank };
  const size = buildingSize(s, b);
  for (const t of footprint(b.x, b.y, size)) bank.add(tileKey(t.x, t.y));
  const queue: { x: number; y: number }[] = [];
  for (const t of perimeter(b.x, b.y, size)) {
    const k = tileKey(t.x, t.y);
    if (roads.has(k) && !tiles.has(k)) {
      tiles.add(k);
      queue.push(t);
    }
  }
  while (queue.length) {
    const t = queue.pop()!;
    for (const n of perimeter(t.x, t.y, 1)) {
      const k = tileKey(n.x, n.y);
      if (!roads.has(k) || tiles.has(k)) continue;
      tiles.add(k);
      queue.push(n);
    }
  }
  return { tiles, bank };
}

/**
 * 道路網のきまりを満たすか（v1 の街は常に満たす）。
 * 道路以外は占有範囲の外周が道路網の道路に接すること。道路は道路網か銀行に隣り合うこと（網の端から延ばす形）
 */
export function connected(s: CityState, net: RoadNetwork, b: Kind, x: number, y: number): boolean {
  if (isLegacy(s)) return true;
  const size = buildingSize(s, b);
  for (const t of perimeter(x, y, size)) {
    const k = tileKey(t.x, t.y);
    if (net.tiles.has(k) || (b.line === "road" && net.bank.has(k))) return true;
  }
  return false;
}

export interface PlaceCtx {
  occ: Map<string, string>;
  net: RoadNetwork;
  /** 空きとみなす建物（移動する建物自身） */
  ignore?: string;
}

/** 配置の確かめに使う盤面の情報。道路を動かす時は、その道路を除いた道路網で確かめる */
export function placeCtx(s: CityState, ignore?: string): PlaceCtx {
  const moving = ignore ? s.buildings.find((b) => b.id === ignore) : undefined;
  return { occ: occupancy(s), net: roadNetwork(s, moving?.line === "road" ? ignore : undefined), ignore };
}

/** (x, y) を左上にして置けるか（開いた区画・空き・道路網） */
export function canPlace(s: CityState, b: Kind, x: number, y: number, c = placeCtx(s)): boolean {
  return fits(s, x, y, buildingSize(s, b), c.occ, c.ignore) && connected(s, c.net, b, x, y);
}

/**
 * 選んだマス（tx, ty）を含むように置ける左上のマス。選んだマスを左上にできればそれを、
 * できなければ占有範囲が選んだマスを含むほかの置き方を、左上から順に試す
 */
export function placementFor(s: CityState, b: Kind, tx: number, ty: number, c = placeCtx(s)): { x: number; y: number } | null {
  const size = buildingSize(s, b);
  if (canPlace(s, b, tx, ty, c)) return { x: tx, y: ty };
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      if ((dx || dy) && canPlace(s, b, tx - dx, ty - dy, c)) return { x: tx - dx, y: ty - dy };
    }
  return null;
}

/** 選んだマスに置けない理由（置けるなら null） */
export function placementError(s: CityState, b: Kind, tx: number, ty: number, c = placeCtx(s)): string | null {
  if (placementFor(s, b, tx, ty, c)) return null;
  if (!inBounds(s, tx, ty)) return "マップの外です";
  if (!isTileUnlocked(s, tx, ty)) return "まだ解放されていない区画です";
  const o = c.occ.get(tileKey(tx, ty));
  if (o && o !== c.ignore) return "そのマスは使用中です";
  const size = buildingSize(s, b);
  // 空きはあるのに置けない：道路網に接していない
  let room = false;
  for (let dy = 0; dy < size && !room; dy++) for (let dx = 0; dx < size && !room; dx++) room = fits(s, tx - dx, ty - dy, size, c.occ, c.ignore);
  if (!room) return `${size}×${size} マスの空きがありません`;
  return b.line === "road" ? "道路は、銀行までつながった道路の隣に建ててください" : "銀行までつながった道路に接していません";
}

/**
 * 置ける場所（左上のマス、y・x の小さい順）。v1 は開いたマスすべてを、v2 は道路網に接する場所だけを調べる
 */
export function candidateSites(s: CityState, b: Kind, c = placeCtx(s)): { x: number; y: number }[] {
  if (isLegacy(s)) return openTiles(s).filter((t) => canPlace(s, b, t.x, t.y, c));
  const size = buildingSize(s, b);
  const seen = new Set<string>();
  const out: { x: number; y: number }[] = [];
  const near = b.line === "road" ? [...c.net.tiles, ...c.net.bank] : [...c.net.tiles];
  for (const k of near) {
    const [rx, ry] = k.split(",").map(Number);
    for (const n of perimeter(rx, ry, 1))
      for (let dy = 0; dy < size; dy++)
        for (let dx = 0; dx < size; dx++) {
          const x = n.x - dx;
          const y = n.y - dy;
          const key = tileKey(x, y);
          if (seen.has(key)) continue;
          seen.add(key);
          if (canPlace(s, b, x, y, c)) out.push({ x, y });
        }
  }
  return out.sort((a, b2) => a.y - b2.y || a.x - b2.x);
}

/** 盤面の中心（自動配置は中心に近いほど加点する） */
function centerOf(s: Pick<CityState, "v">): { x: number; y: number } {
  return isLegacy(s) ? { x: 4.5, y: 4.5 } : { x: 0, y: 0 };
}

/** 占有範囲に隣り合う建物の系統（特殊施設は "special"） */
function neighborLines(x: number, y: number, size: number, grid: Map<string, LineId | "special">): (LineId | "special")[] {
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

/** 自動開発が使ってよい場所か（v2 は、道路は推奨道路の上だけ、ほかの建物は推奨道路をふさがない。§5.3） */
function autoAllowed(s: CityState, line: LineId, x: number, y: number, size: number): boolean {
  if (footprint(x, y, size).some((t) => isNoAuto(s, t.x, t.y))) return false;
  if (isLegacy(s)) return true;
  if (line === "road") return isPlannedRoad(x, y);
  return !footprint(x, y, size).some((t) => isPlannedRoad(t.x, t.y));
}

/**
 * 自動開発の1回の計画で使い回す盤面の情報（計画を立てる間は街が変わらないので、系統ごとに作り直さない）
 */
export interface SiteCache {
  ctx?: PlaceCtx;
  grid?: Map<string, LineId | "special">;
  /** 大きさ・道路かどうかごとの置ける場所 */
  sites: Map<string, { x: number; y: number }[]>;
}

export const siteCache = (): SiteCache => ({ sites: new Map() });

function cachedSites(s: CityState, kind: Kind, cache?: SiteCache): { x: number; y: number }[] {
  if (!cache) return candidateSites(s, kind);
  const key = `${buildingSize(s, kind)}:${kind.line === "road"}`;
  let list = cache.sites.get(key);
  if (!list) {
    cache.ctx ??= placeCtx(s);
    list = candidateSites(s, kind, cache.ctx);
    cache.sites.set(key, list);
  }
  return list;
}

/**
 * 自動配置の場所を選ぶ。用途が一致する土地 → 未指定の土地 の順。
 * 同系統の隣接と道路の隣接を加点し、住宅と工業の隣接を減点する。決定的にタイブレークする。
 */
export function findSite(s: CityState, line: LineId, cache?: SiteCache): { x: number; y: number } | null {
  const def = LINES[line];
  const kind = { line, tier: 0 };
  const size = buildingSize(s, kind);
  const grid = cache ? (cache.grid ??= lineGrid(s)) : lineGrid(s);
  const c = centerOf(s);
  const half = (size - 1) / 2;

  let best: { x: number; y: number; score: number } | null = null;
  for (const { x, y } of cachedSites(s, kind, cache)) {
    if (!autoAllowed(s, line, x, y, size)) continue;
    const zone = zoneAt(s, x, y);
    let score: number;
    if (def.zone === "any") {
      // 交通施設は空き地を優先し、建物の多い場所に引く
      score = zone === "none" ? 20 : zone === "special" ? -100 : 0;
    } else if (zone === def.zone) score = 100;
    else if (zone === "none") score = 40;
    else continue;

    const neighbors = neighborLines(x, y, size, grid);
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

/** 特殊施設（公園・像）の場所：特殊地区 → 未指定 → 任意の空き。v2 は推奨道路をふさがない */
export function findSpecialSite(s: CityState, b: Kind): { x: number; y: number } | null {
  const size = buildingSize(s, b);
  const free = candidateSites(s, b).filter((t) => isLegacy(s) || !footprint(t.x, t.y, size).some((f) => isPlannedRoad(f.x, f.y)));
  const rank = (z: Zone) => (z === "special" ? 0 : z === "none" ? 1 : 2);
  free.sort((a, b2) => rank(zoneAt(s, a.x, a.y)) - rank(zoneAt(s, b2.x, b2.y)));
  return free[0] ?? null;
}

/**
 * 道路 roadId を外すと、銀行とのつながりが切れるもの（なければ null）。
 * 道路網から外れる道路があるか、道路網に接しなくなる建物・工事があれば、その名前の代わりに建物ID を返す
 */
export function removalBreaks(s: CityState, roadId: string): string | null {
  if (isLegacy(s)) return null;
  const net = roadNetwork(s, roadId);
  for (const b of s.buildings) {
    if (b.id === roadId || !isPlaced(b)) continue;
    if (b.line === "road" ? !net.tiles.has(tileKey(b.x, b.y)) : !connected(s, net, b, b.x, b.y)) return b.id;
  }
  for (const j of s.jobs) {
    if (j.kind !== "build" || j.buildingId === roadId) continue;
    if (j.line === "road" ? !net.tiles.has(tileKey(j.x, j.y)) : !connected(s, net, j, j.x, j.y)) return j.buildingId;
  }
  return null;
}

// ---- 開拓（docs/map-layout-redesign.md §7） ----

/** 開拓できる区画数の上限（初期の区画を含む。Q8） */
export function plotLimit(devPoints: number): number {
  const lv = devLevel(devPoints);
  const base = PLOT_LIMIT[Math.min(lv, PLOT_LIMIT.length) - 1];
  const top = DEV_THRESHOLDS[DEV_THRESHOLDS.length - 1];
  const extra = devPoints > top ? Math.floor((devPoints - top) / PLOT_STEP_POINTS) * PLOT_STEP : 0;
  return Math.min(MAX_PLOTS, base + extra);
}

/** 開拓中の区画（"px,py"） */
export function expandingPlots(s: Pick<CityState, "jobs">): Set<string> {
  return new Set(s.jobs.flatMap((j) => (j.kind === "expand" && j.plot ? [j.plot] : [])));
}

/** 開いた区画と開拓中の区画の数（上限と比べる数） */
export function plotsUsed(s: Pick<CityState, "plots" | "jobs">): number {
  return (s.plots ?? []).length + expandingPlots(s).size;
}

/** 区画の推奨道路（真ん中を通る十字、9マス） */
export function plotCross(px: number, py: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let d = 0; d < PLOT_SIZE; d++) out.push({ x: px * PLOT_SIZE + 2, y: py * PLOT_SIZE + d });
  for (let d = 0; d < PLOT_SIZE; d++) if (d !== 2) out.push({ x: px * PLOT_SIZE + d, y: py * PLOT_SIZE + 2 });
  return out;
}

/** その区画を開拓できない理由（できれば null） */
export function expansionError(s: CityState, px: number, py: number, net = roadNetwork(s)): string | null {
  if (isLegacy(s)) return "この街は区画を開拓できません";
  const k = plotKey(px, py);
  if (plotSet(s).has(k)) return "開拓済みの区画です";
  if (expandingPlots(s).has(k)) return "開拓中の区画です";
  const near = [plotKey(px + 1, py), plotKey(px - 1, py), plotKey(px, py + 1), plotKey(px, py - 1)];
  if (!near.some((n) => plotSet(s).has(n))) return "開拓済みの区画の隣から開拓してください";
  if (plotsUsed(s) >= plotLimit(s.devPoints)) {
    return plotsUsed(s) >= MAX_PLOTS ? "これ以上は開拓できません" : `開拓できる区画は ${plotLimit(s.devPoints)} までです。発展Lvを上げると増えます`;
  }
  // 区画の十字の道路が、銀行までつながった道路の隣に来ること（Q4）
  if (!plotCross(px, py).some((t) => perimeter(t.x, t.y, 1).some((n) => net.tiles.has(tileKey(n.x, n.y))))) return "銀行までつながった道路が、この区画の境目まで届いていません";
  return null;
}

/** 開拓できる区画（"px,py"） */
export function expandablePlots(s: CityState, net = roadNetwork(s)): string[] {
  if (isLegacy(s)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of s.plots ?? []) {
    const [px, py] = k.split(",").map(Number);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = plotKey(px + dx, py + dy);
      if (seen.has(n)) continue;
      seen.add(n);
      if (!expansionError(s, px + dx, py + dy, net)) out.push(n);
    }
  }
  return out;
}

/** 区画の中で一番多い土地用途（未指定・特殊地区を除く） */
function plotZone(s: CityState, px: number, py: number): Zone | null {
  const count = new Map<Zone, number>();
  for (let y = py * PLOT_SIZE; y < (py + 1) * PLOT_SIZE; y++)
    for (let x = px * PLOT_SIZE; x < (px + 1) * PLOT_SIZE; x++) {
      const z = zoneAt(s, x, y);
      if (z !== "none" && z !== "special") count.set(z, (count.get(z) ?? 0) + 1);
    }
  let best: Zone | null = null;
  for (const [z, n] of count) if (!best || n > count.get(best)!) best = z;
  return best;
}

/**
 * 自動開発が開く区画：同じ用途の区画の隣を優先し、次に銀行に近いもの。決定的にタイブレークする
 */
export function choosePlot(s: CityState, zone: Zone | null, cache?: SiteCache): string | null {
  let best: { k: string; score: number } | null = null;
  const net = cache ? (cache.ctx ??= placeCtx(s)).net : roadNetwork(s);
  for (const k of expandablePlots(s, net)) {
    const [px, py] = k.split(",").map(Number);
    let score = -Math.hypot(px + 0.5, py + 0.5);
    if (zone)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        if (plotSet(s).has(plotKey(px + dx, py + dy)) && plotZone(s, px + dx, py + dy) === zone) score += 3;
    if (!best || score > best.score) best = { k, score };
  }
  return best?.k ?? null;
}

/** マップ外に置かれた特殊施設を、場所ができたら置く（区画の解放・開拓・撤去のあと） */
export function placeOffMapSpecials(s: CityState) {
  for (const b of s.buildings) {
    if (isPlaced(b) || !b.special) continue;
    const site = findSpecialSite(s, b);
    if (!site) continue;
    b.x = site.x;
    b.y = site.y;
    delete b.placed;
  }
}

/** 住宅と工業が隣接している組の数（公害による幸福度の減点） */
export function pollutionPairs(s: CityState): number {
  // 毎ティック数えるので、工業の建物のマスだけを引けるようにする
  const industry = new Map<string, string>();
  for (const b of s.buildings) {
    if (!isPlaced(b) || !b.line || LINES[b.line].category !== "industry") continue;
    for (const t of footprint(b.x, b.y, buildingSize(s, b))) industry.set(tileKey(t.x, t.y), b.id);
  }
  if (!industry.size) return 0;
  let pairs = 0;
  for (const b of s.buildings) {
    if (b.line !== "housing" || !isPlaced(b)) continue;
    const size = buildingSize(s, b);
    // v1（1マス）は辺ごとに数える。大きな建物は同じ隣の建物を1回だけ数える
    const seen = new Set<string>();
    for (const t of perimeter(b.x, b.y, size)) {
      const n = industry.get(tileKey(t.x, t.y));
      if (!n) continue;
      if (size > 1 && seen.has(n)) continue;
      seen.add(n);
      pairs++;
    }
  }
  return pairs;
}
