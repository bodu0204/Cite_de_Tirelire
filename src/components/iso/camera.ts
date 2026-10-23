// カメラ（CAM-01〜04・CAM-09）。描画ライブラリに依存しない純粋な計算だけを置く。
// zoom は「1ドットを何物理ピクセルで描くか」。操作中以外は整数に止める（CAM-03）。
import type { Rect } from "./chunks";

export interface Camera {
  /** 画面の中心に来るワールド座標 */
  cx: number;
  cy: number;
  zoom: number;
}

/** 画面の大きさ（CSS px）と devicePixelRatio */
export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

/**
 * 整数倍ズームの範囲。上限は「1ドット＝3 CSS px」相当（devicePixelRatio に合わせる。§10.1）。
 * 下限は1物理ピクセル。
 */
export function zoomRange(dpr: number): { min: number; max: number } {
  return { min: 1, max: Math.max(4, Math.round(dpr * 3)) };
}

/** 1ドット＝1 CSS px に一番近い整数倍（初めて開いた時の倍率） */
export function defaultZoom(dpr: number, tw: number): number {
  const r = zoomRange(dpr);
  return clamp(Math.round((dpr * 64) / tw), r.min, r.max);
}

export function snapZoom(z: number, dpr: number): number {
  const r = zoomRange(dpr);
  return clamp(Math.round(z), r.min, r.max);
}

/** ＋−ボタン・ホイールの1段（CAM-02） */
export function stepZoom(z: number, dir: 1 | -1, dpr: number): number {
  const r = zoomRange(dpr);
  const base = dir > 0 ? Math.floor(z) : Math.ceil(z);
  return clamp(base + dir, r.min, r.max);
}

/** ワールド1ドットあたりの CSS px */
export const scaleOf = (zoom: number, dpr: number) => zoom / dpr;

/** ワールドを置く位置（CSS px）。物理ピクセル単位に丸める（CAM-04） */
export function worldOffset(cam: Camera, v: Viewport): { x: number; y: number } {
  const s = scaleOf(cam.zoom, v.dpr);
  return {
    x: Math.round((v.w / 2 - cam.cx * s) * v.dpr) / v.dpr,
    y: Math.round((v.h / 2 - cam.cy * s) * v.dpr) / v.dpr,
  };
}

export function screenToWorld(cam: Camera, v: Viewport, px: number, py: number): { x: number; y: number } {
  const s = scaleOf(cam.zoom, v.dpr);
  const o = worldOffset(cam, v);
  return { x: (px - o.x) / s, y: (py - o.y) / s };
}

export function viewRect(cam: Camera, v: Viewport): Rect {
  const a = screenToWorld(cam, v, 0, 0);
  const b = screenToWorld(cam, v, v.w, v.h);
  return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
}

/** 画面上の (px, py) の下にある点を動かさずに倍率を変える（ピンチ・ホイール） */
export function zoomAt(cam: Camera, v: Viewport, zoom: number, px: number, py: number): Camera {
  const s0 = scaleOf(cam.zoom, v.dpr);
  const s1 = scaleOf(zoom, v.dpr);
  const wx = cam.cx + (px - v.w / 2) / s0;
  const wy = cam.cy + (py - v.h / 2) / s0;
  return { zoom, cx: wx - (px - v.w / 2) / s1, cy: wy - (py - v.h / 2) / s1 };
}

/** 中心をマップの範囲に収める（マップの外へ出過ぎない。CAM-01） */
export function clampCamera(cam: Camera, bounds: Rect): Camera {
  return { ...cam, cx: clamp(cam.cx, bounds.minX, bounds.maxX), cy: clamp(cam.cy, bounds.minY, bounds.maxY) };
}

/**
 * 街全体が収まる倍率（CAM-09 のカメラ固定の表示）。1倍以上なら整数に切り捨て、
 * 収まらない時だけ 1倍未満の縮小を許す（§10.1）。
 */
export function fitZoom(bounds: Rect, v: Viewport, padding = 8): number {
  const sx = ((v.w - padding * 2) * v.dpr) / (bounds.maxX - bounds.minX);
  const sy = ((v.h - padding * 2) * v.dpr) / (bounds.maxY - bounds.minY);
  const z = Math.min(sx, sy);
  if (z >= 1) return Math.min(Math.floor(z), zoomRange(v.dpr).max);
  // 縮小時は 1/2・1/3… に止め、ドットの間引きを揃える
  return 1 / Math.ceil(1 / z);
}

/** 慣性の減衰（時定数 325ms。iOS のスクロールに近い） */
export function decay(v: number, dtMs: number): number {
  return v * Math.exp(-dtMs / 325);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
