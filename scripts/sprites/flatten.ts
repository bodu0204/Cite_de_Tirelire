// 地面のひし形が 2:1 より縦長に生成された大きな絵を、下の頂点を固定して縦に縮め、ひし形を 2:1 に合わせる。
// 同じキーの動き（anim/<キー>/*.png）も同じ割合で縮める。
//
//   npx tsx scripts/sprites/flatten.ts <キー…>    例：big/special/park/3
//
// 割合は、絵の左右の端の列の一番下の不透明な画素（ひし形の左右の頂点）と、真ん中の列の一番下（下の頂点）の差から決める。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Png, readPng, writePng } from "./png";

const SRC = path.join(path.resolve(__dirname, "../.."), "art/sprites/64");

function bottomAt(p: Png, x: number): number {
  for (let y = p.height - 1; y >= 0; y--) if (p.alpha[y * p.width + x] > 0) return y;
  return -1;
}

/** 下の頂点の行と、縦の割合（1 なら 2:1） */
function measure(p: Png): { bottom: number; k: number } {
  const mid = Math.floor(p.width / 2);
  const bottom = Math.max(bottomAt(p, mid - 1), bottomAt(p, mid));
  const edge = 2;
  const sides = [bottomAt(p, edge), bottomAt(p, p.width - 1 - edge)].filter((v) => v >= 0);
  const drop = bottom - sides.reduce((a, b) => a + b, 0) / sides.length;
  return { bottom, k: (mid - edge) / 2 / drop };
}

/** 下の頂点を固定して縦に k 倍する（最近傍。1ドット＝1画素のまま） */
function squash(p: Png, bottom: number, k: number): Buffer {
  const out = new Uint8Array(p.width * p.height * 4);
  for (let y = 0; y < p.height; y++) {
    const sy = Math.round(bottom - (bottom - y) / k);
    if (sy < 0 || sy >= p.height) continue;
    out.set(p.rgba.subarray(sy * p.width * 4, (sy + 1) * p.width * 4), y * p.width * 4);
  }
  return writePng(p.width, p.height, out);
}

for (const key of process.argv.slice(2)) {
  const file = path.join(SRC, `${key}.png`);
  const still = readPng(readFileSync(file));
  const { bottom, k } = measure(still);
  if (k >= 0.98) {
    console.log(`${key}: すでに 2:1（${k.toFixed(2)}）`);
    continue;
  }
  writeFileSync(file, squash(still, bottom, k));
  const anim = path.join(SRC, "anim", key);
  const frames = existsSync(anim) ? readdirSync(anim).filter((f) => f.endsWith(".png")) : [];
  for (const f of frames) {
    const p = readPng(readFileSync(path.join(anim, f)));
    // 動きの絵は上に余白を足してあるので、下の頂点はその絵で測る
    writeFileSync(path.join(anim, f), squash(p, measure(p).bottom, k));
  }
  console.log(`${key}: 縦 ×${k.toFixed(3)}（動き ${frames.length} 枚）`);
}
