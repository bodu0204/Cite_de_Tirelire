// 絵をキーで引く台帳（§9 の getTexture）。PixiJS のテクスチャと、タップ判定用の不透明な画素を持つ。
import { Texture } from "pixi.js";
import { ArtBook } from "./artbook";
import { outlineOf } from "./compose";
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
  private animCache = new Map<string, { entries: Entry[]; fps: number } | null>();

  private entry(art: { canvas: HTMLCanvasElement; ax: number; ay: number }): Entry {
    // canvas はアトラスの読み込み結果として描画をまたいで使い回すので、PixiJS の内部の記憶を使わない
    // （使うと、作り直す前の描画が破棄したテクスチャを受け取ってしまう）
    const texture = Texture.from(art.canvas, true);
    texture.source.scaleMode = "nearest";
    return { texture, ax: art.ax, ay: art.ay, w: art.canvas.width, h: art.canvas.height, mask: alphaMask(art) };
  }

  private glowCache = new Map<string, Entry | null>();

  /** 夜の窓の灯り。割合は 0.1 刻みにまとめてテクスチャを使い回す（なければ null）。動く絵は frame にコマの番号 */
  getGlow(key: string, ratio: number, frame?: number): Entry | null {
    const q = Math.round(Math.max(0, Math.min(1, ratio)) * 10) / 10;
    const k = `${key}:${q}:${frame ?? ""}`;
    if (!this.glowCache.has(k)) {
      const a = this.glow(key, q, frame);
      this.glowCache.set(k, a ? this.entry(a) : null);
    }
    return this.glowCache.get(k)!;
  }

  private outlineCache = new Map<string, Entry>();

  /** 選んだ建物の輪郭（絵の外側1ドット） */
  getOutline(key: string): Entry {
    let e = this.outlineCache.get(key);
    if (!e) {
      e = this.entry(outlineOf(this.art(key), "#ffffff"));
      this.outlineCache.set(key, e);
    }
    return e;
  }

  /** 動く絵のコマ（なければ null） */
  getAnim(key: string): { entries: Entry[]; fps: number } | null {
    if (!this.animCache.has(key)) {
      const f = this.frames(key);
      this.animCache.set(key, f ? { entries: f.arts.map((a) => this.entry(a)), fps: f.fps } : null);
    }
    return this.animCache.get(key)!;
  }

  get(key: string): Entry {
    let e = this.cache.get(key);
    if (!e) {
      e = this.entry(this.art(key));
      this.cache.set(key, e);
    }
    return e;
  }

  destroy() {
    for (const e of this.cache.values()) e.texture.destroy(true);
    for (const a of this.animCache.values()) for (const e of a?.entries ?? []) e.texture.destroy(true);
    for (const e of this.glowCache.values()) e?.texture.destroy(true);
    for (const e of this.outlineCache.values()) e.texture.destroy(true);
    this.glowCache.clear();
    this.cache.clear();
    this.animCache.clear();
  }
}
