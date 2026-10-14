"use client";

import { useEffect, useRef, useState } from "react";
import { MAP_SIZE } from "@/game/config";
import { CANVAS_PX, drawCity, T, type DrawInput } from "./draw";

type Props = Omit<DrawInput, "frame" | "now"> & {
  onSelect?: (tile: { x: number; y: number }) => void;
  label: string;
  /** 経過時間の基準（サーバー時刻）。未指定なら端末時刻 */
  serverOffset?: number;
};

export function CityCanvas({ onSelect, label, serverOffset = 0, ...input }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const t = setInterval(() => setFrame((f) => f + 1), 450);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (!c) return;
    c.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    drawCity(c, { ...input, frame, now: Date.now() + serverOffset });
  });

  function pick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!onSelect || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * MAP_SIZE);
    const y = Math.floor(((e.clientY - r.top) / r.height) * MAP_SIZE);
    if (x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE) onSelect({ x, y });
  }

  function onKey(e: React.KeyboardEvent) {
    if (!onSelect) return;
    const cur = input.selected ?? { x: 4, y: 4 };
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = d[e.key];
    if (!step) return;
    e.preventDefault();
    onSelect({ x: Math.max(0, Math.min(MAP_SIZE - 1, cur.x + step[0])), y: Math.max(0, Math.min(MAP_SIZE - 1, cur.y + step[1])) });
  }

  return (
    <div className="rounded-xl border-4 border-[var(--map-frame)] bg-[var(--map-frame)] shadow-inner">
      <canvas
        ref={ref}
        width={CANVAS_PX}
        height={CANVAS_PX}
        onClick={pick}
        onKeyDown={onKey}
        tabIndex={onSelect ? 0 : -1}
        aria-label={label}
        role="img"
        className="pixelated block aspect-square w-full cursor-pointer rounded-md"
        style={{ maxWidth: T * MAP_SIZE * 4 }}
      />
    </div>
  );
}
