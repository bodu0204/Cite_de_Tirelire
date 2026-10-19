"use client";

import { useEffect, useRef, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, CustomIcon, Empty, Field, Modal } from "@/components/ui";
import type { Rule, RuleKind } from "@/game/currency";
import { api, ApiError, fmt, formatDate, todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface Category {
  id: string;
  name: string;
}
interface Currency {
  id: string;
  name: string;
  icon: string;
  categoryIds: string[];
  rules: Rule[];
  remainder: "KEEP" | "TO_BOND";
  remainderDays: number | null;
  startDate: string;
  endDate: string | null;
  balance: number;
  nextIssue: { date: string; amount: number } | null;
  nextExpiry: { at: number; amount: number } | null;
}
interface Preview {
  next: { date: string; amount: number }[];
  months: { monthKey: string; budget: number; subs: number; custom: number; thisCurrency: number; mining: number }[];
  overruns: { monthKey: string; over: number }[];
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const NTH = [
  { v: 1, label: "第1" },
  { v: 2, label: "第2" },
  { v: 3, label: "第3" },
  { v: 4, label: "第4" },
  { v: -1, label: "最終" },
];
const KINDS: { kind: RuleKind; label: string }[] = [
  { kind: "weekly", label: "N週ごと" },
  { kind: "monthDays", label: "毎月・日付" },
  { kind: "monthNth", label: "毎月・第X曜日" },
  { kind: "everyMonths", label: "Nか月ごと" },
  { kind: "dates", label: "カレンダー指定日" },
  { kind: "minute", label: "毎分" },
];

const join = (xs: (string | number)[]) => xs.join("・");

function describeRule(r: Rule): string {
  switch (r.kind) {
    case "minute":
      return `毎分（月 ${fmt(r.monthlyAmount)}）`;
    case "weekly":
      return `${r.every === 1 ? "毎週" : `${r.every}週ごと`} ${join(r.weekdays.map((d) => WEEKDAYS[d]))} ${fmt(r.amount)}`;
    case "monthDays":
      return `毎月 ${join(r.days)}日 ${fmt(r.amount)}`;
    case "monthNth":
      return `毎月 ${join(r.nth.map((n) => NTH.find((x) => x.v === n)!.label))} ${join(r.weekdays.map((d) => WEEKDAYS[d]))}曜 ${fmt(r.amount)}`;
    case "everyMonths":
      return `${r.every}か月ごと ${join(r.days)}日 ${fmt(r.amount)}`;
    case "dates":
      return `${join(r.dates.slice(0, 4).map((d) => d.slice(5).replace("-", "/")))}${r.dates.length > 4 ? ` ほか${r.dates.length - 4}日` : ""} ${fmt(r.amount)}`;
  }
}

function newRule(kind: RuleKind): Rule {
  switch (kind) {
    case "minute":
      return { kind, monthlyAmount: 10000 };
    case "weekly":
      return { kind, every: 1, weekdays: [1], amount: 5000 };
    case "monthDays":
      return { kind, days: [1], amount: 10000 };
    case "monthNth":
      return { kind, nth: [1], weekdays: [1], amount: 5000 };
    case "everyMonths":
      return { kind, every: 2, days: [1], amount: 10000 };
    case "dates":
      return { kind, dates: [], amount: 5000 };
  }
}

const toggle = (xs: number[], v: number) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v].sort((a, b) => a - b));
const digits = (s: string) => Number(s.replace(/\D/g, "") || 0);

function Chips<T extends string | number>({ items, value, onToggle, label }: { items: { v: T; label: string }[]; value: T[]; onToggle: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {items.map((it) => (
        <button
          key={String(it.v)}
          type="button"
          aria-pressed={value.includes(it.v)}
          onClick={() => onToggle(it.v)}
          className={`min-h-8 min-w-8 rounded-md border px-2 text-xs ${value.includes(it.v) ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface-2"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

const DAY_ITEMS = Array.from({ length: 31 }, (_, i) => ({ v: i + 1, label: String(i + 1) }));
const WEEKDAY_ITEMS = WEEKDAYS.map((label, v) => ({ v, label }));

/** 日付を複数選べるカレンダー入力 */
function MultiDatePicker({ value, onChange, today }: { value: string[]; onChange: (v: string[]) => void; today: string }) {
  const [ym, setYm] = useState(() => {
    const [y, m] = (value[0] ?? today).split("-").map(Number);
    return { y, m };
  });
  const first = new Date(Date.UTC(ym.y, ym.m - 1, 1));
  const days = new Date(Date.UTC(ym.y, ym.m, 0)).getUTCDate();
  const lead = first.getUTCDay();
  const key = (d: number) => `${ym.y}-${String(ym.m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const shift = (n: number) => setYm(({ y, m }) => ({ y: m + n > 12 ? y + 1 : m + n < 1 ? y - 1 : y, m: ((m + n + 11) % 12) + 1 }));
  return (
    <div className="rounded-lg border border-line p-2">
      <div className="mb-1 flex items-center justify-between text-sm">
        <button type="button" className="px-2" aria-label="前の月" onClick={() => shift(-1)}>
          ◀
        </button>
        <span className="num">
          {ym.y}年{ym.m}月
        </span>
        <button type="button" className="px-2" aria-label="次の月" onClick={() => shift(1)}>
          ▶
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {WEEKDAYS.map((w) => (
          <span key={w} className="text-muted">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`l${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const k = key(i + 1);
          const on = value.includes(k);
          const past = k < today;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              aria-label={k}
              onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k].sort())}
              className={`num min-h-8 rounded ${on ? "bg-accent text-accent-ink" : past ? "text-muted/50" : "hover:bg-surface-2"}`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
      {value.length > 0 && <p className="mt-1 text-xs text-muted">選択中：{value.map((d) => d.slice(5).replace("-", "/")).join("・")}</p>}
      {value.some((d) => d < today) && <p className="text-xs text-muted">過ぎた日付は発生しません。</p>}
    </div>
  );
}

const EMOJI_GROUPS: { label: string; items: string[] }[] = [
  { label: "食べ物", items: ["🍙", "🍚", "🍞", "🍜", "🍣", "🍱", "🍔", "🍕", "🥗", "🍳", "🥩", "🐟", "🍎", "🍓", "🍰", "🍩", "☕", "🍺", "🍷", "🥤", "🛒"] },
  { label: "生活", items: ["🏠", "🧺", "🧴", "🧻", "🪥", "💡", "🔌", "🚿", "🧹", "🧼", "💊", "🩺", "👶", "🐶", "🐱", "🌱", "💐", "🎁", "📦", "📱", "💻"] },
  { label: "移動", items: ["🚃", "🚌", "🚕", "🚗", "⛽", "🚲", "✈️", "🚄", "🛵", "🎫", "🗺️", "🏨"] },
  { label: "趣味", items: ["🎮", "🎬", "🎵", "📚", "🎨", "⚽", "🎾", "🎤", "🎲", "📷", "🧶", "👕", "👟", "💄", "💇", "🍿"] },
  { label: "お金", items: ["🪙", "💰", "💴", "💳", "🏦", "🐷", "📈", "🎯", "⭐", "❤️", "✨", "🔥", "🍀", "🌈"] },
];

/** 絵文字1文字（結合文字を含む1書記素）か。サーバーの検証と同じ条件 */
function isSingleEmoji(s: string): boolean {
  const graphemes = [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(s)];
  return graphemes.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(s);
}

/** 絵文字を一覧から選ぶ（一覧にないものは入力もできる）。外側を押す・Esc・選んだ時点で閉じる */
function EmojiPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(0);
  const [other, setOther] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // モーダル（dialog）まで閉じないように止める
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const pick = (e: string) => {
    onChange(e);
    setOther("");
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`アイコン ${value}。絵文字を選ぶ`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[42px] w-full items-center justify-center rounded-lg border border-line bg-surface text-2xl"
      >
        {value || "＋"}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 rounded-lg border border-line bg-surface p-2 shadow-lg" style={{ width: "min(20rem, calc(100vw - 4rem))" }}>
          <div role="tablist" className="mb-2 flex flex-wrap gap-1">
            {EMOJI_GROUPS.map((g, i) => (
              <button
                key={g.label}
                type="button"
                role="tab"
                aria-selected={group === i}
                onClick={() => setGroup(i)}
                className={`rounded-md px-2 py-1 text-xs ${group === i ? "bg-surface-2 font-semibold" : "text-muted"}`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {EMOJI_GROUPS[group].items.map((e) => (
              <button
                key={e}
                type="button"
                aria-label={e}
                aria-pressed={value === e}
                onClick={() => pick(e)}
                className={`flex h-9 items-center justify-center rounded-md text-xl ${value === e ? "bg-accent/20 ring-2 ring-accent" : "hover:bg-surface-2"}`}
              >
                {e}
              </button>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            ほかの絵文字
            <input
              className="w-16 text-center text-lg"
              maxLength={16}
              value={other}
              onChange={(e) => {
                const v = e.target.value.trim();
                setOther(e.target.value);
                // 絵文字1文字が入った時点で決める
                if (isSingleEmoji(v)) pick(v);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (isSingleEmoji(other.trim())) pick(other.trim());
              }}
            />
          </label>
          {other && !isSingleEmoji(other.trim()) && <p className="mt-1 text-xs text-danger">絵文字1文字を入力してください</p>}
        </div>
      )}
    </div>
  );
}

function RuleEditor({ rule, onChange, onRemove, today }: { rule: Rule; onChange: (r: Rule) => void; onRemove: () => void; today: string }) {
  const amountField = rule.kind === "minute" ? null : (
    <Field label="1回の量">
      <input inputMode="numeric" value={rule.amount || ""} onChange={(e) => onChange({ ...rule, amount: digits(e.target.value) })} />
    </Field>
  );
  const every = (label: string, unit: string) =>
    "every" in rule && (
      <Field label={label}>
        <select value={rule.every} onChange={(e) => onChange({ ...rule, every: Number(e.target.value) } as Rule)}>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
              {unit}ごと
            </option>
          ))}
        </select>
      </Field>
    );
  return (
    <div className="space-y-2 rounded-lg bg-surface-2 p-3">
      <div className="flex items-center justify-between text-sm font-medium">
        <span>{KINDS.find((k) => k.kind === rule.kind)!.label}</span>
        <button type="button" className="text-xs text-danger underline" onClick={onRemove}>
          削除
        </button>
      </div>
      {rule.kind === "minute" && (
        <Field label="月あたりの量" hint="金貨と同じく毎分少しずつ発生します（1日ぶんを1回分として期限を数えます）。">
          <input inputMode="numeric" value={rule.monthlyAmount || ""} onChange={(e) => onChange({ ...rule, monthlyAmount: digits(e.target.value) })} />
        </Field>
      )}
      {rule.kind === "weekly" && (
        <>
          {every("周期", "週")}
          <Chips label="曜日" items={WEEKDAY_ITEMS} value={rule.weekdays} onToggle={(d) => onChange({ ...rule, weekdays: toggle(rule.weekdays, d) })} />
          <p className="text-xs text-muted">開始日を含む週（月曜始まり）から数えます。</p>
        </>
      )}
      {(rule.kind === "monthDays" || rule.kind === "everyMonths") && (
        <>
          {rule.kind === "everyMonths" && every("周期", "か月")}
          <Chips label="日" items={DAY_ITEMS} value={rule.days} onToggle={(d) => onChange({ ...rule, days: toggle(rule.days, d) })} />
          <p className="text-xs text-muted">その月にない日（31日など）は月末日に発生します。{rule.kind === "everyMonths" && "開始日の月から数えます。"}</p>
        </>
      )}
      {rule.kind === "monthNth" && (
        <>
          <Chips label="第何週" items={NTH} value={rule.nth} onToggle={(n) => onChange({ ...rule, nth: toggle(rule.nth, n) })} />
          <Chips label="曜日" items={WEEKDAY_ITEMS} value={rule.weekdays} onToggle={(d) => onChange({ ...rule, weekdays: toggle(rule.weekdays, d) })} />
        </>
      )}
      {rule.kind === "dates" && <MultiDatePicker value={rule.dates} onChange={(dates) => onChange({ ...rule, dates })} today={today} />}
      {amountField}
    </div>
  );
}

function CurrencyForm({ initial, categories, onDone, tz, onCategoriesChanged }: { initial?: Currency; categories: Category[]; onDone: () => void; tz: string; onCategoriesChanged: () => Promise<void> }) {
  const { act, busy } = useGame();
  const today = todayIn(tz);
  const [f, setF] = useState({
    name: initial?.name ?? "",
    icon: initial?.icon ?? "🍙",
    categoryIds: initial?.categoryIds ?? [],
    rules: initial?.rules ?? [newRule("weekly")],
    remainder: initial?.remainder ?? ("KEEP" as Currency["remainder"]),
    remainderDays: String(initial?.remainderDays ?? 7),
    startDate: initial?.startDate ?? today,
    endDate: initial?.endDate ?? "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const body = { ...f, id: initial?.id, remainderDays: Number(f.remainderDays || 0), endDate: f.endDate || null };

  // 保存前に「次の5回の発生日」と「今月・来月の C と採掘額」を確かめる
  const key = JSON.stringify(body);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setPreview(await api<Preview>("/api/currencies/preview", { body: JSON.parse(key) }));
        setProblem(null);
      } catch (e) {
        setPreview(null);
        setProblem(e instanceof ApiError ? e.message : "確認できませんでした");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [key]);

  const over = preview?.overruns ?? [];
  const setRule = (i: number, r: Rule) => setF((p) => ({ ...p, rules: p.rules.map((x, j) => (j === i ? r : x)) }));

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = initial ? await act(`/api/currencies/${initial.id}`, body, "PATCH") : await act("/api/currencies", body);
        if (r) onDone();
      }}
    >
      <div className="grid grid-cols-[4rem_1fr] items-start gap-3">
        <div className="text-sm">
          <span className="mb-1 block font-medium">アイコン</span>
          <EmojiPicker value={f.icon} onChange={(icon) => setF((p) => ({ ...p, icon }))} />
        </div>
        <Field label="名前">
          <input required maxLength={20} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="食費コイン" />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-medium">使えるジャンル</legend>
        {categories.length === 0 ? (
          <p className="text-xs text-muted">ジャンルがまだありません。下で追加してください。</p>
        ) : (
          <Chips
            label="使えるジャンル"
            items={categories.map((c) => ({ v: c.id, label: c.name }))}
            value={f.categoryIds}
            onToggle={(id) => setF((p) => ({ ...p, categoryIds: p.categoryIds.includes(id) ? p.categoryIds.filter((x) => x !== id) : [...p.categoryIds, id] }))}
          />
        )}
        <div className="mt-2 flex gap-2">
          <input aria-label="新しいジャンル名" maxLength={50} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="ジャンルを追加（例：食費）" />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !newCategory.trim()}
            onClick={async () => {
              const r = await act<{ id: string }>("/api/categories", { name: newCategory.trim() });
              if (!r) return;
              await onCategoriesChanged();
              setNewCategory("");
              setF((p) => ({ ...p, categoryIds: p.categoryIds.includes(r.id) ? p.categoryIds : [...p.categoryIds, r.id] }));
            }}
          >
            追加
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">このジャンルの購入の精算に使えます。ほかには債券への交換だけができます（資源交換・手数料などには使えません）。</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">発生ルール</legend>
        {f.rules.map((r, i) => (
          <RuleEditor key={i} rule={r} today={today} onChange={(x) => setRule(i, x)} onRemove={() => setF((p) => ({ ...p, rules: p.rules.filter((_, j) => j !== i) }))} />
        ))}
        <div className="flex flex-wrap gap-1">
          {KINDS.filter((k) => k.kind !== "minute" || !f.rules.some((r) => r.kind === "minute")).map((k) => (
            <Button key={k.kind} type="button" variant="secondary" className="min-h-8 text-xs" onClick={() => setF((p) => ({ ...p, rules: [...p.rules, newRule(k.kind)] }))}>
              ＋ {k.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted">ルールは組み合わせられます。同じ日に当たったルールは合算して1回分になります。</p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">余りの扱い</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1 w-auto"
            checked={f.remainder === "TO_BOND"}
            onChange={(e) => setF({ ...f, remainder: e.target.checked ? "TO_BOND" : "KEEP" })}
          />
          <span>
            余りを期限つきで債券へ移す
            <span className="block text-xs text-muted">チェックしないと、余りはシーズン中そのまま残ります。</span>
          </span>
        </label>
        {f.remainder === "TO_BOND" && (
          <div className="ml-6 flex flex-wrap items-center gap-2 text-sm">
            発生から
            <input
              aria-label="債券へ移すまでの日数"
              inputMode="numeric"
              className="w-16"
              value={f.remainderDays}
              onChange={(e) => setF({ ...f, remainderDays: e.target.value.replace(/\D/g, "") })}
            />
            日後の0:00に、残りを債券へ移す
          </div>
        )}
        <p className="text-xs text-muted">債券が上限に達していたら、超える分は金貨になります。支払いは期限の近い分から使います。</p>
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <Field label="開始日" hint="周期の起点です。">
          <input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label="終了日（任意）" hint="この日の0:00で発生が止まります。">
          <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
      </div>

      <div className={`rounded-lg p-3 text-sm ${over.length ? "bg-danger/10" : "bg-surface-2"}`}>
        <div className="mb-1 text-xs font-medium">保存前の確認</div>
        {problem && <p className="text-xs text-danger">{problem}</p>}
        {preview && (
          <>
            <p className="text-xs">
              次の発生：
              {preview.next.length ? preview.next.map((n) => `${n.date.slice(5).replace("-", "/")}（${fmt(n.amount)}）`).join("・") : f.rules.some((r) => r.kind === "minute") ? "毎分" : "なし"}
            </p>
            <table className="num mt-2 w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="font-normal">月</th>
                  <th className="text-right font-normal">この通貨</th>
                  <th className="text-right font-normal">C（全通貨）</th>
                  <th className="text-right font-normal">採掘（月）</th>
                </tr>
              </thead>
              <tbody>
                {preview.months.map((m) => (
                  <tr key={m.monthKey}>
                    <td>{m.monthKey}</td>
                    <td className="text-right">{fmt(m.thisCurrency)}</td>
                    <td className="text-right">{fmt(m.custom)}</td>
                    <td className="text-right">{yen(m.mining)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.months[0] && (
              <p className="mt-1 text-xs text-muted">
                採掘 ＝ 自由予算 {yen(preview.months[0].budget)} − サブスク {yen(preview.months[0].subs)} − C
              </p>
            )}
            {over.length > 0 && (
              <p className="mt-2 text-xs font-medium text-danger">
                自由予算を超える月があるため保存できません：{over.map((o) => `${o.monthKey}（${yen(o.over)} 超過）`).join("・")}
              </p>
            )}
          </>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={busy || !preview || over.length > 0 || !!problem}>
        {initial ? "保存" : "通貨を作る"}
      </Button>
    </form>
  );
}

function CategoryManager({ categories, reload }: { categories: Category[]; reload: () => Promise<void> }) {
  const { act, busy } = useGame();
  const [name, setName] = useState("");
  return (
    <div className="space-y-2">
      {categories.length === 0 ? (
        <Empty>ジャンルはまだありません</Empty>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <span className="flex-1">{c.name}</span>
              <button
                className="text-xs underline"
                onClick={async () => {
                  const next = prompt("新しい名前", c.name)?.trim();
                  if (next && next !== c.name && (await act(`/api/categories/${c.id}`, { name: next }, "PATCH"))) reload();
                }}
              >
                名前を変更
              </button>
              <button
                className="text-xs text-danger underline"
                onClick={async () => {
                  if (confirm(`「${c.name}」を一覧から外しますか？過去の購入記録のジャンルはそのまま残ります。`) && (await act(`/api/categories/${c.id}`, undefined, "DELETE"))) reload();
                }}
              >
                外す
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act("/api/categories", { name: name.trim() })) {
            setName("");
            reload();
          }
        }}
      >
        <input aria-label="ジャンル名" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：日用品" />
        <Button type="submit" variant="secondary" disabled={busy || !name.trim()}>
          追加
        </Button>
      </form>
    </div>
  );
}

export default function CurrenciesPage() {
  const { view, act } = useGame();
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const currencies = useList<Currency>("/api/currencies");
  const categories = useList<Category>("/api/categories");
  const [edit, setEdit] = useState<Currency | null>(null);
  const [creating, setCreating] = useState(false);
  const catName = (id: string) => categories.items?.find((c) => c.id === id)?.name ?? "（外したジャンル）";
  const reloadCategories = async () => {
    await categories.reload();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">通貨</h1>
        <p className="mt-1 text-sm text-muted">
          「食費コイン」のように、自由予算の一部を決まったジャンルの購入用に分けた通貨を作れます。発生する分だけ金鉱の採掘が減ります（自由予算の内訳なので、予算の二重計上になりません）。
        </p>
      </div>

      <Card title="ユーザ通貨" action={<Button onClick={() => setCreating(true)}>＋ 作る</Button>}>
        {!currencies.items?.length ? (
          <Empty>ユーザ通貨はまだありません</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {currencies.items.map((c) => (
              <li key={c.id} className="space-y-1 py-3 text-sm">
                <div className="flex items-center gap-2">
                  <CustomIcon icon={c.icon} size={20} />
                  <span className="flex-1 font-medium">{c.name}</span>
                  <span className="num font-pixel text-lg">{fmt(c.balance)}</span>
                </div>
                <div className="text-xs text-muted">
                  {c.rules.map(describeRule).join(" ＋ ")}
                  {" ・ "}
                  {c.remainder === "KEEP" ? "余りは残す" : `余りは${c.remainderDays}日後に債券へ`}
                  {" ・ "}
                  {c.categoryIds.map(catName).join("・")}で使える
                </div>
                <div className="text-xs text-muted">
                  {c.nextIssue && `次の発生 ${c.nextIssue.date}（${fmt(c.nextIssue.amount)}）`}
                  {c.nextExpiry && ` ・ ${formatDate(c.nextExpiry.at, tz)}に ${fmt(c.nextExpiry.amount)} が債券へ`}
                  {c.endDate && ` ・ ${c.endDate} で終了`}
                </div>
                <div className="flex gap-3 text-xs">
                  <button className="underline" onClick={() => setEdit(c)}>
                    編集
                  </button>
                  <button
                    className="text-danger underline"
                    onClick={async () => {
                      if (!confirm(`${c.name}を削除しますか？今の残高 ${fmt(c.balance)} は金貨に戻ります。`)) return;
                      if (await act(`/api/currencies/${c.id}`, undefined, "DELETE")) currencies.reload();
                    }}
                  >
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="ジャンル">
        <CategoryManager categories={categories.items ?? []} reload={reloadCategories} />
      </Card>

      <Modal open={creating} onClose={() => setCreating(false)} title="ユーザ通貨を作る">
        {creating && (
          <CurrencyForm
            tz={tz}
            categories={categories.items ?? []}
            onCategoriesChanged={reloadCategories}
            onDone={() => (setCreating(false), currencies.reload())}
          />
        )}
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="ユーザ通貨を編集">
        {edit && (
          <CurrencyForm
            key={edit.id}
            initial={edit}
            tz={tz}
            categories={categories.items ?? []}
            onCategoriesChanged={reloadCategories}
            onDone={() => (setEdit(null), currencies.reload())}
          />
        )}
      </Modal>
    </div>
  );
}
