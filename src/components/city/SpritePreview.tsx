"use client";

// 絵1枚のプレビュー（ほしい物の像、確認ページの並び）。PixiJS を使わず、アトラスから切り出して canvas に描く（§6）。
import { useEffect, useRef, useState } from "react";
import { loadAtlas } from "@/components/iso/atlas";
import { ArtBook } from "@/components/iso/artbook";
import { nightColor } from "@/components/iso/compose";

type Props = {
  spriteKey: string;
  className?: string;
  /** 夜の暗さ（0〜1）。描画と同じく、暗い色を掛けて窓の灯りを足す（OBJ-14） */
  night?: number;
  /** 灯る窓の割合 */
  lights?: number;
  /** 1ドットを何物理ピクセルで見せるか。省略すると className の大きさに任せる */
  scale?: number;
};

export function SpritePreview({ spriteKey, className, night = 0, lights = 1, scale }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    let alive = true;
    const draw = (book: ArtBook) => {
      const c = ref.current;
      if (!alive || !c) return;
      const art = book.art(spriteKey);
      c.width = art.canvas.width;
      c.height = art.canvas.height;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(art.canvas, 0, 0);
      if (night > 0) {
        const [r, g, b] = nightColor(night);
        ctx.globalCompositeOperation = "multiply";
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, 0, c.width, c.height);
        // 掛けた色で透明な所まで塗られたので、元の形で切り抜き直す
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(art.canvas, 0, 0);
        const glow = book.glow(spriteKey, lights);
        if (glow) {
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = night;
          ctx.drawImage(glow.canvas, Math.round(art.ax - glow.ax), Math.round(art.ay - glow.ay));
          ctx.globalAlpha = 1;
        }
        ctx.globalCompositeOperation = "source-over";
      }
      if (scale) {
        const dpr = window.devicePixelRatio || 1;
        setSize({ width: (c.width * scale) / dpr, height: (c.height * scale) / dpr });
      }
    };
    loadAtlas()
      .then(({ tw }) => {
        const book = new ArtBook(tw);
        return book.loadAtlas().then(() => draw(book));
      })
      // アトラスが読めなければ仮の絵で描く
      .catch(() => draw(new ArtBook(64)));
    return () => {
      alive = false;
    };
  }, [spriteKey, night, lights, scale]);
  return <canvas ref={ref} aria-hidden title={spriteKey} className={`pixelated object-contain ${className ?? ""}`} style={size} />;
}
