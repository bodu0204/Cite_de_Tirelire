// アトラス（public/sprites/）を読み込み、絵ごとの canvas に切り出す。PixiJS に依存しないので、
// ほしい物の像のプレビューのように1枚だけ描く画面からも使える（§6）。
import type { Art } from "./placeholder";

/** scripts/sprites/build-atlas.ts が書き出す入口 */
export const ATLAS_INDEX = "/sprites/index.json";

interface AtlasJson {
  frames: Record<string, { frame: { x: number; y: number; w: number; h: number }; anchor: { x: number; y: number } }>;
  meta: { image: string };
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ng(new Error(`読み込めません：${url}`));
    img.src = url;
  });
}

/** 動く絵：キー → コマ数と速さ（コマはアトラスに anim/<キー>/<番号> の名前で入っている。ANI-02） */
export type AnimIndex = Record<string, { fps: number; frames: number }>;

interface LoadedAtlas {
  tw: number;
  arts: Map<string, Art>;
  anims: AnimIndex;
}

let cached: Promise<LoadedAtlas> | null = null;

/** 1回だけ読み込み、以後は同じ結果を返す（失敗したら次に呼んだ時に読み直す） */
export function loadAtlas(indexUrl = ATLAS_INDEX): Promise<LoadedAtlas> {
  if (cached) return cached;
  const base = indexUrl.slice(0, indexUrl.lastIndexOf("/") + 1);
  cached = (async () => {
    const index = (await (await fetch(indexUrl)).json()) as { tw: number; atlases: string[]; anims?: AnimIndex };
    const arts = new Map<string, Art>();
    await Promise.all(
      index.atlases.map(async (name) => {
        const json = (await (await fetch(base + name)).json()) as AtlasJson;
        const img = await loadImage(base + json.meta.image);
        for (const [key, f] of Object.entries(json.frames)) {
          const c = document.createElement("canvas");
          c.width = f.frame.w;
          c.height = f.frame.h;
          c.getContext("2d", { willReadFrequently: true })!.drawImage(img, f.frame.x, f.frame.y, f.frame.w, f.frame.h, 0, 0, f.frame.w, f.frame.h);
          arts.set(key, { canvas: c, ax: Math.round(f.anchor.x * f.frame.w), ay: Math.round(f.anchor.y * f.frame.h) });
        }
      }),
    );
    return { tw: index.tw, arts, anims: index.anims ?? {} };
  })();
  cached.catch(() => (cached = null));
  return cached;
}
