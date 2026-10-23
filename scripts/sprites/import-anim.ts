// 建物の動き（OBJ-12）の候補を取り込む。各コマに後処理（パレット・輪郭）をかけ、
// art/sprites/64/anim/<キー>/<コマ>.png と art/sprites/64/anim.json（コマ数・速さ・基準点。ANI-02）に書く。
//
//   npx tsx scripts/sprites/import-anim.ts <候補のフォルダ> <キー> [fps]
//
// animate-with-text-v3 は1コマ目（渡した絵）と8コマを返し、最後のコマが1コマ目に戻る。ループには先頭の8コマを使う。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { selectiveOutline, toPalette } from "./finish";
import { loadPalette } from "./palette";
import { readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
const OUT = path.join(ROOT, "art/sprites/64");
export const ANIM_FILE = path.join(OUT, "anim.json");
const FRAMES = 8;

export interface AnimDef {
  fps: number;
  frames: number;
  /** 全コマ共通の基準点（足元のひし形の中心） */
  anchor: [number, number];
}

function main() {
  const [dir, key, fpsArg] = process.argv.slice(2);
  if (!dir || !key) throw new Error("使い方はファイル先頭のコメントを見てください");
  const fps = Number(fpsArg ?? 8);
  if (fps < 6 || fps > 12) throw new Error("コマ送りの速さは 6〜12fps（ANI-02）");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .slice(0, FRAMES);
  if (files.length < FRAMES) throw new Error(`コマが ${files.length} 枚しかありません`);
  const pal = loadPalette();
  const frames = files.map((f) => {
    const png = readPng(readFileSync(path.join(dir, f)));
    toPalette(png, pal);
    selectiveOutline(png, pal);
    return png;
  });
  const { width, height } = frames[0];
  if (frames.some((p) => p.width !== width || p.height !== height)) throw new Error("コマの大きさがそろっていません（LINT-06）");
  // 基準点は1コマ目の足元（不透明な画素の一番下）から求め、全コマで同じにする
  let bottom = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (frames[0].alpha[y * width + x]) bottom = y;
  const anchor: [number, number] = [width / 2, bottom - 15];

  const outDir = path.join(OUT, "anim", key);
  if (existsSync(outDir)) rmSync(outDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  frames.forEach((p, i) => writeFileSync(path.join(outDir, `${i}.png`), writePng(p.width, p.height, p.rgba)));
  const anims: Record<string, AnimDef> = existsSync(ANIM_FILE) ? JSON.parse(readFileSync(ANIM_FILE, "utf8")) : {};
  anims[key] = { fps, frames: FRAMES, anchor };
  writeFileSync(ANIM_FILE, JSON.stringify(anims, null, 2) + "\n");
  console.log(`${key}：${FRAMES}コマ、${fps}fps、基準点 ${anchor.join(",")}`);
}

if (require.main === module) main();
