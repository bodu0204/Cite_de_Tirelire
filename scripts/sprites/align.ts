// 大きな建物（big/。2×2・3×3）の絵を、占有範囲のひし形に合わせる（docs/map-layout-redesign.md §4.5）。
//
// 描画は「横の中央・不透明な画素の一番下」を占有範囲の前の角とみなす。生成した絵には、建物が横に寄っているもの、
// 前の角が画像の下で切れているもの、小物（車・柵）だけが下に飛び出しているものがあり、そのままでは建物が
// 前のマスにはみ出したり、敷地の奥や横に寄って見えたりする。そこで、絵の下の輪郭が収まるひし形の下の辺
// （傾き 1/2 の V 字）のうち、輪郭との隙間が一番小さいものを求め、
//   - その V 字の頂点が横の中央に来るように、画素を横にずらす（画像の端で切れない範囲まで）
//   - その V 字の頂点を前の角として、基準点を anchors.json に書く（動きは anim.json の基準点も同じだけずらす）
// 発光マスク（glow/<キー>）も同じだけ横にずらす。何度かけても結果は変わらない。
//
//   npx tsx scripts/sprites/align.ts            ずれを表示するだけ
//   npx tsx scripts/sprites/align.ts --write    直して書き出す
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANIM_FILE, type AnimDef } from "./import-anim";
import { type Png, readPng, writePng } from "./png";

const SRC = path.join(path.resolve(__dirname, "../.."), "art/sprites/64");
const ANCHORS = path.join(SRC, "anchors.json");

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const f of readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${f}` : f;
    if (statSync(path.join(dir, r)).isDirectory()) out.push(...walk(dir, r));
    else if (f.endsWith(".png")) out.push(r.slice(0, -4));
  }
  return out;
}

/** 列ごとの不透明な画素の一番下（なければ -1） */
function columnBottoms(p: Png): number[] {
  return Array.from({ length: p.width }, (_, x) => {
    for (let y = p.height - 1; y >= 0; y--) if (p.alpha[y * p.width + x]) return y;
    return -1;
  });
}

/** 頂点の列 cx（0.5 刻み）の V 字のうち、輪郭がはみ出さない一番上のものの頂点の行と、輪郭との隙間 */
function vee(bottoms: number[], cx: number): { apex: number; gap: number } {
  const drop = (x: number) => Math.floor(Math.abs(x + 0.5 - cx) / 2);
  let apex = -Infinity;
  bottoms.forEach((b, x) => b >= 0 && (apex = Math.max(apex, b + drop(x))));
  let gap = 0;
  bottoms.forEach((b, x) => b >= 0 && (gap += apex - drop(x) - b));
  return { apex, gap };
}

/** 左右の空いている列の数（同じだけずらすほかの絵＝動きのコマ・発光マスクも含めて、一番狭いもの） */
export function room(pngs: Png[]): [number, number] {
  let left = Infinity;
  let right = Infinity;
  for (const p of pngs) {
    const used = columnBottoms(p).flatMap((b, x) => (b >= 0 ? [x] : []));
    if (!used.length) continue;
    left = Math.min(left, used[0]);
    right = Math.min(right, p.width - 1 - used[used.length - 1]);
  }
  return [left, right];
}

/** 隙間が一番小さい V 字。頂点の列は、画像の端で切れずにずらせる範囲（room）から選ぶ */
export function fit(p: Png, [left, right]: [number, number]): { dx: number; apex: number } {
  const bottoms = columnBottoms(p);
  let best = { dx: 0, ...vee(bottoms, p.width / 2) };
  for (let c2 = p.width / 2; c2 <= (p.width * 3) / 2; c2++) {
    const dx = Math.round(p.width / 2 - c2 / 2);
    if (dx < -left || dx > right) continue;
    const v = vee(bottoms, c2 / 2);
    if (v.gap < best.gap) best = { dx, ...v };
  }
  // 1ドットのずれは直さない（輪郭の段差の誤差）
  if (Math.abs(best.dx) < 2) best = { dx: 0, ...vee(bottoms, p.width / 2) };
  return { dx: best.dx, apex: best.apex };
}

function shift(p: Png, dx: number): Buffer {
  const out = new Uint8Array(p.rgba.length);
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= p.width) continue;
      out.set(p.rgba.subarray((y * p.width + sx) * 4, (y * p.width + sx + 1) * 4), (y * p.width + x) * 4);
    }
  return writePng(p.width, p.height, out);
}

function main() {
  const write = process.argv.includes("--write");
  const anchors: Record<string, [number, number]> = existsSync(ANCHORS) ? JSON.parse(readFileSync(ANCHORS, "utf8")) : {};
  const anims: Record<string, AnimDef> = existsSync(ANIM_FILE) ? JSON.parse(readFileSync(ANIM_FILE, "utf8")) : {};
  for (const key of walk(SRC).filter((k) => k.startsWith("big/")).sort()) {
    const file = path.join(SRC, `${key}.png`);
    const png = readPng(readFileSync(file));
    const bottom = Math.max(...columnBottoms(png));
    const lift = png.width / 4 - 1;
    const before = anchors[key] ?? [png.width / 2, bottom - lift];
    const glow = path.join(SRC, "glow", `${key}.png`);
    const dir = path.join(SRC, "anim", key);
    const pngs = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".png")).map((f) => path.join(d, f)) : []);
    const frames = pngs(dir);
    // コマごとの窓の灯り（glow-frames.ts）は止めた絵と同じ座標なので、止めた絵と同じだけずらす
    const others = [...(existsSync(glow) ? [glow] : []), ...frames, ...pngs(path.join(SRC, "glowanim", key))];
    const { dx, apex } = fit(png, room([png, ...others.map((f) => readPng(readFileSync(f)))]));
    const ay = apex - lift;
    if (!dx && ay === before[1]) continue;
    console.log(`${key}: 横 ${dx > 0 ? "+" : ""}${dx}、前の角 ${before[1] + lift} → ${apex}`);
    if (!write) continue;
    if (dx) {
      writeFileSync(file, shift(png, dx));
      for (const f of others) writeFileSync(f, shift(readPng(readFileSync(f)), dx));
    }
    // 前の角がちょうど一番下の画素なら、build-atlas.ts の決まり（画像から求める）のままでよい
    if (apex === bottom) delete anchors[key];
    else anchors[key] = [png.width / 2, ay];
    if (anims[key]) anims[key].anchor = [anims[key].anchor[0], anims[key].anchor[1] + ay - before[1]];
  }
  if (!write) return;
  writeFileSync(ANCHORS, `${JSON.stringify(anchors, null, 2)}\n`);
  writeFileSync(ANIM_FILE, `${JSON.stringify(anims, null, 2)}\n`);
}

if (require.main === module) main();
