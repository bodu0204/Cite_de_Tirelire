// マスターパレット（§4.1 の1、ART-04）。全部の絵はこの色だけを使う（LINT-02）。
//
//   npx tsx scripts/sprites/palette.ts build     選んだ地面・建物の色から作り直す（art/palette.json）
//   npx tsx scripts/sprites/palette.ts remap <png…>   絵をパレットの色に置き換える（上書き）
//
// 作り方：画風の基準（選んだ草と建物）の色から k-means で 48 色を選び、まだ絵のない系統の色相（ART-05 の
// 公共の紫、未来の水色、金・銀・銅など）を足して 64 色にする。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
export const PALETTE_FILE = path.join(ROOT, "art/palette.json");

type RGB = [number, number, number];

export const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
export const fromHex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;

/** 人の目に近い色の距離（redmean） */
export function dist(a: RGB, b: RGB): number {
  const r = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return (2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db;
}

export function nearest(c: RGB, pal: RGB[]): RGB {
  let best = pal[0];
  let bd = Infinity;
  for (const p of pal) {
    const d = dist(c, p);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

/** 決まった順で選ぶ k-means++（同じ入力なら同じパレット） */
function kmeans(points: RGB[], weights: number[], k: number): RGB[] {
  const centers: RGB[] = [];
  let i0 = 0;
  for (let i = 1; i < points.length; i++) if (weights[i] > weights[i0]) i0 = i;
  centers.push(points[i0]);
  while (centers.length < k && centers.length < points.length) {
    // 既存の中心から一番遠い点（重み付き）を次の中心にする
    let bi = 0;
    let bs = -1;
    for (let i = 0; i < points.length; i++) {
      const d = Math.min(...centers.map((c) => dist(points[i], c)));
      const s = d * Math.sqrt(weights[i]);
      if (s > bs) {
        bs = s;
        bi = i;
      }
    }
    centers.push(points[bi]);
  }
  for (let iter = 0; iter < 20; iter++) {
    const sum = centers.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      let bj = 0;
      let bd = Infinity;
      centers.forEach((c, j) => {
        const d = dist(p, c);
        if (d < bd) {
          bd = d;
          bj = j;
        }
      });
      const w = weights[i];
      sum[bj][0] += p[0] * w;
      sum[bj][1] += p[1] * w;
      sum[bj][2] += p[2] * w;
      sum[bj][3] += w;
    });
    sum.forEach((s, j) => {
      if (s[3]) centers[j] = [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])];
    });
  }
  return centers;
}

/** まだ絵のない系統の色相（暗→明） */
const EXTRA = [
  // 公共（ART-05：紫）
  "#3e2a5c",
  "#6a4a94",
  "#9a78c4",
  "#d2c2ea",
  // 未来（水色）
  "#1f5f6b",
  "#3fa7b5",
  "#a8e6ee",
  // 金
  "#8a5a12",
  "#e0a828",
  "#ffe58a",
  // 銀
  "#8c939c",
  "#e8eef2",
  // 銅
  "#7a3f1e",
  "#c27a45",
  // 水（公園の池・噴水）
  "#2f6fb0",
  "#7cc4f0",
];

function collect(dir: string, out: Map<string, number>) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (f.endsWith(".png")) {
      const { rgba } = readPng(readFileSync(p));
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 128) continue;
        const k = hex([rgba[i], rgba[i + 1], rgba[i + 2]]);
        out.set(k, (out.get(k) ?? 0) + 1);
      }
    }
  }
}

export function loadPalette(): RGB[] {
  return (JSON.parse(readFileSync(PALETTE_FILE, "utf8")).colors as string[]).map(fromHex);
}

/** 絵の色をパレットへ置き換える。半透明は 0 か 255 に揃える（LINT-03） */
export function remapPng(buf: Buffer, pal: RGB[], keepAlpha = false): Buffer {
  const png = readPng(buf);
  const cache = new Map<number, RGB>();
  const { rgba } = png;
  for (let i = 0; i < rgba.length; i += 4) {
    if (!keepAlpha) rgba[i + 3] = rgba[i + 3] < 128 ? 0 : 255;
    if (!rgba[i + 3]) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      continue;
    }
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    let c = cache.get(key);
    if (!c) {
      c = nearest([rgba[i], rgba[i + 1], rgba[i + 2]], pal);
      cache.set(key, c);
    }
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
  }
  return writePng(png.width, png.height, rgba);
}

function main() {
  const [cmd, ...files] = process.argv.slice(2);
  if (cmd === "build") {
    // 画風の基準：地面の草と、M0 で選んだ建物（道路の草は明るすぎるので入れない）
    const counts = new Map<string, number>();
    collect(path.join(ROOT, "art/sprites/64/ground"), counts);
    collect(path.join(ROOT, "art/sprites/64/building"), counts);
    const points = [...counts.keys()].map(fromHex);
    const weights = [...counts.values()];
    const base = kmeans(points, weights, 64 - EXTRA.length).sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    const colors = [...base.map(hex), ...EXTRA];
    writeFileSync(PALETTE_FILE, JSON.stringify({ name: "Cite de Tirelire", colors }, null, 2) + "\n");
    // 見本の帯（1色 8×8）
    const w = 8 * 16;
    const h = 8 * Math.ceil(colors.length / 16);
    const rgba = new Uint8Array(w * h * 4);
    colors.forEach((c, i) => {
      const [r, g, b] = fromHex(c);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const o = (((Math.floor(i / 16) * 8 + y) * w) + (i % 16) * 8 + x) * 4;
          rgba.set([r, g, b, 255], o);
        }
    });
    writeFileSync(path.join(ROOT, "art/palette.png"), writePng(w, h, rgba));
    console.log(`${colors.length} 色を art/palette.json に書きました（基準の色 ${counts.size} 色から）`);
  } else if (cmd === "remap") {
    const pal = loadPalette();
    for (const f of files) {
      writeFileSync(f, remapPng(readFileSync(f), pal));
      console.log(`置き換え：${f}`);
    }
  } else {
    throw new Error("使い方はファイル先頭のコメントを見てください");
  }
}

if (require.main === module) main();
