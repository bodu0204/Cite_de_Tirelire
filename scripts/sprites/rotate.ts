// 入れてある絵を別の向きに回した版を、PixelLab の rotate で作る（人と車の向きの絵。§4.2）。
//
//   npx tsx scripts/sprites/rotate.ts <元のキー> <新しいキー> [--from south-west] [--to north-east] [--view high top-down] [--n 4]
//
// 元の絵（art/sprites/64/<元のキー>.png）を 32×32 の下寄せ中央に置いて送り、候補を
// art/candidates/64/<新しいキー>/<日時>/NN.png に保存する。選んだら finish.ts で取り込む。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findImages, generate, imageParam } from "./pixellab";
import { readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "art/sprites/64");
const CANDIDATES = path.join(ROOT, "art/candidates/64");
/** rotate が受け付ける大きさのうち、人と車が収まる一番小さいもの */
const SIZE = 32;

/** 絵を SIZE×SIZE の透明な画像の、横は中央・縦は下から2ドット上に置く */
function pad(buf: Buffer): Buffer {
  const src = readPng(buf);
  if (src.width > SIZE || src.height > SIZE) throw new Error(`${SIZE}px より大きい絵です`);
  const out = new Uint8Array(SIZE * SIZE * 4);
  const x0 = Math.floor((SIZE - src.width) / 2);
  const y0 = SIZE - 2 - src.height;
  for (let y = 0; y < src.height; y++) out.set(src.rgba.subarray(y * src.width * 4, (y + 1) * src.width * 4), ((y0 + y) * SIZE + x0) * 4);
  return writePng(SIZE, SIZE, out);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, def: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : def;
  };
  const from = opt("from", "south-west");
  const to = opt("to", "north-east");
  const view = opt("view", "high top-down");
  const n = Number(opt("n", "4"));
  const [srcKey, outKey] = args;
  if (!srcKey || !outKey) throw new Error("使い方はファイル先頭のコメントを見てください");
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // .env がなければ環境変数をそのまま使う
  }
  const image = pad(readFileSync(path.join(SRC, `${srcKey}.png`)));
  const dir = path.join(CANDIDATES, outKey, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const body = {
    image_size: { width: SIZE, height: SIZE },
    from_image: imageParam(image),
    from_direction: from,
    to_direction: to,
    from_view: view,
    to_view: view,
    isometric: true,
  };
  writeFileSync(path.join(dir, "request.json"), JSON.stringify({ ...body, from_image: srcKey }, null, 2));
  // 1回で1枚なので、シードを変えて n 回送る
  const results = await Promise.all(
    Array.from({ length: n }, (_, k) => generate("rotate", { ...body, seed: k + 1 }).then((r) => findImages(r)[0] ?? null)),
  );
  results.forEach((img, k) => img && writeFileSync(path.join(dir, `${String(k).padStart(2, "0")}.png`), img));
  console.log(`${results.filter(Boolean).length} 枚を保存：${path.relative(ROOT, dir)}`);
}

if (require.main === module)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
