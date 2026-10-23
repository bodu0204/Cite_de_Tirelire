// 夜の窓の灯り（OBJ-14・§4.2「夜の姿」）。PixelLab の edit-images-v2 で「同じ建物の夜、窓に灯り」の版を作り、
// 昼の版との差から灯りの形（発光マスク）を取り出す。
//
//   npx tsx scripts/sprites/night.ts gen <キー…>        夜の版を生成する（同じ大きさの絵をまとめて1回で送る）
//   npx tsx scripts/sprites/night.ts import <フォルダ>    夜の版から発光マスクを作り、art/sprites/64/glow/<キー>.png に書く
//
// 発光マスクは灯りの画素だけを不透明にした絵。描画側はこれを夜だけ加算で重ね、人口に応じて窓の一部だけ灯す。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPalette, nearest } from "./palette";
import { generate, imageParam, findImages, stripImages } from "./pixellab";
import { readPng, writePng } from "./png";

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
  for (const sub of readdirSync(dir)) {
    const d = path.join(dir, sub);
    if (!existsSync(path.join(d, "job.json"))) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith(".png"))) {
      const key = f.slice(0, -4).replace(/__/g, "/");
      const day = readPng(readFileSync(path.join(SRC, `${key}.png`)));
      const night = readPng(readFileSync(path.join(d, f)));
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
  else if (cmd === "import") for (const d of rest) importDir(d);
  else throw new Error("使い方はファイル先頭のコメントを見てください");
}

if (require.main === module) main();
