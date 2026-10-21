"use client";

import { useEffect, useRef, useState } from "react";
import { useSeasonView } from "@/components/GameProvider";
import { Button } from "@/components/ui";
import { api, fmt } from "@/lib/api";
import { digits, ResolutionPreview, type Resolution } from "./shared";

export type AllocCurrency = "SAVE" | "GOLD" | "BOND" | "CUSTOM";
export type Preset = "save" | "gold" | "ratio";

export interface AllocationRow {
  currency: AllocCurrency;
  currencyId?: string | null;
  amount: number;
  when: "now" | "dates" | "range";
  dates?: string[];
  rangeStart?: string;
  rangeEnd?: string;
  how: "lump" | "daily" | "minute";
}

export interface IncomeQuote {
  base: number;
  diff: number;
  preset: Preset;
  rows: AllocationRow[];
  saving: Resolution | null;
  reduction: { cutMining: number; cutCustom: { currencyId: string; amount: number }[]; bond: number; shortfall: Resolution | null } | null;
}

export const PRESET_LABELS: Record<Preset, string> = {
  save: "全額を即時貯蓄",
  gold: "全額を金貨に即時",
  ratio: "通貨配分設定の割合",
};

const WHEN_LABELS = { now: "即時", dates: "指定日", range: "期間で均等" } as const;
const HOW_LABELS = { lump: "一括", daily: "日ごと均等", minute: "毎分" } as const;

/**
 * 収入の振り分け（docs/record-input-redesign.md §5.5）。プリセットを切り替えると、そのプリセットの行が雛形として入り、そこから直せる。
 * 直したあとにプリセットを切り替えるときは置き換えてよいか確かめる。
 */
export function AllocationEditor({
  kind,
  monthKey,
  amount,
  defaultPreset,
  rows,
  onRows,
  onQuote,
}: {
  kind: "MONTHLY" | "EXTRA";
  monthKey?: string;
  /** 収入の金額（月の収入は雛形との差分をサーバーが求める） */
  amount: number;
  defaultPreset: Preset;
  rows: AllocationRow[] | null;
  onRows: (rows: AllocationRow[] | null) => void;
  onQuote?: (q: IncomeQuote | null) => void;
}) {
  const v = useSeasonView();
  const [preset, setPreset] = useState<Preset>(defaultPreset);
  const [dirty, setDirty] = useState(false);
  const [quote, setQuote] = useState<IncomeQuote | null>(null);
  const seq = useRef(0);

  // 金額・プリセットが変わったら、直していなければ雛形を取り直す。直したあとはその行で解消のプレビューだけ取り直す
  useEffect(() => {
    if (!v || amount < 0) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const q = await api<IncomeQuote>("/api/incomes/quote", {
          body: { kind, monthKey, amount, ...(dirty && rows ? { allocation: rows } : { preset }) },
        });
        if (n !== seq.current) return;
        setQuote(q);
        onQuote?.(q);
        if (!dirty) onRows(q.rows);
      } catch {
        if (n === seq.current) {
          setQuote(null);
          onQuote?.(null);
        }
      }
    }, 300);
    return () => clearTimeout(t);
    // rows は直したときだけ送るので、直したときだけ依存に入れる
  }, [v, kind, monthKey, amount, preset, dirty, dirty ? JSON.stringify(rows) : ""]);

  const total = kind === "MONTHLY" ? (quote?.diff ?? 0) : amount;
  if (!v || total <= 0 || !rows) return null;
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  const custom = v.currencies.custom;
  const tz = v.user.timezone;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  const update = (i: number, patch: Partial<AllocationRow>) => {
    setDirty(true);
    onRows(rows.map((r, j) => (j === i ? normalize({ ...r, ...patch }, today) : r)));
  };

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{kind === "MONTHLY" ? `＋差分 ${fmt(total)}円の振り分け` : "振り分け"}</span>
        <select
          aria-label="プリセット"
          className="w-auto"
          value={preset}
          onChange={(e) => {
            if (dirty && !confirm("入力した振り分けをプリセットで置き換えますか？")) return;
            setDirty(false);
            setPreset(e.target.value as Preset);
          }}
        >
          {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABELS[p]}
            </option>
          ))}
        </select>
        {dirty && <span className="text-xs text-muted">（直しています）</span>}
      </div>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li key={i} className="grid gap-2 rounded-md bg-surface-2 p-2 sm:grid-cols-[1fr_7rem]">
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="通貨"
                className="w-auto"
                value={r.currency === "CUSTOM" ? `CUSTOM:${r.currencyId}` : r.currency}
                onChange={(e) => {
                  const [c, id] = e.target.value.split(":");
                  update(i, { currency: c as AllocCurrency, currencyId: id ?? null });
                }}
              >
                <option value="SAVE">即時貯蓄（債券 → おまかせ交換）</option>
                <option value="GOLD">金貨</option>
                <option value="BOND">債券</option>
                {custom.map((c) => (
                  <option key={c.id} value={`CUSTOM:${c.id}`}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
              {r.currency !== "SAVE" && (
                <select aria-label="いつ" className="w-auto" value={r.when} onChange={(e) => update(i, { when: e.target.value as AllocationRow["when"] })}>
                  {(Object.keys(WHEN_LABELS) as AllocationRow["when"][]).map((w) => (
                    <option key={w} value={w}>
                      {WHEN_LABELS[w]}
                    </option>
                  ))}
                </select>
              )}
              {r.when === "range" && (
                <>
                  <input aria-label="開始日" type="date" className="w-auto" value={r.rangeStart ?? today} onChange={(e) => update(i, { rangeStart: e.target.value })} />
                  <span className="self-center text-xs">〜</span>
                  <input aria-label="終了日" type="date" className="w-auto" value={r.rangeEnd ?? today} onChange={(e) => update(i, { rangeEnd: e.target.value })} />
                  <select aria-label="どう" className="w-auto" value={r.how} onChange={(e) => update(i, { how: e.target.value as AllocationRow["how"] })}>
                    <option value="lump">{HOW_LABELS.lump}（開始日）</option>
                    <option value="daily">{HOW_LABELS.daily}</option>
                    {r.currency === "GOLD" && <option value="minute">{HOW_LABELS.minute}（採掘に上乗せ）</option>}
                  </select>
                </>
              )}
              {r.when === "dates" && (
                <DatesInput
                  dates={r.dates ?? []}
                  today={today}
                  onChange={(dates) => update(i, { dates })}
                />
              )}
            </div>
            <div className="flex items-center gap-1">
              <input
                aria-label="量（円）"
                inputMode="numeric"
                value={String(r.amount)}
                onChange={(e) => update(i, { amount: Number(digits(e.target.value) || 0) })}
              />
              <button
                type="button"
                aria-label="この行を削除"
                className="px-1 text-danger"
                onClick={() => {
                  setDirty(true);
                  onRows(rows.filter((_, j) => j !== i));
                }}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDirty(true);
            onRows([...rows, { currency: "GOLD", amount: Math.max(0, total - sum), when: "now", how: "lump" }]);
          }}
        >
          ＋ 行を追加
        </Button>
        <span className={`num text-xs ${sum === total ? "text-muted" : "font-medium text-danger"}`}>
          合計 {fmt(sum)} / {fmt(total)}円{sum !== total && "（合計を合わせてください）"}
        </span>
      </div>
      {quote?.saving && <ResolutionPreview r={quote.saving} title="即時貯蓄の見込み（債券 → おまかせ交換）" />}
      <p className="text-xs text-muted">先の日付・期間の分は予約され、その日が来たら入ります。期間で均等（毎分）の金貨は採掘に上乗せされます（債券化率もかかります）。</p>
    </div>
  );
}

/** 行の組み合わせを整える（即時貯蓄は即時だけ、毎分は金貨だけ） */
function normalize(r: AllocationRow, today: string): AllocationRow {
  const out = { ...r };
  if (out.currency === "SAVE") out.when = "now";
  if (out.when === "range") {
    out.rangeStart ??= today;
    out.rangeEnd ??= today;
    if (out.how === "minute" && out.currency !== "GOLD") out.how = "daily";
  }
  if (out.when === "dates") out.dates = out.dates?.length ? out.dates : [today];
  if (out.when !== "range") out.how = "lump";
  if (out.currency !== "CUSTOM") out.currencyId = null;
  return out;
}

function DatesInput({ dates, today, onChange }: { dates: string[]; today: string; onChange: (d: string[]) => void }) {
  const [draft, setDraft] = useState(today);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {dates.map((d) => (
        <span key={d} className="num inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-xs">
          {d}
          <button type="button" aria-label={`${d}を外す`} onClick={() => onChange(dates.filter((x) => x !== d))}>
            ✕
          </button>
        </span>
      ))}
      <input aria-label="日付を追加" type="date" className="w-auto" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="text-xs underline" onClick={() => draft && onChange([...new Set([...dates, draft])].sort())}>
        追加
      </button>
    </div>
  );
}
