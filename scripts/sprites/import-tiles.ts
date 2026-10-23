// create-tiles-pro の結果を、選んだ絵の置き場（art/sprites/<tw>/）へキーの名前で取り込む（§4.1 の4）。
//
//   npx tsx scripts/sprites/import-tiles.ts road <候補のフォルダ> road/1           道路：tile_rules のつながり方でキーを付ける
//   npx tsx scripts/sprites/import-tiles.ts ground <候補のフォルダ> ground/grass 0 3 5 7  地面：選んだタイルを 0, 1, 2… の順に付ける
//
// 道路のタイルの草は、地面の草のタイル（ground/grass/0）の同じ位置の画素に置き換える。タイルの形が同じなので、
// 隣の草と色も模様もつながる（道路のタイルの草は明るすぎて、地面の草と並べると帯に見えるため）。
//
// タイルの絵は上面のひし形の上に余白や、隣のタイルの切れ端が乗ることがある。ひし形の先端より上は消し、
// 基準点（ひし形の中心）を画像から求めて anchors.json に書く。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Png, readPng, writePng } from "./png";

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

/** 緑が勝っている画素を草とみなし、草のタイルの同じ位置（基準点をそろえた位置）の画素に置き換える */
export function replaceGrass(png: { width: number; height: number; rgba: Uint8Array }, grass: { width: number; height: number; rgba: Uint8Array }, dy: number) {
  const { width, height, rgba } = png;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (rgba[o + 3] < 128) continue;
      const [r, g, b] = [rgba[o], rgba[o + 1], rgba[o + 2]];
      if (!(g > r + 12 && g > b + 12)) continue;
      const gy = y + dy;
      if (gy < 0 || gy >= grass.height || x >= grass.width) continue;
      const go = (gy * grass.width + x) * 4;
      if (grass.rgba[go + 3] < 128) continue;
      rgba.set(grass.rgba.subarray(go, go + 4), o);
    }
}

const bits = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

/** 画素がどの腕の側にあるか（北1・東2・南4・西8）。基準点からのずれをマス座標に戻して、一番近い辺の向きを返す */
export function armOf(dx: number, dy: number, tw: number): number {
  const a = dx / (tw / 2);
  const b = dy / (tw / 4);
  const x = (a + b) / 2;
  const y = (b - a) / 2;
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? 1 : 4;
  return x > 0 ? 2 : 8;
}

/**
 * 十字路（15）から、つながり方 m にない腕を消したタイルを作る。消す腕の側は、その腕のない直線道路
 * （北・南の腕なら東西の 10、東・西の腕なら南北の 5）の同じ位置の画素で置き換える。3つのタイルは同じ形で、基準点も同じ。
 */
export function composeJunction(m: number, load: (mask: number) => Png) {
  const cross = load(15);
  const ew = load(10);
  const ns = load(5);
  const { anchor } = tileTip(cross);
  const out = { width: cross.width, height: cross.height, rgba: new Uint8Array(cross.rgba) };
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const arm = armOf(x + 0.5 - anchor[0], y + 0.5 - anchor[1], out.width);
      if (m & arm) continue;
      const src = arm === 1 || arm === 4 ? ew : ns;
      const o = (y * out.width + x) * 4;
      out.rgba.set(src.rgba.subarray(o, o + 4), o);
    }
  return out;
}

function main() {
  const [kind, dir, prefix, ...picks] = process.argv.slice(2);
  if (!kind || !dir || !prefix) throw new Error("使い方はファイル先頭のコメントを見てください");
  const tw = path.relative(path.join(ROOT, "art/candidates"), path.resolve(dir)).split(path.sep)[0];
  const outDir = path.join(ROOT, "art/sprites", tw);
  const anchorsFile = path.join(outDir, "anchors.json");
  const anchors: Record<string, [number, number]> = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : {};

  const grassFile = path.join(outDir, "ground/grass/0.png");
  const grass = kind === "road" && existsSync(grassFile) ? readPng(readFileSync(grassFile)) : null;

  const put = (tile: string, key: string) => {
    const png = readPng(readFileSync(path.join(dir, `${tile}.png`)));
    const { tip, anchor } = tileTip(png);
    png.rgba.fill(0, 0, tip * png.width * 4);
    if (grass) {
      const g = tileTip(grass);
      replaceGrass(png, grass, g.anchor[1] - anchor[1]);
    }
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
    // 3方向以上のつながり方が欠けていたら、十字路から腕を消して作る
    for (let m = 0; m < 16; m++) {
      if (done.has(m) || bits(m) < 3 || !done.has(15) || !done.has(5) || !done.has(10)) continue;
      const out = composeJunction(m, (k) => readPng(readFileSync(path.join(outDir, `${prefix}/${k}.png`))));
      writeFileSync(path.join(outDir, `${prefix}/${m}.png`), writePng(out.width, out.height, out.rgba));
      anchors[`${prefix}/${m}`] = anchors[`${prefix}/15`];
      done.add(m);
      console.log(`合成 → ${prefix}/${m}（十字路から腕を消した）`);
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
