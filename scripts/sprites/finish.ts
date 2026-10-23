// 選んだ建物の絵の後処理（§4.1 の5）：パレットへの置き換え、輪郭を面の色に合わせる、透明度の整理。
//
//   npx tsx scripts/sprites/finish.ts <候補のpng> <キー>     art/sprites/64/<キー>.png に後処理して入れる
//   npx tsx scripts/sprites/finish.ts --redo <キー…>          入れてある絵にもう一度かける
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPalette, nearest } from "./palette";
import { type Png, readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "art/sprites/64");

type RGB = [number, number, number];
const luma = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/**
 * 外周の黒い輪郭を「隣の面の色を暗くした色」に置き換える（ART-03 の selective outline）。
 * 地面と道路は輪郭なしなので、建物の外周だけ黒い線で浮くのを防ぐ。内側の線（窓枠など）はそのまま。
 */
export function selectiveOutline(png: Png, pal: RGB[]): number {
  const { width: w, height: h, rgba } = png;
  const at = (x: number, y: number): RGB | null => {
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const o = (y * w + x) * 4;
    return rgba[o + 3] < 128 ? null : [rgba[o], rgba[o + 1], rgba[o + 2]];
  };
  const isEdge = (x: number, y: number) => !!at(x, y) && (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1));
  const dark = (c: RGB) => luma(c) < 56;
  const changes: [number, RGB][] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = at(x, y);
      if (!c || !dark(c) || !isEdge(x, y)) continue;
      // 内側へ2画素までの、暗くない面の色を集める
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const d = at(x + dx, y + dy);
          if (!d || dark(d) || isEdge(x + dx, y + dy)) continue;
          r += d[0];
          g += d[1];
          b += d[2];
          n++;
        }
      if (!n) continue;
      const shade: RGB = [Math.round((r / n) * 0.5), Math.round((g / n) * 0.5), Math.round((b / n) * 0.5)];
      changes.push([(y * w + x) * 4, nearest(shade, pal)]);
    }
  for (const [o, c] of changes) rgba.set(c, o);
  return changes.length;
}

/** パレットの色に置き換え、透明度を 0 か 255 にする（LINT-02・03） */
export function toPalette(png: Png, pal: RGB[]) {
  const { rgba } = png;
  const cache = new Map<number, RGB>();
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i + 3] = rgba[i + 3] < 128 ? 0 : 255;
    if (!rgba[i + 3]) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      continue;
    }
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    let c = cache.get(key);
    if (!c) cache.set(key, (c = nearest([rgba[i], rgba[i + 1], rgba[i + 2]], pal)));
    rgba.set(c, i);
  }
}

/** 不透明な画素を囲む最小の矩形に切り詰める（小物。地面のひし形に乗らないので幅の決まりがない） */
export function crop(png: Png): Png {
  const { width: w, height: h, rgba } = png;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return png;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  const alpha = new Uint8Array(cw * ch);
  for (let i = 0; i < alpha.length; i++) alpha[i] = out[i * 4 + 3];
  return { width: cw, height: ch, rgba: out, alpha };
}

export function finish(buf: Buffer, key = ""): { png: Png; outline: number } {
  const pal = loadPalette();
  let png = readPng(buf);
  toPalette(png, pal);
  const outline = selectiveOutline(png, pal);
  if (key.startsWith("props/")) png = crop(png);
  return { png, outline };
}

function main() {
  const args = process.argv.slice(2);
  const jobs: [string, string][] = args[0] === "--redo" ? args.slice(1).map((k) => [path.join(OUT, `${k}.png`), k]) : [[args[0], args[1]]];
  for (const [from, key] of jobs) {
    if (!from || !key) throw new Error("使い方はファイル先頭のコメントを見てください");
    const { png, outline } = finish(readFileSync(from), key);
    const to = path.join(OUT, `${key}.png`);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, writePng(png.width, png.height, png.rgba));
    console.log(`${key}：輪郭 ${outline} 画素を面の色に`);
  }
}

if (require.main === module) main();
