// 絵をキーで引く台帳（§9 の getTexture）の、PixiJS に依存しない部分。読み込んだ絵（アトラスか、開発用の選んだ絵）を
// 先に引き、組み合わせの絵（compose.ts）を作り、なければ仮の絵を描いて返す。
import { LINES, type LineId } from "@/game/catalog";
import { type AnimIndex, loadAtlas, loadImage } from "./atlas";
import { blended, dimmed, statueInProgress, withLevel } from "./compose";
import { type Art, drawAgentArt, drawBuildingArt, drawGroundArt, drawSelectArt } from "./placeholder";

function drawArt(key: string, tw: number): Art | null {
  const [kind, a, b] = key.split("/");
  if (kind === "building" && a in LINES) {
    const tier = Number(b);
    if (tier >= 0 && tier < LINES[a as LineId].tiers.length) return drawBuildingArt(a as LineId, tier, tw);
    return null;
  }
  if (kind === "ground" || kind === "road") return drawGroundArt(key, tw);
  if (key === "ui/select") return drawSelectArt(tw);
  if (key === "ui/highlight") return drawSelectArt(tw, "#fff176");
  if (kind === "agent" && (a === "person" || a === "car")) return drawAgentArt(a, Number(b) || 0, tw);
  return null;
}

/** 台帳にない絵の代わり（抜け漏れが目で分かるよう、目立つ色にする） */
function missingArt(tw: number): Art {
  const c = document.createElement("canvas");
  c.width = tw / 2;
  c.height = tw / 2;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, c.width, c.height);
  return { canvas: c, ax: c.width / 2, ay: c.height - 1 };
}

/** 選んだ絵の置き場所（開発環境では /dev/sprites/file/sprites/<tw>/<キー>.png） */
export interface ArtSource {
  url: (key: string) => string;
  keys: string[];
  /** 基準点（地面・道路のタイルは画像から求めて anchors.json に書いてある） */
  anchors?: Record<string, [number, number]>;
}

/** 左右反転したときのつながり方（北↔西、東↔南） */
function mirrorMask(m: number): number {
  return ((m & 1) << 3) | ((m & 8) >> 3) | ((m & 2) << 1) | ((m & 4) >> 1);
}

/** 左右反転（南北の道路から東西の道路を作る） */
function mirror(a: Art): Art {
  const c = document.createElement("canvas");
  c.width = a.canvas.width;
  c.height = a.canvas.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(a.canvas, 0, 0);
  return { canvas: c, ax: c.width - a.ax, ay: a.ay };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 不透明な画素の一番下の行（建物の足元のひし形の下の頂点） */
function opaqueBottom(c: HTMLCanvasElement): number {
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  for (let y = c.height - 1; y >= 0; y--) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 127) return y;
  return c.height - 1;
}

export class ArtBook {
  protected loaded = new Map<string, Art>();
  protected anims: AnimIndex = {};

  constructor(readonly tw: number) {}

  /** アトラスを読み込む（基準点はアトラスの JSON の anchor） */
  async loadAtlas() {
    const { tw, arts, anims } = await loadAtlas();
    if (tw !== this.tw) throw new Error(`アトラスは ${tw}px 用です（描画は ${this.tw}px）`);
    for (const [k, a] of arts) this.loaded.set(k, a);
    this.anims = anims;
  }

  /**
   * 動く絵のコマ（OBJ-12）。基の絵に動きがなければ null。建物Lv の小物（@lv）は各コマに重ねる。
   * 閉園・建設途中など、止まっているはずの見た目には動きを付けない。
   */
  frames(key: string): { arts: Art[]; fps: number } | null {
    const at = key.indexOf("@");
    const base = at < 0 ? key : key.slice(0, at);
    const mod = at < 0 ? "" : key.slice(at + 1);
    const a = this.anims[base];
    if (!a || (mod && !mod.startsWith("lv") && mod !== "flip")) return null;
    const arts: Art[] = [];
    for (let i = 0; i < a.frames; i++) {
      const f = this.loaded.get(`anim/${base}/${i}`);
      if (!f) return null;
      arts.push(mod === "flip" ? mirror(f) : mod ? withLevel(f, Number(mod.slice(2)), this.props(), this.tw) : f);
    }
    return { arts, fps: a.fps };
  }

  /**
   * 夜の窓の灯り（OBJ-14）。発光マスク glow/<基のキー> の、つながった灯りのかたまりごとに、
   * 割合 ratio に応じて灯すかを決める（同じ建物はいつも同じ窓が灯る）。マスクがなければ null。
   */
  glow(key: string, ratio: number): Art | null {
    const at = key.indexOf("@");
    const base = at < 0 ? key : key.slice(0, at);
    const mask = this.loaded.get(`glow/${base}`);
    const shape = this.loaded.get(base);
    if (!mask || !shape || ratio <= 0) return null;
    const { width: w, height: h } = mask.canvas;
    const ctx = mask.canvas.getContext("2d", { willReadFrequently: true })!;
    const src = ctx.getImageData(0, 0, w, h);
    const d = src.data;
    const seen = new Uint8Array(w * h);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const out = c.getContext("2d", { willReadFrequently: true })!.createImageData(w, h);
    for (let start = 0; start < w * h; start++) {
      if (seen[start] || d[start * 4 + 3] < 128) continue;
      // つながった灯りの画素（上下左右と斜め）を1つの窓とみなす
      const stack = [start];
      const comp: number[] = [];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        comp.push(i);
        const x = i % w;
        const y = (i - x) / w;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!seen[j] && d[j * 4 + 3] >= 128) {
              seen[j] = 1;
              stack.push(j);
            }
          }
      }
      if ((hashStr(base) ^ Math.imul(start, 2654435761)) >>> 0 > ratio * 0xffffffff) continue;
      for (const i of comp) out.data.set(d.subarray(i * 4, i * 4 + 4), i * 4);
    }
    c.getContext("2d", { willReadFrequently: true })!.putImageData(out, 0, 0);
    return { canvas: c, ax: shape.ax, ay: shape.ay };
  }

  private props(): (Art | null)[] {
    return [2, 3, 4, 5, 6].map((lv) => this.loaded.get(`props/lv/${lv}`) ?? null);
  }

  /** キーの絵（組み合わせも含む）を canvas で返す。PixiJS を使わない画面向け */
  art(key: string): Art {
    return this.composed(key) ?? this.loadedArt(key) ?? drawArt(key, this.tw) ?? missingArt(this.tw);
  }

  /** 組み合わせて作る絵（compose.ts）。基の絵がなければ null */
  protected composed(key: string): Art | null {
    const at = key.indexOf("@");
    if (key === "ground/locked") {
      const g = this.loaded.get("ground/grass/0");
      return g ? dimmed(g, 0.5, 0.55) : null;
    }
    // 大きな建物の敷地（生成した絵がなければ、草を土の色に寄せて作る）
    if (key === "ground/lot" && !this.loaded.has(key)) {
      const g = this.loaded.get("ground/grass/0");
      return g ? blended(g, [0xc9, 0xb3, 0x86], 0.72) : null;
    }
    if (at < 0) return null;
    const baseKey = key.slice(0, at);
    const mod = key.slice(at + 1);
    const base = this.loadedArt(baseKey) ?? drawArt(baseKey, this.tw);
    if (!base) return null;
    if (mod.startsWith("lv")) {
      const props = [2, 3, 4, 5, 6].map((lv) => this.loaded.get(`props/lv/${lv}`) ?? null);
      return withLevel(base, Number(mod.slice(2)), props, this.tw);
    }
    if (mod === "closed") return dimmed(base, 0.7, 0.8);
    // 左右反転（人と車の左向き）
    if (mod === "flip") return mirror(base);
    if (mod.startsWith("stage")) return statueInProgress(base, Number(mod.slice(5)), this.loaded.get("fx/cover") ?? null);
    return base;
  }

  /**
   * 開発用に、選んだ絵をそのまま読み込む。基準点は anchors にあればそれを、なければ build-atlas.ts と同じく
   * 「横の中央・不透明な画素の一番下から th/2 上」とする（本番はアトラスの JSON の anchor を使う）。
   */
  async load(src: ArtSource) {
    await Promise.all(
      src.keys.map(async (key) => {
        const img = await loadImage(src.url(key));
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0);
        // 小物・人と車・アイコンは地面のひし形に乗らないので、不透明な画素の一番下を基準点にする
        const small = /^(props|agent|icons)\//.test(key);
        const [ax, ay] = src.anchors?.[key] ?? [c.width / 2, opaqueBottom(c) - (small ? 0 : this.tw / 4 - 1)];
        this.loaded.set(key, { canvas: c, ax, ay });
      }),
    );
  }

  /**
   * 読み込んだ絵から探す。足りない分は代わりを使う：草は1種目、道路は1段階目（舗装道路）。
   * 道路のつながり方がなければ、左右反転したつながり方の絵を反転して使い、それもなければ十字路にする。
   */
  protected loadedArt(key: string): Art | null {
    const hit = this.loaded.get(key);
    if (hit) return hit;
    const [kind, a, b] = key.split("/");
    if (kind === "ground" && a === "grass") return this.loaded.get("ground/grass/0") ?? null;
    if (kind === "road") {
      const mask = Number(b);
      const tier = this.loaded.has(`road/${a}/15`) ? a : "1";
      const same = this.loaded.get(`road/${tier}/${mask}`);
      if (same) return same;
      const flipped = this.loaded.get(`road/${tier}/${mirrorMask(mask)}`);
      if (flipped) return mirror(flipped);
      return this.loaded.get(`road/${tier}/15`) ?? null;
    }
    return null;
  }
}
