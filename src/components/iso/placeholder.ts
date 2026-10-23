// M0 用の仮の絵。PixelLab の絵（アトラス）が揃うまで、同じキーで代わりに出す（§9 の「仮の絵」）。
// Canvas 2D で1ドットずつ描き、光源は左上（ART-02：右の面を暗く）。
import { LINES, type Category, type LineId } from "@/game/catalog";

export interface Art {
  canvas: HTMLCanvasElement;
  /** 基準点（足元のひし形の中心）の位置。絵の左上からのドット数 */
  ax: number;
  ay: number;
}

type Ctx = CanvasRenderingContext2D;

/** 系統ごとの識別色（ART-05）：屋根（上面）・左の壁・右の壁 */
const CATEGORY_COLORS: Record<Category, [string, string, string]> = {
  housing: ["#c0504d", "#e8d8bc", "#bfae92"],
  agriculture: ["#7a9a3a", "#d8c08a", "#b09868"],
  industry: ["#e0b030", "#9aa0a6", "#6f757b"],
  commerce: ["#3f7fbf", "#e6e1d6", "#b8b2a4"],
  infra: ["#8a8f96", "#c7c9cc", "#979a9f"],
  public: ["#8e5fb0", "#efe7f4", "#c0b4ca"],
  future: ["#40c4d0", "#dff6f8", "#9fd2d8"],
};

function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** 中心 (cx, cy)、横の半径 hw のひし形を1行ずつ塗る。左半分と右半分で色を変えられる */
function diamond(ctx: Ctx, cx: number, cy: number, hw: number, left: string, right = left) {
  const hh = hw / 2;
  for (let j = 0; j < hh * 2; j++) {
    const half = (j < hh ? j + 1 : hh * 2 - j) * 2;
    const y = cy - hh + j;
    ctx.fillStyle = left;
    ctx.fillRect(cx - half, y, half, 1);
    ctx.fillStyle = right;
    ctx.fillRect(cx, y, half, 1);
  }
}

/** ひし形の輪郭だけ */
function diamondOutline(ctx: Ctx, cx: number, cy: number, hw: number, color: string) {
  const hh = hw / 2;
  ctx.fillStyle = color;
  for (let j = 0; j < hh * 2; j++) {
    const half = (j < hh ? j + 1 : hh * 2 - j) * 2;
    const y = cy - hh + j;
    ctx.fillRect(cx - half, y, 2, 1);
    ctx.fillRect(cx + half - 2, y, 2, 1);
  }
}

/** 高さ h の箱。底面の中心が (cx, by) */
function box(ctx: Ctx, cx: number, by: number, hw: number, h: number, top: string, wl: string, wr: string) {
  for (let k = 0; k <= h; k++) diamond(ctx, cx, by - k, hw, wl, wr);
  diamond(ctx, cx, by - h, hw, top);
}

/** 箱の左右の壁に窓を並べる */
function windows(ctx: Ctx, cx: number, by: number, hw: number, h: number, s: number, color: string) {
  const step = Math.max(3, 6 * s);
  const floor = Math.max(4, 8 * s);
  ctx.fillStyle = color;
  for (let dx = step; dx < hw - 1; dx += step) {
    // 左の壁の下辺は (cx − hw, by) から (cx, by + hw/2) へ下がる
    const yl = by + (hw - dx) / 2;
    for (let f = floor; f < h - 1; f += floor) {
      ctx.fillRect(cx - dx, Math.round(yl - f), Math.max(1, s * 2), Math.max(1, s * 3));
      ctx.fillRect(cx + dx - Math.max(1, s * 2), Math.round(yl - f), Math.max(1, s * 2), Math.max(1, s * 3));
    }
  }
}

/** 段階が上がるほど高くなる（OBJ-04・LINT-07） */
export function buildingHeight(line: LineId, tier: number, tw: number): number {
  const s = tw / 64;
  const tiers = LINES[line].tiers.length;
  const base = LINES[line].category === "agriculture" ? 4 : 10;
  return Math.round((base + tier * (tiers > 3 ? 12 : 16)) * s);
}

export function drawBuildingArt(line: LineId, tier: number, tw: number): Art {
  const s = tw / 64;
  const th = tw / 2;
  const h = buildingHeight(line, tier, tw);
  const [c, ctx] = canvas(tw, th + h + 2);
  const cx = tw / 2;
  const by = h + 2 + th / 2;
  const [top, wl, wr] = CATEGORY_COLORS[LINES[line].category];
  const hw = Math.round((tw / 2) * (0.62 + 0.06 * Math.min(tier, 4)) / 2) * 2;
  if (LINES[line].category === "agriculture") {
    diamond(ctx, cx, by, tw / 2 - 2 * s, "#8d6e63", "#7b5e54");
    for (let k = -3; k <= 3; k++) {
      ctx.fillStyle = "#9ccc65";
      ctx.fillRect(cx + k * 6 * s, by - 2 + (k % 2), Math.max(1, 2 * s), 1);
    }
  }
  box(ctx, cx, by, hw, h, top, wl, wr);
  windows(ctx, cx, by, hw, h, s, "#45607a");
  return { canvas: c, ax: cx, ay: by };
}

const GRASS = ["#86bd46", "#8bc34a", "#82b843", "#8fc24e"];

export function drawGroundArt(key: string, tw: number): Art {
  const th = tw / 2;
  const [c, ctx] = canvas(tw, th);
  const cx = tw / 2;
  const cy = th / 2;
  const [, kind, a] = key.split("/");
  if (key === "ground/locked") {
    diamond(ctx, cx, cy, tw / 2, "#3b4a3a", "#344233");
    ctx.fillStyle = "#2b3a2a";
    for (let k = 0; k < 5; k++) ctx.fillRect(cx - tw / 4 + ((k * 7) % (tw / 2)), cy - 3 + ((k * 5) % 6), 3, 2);
  } else if (key.startsWith("ground/grass")) {
    const v = Number(a) || 0;
    diamond(ctx, cx, cy, tw / 2, GRASS[v % GRASS.length]);
    ctx.fillStyle = "#9ccc65";
    ctx.fillRect(cx - 6 + v * 3, cy - 2, 1, 1);
    ctx.fillStyle = "#7cb342";
    ctx.fillRect(cx + 5 - v * 2, cy + 3, 1, 1);
  } else {
    // road/<段階>/<つながり>
    const tier = Number(kind) || 0;
    const mask = Number(a) || 0;
    const asphalt = ["#a1887f", "#8d8d8d", "#6d6d6d", "#5a5f66"][tier] ?? "#6d6d6d";
    diamond(ctx, cx, cy, tw / 2, asphalt);
    ctx.fillStyle = tier === 0 ? "#bcaaa4" : "#f5f5f5";
    const dirs: [number, number, number][] = [
      [1, 1, -1], // 北（y−1）は画面の右上
      [2, 1, 1], // 東（x+1）は右下
      [4, -1, 1], // 南（y+1）は左下
      [8, -1, -1], // 西（x−1）は左上
    ];
    for (const [bit, sx, sy] of dirs) {
      if (!(mask & bit)) continue;
      for (let t = 2; t < tw / 4; t += 3) ctx.fillRect(cx + sx * t, cy + (sy * t) / 2, 1, 1);
    }
  }
  return { canvas: c, ax: cx, ay: cy };
}

export function drawSelectArt(tw: number, color = "#ffffff"): Art {
  const th = tw / 2;
  const [c, ctx] = canvas(tw, th);
  diamondOutline(ctx, tw / 2, th / 2, tw / 2, color);
  return { canvas: c, ax: tw / 2, ay: th / 2 };
}

export function drawAgentArt(kind: "person" | "car", variant: number, tw: number): Art {
  const s = Math.max(1, Math.round(tw / 64));
  if (kind === "person") {
    const colors = ["#e53935", "#1e88e5", "#fdd835", "#43a047", "#8e24aa"];
    const [c, ctx] = canvas(2 * s, 6 * s);
    ctx.fillStyle = "#f1c27d";
    ctx.fillRect(0, 0, 2 * s, 2 * s);
    ctx.fillStyle = colors[variant % colors.length];
    ctx.fillRect(0, 2 * s, 2 * s, 3 * s);
    ctx.fillStyle = "#37474f";
    ctx.fillRect(0, 5 * s, 2 * s, s);
    return { canvas: c, ax: s, ay: 6 * s - 1 };
  }
  const colors = ["#d32f2f", "#1976d2", "#fbc02d", "#eeeeee"];
  const hw = 6 * s;
  const [c, ctx] = canvas(hw * 2, hw + 4 * s);
  box(ctx, hw, hw / 2 + 4 * s, hw, 3 * s, colors[variant % colors.length], "#455a64", "#37474f");
  return { canvas: c, ax: hw, ay: hw / 2 + 4 * s };
}

/** 不透明な画素（CAM-05 のタップ判定に使う） */
export function alphaMask(a: Art): Uint8Array {
  const { width, height } = a.canvas;
  const data = a.canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  return out;
}
