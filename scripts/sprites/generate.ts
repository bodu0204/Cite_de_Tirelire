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

interface SpriteDef {
  key: string;
  stage: string;
  endpoint: string;
  heightTiles: number;
  description: string;
  body: Record<string, unknown>;
  /** API の項目名 → 参照する絵のキー */
  refs?: Record<string, string>;
}

interface Manifest {
  style: string;
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
export function buildBody(def: SpriteDef, style: string, tw: number): Record<string, unknown> {
  const width = tw;
  const height = Math.round(tw * def.heightTiles);
  const description = `${def.description}. ${style}`;
  const body: Record<string, unknown> = { description };
  if (def.endpoint === "create-isometric-tile") {
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
  Object.assign(body, def.body);
  for (const [field, key] of Object.entries(def.refs ?? {})) {
    const file = path.join(SELECTED, String(tw), `${key}.png`);
    if (!existsSync(file)) throw new Error(`${def.key}：参照する絵 ${key} がまだ選ばれていません（${file}）`);
    const img = imageParam(readFileSync(file));
    body[field] = field.endsWith("s") ? [img] : img;
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
    const body = buildBody(def, m.style, tw);
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
