// 描画に渡す盤面と、地面の絵のキー。マップの大きさはデータで決まる（RND-10）。
import { LINES, LINE_IDS, type LineId } from "@/game/catalog";

export interface IsoObject {
  id: string;
  x: number;
  y: number;
  /** 絵のキー（例 building/housing/2、building/housing/2@lv3） */
  key: string;
  /** 同じマスに重ねる時の前後（工事の覆いなど。大きいほど手前） */
  dz?: number;
  /** マスの中心からずらして置く（ドット、64px タイル基準。金鉱の前の金貨の山など） */
  ox?: number;
  oy?: number;
}

/** 土地用途（ゲームの Zone と同じ値。描画側は文字列として扱う） */
export type IsoZone = "residential" | "commercial" | "industrial" | "agricultural" | "public" | "special" | "none";

/** 盤面の上に重ねる情報（地面の絵や建物とは別に描き直す） */
export interface IsoOverlay {
  /** 行優先の土地用途。showZones の時だけ描く（OBJ-08） */
  zones?: IsoZone[];
  showZones?: boolean;
  /** 行優先。自動開発の対象外（OBJ-09） */
  noAuto?: boolean[];
  /** 工事の進み具合のバー（OBJ-07）。時刻はミリ秒 */
  jobs?: { x: number; y: number; startedAt: number; finishAt: number }[];
  /** 点滅させるマス（"x,y"。B6 の強調） */
  highlights?: string[];
  /** 夜の暗さ（0 = 昼、1 = 夜。OBJ-14） */
  night?: number;
  /** 夜に灯る窓の割合（0〜1。人口に比例させる） */
  lights?: number;
  /** 道路を行き交う人と車の数（OBJ-11。人口・物流効率に比例させ、上限を設ける） */
  people?: number;
  cars?: number;
  /**
   * 困りごとアイコン（A3）。建物の上に出す。kind は icons/<kind> の絵。
   * dark は電気が足りない建物で、夜も窓を灯さない
   */
  troubles?: { x: number; y: number; kind: string; dark?: boolean }[];
}

export interface IsoMap {
  width: number;
  height: number;
  /** 行優先。0 = 道路なし、1〜4 = 道路の段階＋1 */
  road: Uint8Array;
  /** 行優先。1 = 未開放の区画 */
  locked: Uint8Array;
  objects: IsoObject[];
}

/** 座標から決まる乱数（同じ街はいつも同じ見た目。OBJ-01） */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function isRoad(m: IsoMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.width && y < m.height && m.road[y * m.width + x] > 0;
}

/** 道路のつながり：北（y−1）=1、東（x+1）=2、南（y+1）=4、西（x−1）=8 */
export function roadMask(m: IsoMap, x: number, y: number): number {
  return (isRoad(m, x, y - 1) ? 1 : 0) | (isRoad(m, x + 1, y) ? 2 : 0) | (isRoad(m, x, y + 1) ? 4 : 0) | (isRoad(m, x - 1, y) ? 8 : 0);
}

export const GRASS_VARIANTS = 4;

export function groundKey(m: IsoMap, x: number, y: number): string {
  const i = y * m.width + x;
  if (m.locked[i]) return "ground/locked";
  if (m.road[i]) return `road/${m.road[i] - 1}/${roadMask(m, x, y)}`;
  return `ground/grass/${hash2(x, y) % GRASS_VARIANTS}`;
}

/** 道路を除いた建物の系統 */
export const BUILDING_LINES = LINE_IDS.filter((l) => l !== "road");

/**
 * 検証用のダミーマップ（RND-13）。6マスおきの道路、中心ほど高い段階の建物、外周は未開放。
 * 実際のゲームの盤面とは関係ない。
 */
export function dummyMap(size: number, seed = 1): IsoMap {
  const road = new Uint8Array(size * size);
  const locked = new Uint8Array(size * size);
  const objects: IsoObject[] = [];
  const mid = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const r = Math.max(Math.abs(x - mid), Math.abs(y - mid)) / (size / 2); // 0（中心）〜1（端）
      if (r > 0.9) {
        locked[i] = 1;
        continue;
      }
      if (x % 6 === 2 || y % 6 === 2) {
        road[i] = 1 + Math.min(3, Math.floor((1 - r) * 4));
        continue;
      }
      const h = hash2(x, y, seed);
      if (h % 100 >= 85) continue;
      const line: LineId = BUILDING_LINES[(hash2(Math.floor(x / 6), Math.floor(y / 6), seed) + (h % 3 === 0 ? h : 0)) % BUILDING_LINES.length];
      const tiers = LINES[line].tiers.length;
      const tier = Math.min(tiers - 1, Math.floor((1 - r) * tiers * 1.2 + ((h >> 8) % 2)));
      objects.push({ id: `${x},${y}`, x, y, key: `building/${line}/${Math.max(0, tier)}` });
    }
  }
  return { width: size, height: size, road, locked, objects };
}

/**
 * 画風の見本（§5.2「草の地面に建物を並べた街の見本」）。M0 の代表の絵（木造住宅・市場・工場・舗装道路）だけで作る。
 */
export function sampleMap(): IsoMap {
  const size = 12;
  const road = new Uint8Array(size * size);
  const locked = new Uint8Array(size * size);
  const objects: IsoObject[] = [];
  const kinds = ["building/housing/1", "building/commerce/2", "building/factory/1"];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x === 5 || y === 6) {
        road[i] = 2;
        continue;
      }
      // 左上は住宅、右上は市場、下は工場。ところどころ空き地を残す
      if (hash2(x, y, 3) % 5 === 0) continue;
      const k = y < 6 ? (x < 5 ? kinds[0] : kinds[1]) : kinds[2];
      objects.push({ id: `${x},${y}`, x, y, key: k });
    }
  return { width: size, height: size, road, locked, objects };
}
