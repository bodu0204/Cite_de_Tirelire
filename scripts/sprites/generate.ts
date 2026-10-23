// 素材の候補を PixelLab で生成する（docs/rendering-requirements.md §4.1 の3）。
//
//   npx tsx scripts/sprites/generate.ts balance                      残高を見る
//   npx tsx scripts/sprites/generate.ts --tw 64 --dry-run            送る内容だけ表示する（課金なし）
//   npx tsx scripts/sprites/generate.ts --tw 64 [--stage M0] [キー…]  候補を作る
//   npx tsx scripts/sprites/generate.ts refetch <候補のフォルダ…>       課金済みのジョブの結果を取り直す（追加の課金なし）
//
// 候補は art/candidates/<tw>/<キー>/<実行時刻>/ に保存する（Git には入れない）。
// 選んだ絵は確認ページ（/dev/sprites）で art/sprites/<tw>/<キー>.png にコピーする。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { balance, findImages, generate, getTiles, imageParam, stripImages, waitJob } from "./pixellab";
import { readPng, writePng } from "./png";

interface SpriteDef {
  key: string;
  stage: string;
  endpoint: string;
  heightTiles: number;
  description: string;
  body: Record<string, unknown>;
  /** API の項目名 → 参照する絵のキー（reference_images は前の段階の絵など） */
  refs?: Record<string, string>;
  /** 画風の基準（manifest の styleKey）とマスターパレットで描かせる */
  styled?: boolean;
  /** 幅と高さ（ドット）。heightTiles より優先する */
  size?: [number, number];
  /** 動きの1コマ目の上に足す透明な行の数（煙など、上へはみ出す動き） */
  padTop?: number;
}

interface Manifest {
  style: string;
  /** 画風の基準にする絵のキー（styled な絵の style_image） */
  styleKey?: string;
  sprites: SpriteDef[];
}

const ROOT = path.resolve(__dirname, "../..");
export const CANDIDATES = path.join(ROOT, "art/candidates");
export const SELECTED = path.join(ROOT, "art/sprites");

function loadEnv() {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // .env がなければ環境変数をそのまま使う
  }
}

export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
}

/** 端点ごとに送る内容を組み立てる */
/** 絵の上に透明な行を足す */
function padTop(buf: Buffer, rows: number): Buffer {
  const p = readPng(buf);
  const out = new Uint8Array(p.width * (p.height + rows) * 4);
  out.set(p.rgba, p.width * rows * 4);
  return writePng(p.width, p.height + rows, out);
}

/** generate-image-v2 の ReferenceImage（画像と大きさ） */
function referenceImage(tw: number, key: string, usage?: string) {
  const file = path.join(SELECTED, String(tw), `${key}.png`);
  if (!existsSync(file)) throw new Error(`参照する絵 ${key} がまだ選ばれていません（${file}）`);
  const buf = readFileSync(file);
  const { width, height } = readPng(buf);
  return { image: imageParam(buf), size: { width, height }, ...(usage ? { usage_description: usage } : {}) };
}

export function buildBody(def: SpriteDef, style: string, tw: number, styleKey?: string): Record<string, unknown> {
  // 小物は size で大きさを直接決める（地面のひし形に乗らない絵）
  const [width, height] = def.size ?? [tw, Math.round(tw * def.heightTiles)];
  const description = `${def.description}. ${style}`;
  const body: Record<string, unknown> = { description };
  if (def.endpoint === "animate-with-text-v3") {
    // 動き（OBJ-12）：選んだ絵を1コマ目にして、動作だけを文章で伝える（画風の文は付けない）
    delete body.description;
    body.action = def.description;
    body.frame_count = 8;
    body.no_background = true;
  } else if (def.endpoint === "create-isometric-tile") {
    body.image_size = { width, height: width };
    body.isometric_tile_size = tw;
  } else if (def.endpoint === "create-tiles-pro") {
    body.tile_type = "isometric";
    body.tile_size = tw;
    body.tile_flat_top_px = 2;
  } else if (def.endpoint === "generate-with-style-v2") {
    // 大きさは参照画像から決まる（image_size は送らない）
  } else {
    body.image_size = { width, height };
    body.no_background = true;
  }
  if (def.styled && styleKey) {
    // 画風（画素の大きさ・輪郭・陰影）は基準の絵に、色はマスターパレットに合わせる
    body.style_image = referenceImage(tw, styleKey);
    body.style_options = { color_palette: false, outline: true, detail: true, shading: true };
    body.target_palette = { colors: (JSON.parse(readFileSync(path.join(ROOT, "art/palette.json"), "utf8")) as { colors: string[] }).colors, name: "Cite de Tirelire" };
  }
  Object.assign(body, def.body);
  for (const [field, key] of Object.entries(def.refs ?? {})) {
    if (field === "reference_images")
      body[field] = [referenceImage(tw, key, "the previous, smaller stage of the same building line: keep its materials and identity colors, but make this one clearly bigger, taller and more developed")];
    else {
      let buf: Buffer = readFileSync(path.join(SELECTED, String(tw), `${key}.png`));
      // 煙などが上へはみ出す動きは、1コマ目の上に透明な余白を足して描く場所を作る
      if (field === "first_frame" && def.padTop) buf = padTop(buf, def.padTop);
      body[field] = imageParam(buf);
    }
  }
  return body;
}

/** 結果の画像と、画像を除いた返答を保存する */
function save(dir: string, res: unknown) {
  for (const f of readdirSync(dir)) if (f.endsWith(".png") || f === "error.txt") rmSync(path.join(dir, f));
  // create-tiles-pro は tile_0, tile_1… の名前を保つ（tile_rules がその名前で規則を持つため）
  const named = (res as { tiles?: { images?: Record<string, string> } }).tiles?.images;
  const images = named ? Object.entries(named).map(([k, b64]) => [k, Buffer.from(b64, "base64")] as const) : findImages(res).map((png, i) => [String(i).padStart(2, "0"), png] as const);
  for (const [name, png] of images) writeFileSync(path.join(dir, `${name}.png`), png);
  writeFileSync(path.join(dir, "response.json"), JSON.stringify(stripImages(res), null, 2));
  console.log(`  ${images.length} 枚を保存：${path.relative(ROOT, dir)}`);
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (args[0] === "balance") {
    console.log(JSON.stringify(await balance(), null, 2));
    return;
  }
  if (args[0] === "refetch") {
    for (const dir of args.slice(1)) {
      const { job_id, tile_id } = JSON.parse(readFileSync(path.join(dir, "job.json"), "utf8")) as { job_id: string; tile_id?: string };
      const job = await waitJob(job_id, { log: console.log });
      save(dir, tile_id ? { job, tiles: await getTiles(tile_id) } : job);
    }
    return;
  }
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const tw = Number(opt("--tw") ?? 64);
  const stage = opt("--stage");
  const dry = args.includes("--dry-run");
  const keys = args.filter((a) => !a.startsWith("--"));
  const m = loadManifest();
  const targets = m.sprites.filter((s) => (!stage || s.stage === stage) && (!keys.length || keys.includes(s.key)));
  if (!targets.length) throw new Error("対象の絵がありません。キーか --stage を確かめてください");

  const run = new Date().toISOString().replace(/[:.]/g, "-");
  for (const def of targets) {
    const body = buildBody(def, m.style, tw, m.styleKey);
    console.log(`▶ ${def.key}（${def.endpoint}、${tw}px）`);
    if (dry) {
      console.log(JSON.stringify(stripImages(body), null, 2));
      continue;
    }
    const dir = path.join(CANDIDATES, String(tw), def.key, run);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "request.json"), JSON.stringify({ endpoint: def.endpoint, body: stripImages(body) }, null, 2));
    try {
      const onJob = (ids: object) => writeFileSync(path.join(dir, "job.json"), JSON.stringify(ids, null, 2));
      save(dir, await generate(def.endpoint, body, { log: console.log, onJob }));
    } catch (e) {
      writeFileSync(path.join(dir, "error.txt"), String(e instanceof Error ? e.message : e));
      console.error(`  失敗：${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
