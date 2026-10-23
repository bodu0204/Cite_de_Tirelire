// 選んだ絵（art/sprites/64/）を自動チェック（§4.3 の LINT）にかけ、アトラスにまとめて public/sprites/ に書き出す（§4.1 の7）。
// 1つでも外れたら書き出さずに終了コード 1 で止まる。
//
//   npx tsx scripts/sprites/build-atlas.ts           チェックして書き出す
//   npx tsx scripts/sprites/build-atlas.ts --check   チェックだけ
//   npx tsx scripts/sprites/build-atlas.ts --allow-missing   絵の抜け（LINT-01）は警告にして書き出す（開発中。足りない絵は仮の絵で描く）
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requiredKeys, tierChains } from "./catalog";
import { ANIM_FILE, type AnimDef } from "./import-anim";
import { PALETTE_FILE } from "./palette";
import { type Png, readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
const TW = 64;
const SRC = path.join(ROOT, "art/sprites", String(TW));
const OUT = path.join(ROOT, "public/sprites");
/** NF-03：アトラス1枚の上限 */
const MAX = 2048;
/** NF-04：絵の間の余白 */
const PAD = 2;

interface Sprite {
  key: string;
  png: Png;
  ax: number;
  ay: number;
}

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const f of readdirSync(path.join(dir, rel))) {
    const r = rel ? `${rel}/${f}` : f;
    if (statSync(path.join(dir, r)).isDirectory()) out.push(...walk(dir, r));
    else if (f.endsWith(".png")) out.push(r.slice(0, -4));
  }
  return out;
}

/** 地面のひし形に乗る絵（幅が基準タイルの倍数で、基準点が足元にある） */
const onTile = (key: string) => !key.startsWith("props/");

/** 不透明な画素の上端と下端 */
function opaqueRows(p: Png): [number, number] {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if (p.alpha[y * p.width + x]) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
  return [top, bottom];
}

/** 2×2 の同じ色の塊だけでできている（拡大された絵）か。偶数・奇数どちらの区切りでも調べる */
function looksUpscaled(p: Png): boolean {
  const px = (x: number, y: number) => {
    const o = (y * p.width + x) * 4;
    return (p.rgba[o] << 24) | (p.rgba[o + 1] << 16) | (p.rgba[o + 2] << 8) | p.rgba[o + 3];
  };
  for (const off of [0, 1]) {
    let uniform = true;
    for (let y = off; y + 1 < p.height && uniform; y += 2)
      for (let x = off; x + 1 < p.width; x += 2) {
        const c = px(x, y);
        if (px(x + 1, y) !== c || px(x, y + 1) !== c || px(x + 1, y + 1) !== c) {
          uniform = false;
          break;
        }
      }
    if (uniform) return true;
  }
  return false;
}

export function lint(sprites: Map<string, Sprite>, palette: Set<string>, anims: Record<string, AnimDef> = {}): string[] {
  const errors: string[] = [];
  // LINT-01：抜け漏れ
  for (const k of requiredKeys()) if (!sprites.has(k)) errors.push(`LINT-01 絵がありません：${k}`);
  for (const s of sprites.values()) {
    const { png, key } = s;
    let off = 0;
    let semi = 0;
    for (let i = 0; i < png.rgba.length; i += 4) {
      const a = png.rgba[i + 3];
      if (a && a !== 255) semi++;
      if (!a) continue;
      const hex = `#${[png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      if (!palette.has(hex)) off++;
    }
    if (off) errors.push(`LINT-02 パレットにない色が ${off} 画素：${key}`);
    if (semi) errors.push(`LINT-03 半透明の画素が ${semi}：${key}`);
    if (onTile(key)) {
      if (png.width % TW) errors.push(`LINT-04 幅 ${png.width} が ${TW} の倍数でない：${key}`);
      if (s.ax !== png.width / 2 || s.ay < 0 || s.ay >= png.height) errors.push(`LINT-04 基準点 ${s.ax},${s.ay} が足元の中心にない：${key}`);
    }
    // 発光マスクは灯りの画素がまばらなので、拡大の判定から外す
    if (!key.startsWith("glow/") && looksUpscaled(png)) errors.push(`LINT-05 2倍に拡大された絵に見える：${key}`);
  }
  // LINT-06：動きの全コマがあり、同じ大きさで、同じ基準点を持つ
  for (const [key, a] of Object.entries(anims)) {
    if (!sprites.has(key)) errors.push(`LINT-06 動きの基になる絵がありません：${key}`);
    const frames = Array.from({ length: a.frames }, (_, i) => sprites.get(`anim/${key}/${i}`));
    if (frames.some((f) => !f)) {
      errors.push(`LINT-06 コマが足りません：${key}`);
      continue;
    }
    const [f0] = frames as Sprite[];
    for (const f of frames as Sprite[]) {
      if (f.png.width !== f0.png.width || f.png.height !== f0.png.height) errors.push(`LINT-06 コマの大きさがそろっていません：${f.key}`);
      if (f.ax !== f0.ax || f.ay !== f0.ay) errors.push(`LINT-06 コマの基準点がそろっていません：${f.key}`);
    }
    if (a.fps < 6 || a.fps > 12) errors.push(`LINT-06 コマ送りの速さ ${a.fps}fps が 6〜12 の外：${key}`);
  }
  // LINT-07：段階が上がるほど高くなる
  for (const chain of tierChains()) {
    let prev = 0;
    let prevKey = "";
    for (const k of chain) {
      const s = sprites.get(k);
      if (!s) continue;
      const [top] = opaqueRows(s.png);
      const h = s.ay - top;
      if (h < prev) errors.push(`LINT-07 ${k} の高さ ${h} が前の段階 ${prevKey}（${prev}）より低い`);
      prev = h;
      prevKey = k;
    }
  }
  return errors;
}

/** 高さの順に棚へ並べる。入りきらなければ次のアトラスへ */
function pack(sprites: Sprite[]) {
  const sorted = [...sprites].sort((a, b) => b.png.height - a.png.height || a.key.localeCompare(b.key));
  const atlases: { w: number; h: number; items: { s: Sprite; x: number; y: number }[] }[] = [];
  let cur = { w: 0, h: 0, items: [] as { s: Sprite; x: number; y: number }[] };
  let x = PAD;
  let y = PAD;
  let shelf = 0;
  for (const s of sorted) {
    const { width: w, height: h } = s.png;
    if (x + w + PAD > MAX) {
      x = PAD;
      y += shelf + PAD;
      shelf = 0;
    }
    if (y + h + PAD > MAX) {
      atlases.push(cur);
      cur = { w: 0, h: 0, items: [] };
      x = PAD;
      y = PAD;
      shelf = 0;
    }
    cur.items.push({ s, x, y });
    cur.w = Math.max(cur.w, x + w + PAD);
    cur.h = Math.max(cur.h, y + h + PAD);
    x += w + PAD;
    shelf = Math.max(shelf, h);
  }
  if (cur.items.length) atlases.push(cur);
  return atlases;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const allowMissing = process.argv.includes("--allow-missing");
  const palette = new Set((JSON.parse(readFileSync(PALETTE_FILE, "utf8")).colors as string[]).map((c) => c.toLowerCase()));
  const anchorsFile = path.join(SRC, "anchors.json");
  const anchors: Record<string, [number, number]> = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : {};
  const anims: Record<string, AnimDef> = existsSync(ANIM_FILE) ? JSON.parse(readFileSync(ANIM_FILE, "utf8")) : {};
  const sprites = new Map<string, Sprite>();
  for (const key of walk(SRC)) {
    const png = readPng(readFileSync(path.join(SRC, `${key}.png`)));
    // 基準点：タイルは anchors.json。建物などは「横の中央・足元のひし形の中心」＝不透明な画素の一番下（ひし形の
    // 下の頂点）から th/2 上（生成した絵は下に余白が残ることがあるため、画像から求める）。小物は一番下
    const bottom = opaqueRows(png)[1];
    // 動きのコマは anim.json の基準点（全コマ共通）
    const animKey = key.startsWith("anim/") ? key.slice(5, key.lastIndexOf("/")) : null;
    const [ax, ay] = (animKey && anims[animKey]?.anchor) || anchors[key] || (onTile(key) ? [png.width / 2, bottom - (TW / 4 - 1)] : [png.width / 2, bottom]);
    sprites.set(key, { key, png, ax, ay });
  }
  // 発光マスクは元の建物の絵に重ねるので、基準点も元の絵と同じにする
  for (const s of sprites.values()) {
    if (!s.key.startsWith("glow/")) continue;
    const base = sprites.get(s.key.slice(5));
    if (base) {
      s.ax = base.ax;
      s.ay = base.ay;
    }
  }
  let errors = lint(sprites, palette, anims);
  if (allowMissing) {
    const missing = errors.filter((e) => e.startsWith("LINT-01"));
    if (missing.length) console.warn(`LINT-01：絵が ${missing.length} 枚足りません（仮の絵で描きます）`);
    errors = errors.filter((e) => !e.startsWith("LINT-01"));
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`\nLINT：${errors.length} 件。アトラスは書き出していません`);
    process.exit(1);
  }
  console.log(`LINT：${sprites.size} 枚${allowMissing ? "（抜けを除き）" : "すべて"}合格`);
  if (checkOnly) return;

  const atlases = pack([...sprites.values()]);
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const index: string[] = [];
  atlases.forEach((a, n) => {
    const rgba = new Uint8Array(a.w * a.h * 4);
    const frames: Record<string, unknown> = {};
    for (const { s, x, y } of a.items) {
      for (let row = 0; row < s.png.height; row++) rgba.set(s.png.rgba.subarray(row * s.png.width * 4, (row + 1) * s.png.width * 4), ((y + row) * a.w + x) * 4);
      const { width: w, height: h } = s.png;
      // PixiJS の Spritesheet 形式（anchor は 0〜1 の割合）
      frames[s.key] = {
        frame: { x, y, w, h },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w, h },
        sourceSize: { w, h },
        anchor: { x: s.ax / w, y: s.ay / h },
      };
    }
    const png = writePng(a.w, a.h, rgba);
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 10);
    const image = `atlas-${n}-${hash}.png`;
    writeFileSync(path.join(OUT, image), png);
    const json = JSON.stringify({ frames, meta: { image, format: "RGBA8888", size: { w: a.w, h: a.h }, scale: "1" } });
    const jsonName = `atlas-${n}-${createHash("sha256").update(json).digest("hex").slice(0, 10)}.json`;
    writeFileSync(path.join(OUT, jsonName), json);
    index.push(jsonName);
    console.log(`${image}：${a.items.length} 枚、${a.w}×${a.h}`);
  });
  // 入口のファイルだけは名前を固定する（中身のアトラスはハッシュ付きなので、更新時に古い絵が残らない）
  // anims：動く絵のキー → コマ数と速さ（コマは anim/<キー>/<番号> の名前でアトラスに入っている）
  const animIndex = Object.fromEntries(Object.entries(anims).map(([k, a]) => [k, { fps: a.fps, frames: a.frames }]));
  writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ tw: TW, atlases: index, anims: animIndex }) + "\n");
}

if (require.main === module) main();
