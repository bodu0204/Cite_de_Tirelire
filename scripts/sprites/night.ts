// 夜の窓の灯り（OBJ-14・§4.2「夜の姿」）。PixelLab の edit-images-v2 で「同じ建物の夜、窓に灯り」の版を作り、
// 昼の版との差から灯りの形（発光マスク）を取り出す。
//
//   npx tsx scripts/sprites/night.ts gen <キー…>        夜の版を生成する（同じ大きさの絵をまとめて1回で送る）
//   npx tsx scripts/sprites/night.ts import <フォルダ>    夜の版から発光マスクを作り、art/sprites/64/glow/<キー>.png に書く
//   npx tsx scripts/sprites/night.ts gen-tiled <キー…>  大きな絵（big/）を 128×128 に切り分け、4枚ずつまとめて夜の版を作る
//                                                       （128px を超える絵は1回に1枚しか送れず高くつくため。import で継ぎ合わせる）
//
// 発光マスクは灯りの画素だけを不透明にした絵。描画側はこれを夜だけ加算で重ね、人口に応じて窓の一部だけ灯す。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPalette, nearest } from "./palette";
import { generate, imageParam, findImages, stripImages } from "./pixellab";
import { type Png, readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "art/sprites/64");
const CANDIDATES = path.join(ROOT, "art/candidates/64/night");

const DESCRIPTION =
  "the same building at night: keep every pixel of the shape, outline, roof and walls exactly in place, make the walls and roof darker and bluish, and light up the windows with warm yellow light. Do not add new objects, do not change the silhouette";

/** edit-images-v2 が1回で受け付ける枚数（出力の大きさの長い辺で決まる） */
function perCall(maxDim: number): number {
  if (maxDim <= 64) return 16;
  if (maxDim <= 80) return 9;
  if (maxDim <= 128) return 4;
  return 1;
}

async function gen(keys: string[]) {
  const groups = new Map<string, { key: string; buf: Buffer; w: number; h: number }[]>();
  for (const key of keys) {
    const buf = readFileSync(path.join(SRC, `${key}.png`));
    const { width: w, height: h } = readPng(buf);
    const g = groups.get(`${w}x${h}`) ?? [];
    g.push({ key, buf, w, h });
    groups.set(`${w}x${h}`, g);
  }
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  for (const items of groups.values()) {
    const n = perCall(Math.max(items[0].w, items[0].h));
    for (let i = 0; i < items.length; i += n) {
      const batch = items.slice(i, i + n);
      const { w, h } = batch[0];
      const body = {
        method: "edit_with_text",
        edit_images: batch.map((b) => ({ image: imageParam(b.buf), width: b.w, height: b.h })),
        image_size: { width: w, height: h },
        description: DESCRIPTION,
        no_background: true,
      };
      console.log(`▶ ${batch.map((b) => b.key).join(" ")}（${w}×${h}）`);
      const dir = path.join(CANDIDATES, run, `${w}x${h}-${i / n}`);
      mkdirSync(dir, { recursive: true });
      try {
        const res = await generate("edit-images-v2", body, {
          onJob: (ids) => writeFileSync(path.join(dir, "job.json"), JSON.stringify({ ...ids, keys: batch.map((b) => b.key) }, null, 2)),
        });
        const images = findImages(res);
        // 返る順は送った順。キーの名前で保存する
        batch.forEach((b, k) => {
          if (!images[k]) return;
          const to = path.join(dir, `${b.key.replace(/\//g, "__")}.png`);
          writeFileSync(to, images[k]);
        });
        writeFileSync(path.join(dir, "response.json"), JSON.stringify(stripImages(res), null, 2));
        console.log(`  ${images.length} 枚を保存：${path.relative(ROOT, dir)}`);
      } catch (e) {
        console.error(`  失敗：${e instanceof Error ? e.message : e}`);
        process.exitCode = 1;
      }
    }
  }
}

/** 切り分ける大きさ（edit-images-v2 が1回で4枚を受け付ける上限） */
const TILE = 128;

/** 絵を TILE×TILE の格子に切り分ける。下と左にそろえ、足りない分は上と右を透明で埋める。全部透明な区画は除く */
export function splitTiles(p: Png): { row: number; col: number; buf: Buffer }[] {
  const cols = Math.ceil(p.width / TILE);
  const rows = Math.ceil(p.height / TILE);
  const top = rows * TILE - p.height;
  const out: { row: number; col: number; buf: Buffer }[] = [];
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const rgba = new Uint8Array(TILE * TILE * 4);
      let any = false;
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const sx = col * TILE + x;
          const sy = row * TILE + y - top;
          if (sx >= p.width || sy < 0 || sy >= p.height) continue;
          const o = (sy * p.width + sx) * 4;
          if (p.rgba[o + 3] >= 128) any = true;
          rgba.set(p.rgba.subarray(o, o + 4), (y * TILE + x) * 4);
        }
      if (any) out.push({ row, col, buf: writePng(TILE, TILE, rgba) });
    }
  return out;
}

/** 切り分けた夜の版を元の大きさに継ぎ合わせる（ない区画は透明） */
export function joinTiles(width: number, height: number, tiles: { row: number; col: number; png: Png }[]): Png {
  const rows = Math.ceil(height / TILE);
  const top = rows * TILE - height;
  const rgba = new Uint8Array(width * height * 4);
  for (const t of tiles)
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const dx = t.col * TILE + x;
        const dy = t.row * TILE + y - top;
        if (dx >= width || dy < 0 || dy >= height) continue;
        const o = (y * t.png.width + x) * 4;
        rgba.set(t.png.rgba.subarray(o, o + 4), (dy * width + dx) * 4);
      }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return { width, height, rgba, alpha };
}

async function genTiled(keys: string[]) {
  const tiles = keys.flatMap((key) => splitTiles(readPng(readFileSync(path.join(SRC, `${key}.png`)))).map((t) => ({ ...t, key })));
  const run = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < tiles.length; i += 4) {
    const batch = tiles.slice(i, i + 4);
    const body = {
      method: "edit_with_text",
      edit_images: batch.map((b) => ({ image: imageParam(b.buf), width: TILE, height: TILE })),
      image_size: { width: TILE, height: TILE },
      description: DESCRIPTION,
      no_background: true,
    };
    const names = batch.map((b) => `${b.key.replace(/\//g, "__")}~${b.row}_${b.col}`);
    console.log(`▶ ${names.join(" ")}`);
    const dir = path.join(CANDIDATES, run, `tiled-${i / 4}`);
    mkdirSync(dir, { recursive: true });
    try {
      const res = await generate("edit-images-v2", body, {
        onJob: (ids) => writeFileSync(path.join(dir, "job.json"), JSON.stringify({ ...ids, keys: names }, null, 2)),
      });
      const images = findImages(res);
      batch.forEach((_, k) => images[k] && writeFileSync(path.join(dir, `${names[k]}.png`), images[k]));
      console.log(`  ${images.length} 枚を保存：${path.relative(ROOT, dir)}`);
    } catch (e) {
      console.error(`  失敗：${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }
}

/**
 * 夜の版から灯りの画素を取り出す。夜の版で「明るく、暖かい色（赤・緑が青より十分強い）」画素のうち、
 * 昼の版でも不透明な所だけを灯りとみなす（夜の版で形がずれても、建物の外には灯りを出さない）。
 * 色はパレットの暖色に寄せる。
 */
export function glowMask(day: ReturnType<typeof readPng>, night: ReturnType<typeof readPng>) {
  const pal = loadPalette().filter(([r, g, b]) => r > 200 && g > 140 && b < 160);
  const out = new Uint8Array(day.rgba.length);
  let lit = 0;
  for (let i = 0; i < day.rgba.length; i += 4) {
    if (day.rgba[i + 3] < 128 || night.rgba[i + 3] < 128) continue;
    const [r, g, b] = [night.rgba[i], night.rgba[i + 1], night.rgba[i + 2]];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (l < 150 || r < b + 50 || g < b + 20) continue;
    out.set([...nearest([r, g, b], pal), 255], i);
    lit++;
  }
  return { rgba: out, lit };
}

function importDir(dir: string) {
  // 切り分けて送った夜の版（<キー>~<行>_<列>.png）は、キーごとに継ぎ合わせる
  const pieces = new Map<string, { row: number; col: number; png: Png }[]>();
  const whole: [string, () => Png][] = [];
  for (const sub of readdirSync(dir)) {
    const d = path.join(dir, sub);
    if (!existsSync(path.join(d, "job.json"))) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".png"))) {
      const [name, at] = f.slice(0, -4).split("~");
      const key = name.replace(/__/g, "/");
      if (!at) {
        whole.push([key, () => readPng(readFileSync(path.join(d, f)))]);
        continue;
      }
      const [row, col] = at.split("_").map(Number);
      const list = pieces.get(key) ?? [];
      list.push({ row, col, png: readPng(readFileSync(path.join(d, f))) });
      pieces.set(key, list);
    }
  }
  for (const [key, list] of pieces) {
    const day = readPng(readFileSync(path.join(SRC, `${key}.png`)));
    whole.push([key, () => joinTiles(day.width, day.height, list)]);
  }
  {
    for (const [key, load] of whole) {
      const day = readPng(readFileSync(path.join(SRC, `${key}.png`)));
      const night = load();
      if (night.width !== day.width || night.height !== day.height) {
        console.error(`${key}：大きさが違います`);
        continue;
      }
      const { rgba, lit } = glowMask(day, night);
      const to = path.join(SRC, "glow", `${key}.png`);
      if (!lit) {
        // 灯りがない（夜の版で窓が灯らなかった）建物はマスクを作らない
        if (existsSync(to)) rmSync(to);
        console.log(`${key}：灯りなし`);
        continue;
      }
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, writePng(day.width, day.height, rgba));
      console.log(`${key}：灯り ${lit} 画素`);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // .env がなければ環境変数をそのまま使う
  }
  if (cmd === "gen") await gen(rest);
  else if (cmd === "gen-tiled") await genTiled(rest);
  else if (cmd === "import") for (const d of rest) importDir(d);
  else throw new Error("使い方はファイル先頭のコメントを見てください");
}

if (require.main === module) main();
