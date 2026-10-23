// 絵をキーで引く台帳（§9 の getTexture）。PixiJS のテクスチャと、タップ判定用の不透明な画素を持つ。
import { Texture } from "pixi.js";
import { ArtBook } from "./artbook";
import { alphaMask } from "./placeholder";

export type { ArtSource } from "./artbook";

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

export class TextureBook extends ArtBook {
  private cache = new Map<string, Entry>();

  get(key: string): Entry {
    let e = this.cache.get(key);
    if (!e) {
      const art = this.art(key);
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
