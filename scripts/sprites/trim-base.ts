// 地面のひし形の下に土の側面（土台の厚み）が付いて生成された絵から、側面を削る。
// 林・岩のように地面の上に置く絵は、側面があると草地との境目で一段高い台に見える。上の面の下の頂点が新しい足元になる。
// 同じキーの動き（anim/<キー>/*.png）も同じ厚みだけ削り、anim.json の基準点を厚みの分だけ上げる。
//
//   npx tsx scripts/sprites/trim-base.ts <キー>:<厚み…>    例：locked/forest:5 big/special/park/2:6
//
// 厚みは、真ん中の列の一番下から上の面の縁の手前までのドット数（側面の輪郭を含む）。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AnimDef } from "./import-anim";
import { ANIM_FILE } from "./import-anim";
import { type Png, readPng, writePng } from "./png";

const SRC = path.join(path.resolve(__dirname, "../.."), "art/sprites/64");

export function opaqueBottom(p: Png): number {
  for (let y = p.height - 1; y >= 0; y--) for (let x = 0; x < p.width; x++) if (p.alpha[y * p.width + x]) return y;
  return -1;
}

/** 下の頂点を depth ドット上げたひし形の下の辺より下の画素を消す */
function trim(p: Png, depth: number): Buffer {
  const out = new Uint8Array(p.rgba);
  const top = opaqueBottom(p) - depth;
  for (let x = 0; x < p.width; x++) {
    const limit = top - Math.floor(Math.abs(x + 0.5 - p.width / 2) / 2);
    for (let y = Math.max(0, limit + 1); y < p.height; y++) out.fill(0, (y * p.width + x) * 4, (y * p.width + x + 1) * 4);
  }
  return writePng(p.width, p.height, out);
}

function main() {
  const anims: Record<string, AnimDef> = existsSync(ANIM_FILE) ? JSON.parse(readFileSync(ANIM_FILE, "utf8")) : {};
  for (const arg of process.argv.slice(2)) {
    const [key, d] = arg.split(":");
    const depth = Number(d);
    if (!key || !(depth > 0)) throw new Error(`<キー>:<厚み> の形で渡してください：${arg}`);
    const file = path.join(SRC, `${key}.png`);
    writeFileSync(file, trim(readPng(readFileSync(file)), depth));
    const dir = path.join(SRC, "anim", key);
    const frames = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")) : [];
    // 動きのコマは上に余白を足してあるので、下の頂点はそのコマで測る
    for (const f of frames) writeFileSync(path.join(dir, f), trim(readPng(readFileSync(path.join(dir, f))), depth));
    if (anims[key]) anims[key].anchor = [anims[key].anchor[0], anims[key].anchor[1] - depth];
    console.log(`${key}: 側面 ${depth} ドットを削った（動き ${frames.length} 枚）`);
  }
  writeFileSync(ANIM_FILE, `${JSON.stringify(anims, null, 2)}\n`);
}

main();
