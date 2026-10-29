// アイソメトリックの座標変換（docs/rendering-requirements.md RND-01〜03）。
// 画面座標は「1ドット＝1」のワールド座標。マス (x, y) の足元のひし形の中心を返す。

export interface Iso {
  /** 地面のひし形の幅（ドット）。高さはその半分（2:1） */
  tw: number;
  th: number;
}

export const iso = (tw: number): Iso => ({ tw, th: tw / 2 });

/** マスの足元のひし形の中心（RND-01・RND-02）。小数のマス座標も受け付ける（人や車） */
export function toScreen(p: Iso, x: number, y: number): { sx: number; sy: number } {
  return { sx: (x - y) * (p.tw / 2), sy: (x + y) * (p.th / 2) };
}

/** 画面座標を連続したマス座標へ戻す */
export function toTileF(p: Iso, sx: number, sy: number): { x: number; y: number } {
  const a = sx / (p.tw / 2);
  const b = sy / (p.th / 2);
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** 画面座標からマスを求める。ひし形の中心が整数座標なので、0.5 ずらして切り捨てる */
export function toTile(p: Iso, sx: number, sy: number): { x: number; y: number } {
  const f = toTileF(p, sx, sy);
  return { x: Math.floor(f.x + 0.5), y: Math.floor(f.y + 0.5) };
}

/**
 * 描く順番（RND-03）：x + y の小さい順、同じなら x の小さい順。
 * 人や車は連続した位置を渡す。x の重みを小さくして x + y を優先させる。
 */
export function depth(x: number, y: number): number {
  return (x + y) * 1024 + x;
}

/** マスの矩形（minX〜maxX、minY〜maxY）の地面を囲む矩形（ワールド座標） */
export function mapBounds(p: Iso, tiles: { minX: number; minY: number; maxX: number; maxY: number }) {
  return {
    minX: toScreen(p, tiles.minX, tiles.maxY).sx - p.tw / 2,
    maxX: toScreen(p, tiles.maxX, tiles.minY).sx + p.tw / 2,
    minY: toScreen(p, tiles.minX, tiles.minY).sy - p.th / 2,
    maxY: toScreen(p, tiles.maxX, tiles.maxY).sy + p.th / 2,
  };
}
