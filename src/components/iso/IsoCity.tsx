"use client";

// React から PixiJS の街を使う入口。PixiJS はブラウザ専用なので、useEffect の中で動的に読み込む。
import { useEffect, useRef, useState } from "react";
import type { Camera } from "./camera";
import type { IsoStage, StageOptions } from "./IsoStage";
import type { IsoMap } from "./map";

type Props = {
  map: IsoMap;
  tw?: number;
  agents?: number;
  /** false ならカメラ固定（CAM-09） */
  interactive?: boolean;
  /** 最後に見ていた位置と倍率を覚えておくキー（CAM-07）。省略すると覚えない */
  storageKey?: string;
  selected?: { x: number; y: number } | null;
  onSelect?: (tile: { x: number; y: number }) => void;
  onStats?: StageOptions["onStats"];
  /** 描画の準備ができた時に呼ぶ。focusTile（CAM-08）などを呼ぶのに使う */
  onReady?: (stage: IsoStage) => void;
  label: string;
  className?: string;
};

function loadCamera(key?: string): Camera | null {
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v && typeof v.cx === "number" && typeof v.cy === "number" && typeof v.zoom === "number" ? v : null;
  } catch {
    return null;
  }
}

function saveCamera(key: string, cam: Camera) {
  try {
    localStorage.setItem(key, JSON.stringify(cam));
  } catch {
    // 保存できなくても描画には影響しない
  }
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function IsoCity({ map, tw = 64, agents = 0, interactive = true, storageKey, selected, onSelect, onStats, onReady, label, className }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<IsoStage | null>(null);
  const [failed, setFailed] = useState<null | "nowebgl" | "lost">(null);
  const [generation, setGeneration] = useState(0);
  const latest = useRef({ onSelect, onStats, onReady, selected });
  latest.current = { onSelect, onStats, onReady, selected };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (!hasWebGL()) {
      setFailed("nowebgl");
      return;
    }
    let alive = true;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    import("./IsoStage")
      .then(({ IsoStage }) =>
        IsoStage.create(el, map, {
          tw,
          agents,
          interactive,
          reducedMotion,
          camera: loadCamera(storageKey),
          onSelect: (t) => latest.current.onSelect?.(t),
          onStats: (s) => latest.current.onStats?.(s),
          onCamera: (cam) => {
            if (!storageKey) return;
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => saveCamera(storageKey, cam), 300);
          },
          onContextLost: () => {
            // WebGL のコンテキストが失われたら作り直す（NF-06）
            setFailed("lost");
            setTimeout(() => {
              setFailed(null);
              setGeneration((g) => g + 1);
            }, 500);
          },
        }),
      )
      .then((s) => {
        if (!alive) return s.destroy();
        stage.current = s;
        s.setSelected(latest.current.selected ?? null);
        latest.current.onReady?.(s);
      })
      .catch(() => alive && setFailed("nowebgl"));
    return () => {
      alive = false;
      clearTimeout(saveTimer);
      stage.current?.destroy();
      stage.current = null;
    };
    // 盤面の入れ替えは下の effect で行う。ここは作り直しが必要な設定だけ
  }, [tw, agents, interactive, storageKey, generation]);

  useEffect(() => {
    stage.current?.setMap(map);
  }, [map]);

  useEffect(() => {
    stage.current?.setSelected(selected ?? null);
  }, [selected]);

  function onKey(e: React.KeyboardEvent) {
    const s = stage.current;
    if (!s || !onSelect) return;
    const d: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = d[e.key];
    if (e.key === "+" || e.key === "=") s.zoomBy(1);
    else if (e.key === "-") s.zoomBy(-1);
    if (!step) return;
    e.preventDefault();
    const { width, height } = s.mapSize;
    const cur = selected ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) };
    const next = { x: Math.max(0, Math.min(width - 1, cur.x + step[0])), y: Math.max(0, Math.min(height - 1, cur.y + step[1])) };
    onSelect(next);
    s.follow(next.x, next.y);
  }

  if (failed === "nowebgl")
    return (
      <div className={`grid place-items-center rounded-md bg-[var(--map-frame)] p-4 text-sm text-white ${className ?? ""}`} role="img" aria-label={label}>
        この端末では街の絵を表示できません（WebGL が使えません）。数値の情報は下に表示しています。
      </div>
    );

  return (
    <div className={`relative overflow-hidden rounded-md bg-[var(--map-frame)] ${className ?? ""}`}>
      <div ref={host} className="absolute inset-0" role="img" aria-label={label} tabIndex={onSelect ? 0 : -1} onKeyDown={onKey} />
      {failed === "lost" && <div className="absolute inset-0 grid place-items-center bg-black/50 text-sm text-white">描画を作り直しています…</div>}
      {interactive && (
        <div className="absolute right-2 bottom-2 flex flex-col gap-1">
          <button type="button" className="size-10 rounded-md bg-white/90 text-lg font-bold shadow" aria-label="拡大" onClick={() => stage.current?.zoomBy(1)}>
            ＋
          </button>
          <button type="button" className="size-10 rounded-md bg-white/90 text-lg font-bold shadow" aria-label="縮小" onClick={() => stage.current?.zoomBy(-1)}>
            −
          </button>
        </div>
      )}
    </div>
  );
}
