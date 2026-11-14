// 絵を組み合わせて別の見た目を作る（キーの @ 以降で指定する）。生成した絵の枚数を増やさずに状態を描き分ける。
//   building/housing/2@lv4   建物Lv：Lv2〜6 で1つずつ小物が増える（OBJ-05）
//   special/park/2@closed    閉園：色を抜いて暗くする
//   building/housing/2@burnt 火事で休業（悪い出来事 EVT-03）：焦げたように暗くする。炎と煙は IsoStage が重ねる
//   building/farm/1@withered 不作（EVT-03）：緑の画素を枯れた茶色に寄せる
//   special/statue/gold@stage3  像の建設途中：下から少しずつ姿を見せ、足場をかける（OBJ-06）
//   ground/locked            未開放の地面：草を暗くする
import type { Art } from "./placeholder";

function blank(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

function copy(a: Art): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const [c, ctx] = blank(a.canvas.width, a.canvas.height);
  ctx.drawImage(a.canvas, 0, 0);
  return [c, ctx];
}

/** 夜に掛ける色（OBJ-14。昼は白＝そのまま、夜ほどこの色に近づける） */
export const NIGHT_RGB: [number, number, number] = [0x4a, 0x58, 0x94];

/** 夜の暗さ n（0〜1）で掛ける色 */
export function nightColor(n: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, n));
  return NIGHT_RGB.map((c) => Math.round(255 + (c - 255) * k)) as [number, number, number];
}

/** 建物Lv の小物を置く位置（基準点からのずれ。64px タイル基準）。Lv2 から順に1つずつ増える */
const PROP_SPOTS: [number, number][] = [
  [-21, 10], // Lv2 植木鉢
  [25, 5], // Lv3 街灯
  [-27, 4], // Lv4 旗
  [13, 13], // Lv5 ベンチ
  [-6, 15], // Lv6 車
];

export function withLevel(base: Art, level: number, props: (Art | null)[], tw: number): Art {
  const [c, ctx] = copy(base);
  const u = tw / 64;
  for (let lv = 2; lv <= Math.min(6, level); lv++) {
    const p = props[lv - 2];
    if (!p) continue;
    const [dx, dy] = PROP_SPOTS[lv - 2];
    ctx.drawImage(p.canvas, Math.round(base.ax + dx * u - p.ax), Math.round(base.ay + dy * u - p.ay));
  }
  return { canvas: c, ax: base.ax, ay: base.ay };
}

/** 色を抜いて暗くする（閉園・未開放の地面） */
export function dimmed(base: Art, gray: number, dark: number): Art {
  const [c, ctx] = copy(base);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    for (let k = 0; k < 3; k++) d[i + k] = Math.round((d[i + k] * (1 - gray) + l * gray) * dark);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, ax: base.ax, ay: base.ay };
}

/** 不作の畑：緑がかった画素（作物・草）を枯れた茶色に寄せ、絵全体も少し乾いた色にする（畑の少ない段階の絵でも分かるように） */
export function withered(base: Art): Art {
  const [c, ctx] = copy(base);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const DRY: [number, number, number] = [0xa6, 0x86, 0x4a];
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (d[i + 3] === 0) continue;
    // 緑の強い画素ほど強く寄せ、それ以外も少しだけ寄せる。明るさは元の画素に合わせる
    const k = g > r && g > b ? Math.min(0.85, 0.4 + (g - Math.max(r, b)) / 120) : 0.35;
    const l = (0.299 * r + 0.587 * g + 0.114 * b) / 140;
    for (let j = 0; j < 3; j++) d[i + j] = Math.round(d[i + j] * (1 - k) + Math.min(255, DRY[j] * l) * k);
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: c, ax: base.ax, ay: base.ay };
}

/** 色を rgb に k の割合で寄せる（大きな建物の敷地：草を踏み固めた土の色にする） */
export function blended(base: Art, rgb: [number, number, number], k: number): Art {
  const [c, ctx] = copy(base);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) d[i + j] = Math.round(d[i + j] * (1 - k) + rgb[j] * k);
  ctx.putImageData(img, 0, 0);
  return { canvas: c, ax: base.ax, ay: base.ay };
}

/**
 * 絵の外側を1ドット囲む輪郭だけの絵（選んだ建物を光らせる。OBJ-10）。
 * 上下左右に不透明な画素がある透明な画素を塗る。絵より上下左右1ドットずつ大きい
 */
export function outlineOf(base: Art, color: string): Art {
  const w = base.canvas.width;
  const h = base.canvas.height;
  const src = base.canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] >= 128;
  const [c, ctx] = blank(w + 2, h + 2);
  ctx.fillStyle = color;
  for (let y = -1; y <= h; y++)
    for (let x = -1; x <= w; x++)
      if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) ctx.fillRect(x + 1, y + 1, 1, 1);
  return { canvas: c, ax: base.ax + 1, ay: base.ay + 1 };
}

/** 像の建設途中（stage 0〜4）：台座から上へ、段階に応じて姿を見せ、手前に足場をかける */
export function statueInProgress(statue: Art, stage: number, cover: Art | null): Art {
  const [c, ctx] = blank(statue.canvas.width, statue.canvas.height);
  const h = statue.canvas.height;
  const shown = Math.round(h * (0.3 + 0.14 * Math.max(0, Math.min(4, stage))));
  ctx.drawImage(statue.canvas, 0, h - shown, c.width, shown, 0, h - shown, c.width, shown);
  if (cover) ctx.drawImage(cover.canvas, Math.round(statue.ax - cover.ax), Math.round(statue.ay - cover.ay));
  return { canvas: c, ax: statue.ax, ay: statue.ay };
}
