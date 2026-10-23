"use client";

import { useEffect, useRef, useState } from "react";
import { BUILDING_LINES } from "@/components/iso/map";
import { drawBuildingArt } from "@/components/iso/placeholder";
import { LINES } from "@/game/catalog";
import type { CandidateRun } from "./files";

const fileUrl = (rel: string) => `/dev/sprites/file/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** 系統ごとに全段階を横一列に並べる */
export function Lineup({ selected }: { selected: Record<string, string[]> }) {
  const [tw, setTw] = useState("64");
  return (
    <div className="space-y-2">
      <div className="flex gap-2 text-sm">
        {Object.keys(selected).map((t) => (
          <button key={t} type="button" className={`rounded border px-2 ${t === tw ? "bg-black text-white" : ""}`} onClick={() => setTw(t)}>
            {t}×{Number(t) / 2}
          </button>
        ))}
      </div>
      {[1, 2].map((scale) => (
        <div key={scale} className="overflow-x-auto rounded bg-[#86bd46] p-2">
          <p className="text-xs">{scale}倍</p>
          {BUILDING_LINES.map((line) => (
            <div key={line} className="flex items-end gap-2">
              <span className="w-20 shrink-0 text-xs">{LINES[line].label}</span>
              {LINES[line].tiers.map((t, i) => {
                const key = `building/${line}/${i}`;
                return selected[tw].includes(key) ? (
                  <PixelImage key={key} src={fileUrl(`sprites/${tw}/${key}.png`)} scale={scale} title={t.name} />
                ) : (
                  <Placeholder key={key} line={line} tier={i} tw={Number(tw)} scale={scale} title={t.name} />
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 1ドット＝scale 物理ピクセルで見せる（devicePixelRatio で割る）。
 * サーバーには devicePixelRatio がないので、表示後（effect やイベントの中）でだけ呼ぶ。
 */
function pixelSize(w: number, h: number, scale: number) {
  const dpr = window.devicePixelRatio || 1;
  return { width: (w * scale) / dpr, height: (h * scale) / dpr };
}

function PixelImage({ src, scale, title }: { src: string; scale: number; title: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>();
  const measure = () => {
    const img = ref.current;
    if (img?.naturalWidth) setSize(pixelSize(img.naturalWidth, img.naturalHeight, scale));
  };
  // React が読み込みを見張る前に読み終わっていることがあるので、表示後にも大きさを確かめる
  useEffect(measure, [src, scale]);
  return <img ref={ref} src={src} alt={title} title={title} className="pixelated" style={size} onLoad={measure} />;
}

function Placeholder({ line, tier, tw, scale, title }: { line: (typeof BUILDING_LINES)[number]; tier: number; tw: number; scale: number; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // 大きさは表示後に決める（サーバーとブラウザで最初の描画を揃えるため）
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const art = drawBuildingArt(line, tier, tw);
    const c = ref.current;
    if (!c) return;
    c.width = art.canvas.width;
    c.height = art.canvas.height;
    c.getContext("2d")!.drawImage(art.canvas, 0, 0);
    setSize(pixelSize(art.canvas.width, art.canvas.height, scale));
  }, [line, tier, tw, scale]);
  return <canvas ref={ref} title={`${title}（仮）`} className="pixelated" style={size} />;
}

/** 生成の候補を並べ、1つを選ぶ（§4.1 の4） */
export function CandidatePicker({ runs }: { runs: CandidateRun[] }) {
  const [msg, setMsg] = useState("");
  async function pick(r: CandidateRun, img: string) {
    const res = await fetch("/dev/sprites/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tw: r.tw, key: r.key, file: `${r.tw}/${r.key}/${r.run}/${img}` }),
    });
    setMsg(res.ok ? `${r.key}（${r.tw}px）に ${r.run}/${img} を選びました。再読み込みすると並びに出ます。` : "選べませんでした");
  }
  return (
    <div className="space-y-4">
      {msg && <p className="text-sm font-bold">{msg}</p>}
      {runs.map((r) => (
        <div key={`${r.tw}/${r.key}/${r.run}`} className="space-y-1">
          <p className="text-sm">
            <b>{r.key}</b>（{r.tw}px）<span className="text-xs text-muted">{r.run}</span>
            {r.error && <span className="ml-2 text-danger">失敗（error.txt を見てください）</span>}
          </p>
          <div className="flex flex-wrap gap-2 rounded bg-[#86bd46] p-2">
            {r.images.map((img) => (
              <button key={img} type="button" onClick={() => pick(r, img)} className="rounded border-2 border-transparent p-1 hover:border-white" title="これを選ぶ">
                <img src={fileUrl(`candidates/${r.tw}/${r.key}/${r.run}/${img}`)} alt={img} className="pixelated" style={{ zoom: 2 }} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
