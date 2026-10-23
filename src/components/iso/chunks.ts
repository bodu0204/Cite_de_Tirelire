// チャンク分割と画面外の省略（RND-11・RND-12）。
import { type Iso, toScreen } from "./projection";

export const CHUNK = 16;

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ChunkId {
  cx: number;
  cy: number;
}

export const chunkKey = (c: ChunkId) => `${c.cx},${c.cy}`;

export function chunkOf(x: number, y: number): ChunkId {
  return { cx: Math.floor(x / CHUNK), cy: Math.floor(y / CHUNK) };
}

/** チャンクの地面を焼き付ける矩形（ワールド座標）。大きさは常に 16tw × 16th */
export function chunkRect(p: Iso, c: ChunkId): Rect {
  const x0 = c.cx * CHUNK;
  const y0 = c.cy * CHUNK;
  const left = toScreen(p, x0, y0 + CHUNK - 1).sx - p.tw / 2;
  const top = toScreen(p, x0, y0).sy - p.th / 2;
  return { minX: left, minY: top, maxX: left + CHUNK * p.tw, maxY: top + CHUNK * p.th };
}

/** チャンクの地面のひし形（ワールド座標の4頂点：上・右・下・左の順） */
function chunkDiamond(p: Iso, c: ChunkId): [number, number][] {
  const x0 = c.cx * CHUNK - 0.5;
  const y0 = c.cy * CHUNK - 0.5;
  const x1 = x0 + CHUNK;
  const y1 = y0 + CHUNK;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => {
    const s = toScreen(p, x, y);
    return [s.sx, s.sy];
  });
}

/** 矩形とひし形が重なるか（分離軸：矩形の2軸と、ひし形の2辺の法線） */
function hitsDiamond(r: Rect, d: [number, number][]): boolean {
  const rect: [number, number][] = [
    [r.minX, r.minY],
    [r.maxX, r.minY],
    [r.maxX, r.maxY],
    [r.minX, r.maxY],
  ];
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
  ];
  for (let i = 0; i < 2; i++) {
    const [ax, ay] = d[i];
    const [bx, by] = d[i + 1];
    axes.push([-(by - ay), bx - ax]);
  }
  for (const [nx, ny] of axes) {
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const [x, y] of rect) {
      const v = x * nx + y * ny;
      a0 = Math.min(a0, v);
      a1 = Math.max(a1, v);
    }
    for (const [x, y] of d) {
      const v = x * nx + y * ny;
      b0 = Math.min(b0, v);
      b1 = Math.max(b1, v);
    }
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}

/**
 * 見えているチャンクと、その周り `margin` 個分（RND-12 の余白は1）。
 * 背の高い建物は上へはみ出すので、見えている範囲の下側を `tallMargin` だけ広げて判定する。
 */
export function visibleChunks(p: Iso, view: Rect, width: number, height: number, tallMargin = 0, margin = 1): ChunkId[] {
  const v: Rect = { ...view, maxY: view.maxY + tallMargin };
  const nx = Math.ceil(width / CHUNK);
  const ny = Math.ceil(height / CHUNK);
  const hit = new Set<string>();
  for (let cy = 0; cy < ny; cy++)
    for (let cx = 0; cx < nx; cx++) {
      if (!hitsDiamond(v, chunkDiamond(p, { cx, cy }))) continue;
      for (let dy = -margin; dy <= margin; dy++)
        for (let dx = -margin; dx <= margin; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < nx && y < ny) hit.add(`${x},${y}`);
        }
    }
  return [...hit].map((k) => {
    const [cx, cy] = k.split(",").map(Number);
    return { cx, cy };
  });
}
