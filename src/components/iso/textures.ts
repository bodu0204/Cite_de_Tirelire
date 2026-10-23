// 絵をキーで引く台帳（§9 の getTexture）。今は仮の絵を描いて返し、アトラスが揃ったらそちらを先に引く。
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

export class TextureBook {
  private cache = new Map<string, Entry>();

  constructor(readonly tw: number) {}

  get(key: string): Entry {
    let e = this.cache.get(key);
    if (!e) {
      const art = drawArt(key, this.tw) ?? missingArt(this.tw);
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
