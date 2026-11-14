"use client";

// 装飾の位置の編集（/dev/decor）。建物の絵の基準点（占有範囲の中心の足元）からのずれを、ドット単位で手で合わせる。
// 位置の意味と描き方は toIso.ts の decorSpot・decorObject と同じ。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { decorSpot, type DecorSpot, type DecorSpots } from "@/components/city/toIso";
import { DECOR_KINDS, DECOR_LABELS, type DecorKind } from "@/game/catalog";

export interface DecorItem {
  /** 建物の絵のキー（big/ 付き） */
  key: string;
  label: string;
  /** 系統（同じ系統の全段階に当てはめる時に使う） */
  group: string;
  /** 一辺のマス数 */
  size: number;
}

interface Art {
  img: HTMLImageElement;
  /** 基準点（絵の中のドット） */
  ax: number;
  ay: number;
}

const url = (key: string) => `/dev/sprites/file/sprites/64/${key}.png`;

/** 絵を読み、基準点を求める（build-atlas.ts と同じ：建物は足元のひし形の中心、小物は不透明な画素の一番下） */
const cache = new Map<string, Promise<Art>>();
function loadArt(key: string, small: boolean): Promise<Art> {
  let p = cache.get(key);
  if (!p) {
    p = new Promise<Art>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let bottom = c.height - 1;
        search: for (let y = c.height - 1; y >= 0; y--) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] > 127) {
          bottom = y;
          break search;
        }
        const lift = small ? 0 : c.width / 4 - 1;
        resolve({ img, ax: c.width / 2, ay: bottom - lift });
      };
      img.onerror = () => reject(new Error(`${key} を読めません`));
      img.src = url(key);
    });
    cache.set(key, p);
  }
  return p;
}

function useArt(key: string, small: boolean): Art | null {
  const [art, setArt] = useState<Art | null>(null);
  useEffect(() => {
    let live = true;
    setArt(null);
    loadArt(key, small).then((a) => live && setArt(a), () => undefined);
    return () => {
      live = false;
    };
  }, [key, small]);
  return art;
}

/**
 * 敷地とまわりのマス、建物、装飾を描く。origin は建物の基準点を置くキャンバス上の位置（CSS px）、z は拡大率。
 * 装飾は front なら建物のあと、そうでなければ先に描く（ゲームの重なり順と同じ）
 */
function drawScene(ctx: CanvasRenderingContext2D, o: { origin: [number, number]; z: number; size: number; ring: number; building: Art | null; decor: Art | null; spot: DecorSpot }) {
  const { z, size, ring, building, decor, spot } = o;
  const [cx, cy] = o.origin;
  ctx.imageSmoothingEnabled = false;
  const h = (size - 1) / 2;
  // マスのひし形（敷地は土の色、まわりは草の色。境目に線）
  for (let j = -ring; j < size + ring; j++)
    for (let i = -ring; i < size + ring; i++) {
      const lot = i >= 0 && j >= 0 && i < size && j < size;
      const x = cx + (i - h - (j - h)) * 32 * z;
      const y = cy + (i - h + (j - h)) * 16 * z;
      ctx.beginPath();
      ctx.moveTo(x, y - 16 * z);
      ctx.lineTo(x + 32 * z, y);
      ctx.lineTo(x, y + 16 * z);
      ctx.lineTo(x - 32 * z, y);
      ctx.closePath();
      ctx.fillStyle = lot ? "#c9b386" : "#8fbf6a";
      ctx.fill();
      ctx.strokeStyle = lot ? "rgba(80,60,30,0.35)" : "rgba(40,80,30,0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  const put = (a: Art | null, dx: number, dy: number) => {
    if (!a) return;
    ctx.drawImage(a.img, Math.round(cx + (dx - a.ax) * z), Math.round(cy + (dy - a.ay) * z), a.img.naturalWidth * z, a.img.naturalHeight * z);
  };
  if (!spot.front) put(decor, spot.ox, spot.oy);
  put(building, 0, 0);
  if (spot.front) put(decor, spot.ox, spot.oy);
  // 基準点（青）と装飾の足元（赤）
  ctx.fillStyle = "#1e88e5";
  ctx.fillRect(cx - 1, cy - 1, 3, 3);
  ctx.fillStyle = "#e53935";
  ctx.fillRect(cx + spot.ox * z - 1, cy + spot.oy * z - 1, 3, 3);
}

/** 装飾の足元がどのマスにあるか（敷地の左上のマスを (0, 0) とする）。敷地の外なら outside */
function tileOf(spot: DecorSpot, size: number): { x: number; y: number; outside: boolean } {
  const h = (size - 1) / 2;
  const a = spot.ox / 32;
  const b = spot.oy / 16;
  const x = Math.floor(h + (a + b) / 2 + 0.5);
  const y = Math.floor(h + (b - a) / 2 + 0.5);
  return { x, y, outside: x < 0 || y < 0 || x >= size || y >= size };
}

const W = 640;
const H = 520;

function Stage({ item, decorKind, spot, onMove }: { item: DecorItem; decorKind: DecorKind; spot: DecorSpot; onMove: (s: DecorSpot) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const building = useArt(item.key, false);
  const decor = useArt(`props/decor/${decorKind}`, true);
  const [z, setZ] = useState(3);
  // 建物を選び直したら、絵の上端がキャンバスに収まる一番大きい拡大率にする（あとからつまみで変えられる）
  useEffect(() => {
    if (building) setZ(Math.max(1, Math.min(4, Math.floor((H - 20) / (building.ay + (item.size + 2) * 16)))));
  }, [item.key, item.size, building]);
  const drag = useRef<{ px: number; py: number; spot: DecorSpot } | null>(null);
  // 建物の基準点を置く位置：大きな建物ほど下に寄せ、上に伸びる絵が入るようにする
  const origin: [number, number] = [W / 2, H - (item.size + 2) * 16 * z - 10];

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#e3ecd6";
    ctx.fillRect(0, 0, W, H);
    drawScene(ctx, { origin, z, size: item.size, ring: 2, building, decor, spot });
  });

  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    drag.current = { px: e.clientX, py: e.clientY, spot };
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d) return;
    onMove({ ...d.spot, ox: d.spot.ox + Math.round((e.clientX - d.px) / z), oy: d.spot.oy + Math.round((e.clientY - d.py) / z) });
  };
  const up = () => {
    drag.current = null;
  };
  const key = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? 4 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    onMove({ ...spot, ox: spot.ox + d[0], oy: spot.oy + d[1] });
  };

  return (
    <div className="space-y-1">
      <canvas
        ref={ref}
        tabIndex={0}
        aria-label={`${item.label}の装飾の位置（ドラッグか矢印キーで動かす）`}
        style={{ width: W, height: H, touchAction: "none" }}
        className="cursor-move rounded border border-line outline-none focus:ring-2 focus:ring-accent"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      />
      <label className="flex items-center gap-2 text-xs">
        拡大
        <input type="range" min={1} max={5} value={z} onChange={(e) => setZ(Number(e.target.value))} className="w-32 border-0 p-0" />
        ×{z}
      </label>
    </div>
  );
}

/** 一覧の小さな見本（等倍）。押すとその建物を選ぶ */
function Thumb({ item, decorKind, spot, active, onPick }: { item: DecorItem; decorKind: DecorKind; spot: DecorSpot; active: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const building = useArt(item.key, false);
  const decor = useArt(`props/decor/${decorKind}`, true);
  const w = 64 * item.size + 96;
  const h = 64 * item.size + 110;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawScene(ctx, { origin: [w / 2, h - (item.size + 1) * 16 - 6], z: 1, size: item.size, ring: 1, building, decor, spot });
  });
  return (
    <button type="button" onClick={onPick} className={`rounded border p-1 text-left ${active ? "border-accent bg-surface" : "border-line"}`} aria-pressed={active}>
      <canvas ref={ref} style={{ width: w, height: h }} />
      <span className="block truncate text-[11px]">{item.label}</span>
    </button>
  );
}

export function DecorEditor({ items, initial }: { items: DecorItem[]; initial: DecorSpots }) {
  const [data, setData] = useState<DecorSpots>({ default: initial.default, spots: initial.spots });
  const [sel, setSel] = useState(items[0]?.key ?? "");
  const [kind, setKind] = useState<DecorKind>("fountain");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const item = items.find((i) => i.key === sel) ?? items[0];
  const spotOf = useCallback((i: DecorItem) => decorSpot(i.key, i.size, data) ?? { ox: 0, oy: 0, front: true }, [data]);

  // 保存していない変更があれば、ページを離れる前に確かめる
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!item) return <p className="text-sm">建物の絵がありません。</p>;
  const spot = spotOf(item);
  const own = !!data.spots[item.key];
  const t = tileOf(spot, item.size);

  const update = (next: DecorSpots) => {
    setData(next);
    setDirty(true);
    setStatus(null);
  };
  const setSpot = (s: DecorSpot) => update({ ...data, spots: { ...data.spots, [item.key]: s } });
  const reset = () => {
    const spots = { ...data.spots };
    delete spots[item.key];
    update({ ...data, spots });
  };
  const asDefault = () => update({ ...data, default: { ...data.default, [String(item.size)]: spot } });
  const toGroup = () => {
    const spots = { ...data.spots };
    for (const i of items) if (i.group === item.group && i.size === item.size) spots[i.key] = spot;
    update({ ...data, spots });
  };
  const save = async () => {
    setStatus("保存しています…");
    const r = await fetch("/dev/decor/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) {
      setStatus(`保存できませんでした：${j.error ?? r.status}`);
      return;
    }
    setDirty(false);
    setStatus("保存しました（art/sprites/64/decor-spots.json）");
  };
  const num = (v: string, f: keyof Pick<DecorSpot, "ox" | "oy">) => {
    const n = Math.round(Number(v));
    if (Number.isFinite(n)) setSpot({ ...spot, [f]: n });
  };

  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        <nav aria-label="建物" className="max-h-[560px] w-56 overflow-y-auto rounded border border-line p-2 text-sm">
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <div className="text-xs font-semibold text-muted">{g}</div>
              {items
                .filter((i) => i.group === g)
                .map((i) => (
                  <button
                    key={i.key}
                    type="button"
                    onClick={() => setSel(i.key)}
                    aria-current={i.key === item.key}
                    className={`block w-full truncate rounded px-1 text-left ${i.key === item.key ? "bg-accent text-accent-ink" : ""}`}
                  >
                    {data.spots[i.key] ? "● " : "○ "}
                    {i.label}
                  </button>
                ))}
            </div>
          ))}
        </nav>

        <Stage item={item} decorKind={kind} spot={spot} onMove={setSpot} />

        <div className="w-64 space-y-3 text-sm">
          <div>
            <div className="font-semibold">{item.label}</div>
            <code className="text-xs text-muted">{item.key}</code>
            <div className="text-xs text-muted">
              {item.size}×{item.size}・{own ? "この建物の位置" : `既定の位置（${item.size}×${item.size}）`}
            </div>
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs text-muted">見本の装飾</legend>
            <div className="flex flex-wrap gap-1">
              {DECOR_KINDS.map((d) => (
                <button key={d} type="button" onClick={() => setKind(d)} aria-pressed={kind === d} className={`rounded border px-2 text-xs ${kind === d ? "border-accent bg-accent text-accent-ink" : "border-line"}`}>
                  {DECOR_LABELS[d]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              横（ox）
              <input type="number" value={spot.ox} onChange={(e) => num(e.target.value, "ox")} />
            </label>
            <label className="text-xs">
              縦（oy）
              <input type="number" value={spot.oy} onChange={(e) => num(e.target.value, "oy")} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" className="w-auto" checked={spot.front} onChange={(e) => setSpot({ ...spot, front: e.target.checked })} />
            建物より手前に描く（外すと建物の後ろ）
          </label>
          <p className="text-xs text-muted">
            足元のマス：({t.x}, {t.y}){t.outside ? "・敷地の外（はみ出し）" : "・敷地の中"}。基準点（青）から装飾の足元（赤）までのずれで、単位は 64px タイルのドット。
          </p>
          <div className="flex flex-wrap gap-1">
            <button type="button" className="rounded border border-line px-2 text-xs" onClick={reset} disabled={!own}>
              既定に戻す
            </button>
            <button type="button" className="rounded border border-line px-2 text-xs" onClick={toGroup}>
              {item.group}の全段階（{item.size}×{item.size}）に当てはめる
            </button>
            <button type="button" className="rounded border border-line px-2 text-xs" onClick={asDefault}>
              {item.size}×{item.size} の既定にする
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="shrink-0 whitespace-nowrap rounded bg-accent px-3 py-1 text-accent-ink disabled:opacity-50" onClick={save} disabled={!dirty}>
              保存
            </button>
            <span className="text-xs text-muted" aria-live="polite">
              {status ?? (dirty ? "保存していない変更があります" : "")}
            </span>
          </div>
        </div>
      </div>

      <section className="space-y-2">
        <button type="button" className="text-sm underline" onClick={() => setAll(!all)} aria-expanded={all}>
          {all ? "一覧を閉じる" : "全部の建物を並べて見る（等倍）"}
        </button>
        {all && (
          <div className="flex flex-wrap gap-2">
            {items.map((i) => (
              <Thumb key={i.key} item={i} decorKind={kind} spot={spotOf(i)} active={i.key === item.key} onPick={() => setSel(i.key)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
