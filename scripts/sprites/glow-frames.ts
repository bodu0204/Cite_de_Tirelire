// 動く建物（anim/<キー>）の夜の窓の灯りを、コマごとに作る（glowanim/<キー>/<コマ>.png）。
//
// 発光マスク（glow/<キー>）は止めた絵から作ったので、動く絵にそのまま重ねると、窓の前を通る部品（未来の塔の輪など）の
// 上にも灯りが乗り、灯りの位置がずれて見える。そこで、マスクの各画素について、止めた絵の色がそのコマで何色になったかを
// 色ごとに数え、一番多い色（＝窓のガラスがそのコマで変わった色）のままの画素だけを残す。前を部品が通る画素は別の色に
// なるので消える。コマごとのマスクは止めた絵と同じ大きさ・同じ座標で、基準点も止めた絵と同じ。
//
//   npx tsx scripts/sprites/glow-frames.ts      発光マスクと動きの両方がある絵をすべて作り直す
//
// align.ts で絵をずらしたあとや、動き・発光マスクを作り直したあとにかけ直す。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANIM_FILE, type AnimDef } from "./import-anim";
import { type Png, readPng, writePng } from "./png";

const SRC = path.join(path.resolve(__dirname, "../.."), "art/sprites/64");
const ANCHORS = path.join(SRC, "anchors.json");

function opaqueBottom(p: Png): number {
  for (let y = p.height - 1; y >= 0; y--) for (let x = 0; x < p.width; x++) if (p.alpha[y * p.width + x]) return y;
  return -1;
}

const color = (p: Png, x: number, y: number) => {
  if (x < 0 || y < 0 || x >= p.width || y >= p.height || !p.alpha[y * p.width + x]) return -1;
  const o = (y * p.width + x) * 4;
  return (p.rgba[o] << 16) | (p.rgba[o + 1] << 8) | p.rgba[o + 2];
};

/** コマ1枚分のマスク。dx, dy は止めた絵の画素からコマの画素へのずれ（基準点の差） */
export function frameMask(still: Png, glow: Png, frame: Png, dx: number, dy: number): Uint8Array {
  const lit: number[] = [];
  for (let i = 0; i < glow.width * glow.height; i++) if (glow.alpha[i]) lit.push(i);
  // 止めた絵の色 → そのコマでの色の数
  const counts = new Map<number, Map<number, number>>();
  for (const i of lit) {
    const x = i % glow.width;
    const y = (i - x) / glow.width;
    const from = color(still, x, y);
    const to = color(frame, x + dx, y + dy);
    const m = counts.get(from) ?? new Map<number, number>();
    m.set(to, (m.get(to) ?? 0) + 1);
    counts.set(from, m);
  }
  const mode = new Map([...counts].map(([from, m]) => [from, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
  const out = new Uint8Array(glow.rgba.length);
  for (const i of lit) {
    const x = i % glow.width;
    const y = (i - x) / glow.width;
    const to = color(frame, x + dx, y + dy);
    if (to >= 0 && to === mode.get(color(still, x, y))) out.set(glow.rgba.subarray(i * 4, i * 4 + 4), i * 4);
  }
  return out;
}

function main() {
  const anims: Record<string, AnimDef> = JSON.parse(readFileSync(ANIM_FILE, "utf8"));
  const anchors: Record<string, [number, number]> = existsSync(ANCHORS) ? JSON.parse(readFileSync(ANCHORS, "utf8")) : {};
  for (const [key, a] of Object.entries(anims)) {
    const out = path.join(SRC, "glowanim", key);
    const glowFile = path.join(SRC, "glow", `${key}.png`);
    if (!existsSync(glowFile)) {
      if (existsSync(out)) rmSync(out, { recursive: true });
      continue;
    }
    const still = readPng(readFileSync(path.join(SRC, `${key}.png`)));
    const glow = readPng(readFileSync(glowFile));
    // 止めた絵の基準点（build-atlas.ts と同じ決め方）
    const lift = key.startsWith("big/") ? still.width / 4 - 1 : 64 / 4 - 1;
    const [sax, say] = anchors[key] ?? [still.width / 2, opaqueBottom(still) - lift];
    mkdirSync(out, { recursive: true });
    const kept: number[] = [];
    for (let i = 0; i < a.frames; i++) {
      const frame = readPng(readFileSync(path.join(SRC, "anim", key, `${i}.png`)));
      const rgba = frameMask(still, glow, frame, a.anchor[0] - sax, a.anchor[1] - say);
      writeFileSync(path.join(out, `${i}.png`), writePng(glow.width, glow.height, rgba));
      let n = 0;
      for (let j = 3; j < rgba.length; j += 4) if (rgba[j]) n++;
      kept.push(n);
    }
    console.log(`${key}: コマごとの灯り ${kept.join(" / ")} 画素`);
  }
}

if (require.main === module) main();
