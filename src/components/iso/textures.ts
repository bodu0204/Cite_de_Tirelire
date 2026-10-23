// 絵をキーで引く台帳（§9 の getTexture）。読み込んだ絵（PixelLab で作って選んだもの）を先に引き、
// なければ仮の絵を描いて返す。
import { Texture } from "pixi.js";
import { LINES, type LineId } from "@/game/catalog";
import { type Art, alphaMask, drawAgentArt, drawBuildingArt, drawGroundArt, drawSelectArt } from "./placeholder";

export interface Entry {
  texture: Texture;
  /** 基準点（足元のひし形の中心）。絵の左上からのドット数 */
  ax: number;
  ay: number;
  w: number;
  h: number;
  /** 不透明な画素（行優先、1 = 不透明） */
  mask: Uint8Array;
}

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
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ff00ff";
  ctx.fillRect(0, 0, c.width, c.height);
  return { canvas: c, ax: c.width / 2, ay: c.height - 1 };
}

/** 選んだ絵の置き場所（開発環境では /dev/sprites/file/sprites/<tw>/<キー>.png） */
export interface ArtSource {
  url: (key: string) => string;
  keys: string[];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ng(new Error(`読み込めません：${url}`));
    img.src = url;
  });
}

/** 左右反転（南北の道路から東西の道路を作る） */
function mirror(a: Art): Art {
  const c = document.createElement("canvas");
  c.width = a.canvas.width;
  c.height = a.canvas.height;
  const ctx = c.getContext("2d")!;
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(a.canvas, 0, 0);
  return { canvas: c, ax: c.width - a.ax, ay: a.ay };
}

export class TextureBook {
  private cache = new Map<string, Entry>();
  private loaded = new Map<string, Art>();

  constructor(readonly tw: number) {}

  /**
   * 選んだ絵を読み込む。基準点は「下端から th/2 上、横の中央」とみなす（M0 の仮の決め方。
   * 後処理で基準点を決める §4.1 の5 ができたら、アトラスの JSON から読む）。
   */
  async load(src: ArtSource) {
    await Promise.all(
      src.keys.map(async (key) => {
        const img = await loadImage(src.url(key));
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        this.loaded.set(key, { canvas: c, ax: c.width / 2, ay: c.height - this.tw / 4 });
      }),
    );
  }

  /** 読み込んだ絵から探す。草は種類違いを、東西の道路は南北の道路の反転を代わりに使う */
  private loadedArt(key: string): Art | null {
    const hit = this.loaded.get(key);
    if (hit) return hit;
    const [kind, a, b] = key.split("/");
    if (kind === "ground" && a === "grass") return this.loaded.get("ground/grass/0") ?? null;
    if (kind === "road") {
      const ns = this.loaded.get(`road/${a}/5`) ?? this.loaded.get("road/1/5");
      if (!ns) return null;
      if (b === "5" || b === "1" || b === "4") return ns;
      if (b === "10" || b === "2" || b === "8") return mirror(ns);
    }
    return null;
  }

  get(key: string): Entry {
    let e = this.cache.get(key);
    if (!e) {
      const art = this.loadedArt(key) ?? drawArt(key, this.tw) ?? missingArt(this.tw);
      const texture = Texture.from(art.canvas);
      texture.source.scaleMode = "nearest";
      e = { texture, ax: art.ax, ay: art.ay, w: art.canvas.width, h: art.canvas.height, mask: alphaMask(art) };
      this.cache.set(key, e);
    }
    return e;
  }

  destroy() {
    for (const e of this.cache.values()) e.texture.destroy(true);
    this.cache.clear();
  }
}
