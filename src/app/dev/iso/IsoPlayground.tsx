"use client";

import { useMemo, useRef, useState } from "react";
import { IsoCity } from "@/components/iso/IsoCity";
import type { IsoStage } from "@/components/iso/IsoStage";
import { dummyMap } from "@/components/iso/map";

const SIZES = [10, 32, 128];
const AGENTS = [0, 100, 300];

/** 128×128 のダミーマップで、カメラ・画面外の省略・人と車の性能を確かめる（RND-13・NF-01） */
export function IsoPlayground() {
  const [tw, setTw] = useState(64);
  const [size, setSize] = useState(128);
  const [agents, setAgents] = useState(300);
  const [fixed, setFixed] = useState(false);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [stats, setStats] = useState({ fps: 0, minFps: 0, sprites: 0, chunks: 0 });
  const stage = useRef<IsoStage | null>(null);
  const map = useMemo(() => dummyMap(size), [size]);

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col gap-2 p-2">
      <h1 className="text-lg font-bold">M0 試作：アイソメトリックの描画</h1>
      <div className="flex flex-wrap gap-2 text-sm">
        <Choice label="タイル" value={tw} options={[64, 32]} format={(v) => `${v}×${v / 2}`} onChange={setTw} />
        <Choice label="マップ" value={size} options={SIZES} format={(v) => `${v}×${v}`} onChange={setSize} />
        <Choice label="人と車" value={agents} options={AGENTS} format={String} onChange={setAgents} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
          カメラ固定（全体表示）
        </label>
        <button type="button" className="underline" onClick={() => stage.current?.focusTile(Math.floor(size / 2), Math.floor(size / 2))}>
          中心へ飛ぶ
        </button>
      </div>
      <p className="num text-xs">
        {stats.fps} fps（直近の最低 {stats.minFps}）・描画中の建物と人 {stats.sprites}・地面のチャンク {stats.chunks}
        {selected && ` ・選択 (${selected.x}, ${selected.y})`}
      </p>
      <IsoCity
        key={`${tw}-${size}-${agents}-${fixed}`}
        className="min-h-0 flex-1"
        map={map}
        tw={tw}
        agents={agents}
        interactive={!fixed}
        storageKey={`dev-iso-camera-${tw}-${size}`}
        selected={selected}
        onSelect={setSelected}
        onStats={setStats}
        onReady={(s) => (stage.current = s)}
        label={`検証用のダミーマップ ${size}×${size}`}
      />
      <p className="text-xs text-muted">
        絵は M0 用の仮の絵です。PixelLab で作った絵が揃ったら同じキーで差し替わります。
      </p>
    </main>
  );
}

function Choice<T extends number>({ label, value, options, format, onChange }: { label: string; value: T; options: T[]; format: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <span className="flex items-center gap-1">
      {label}
      {options.map((o) => (
        <button key={o} type="button" className={`rounded border px-2 ${o === value ? "bg-black text-white" : ""}`} onClick={() => onChange(o)}>
          {format(o)}
        </button>
      ))}
    </span>
  );
}
