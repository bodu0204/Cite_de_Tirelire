"use client";

// 絵1枚のプレビュー（ほしい物の像など）。PixiJS を使わず、アトラスから切り出して canvas に描く（§6）。
import { useEffect, useRef } from "react";
import { loadAtlas } from "@/components/iso/atlas";
import { ArtBook } from "@/components/iso/artbook";

export function SpritePreview({ spriteKey, className }: { spriteKey: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
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
  }, [spriteKey]);
  return <canvas ref={ref} aria-hidden className={`pixelated object-contain ${className ?? ""}`} />;
}
