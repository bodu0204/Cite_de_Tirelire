"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IsoCity } from "@/components/iso/IsoCity";
import type { IsoStage } from "@/components/iso/IsoStage";
import { type IsoMap, dummyMap, hash2, sampleMap } from "@/components/iso/map";
import { LINES, type LineId } from "@/game/catalog";

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
  const base = useMemo(() => (size ? dummyMap(size) : sampleMap()), [size]);
  // 選んだマスの建物を建てる・進化させる（完成・進化の演出を確かめる。"x,y" → キー、null は空き地）
  const [edits, setEdits] = useState<Map<string, string | null>>(new Map());
  useEffect(() => setEdits(new Map()), [base]);
  const [troubles, setTroubles] = useState(false);
  const map = useMemo(() => {
    const m = applyEdits(base, edits);
    // 困りごとの見本では、最初の建物の前に金貨の山（A4）も置く
    const first = m.objects[0];
    return troubles && first ? { ...m, objects: [...m.objects, { id: "gold", x: first.x, y: first.y, key: "props/gold/3", dz: 0.3, ox: 14, oy: 7 }] } : m;
  }, [base, edits, troubles]);
  const here = selected && map.objects.find((o) => o.x === selected.x && o.y === selected.y);
  const edit = (key: string | null) => selected && setEdits((m) => new Map(m).set(`${selected.x},${selected.y}`, key));

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
  // 困りごとアイコン（A3）の見本：建物の3割に、電気・働き手・食料を順に出す
  const overlay = useMemo(() => {
    const list = troubles
      ? map.objects
          .filter((o) => o.key.startsWith("building/") && hash2(o.x, o.y, 9) % 10 < 3)
          .map((o, i) => ({ x: o.x, y: o.y, kind: ["power", "workers", "food"][i % 3], dark: i % 3 === 0 }))
      : undefined;
    return { night, lights, troubles: list };
  }, [night, lights, troubles, map]);

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
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={troubles} onChange={(e) => setTroubles(e.target.checked)} />
          困りごと
        </label>
        <button type="button" className="underline" onClick={() => stage.current?.focusTile(Math.floor(size / 2), Math.floor(size / 2))}>
          中心へ飛ぶ
        </button>
      </div>
      {selected && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs">{here?.key ?? "空き地"}</span>
          <button type="button" className="rounded border px-2" onClick={() => edit(here ? null : "building/housing/0")}>
            {here ? "壊す" : "建てる"}
          </button>
          {here && nextTier(here.key) && (
            <button type="button" className="rounded border px-2" onClick={() => edit(nextTier(here.key))}>
              進化
            </button>
          )}
          {here && nextLevel(here.key) && (
            <button type="button" className="rounded border px-2" onClick={() => edit(nextLevel(here.key))}>
              Lv を上げる
            </button>
          )}
        </div>
      )}
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

function applyEdits(m: IsoMap, edits: Map<string, string | null>): IsoMap {
  if (!edits.size) return m;
  const objects = m.objects.filter((o) => !edits.has(`${o.x},${o.y}`));
  for (const [k, key] of edits) {
    if (!key) continue;
    const [x, y] = k.split(",").map(Number);
    // 元からある建物は同じ id のまま変え、進化・Lv上げを「同じ建物の変化」として描く
    const id = m.objects.find((o) => o.x === x && o.y === y)?.id ?? `edit:${k}`;
    objects.push({ id, x, y, key });
  }
  return { ...m, objects };
}

/** building/<系統>/<段階>@lvN の段階を1つ上げる（最後の段階なら null） */
function nextTier(key: string): string | null {
  const m = /^building\/(\w+)\/(\d+)(@lv\d)?$/.exec(key);
  if (!m) return null;
  const tier = Number(m[2]) + 1;
  return tier < LINES[m[1] as LineId].tiers.length ? `building/${m[1]}/${tier}${m[3] ?? ""}` : null;
}

function nextLevel(key: string): string | null {
  const m = /^(building\/\w+\/\d+)(?:@lv(\d))?$/.exec(key);
  if (!m) return null;
  const lv = Number(m[2] ?? 1) + 1;
  return lv <= 6 ? `${m[1]}@lv${lv}` : null;
}
