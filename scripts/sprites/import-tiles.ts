// create-tiles-pro の結果を、選んだ絵の置き場（art/sprites/<tw>/）へキーの名前で取り込む（§4.1 の4）。
//
//   npx tsx scripts/sprites/import-tiles.ts road <候補のフォルダ> road/1           道路：tile_rules のつながり方でキーを付ける
//   npx tsx scripts/sprites/import-tiles.ts ground <候補のフォルダ> ground/grass 0 3 5 7  地面：選んだタイルを 0, 1, 2… の順に付ける
//
// タイルの絵は上面のひし形の上に余白や、隣のタイルの切れ端が乗ることがある。ひし形の先端より上は消し、
// 基準点（ひし形の中心）を画像から求めて anchors.json に書く。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPng, writePng } from "./png";

const ROOT = path.resolve(__dirname, "../..");

/**
 * 上面のひし形の中心。2:1 のひし形は先端から tw/4 行で幅が tw に達するので、
 * 幅が初めて tw になる行から先端を逆算する（上に飛び出した小物に左右されない）。
 */
export function tileAnchor(file: string): [number, number] {
  return tileTip(readPng(readFileSync(file))).anchor;
}

function tileTip({ width, height, alpha }: { width: number; height: number; alpha: Uint8Array }): { tip: number; anchor: [number, number] } {
  for (let y = 0; y < height; y++) {
    let w = 0;
    for (let x = 0; x < width; x++) if (alpha[y * width + x] > 127) w++;
    if (w >= width) {
      const tip = y - (width / 4 - 1);
      return { tip, anchor: [width / 2, tip + width / 4] };
    }
  }
  throw new Error("幅いっぱいの行がありません（タイルの形ではない）");
}

function main() {
  const [kind, dir, prefix, ...picks] = process.argv.slice(2);
  if (!kind || !dir || !prefix) throw new Error("使い方はファイル先頭のコメントを見てください");
  const tw = path.relative(path.join(ROOT, "art/candidates"), path.resolve(dir)).split(path.sep)[0];
  const outDir = path.join(ROOT, "art/sprites", tw);
  const anchorsFile = path.join(outDir, "anchors.json");
  const anchors: Record<string, [number, number]> = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : {};

  const put = (tile: string, key: string) => {
    const png = readPng(readFileSync(path.join(dir, `${tile}.png`)));
    const { tip, anchor } = tileTip(png);
    png.rgba.fill(0, 0, tip * png.width * 4);
    const to = path.join(outDir, `${key}.png`);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, writePng(png.width, png.height, png.rgba));
    anchors[key] = anchor;
    console.log(`${tile} → ${key}  基準点 ${anchors[key].join(",")}`);
  };

  if (kind === "road") {
    const res = JSON.parse(readFileSync(path.join(dir, "response.json"), "utf8"));
    const rules = res.tiles?.tile_rules?.tiles as Record<string, { mask: number }> | undefined;
    if (!rules) throw new Error("tile_rules がありません（道路の組ではない）");
    // 同じつながり方が複数あるときは、先に出てきたもの（または picks で指定したもの）を使う
    const done = new Set<number>();
    const order = picks.length ? [...picks, ...Object.keys(rules)] : Object.keys(rules);
    for (const tile of order) {
      const mask = rules[tile]?.mask;
      if (mask === undefined || done.has(mask)) continue;
      done.add(mask);
      put(tile, `${prefix}/${mask}`);
    }
    const missing = Array.from({ length: 16 }, (_, m) => m).filter((m) => !done.has(m));
    if (missing.length) console.log(`つながり方 ${missing.join(", ")} の絵がありません（描画側で反転か代わりの絵を使う）`);
  } else if (kind === "ground") {
    if (!picks.length) throw new Error("使うタイル番号を指定してください（例 0 3 5 7）");
    picks.forEach((n, i) => put(`tile_${n}`, `${prefix}/${i}`));
  } else {
    throw new Error(`種類 ${kind} は road か ground`);
  }
  writeFileSync(anchorsFile, JSON.stringify(anchors, null, 2) + "\n");
}

if (require.main === module) main();
