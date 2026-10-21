"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field } from "@/components/ui";
import { api, fmt, yen } from "@/lib/api";
import { ResolutionPreview, type Resolution } from "./shared";

type Key = "E1" | "E2" | "E3a" | "E3b" | "E6a" | "E6b" | "E4a" | "E4b" | "E5";
type Checks = Record<Key, boolean>;
type Items = Record<Key, number>;

const KEYS: Key[] = ["E1", "E2", "E3a", "E3b", "E6a", "E6b", "E4a", "E4b", "E5"];

/** 項目の表示名。親（E3・E4）は子をまとめてチェックする */
const LABELS: Record<Key, string> = {
  E1: "その月の未配当分",
  E2: "未配当分の臨時収入",
  E3a: "その月の配当分",
  E3b: "その月の配当分以外",
  E6a: "ほしい物貯金（像の積立金貨）",
  E6b: "サブスク（まだ記録していない支払い）",
  E4a: "債券",
  E4b: "債券以外（都市に使った金貨）",
  E5: "貯金管理で生まれた（±）",
};
const GROUPS: { label: string; keys: Key[] }[] = [
  { label: LABELS.E1, keys: ["E1"] },
  { label: LABELS.E2, keys: ["E2"] },
  { label: "債券・銀貨を除く所持通貨", keys: ["E3a", "E3b"] },
  { label: "支出として記録していないほしい物貯金・サブスク", keys: ["E6a", "E6b"] },
  { label: "貯金額", keys: ["E4a", "E4b"] },
  { label: "貯金額に対する貯金管理で生まれた（±）", keys: ["E5"] },
];

interface Estimate {
  items: Items | null;
  checks: Checks;
  estimated: number;
  periodKey?: string;
  history: { id: string; date: string; estimated: number; actual: number; diff: number }[];
}

/** 項目の色（カテゴリの固定順。docs/record-input-redesign.md §8.3。明るい面では文字ラベルと表を必ず添える） */
const VIZ_STYLE = `
.est-viz { --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100; --s5:#e87ba4; --s6:#008300; --s7:#6250d6; --s8:#e34948; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .est-viz { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; } }
:root[data-theme="dark"] .est-viz { --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500; --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767; }
`;
/** 色は項目に固定（増やした項目で既存の色を塗り替えない）。8色を超える分は同じ色に斜線を重ねて見分ける */
const SLOT: Record<Key, number> = { E1: 1, E2: 2, E3a: 3, E3b: 4, E6a: 8, E6b: 8, E4a: 5, E4b: 6, E5: 7 };
const HATCHED: Key[] = ["E6b"];
const COLOR = (k: Key) => `var(--s${SLOT[k]})`;
/** 凡例の色見本・棒の塗り（斜線つきは背景に斜線） */
const swatch = (k: Key) => (HATCHED.includes(k) ? `repeating-linear-gradient(135deg, ${COLOR(k)} 0 2px, transparent 2px 4px)` : COLOR(k));

/**
 * 推測の積み上げ（ウォーターフォール）。項目ごとに1行、前の行の終わりから自分の額だけ伸びる（マイナスは左へ戻る）。
 * チェックしていない項目は「足したらここまで」を点線で示す。実際の額を入れると縦線と誤差の区間を出す。
 */
function Waterfall({ items, checks, actual }: { items: Items; checks: Checks; actual: number | null }) {
  const [hover, setHover] = useState<Key | "total" | null>(null);
  const rows: { key: Key; from: number; to: number; on: boolean }[] = [];
  let acc = 0;
  for (const k of KEYS) {
    const on = checks[k];
    rows.push({ key: k, from: acc, to: acc + items[k], on });
    if (on) acc += items[k];
  }
  const total = acc;
  const values = [0, total, ...rows.flatMap((r) => [r.from, r.to]), ...(actual !== null ? [actual] : [])];
  const lo = Math.min(...values);
  const hi = Math.max(...values, lo + 1);
  const W = 640;
  const L = 8;
  const R = 8;
  const ROW = 22;
  const GAP = 2;
  const H = (KEYS.length + 1) * (ROW + GAP) + 24;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const bar = (from: number, to: number) => ({ x: Math.min(x(from), x(to)), w: Math.max(1, Math.abs(x(to) - x(from))) });
  const diff = actual !== null ? actual - total : 0;
  const totalBar = bar(0, total);
  const diffBar = actual !== null ? bar(total, actual) : null;
  const totalY = KEYS.length * (ROW + GAP);
  const tip =
    hover === "total"
      ? `推測 ${yen(total)}${actual !== null ? ` ・ 実際 ${yen(actual)} ・ 誤差 ${diff >= 0 ? "+" : "−"}${yen(Math.abs(diff))}` : ""}`
      : hover
        ? `${LABELS[hover]} ${items[hover] >= 0 ? "+" : "−"}${yen(Math.abs(items[hover]))}${checks[hover] ? "" : "（チェックなし：足したらここまで）"}`
        : "棒にカーソルを合わせると額が出ます";
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`手元のお金の推測 ${yen(total)} の積み上げ`}>
        <defs>
          <pattern id="est-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--surface)" />
            <rect width="3" height="6" fill={COLOR("E6b")} />
          </pattern>
        </defs>
        {/* 0 の基準線 */}
        <line x1={x(0)} x2={x(0)} y1={0} y2={H - 20} stroke="var(--line)" />
        {rows.map((r, i) => {
          const y = i * (ROW + GAP);
          const b = bar(r.from, r.to);
          return (
            <g key={r.key} onMouseEnter={() => setHover(r.key)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(r.key)} onBlur={() => setHover(null)}>
              {/* 当たり判定は行全体 */}
              <rect x={0} y={y} width={W} height={ROW} fill="transparent" />
              {r.from === r.to ? null : r.on ? (
                <rect
                  x={b.x}
                  y={y + 3}
                  width={b.w}
                  height={ROW - 6}
                  rx={4}
                  fill={HATCHED.includes(r.key) ? "url(#est-hatch)" : COLOR(r.key)}
                  stroke={HATCHED.includes(r.key) ? COLOR(r.key) : undefined}
                  strokeWidth={HATCHED.includes(r.key) ? 1.5 : undefined}
                  opacity={hover && hover !== r.key ? 0.45 : 1}
                />
              ) : (
                <rect x={b.x} y={y + 4} width={b.w} height={ROW - 8} rx={4} fill="none" stroke={COLOR(r.key)} strokeWidth={2} strokeDasharray="4 3" opacity={0.7} />
              )}
            </g>
          );
        })}
        {/* 合計（推測）の行 */}
        <g onMouseEnter={() => setHover("total")} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover("total")} onBlur={() => setHover(null)}>
          <rect x={0} y={totalY} width={W} height={ROW} fill="transparent" />
          <rect x={totalBar.x} width={totalBar.w} y={totalY + 2} height={ROW - 4} rx={4} fill="var(--ink)" opacity={0.85} />
        </g>
        {actual !== null && (
          <>
            {diff !== 0 && diffBar && (
              <rect
                x={diffBar.x}
                width={diffBar.w}
                y={totalY + 6}
                height={ROW - 12}
                fill={diff > 0 ? "var(--dev)" : "var(--danger)"}
                opacity={0.8}
              />
            )}
            <line x1={x(actual)} x2={x(actual)} y1={0} y2={H - 20} stroke="var(--ink)" strokeWidth={2} strokeDasharray="2 2" />
          </>
        )}
        <text x={x(0)} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor={x(0) < 40 ? "start" : "middle"}>
          0
        </text>
        <text x={W - R} y={H - 6} fontSize="11" fill="var(--muted)" textAnchor="end">
          {yen(hi)}
        </text>
      </svg>
      <figcaption className="num mt-1 min-h-5 text-xs text-muted" aria-live="polite">
        {tip}
      </figcaption>
    </figure>
  );
}

/** 誤差調整（docs/record-input-redesign.md §8）。チェックは前回の設定を引き継ぐ */
export function AdjustTab({ onDone }: { onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const [est, setEst] = useState<Estimate | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [actual, setActual] = useState("");
  const [quote, setQuote] = useState<{ estimated: number; diff: number; resolution: Resolution | null } | null>(null);
  const saveSeq = useRef(0);

  const load = useCallback(async () => {
    const r = await api<Estimate>("/api/adjustments/estimate");
    setEst(r);
    setChecks(r.checks);
  }, []);
  useEffect(() => {
    load().catch(() => setEst(null));
  }, [load]);

  const actualNum = actual === "" || actual === "-" ? null : Number(actual);
  useEffect(() => {
    if (!checks || actualNum === null || !Number.isFinite(actualNum)) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setQuote(await api("/api/adjustments/quote", { body: { checks, actual: actualNum } }));
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [checks, actualNum]);

  if (!v) return <Card>進行中のシーズンがないため、誤差調整はできません。</Card>;
  if (!est || !checks || !est.items) return <Card>読み込み中…</Card>;
  const items = est.items;

  const setKeys = (keys: Key[], on: boolean) => {
    const next = { ...checks, ...Object.fromEntries(keys.map((k) => [k, on])) } as Checks;
    setChecks(next);
    // 前回の設定として保存する（端末をまたいで引き継ぐ）
    const n = ++saveSeq.current;
    api("/api/settings/estimate-checks", { method: "PUT", body: { checks: next } }).catch(() => {
      if (n === saveSeq.current) toast("チェックの保存に失敗しました", "error");
    });
  };
  const estimated = KEYS.reduce((a, k) => a + (checks[k] ? items[k] : 0), 0);
  const diff = actualNum !== null && Number.isFinite(actualNum) ? actualNum - estimated : null;

  return (
    <div className="space-y-4">
      <Card title="手元のお金の推測" className="est-viz">
        <style>{VIZ_STYLE}</style>
        <p className="mb-3 text-xs text-muted">足し引きする項目をチェックしてください。チェックの状態は次回も引き継ぎます。</p>
        <ul className="space-y-1 text-sm">
          {GROUPS.map((g) => {
            const all = g.keys.every((k) => checks[k]);
            const some = g.keys.some((k) => checks[k]);
            const sum = g.keys.reduce((a, k) => a + items[k], 0);
            return (
              <li key={g.label}>
                <label className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="w-auto"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some && !all;
                    }}
                    onChange={(e) => setKeys(g.keys, e.target.checked)}
                  />
                  {g.keys.length === 1 && <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: swatch(g.keys[0]) }} />}
                  <span className="flex-1">
                    {g.label}
                    {some && !all && <span className="ml-1 text-xs text-muted">（一部）</span>}
                  </span>
                  <span className="num font-medium">
                    {sum < 0 ? "−" : g.keys[0] === "E5" ? "+" : ""}
                    {yen(Math.abs(sum))}
                  </span>
                </label>
                {g.keys.length > 1 && (
                  <ul className="ml-7 space-y-0.5">
                    {g.keys.map((k) => (
                      <li key={k}>
                        <label className="flex items-center gap-2 rounded-md px-2 py-0.5 text-xs hover:bg-surface-2">
                          <input type="checkbox" className="w-auto" checked={checks[k]} onChange={(e) => setKeys([k], e.target.checked)} />
                          <span aria-hidden className="inline-block h-3 w-3 shrink-0 rounded-sm" style={{ background: swatch(k) }} />
                          <span className="flex-1">└ {LABELS[k]}</span>
                          <span className="num">
                            {items[k] < 0 ? "−" : ""}
                            {yen(Math.abs(items[k]))}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <div className="num mt-3 flex items-baseline justify-between border-t border-line pt-2">
          <span className="text-sm font-medium">推測</span>
          <span className="font-pixel text-xl">{yen(estimated)}</span>
        </div>
        <div className="mt-3">
          <Waterfall items={items} checks={checks} actual={diff !== null ? actualNum : null} />
        </div>
      </Card>

      <Card title="誤差調整">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (diff === null || diff === 0) return;
            if (!confirm(`誤差 ${diff > 0 ? "+" : "−"}${yen(Math.abs(diff))} を解消しますか？（あとから編集できません）`)) return;
            const r = await act<{ diff: number }>("/api/adjustments", { checks, actual: actualNum });
            if (!r) return;
            toast(`誤差 ${r.diff > 0 ? "+" : "−"}${yen(Math.abs(r.diff))} を解消しました`);
            setActual("");
            await load();
            onDone();
          }}
        >
          <Field label="実際の手元の額（円）" hint="財布や口座で確かめた、自由予算の手元のお金を入れてください。">
            <input inputMode="numeric" value={actual} onChange={(e) => setActual(e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, ""))} />
          </Field>
          {diff !== null && (
            <p className={`num text-sm font-medium ${diff > 0 ? "text-dev" : diff < 0 ? "text-danger" : ""}`}>
              誤差 {diff === 0 ? "なし" : `${diff > 0 ? "+" : "−"}${yen(Math.abs(diff))}（実際 − 推測）`}
            </p>
          )}
          {quote?.resolution && <ResolutionPreview r={quote.resolution} title={diff! > 0 ? "＋誤差の解消（債券 → おまかせ交換）" : "−誤差の解消（債券から・手数料あり）"} />}
          <Button type="submit" className="w-full" disabled={busy || diff === null || diff === 0}>
            誤差を調整する
          </Button>
          <p className="text-xs text-muted">誤差調整に銀貨の報酬はありません。保存したあとは編集できません（直すときは新しく誤差調整を記録してください）。</p>
        </form>
      </Card>

      <Card title="これまでの誤差調整">
        {est.history.length === 0 ? (
          <Empty>まだ誤差調整はありません</Empty>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {est.history.map((h) => (
              <li key={h.id} className="num flex items-center gap-3 py-2">
                <span className="w-20 shrink-0 text-xs text-muted">{h.date}</span>
                <span className="flex-1 text-xs text-muted">
                  推測 {yen(h.estimated)} → 実際 {yen(h.actual)}
                </span>
                <span className={`font-medium ${h.diff > 0 ? "text-dev" : "text-danger"}`}>
                  {h.diff > 0 ? "+" : "−"}
                  {fmt(Math.abs(h.diff))}円
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
