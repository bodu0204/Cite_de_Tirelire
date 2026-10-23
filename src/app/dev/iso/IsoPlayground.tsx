"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IsoCity } from "@/components/iso/IsoCity";
import type { IsoStage } from "@/components/iso/IsoStage";
import { dummyMap, sampleMap } from "@/components/iso/map";

/** 0 は画風の見本（sampleMap） */
const SIZES = [0, 10, 32, 128];
const AGENTS = [0, 100, 300];

/** 128×128 のダミーマップで、カメラ・画面外の省略・人と車の性能を確かめる（RND-13・NF-01） */
export function IsoPlayground() {
  const [tw, setTw] = useState(64);
  const [size, setSize] = useState(128);
  const [agents, setAgents] = useState(300);
  const [fixed, setFixed] = useState(false);
  const [useArt, setUseArt] = useState(true);
  const [night, setNight] = useState(0);
  const [lights, setLights] = useState(0.7);
  const [artKeys, setArtKeys] = useState<string[] | null>(null);
  const [anchors, setAnchors] = useState<Record<string, [number, number]>>({});
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [stats, setStats] = useState({ fps: 0, panFps: 0, panMinFps: 0, sprites: 0, chunks: 0 });
  const stage = useRef<IsoStage | null>(null);
  const map = useMemo(() => (size ? dummyMap(size) : sampleMap()), [size]);

  // 確認ページで選んだ絵（art/sprites/<tw>/）があれば、仮の絵の代わりに使う
  useEffect(() => {
    setArtKeys(null);
    fetch(`/dev/sprites/selected?tw=${tw}`)
      .then((r) => r.json())
      .then((j: { keys: string[]; anchors: Record<string, [number, number]> }) => {
        setAnchors(j.anchors);
        setArtKeys(j.keys);
      })
      .catch(() => setArtKeys([]));
  }, [tw]);
  // 64px はアトラス（npm run dev の前に作る。動きと窓の灯りも入る）、32px は選んだ絵を直接読む
  const art = useMemo(
    () =>
      !useArt
        ? undefined
        : tw === 64
          ? ("atlas" as const)
          : artKeys?.length
            ? { keys: artKeys, anchors, url: (k: string) => `/dev/sprites/file/sprites/${tw}/${k}.png` }
            : undefined,
    [useArt, artKeys, anchors, tw],
  );
  const overlay = useMemo(() => ({ night, lights }), [night, lights]);

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col gap-2 p-2">
      <h1 className="text-lg font-bold">M0 試作：アイソメトリックの描画</h1>
      <div className="flex flex-wrap gap-2 text-sm">
        <Choice label="タイル" value={tw} options={[64, 32]} format={(v) => `${v}×${v / 2}`} onChange={setTw} />
        <Choice label="マップ" value={size} options={SIZES} format={(v) => (v ? `${v}×${v}` : "見本")} onChange={setSize} />
        <Choice label="人と車" value={agents} options={AGENTS} format={String} onChange={setAgents} />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={fixed} onChange={(e) => setFixed(e.target.checked)} />
          カメラ固定（全体表示）
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={useArt} onChange={(e) => setUseArt(e.target.checked)} />
          選んだ絵を使う（{artKeys?.length ?? "…"}枚）
        </label>
        <label className="flex items-center gap-1">
          夜
          <input type="range" min={0} max={1} step={0.1} value={night} onChange={(e) => setNight(Number(e.target.value))} className="w-24" />
        </label>
        <label className="flex items-center gap-1">
          灯る窓
          <input type="range" min={0} max={1} step={0.1} value={lights} onChange={(e) => setLights(Number(e.target.value))} className="w-24" />
        </label>
        <button type="button" className="underline" onClick={() => stage.current?.focusTile(Math.floor(size / 2), Math.floor(size / 2))}>
          中心へ飛ぶ
        </button>
      </div>
      <p className="num text-xs">
        {stats.fps} fps・パン中（直近5秒）平均 {stats.panFps || "—"}・最低 {stats.panMinFps || "—"}・描画中の建物と人 {stats.sprites}・地面のチャンク {stats.chunks}
        {selected && ` ・選択 (${selected.x}, ${selected.y})`}
      </p>
      {artKeys && <IsoCity
        key={`${tw}-${size}-${agents}-${fixed}-${typeof art === "object" ? art.keys.join() : (art ?? "none")}`}
        art={art}
        overlay={overlay}
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
        label={size ? `検証用のダミーマップ ${size}×${size}` : "画風の見本の街"}
      />}
      <p className="text-xs text-muted">
        選んだ絵がないところは M0 用の仮の絵で描きます。道路は全段階を舗装道路で、足りないつながり方は反転か十字路で代用します。
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
