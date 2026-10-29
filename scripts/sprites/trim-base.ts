// 地面のひし形の下に土の側面（土台の厚み）が付いて生成された絵から、側面を削る。
// 林・岩・像のように地面の上に置く絵は、側面があると草地との境目で一段高い台に見える。上の面の下の縁が新しい足元になる。
// 同じキーの動き（anim/<キー>/*.png）も同じように削り、anim.json の基準点を足元が上がった分だけ上げる。
//
//   npx tsx scripts/sprites/trim-base.ts <キー>:<厚み>[:<側面の色,…>] …   例：locked/forest:6 big/building/housing/2:6:6c312b
//
// 列ごとに、一番下から側面の色（既定は土の茶色と輪郭の色。足した色も含む）が続くところを、厚みまで消す。
// ひし形の頂点が横の中央にない絵や、左右で傾きの違う絵でも、その列の側面だけを消せる。
// 厚みは側面の一番厚い列のドット数（輪郭を含む）。上の面に同じ色があっても、厚みより上は消さない。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANIM_FILE, type AnimDef } from "./import-anim";
import { type Png, readPng, writePng } from "./png";

const SRC = path.join(path.resolve(__dirname, "../.."), "art/sprites/64");
/** 土の側面と、その輪郭の色 */
export const SOIL = ["040203", "271511", "3b221d", "4c352c", "644334", "6d4f3e", "7a3f1e"];

function opaqueBottom(p: Png): number {
  for (let y = p.height - 1; y >= 0; y--) for (let x = 0; x < p.width; x++) if (p.alpha[y * p.width + x]) return y;
  return -1;
}

const hex = (p: Png, x: number, y: number) =>
  Array.from(p.rgba.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 3), (v) => v.toString(16).padStart(2, "0")).join("");

function columnBottom(rgba: Uint8Array, w: number, h: number, x: number): number {
  let y = h - 1;
  while (y >= 0 && !rgba[(y * w + x) * 4 + 3]) y--;
  return y;
}

/**
 * 列ごとに、一番下から側面の色が続く画素を depth ドットまで消す。
 * そのあと、下の縁から1〜3列の幅で飛び出した画素（側面の色でない小石・輪郭の残り）を、両側の列の縁の高さまで消す。
 * ひし形の辺は2列で1ドット下がるので、r 列離れた両側の縁より ceil(r/2) ドットを超えて下にある画素は飛び出し
 */
export function trim(p: Png, depth: number, side: Set<string>): Buffer {
  const out = new Uint8Array(p.rgba);
  const clear = (x: number, y: number) => out.fill(0, (y * p.width + x) * 4, (y * p.width + x + 1) * 4);
  for (let x = 0; x < p.width; x++) {
    let y = columnBottom(out, p.width, p.height, x);
    for (let n = 0; n < depth && y >= 0 && side.has(hex(p, x, y)); n++, y--) clear(x, y);
  }
  const bottoms = Array.from({ length: p.width }, (_, x) => columnBottom(out, p.width, p.height, x));
  for (let x = 0; x < p.width; x++) {
    let limit = Infinity;
    for (let r = 1; r <= 3; r++) {
      const sides = [bottoms[x - r], bottoms[x + r]].filter((b) => b !== undefined && b >= 0);
      if (sides.length) limit = Math.min(limit, Math.max(...sides) + Math.ceil(r / 2));
    }
    for (let y = bottoms[x]; y > limit; y--) clear(x, y);
  }
  return writePng(p.width, p.height, out);
}

/**
 * 土台が残っていそうな度合い：一番下から側面の色が3ドット以上続く列の割合（build-atlas.ts の LINT-09）。
 * 茶色い壁の建物も高くなるので、目で見て土台でないと確かめた絵は base-ok.json に書いて外す
 */
export function sideShare(p: Png): number {
  let used = 0;
  let thick = 0;
  for (let x = 0; x < p.width; x++) {
    let y = columnBottom(p.rgba, p.width, p.height, x);
    if (y < 0) continue;
    used++;
    let run = 0;
    for (; y >= 0 && p.alpha[y * p.width + x] && SOIL.includes(hex(p, x, y)); y--) run++;
    if (run >= 3) thick++;
  }
  return used ? thick / used : 0;
}

function main() {
  const anims: Record<string, AnimDef> = existsSync(ANIM_FILE) ? JSON.parse(readFileSync(ANIM_FILE, "utf8")) : {};
  for (const arg of process.argv.slice(2)) {
    const [key, d, extra] = arg.split(":");
    const depth = Number(d);
    if (!key || !(depth > 0)) throw new Error(`<キー>:<厚み>[:<色,…>] の形で渡してください：${arg}`);
    const side = new Set([...SOIL, ...(extra ? extra.toLowerCase().split(",") : [])]);
    const file = path.join(SRC, `${key}.png`);
    const still = readPng(readFileSync(file));
    const before = opaqueBottom(still);
    const trimmed = trim(still, depth, side);
    writeFileSync(file, trimmed);
    const rise = before - opaqueBottom(readPng(trimmed));
    const dir = path.join(SRC, "anim", key);
    const frames = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
    for (const f of frames) writeFileSync(path.join(dir, f), trim(readPng(readFileSync(path.join(dir, f))), depth, side));
    if (anims[key]) anims[key].anchor = [anims[key].anchor[0], anims[key].anchor[1] - rise];
    console.log(`${key}: 側面を削り、足元が ${rise} ドット上がった（動き ${frames.length} 枚）`);
  }
  writeFileSync(ANIM_FILE, `${JSON.stringify(anims, null, 2)}\n`);
}

if (require.main === module) main();
