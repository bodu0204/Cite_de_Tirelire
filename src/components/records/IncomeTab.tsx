"use client";

import { useCallback, useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field } from "@/components/ui";
import { REWARD_PURCHASE } from "@/game/config";
import { api, fmt, todayIn, yen } from "@/lib/api";
import { AllocationEditor, type AllocationRow, type IncomeQuote } from "./Allocation";
import { digits, ResolutionPreview } from "./shared";

interface BasePeriod {
  key: string;
  startDate: string;
  endDate: string;
  base: number;
  current: boolean;
}

interface RowState {
  amount: string;
  rows: AllocationRow[] | null;
  autoExchange: boolean;
  open: boolean;
  quote: IncomeQuote | null;
}

const monthLabel = (key: string) => `${Number(key.slice(5, 7))}月の月収`;

/** 月の収入：未記録の期間を雛形（今の B）で並べ、保存ボタンひとつで記録する（docs/record-input-redesign.md §5.3） */
function MonthlyIncomes({ onDone }: { onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const [periods, setPeriods] = useState<BasePeriod[] | null>(null);
  const [state, setState] = useState<Record<string, RowState>>({});

  const load = useCallback(async () => {
    const r = await api<{ periods: BasePeriod[] }>("/api/incomes/base");
    setPeriods(r.periods);
    setState((prev) => Object.fromEntries(r.periods.map((p) => [p.key, prev[p.key] ?? { amount: String(p.base), rows: null, autoExchange: false, open: false, quote: null }])));
  }, []);
  useEffect(() => {
    load().catch(() => setPeriods([]));
  }, [load]);

  const set = (key: string, patch: Partial<RowState>) => setState((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const body = (p: BasePeriod) => {
    const st = state[p.key];
    const amount = Number(st.amount || 0);
    return { kind: "MONTHLY", monthKey: p.key, amount, autoExchange: st.autoExchange, ...(amount > p.base && st.rows ? { allocation: st.rows } : {}) };
  };
  const done = async (n: number, reward: number) => {
    toast(reward > 0 ? `月の収入を${n}件記録しました！ 銀貨 +${reward}S` : `月の収入を${n}件記録しました`, reward > 0 ? "reward" : "info");
    await load();
    onDone();
  };

  if (!periods) return <p className="text-sm text-muted">読み込み中…</p>;
  if (!periods.length) return <Empty>未記録の月の収入はありません</Empty>;
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {periods.map((p) => {
          const st = state[p.key];
          if (!st) return null;
          const amount = Number(st.amount || 0);
          const diff = amount - p.base;
          return (
            <li key={p.key} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-28 flex-1">
                  <div className="text-sm font-medium">
                    {monthLabel(p.key)}
                    {p.current && <span className="ml-1 rounded bg-gold-soft px-1 text-xs">当期</span>}
                  </div>
                  <div className="num text-xs text-muted">
                    {p.startDate}〜{p.endDate}
                  </div>
                </div>
                <input aria-label={`${monthLabel(p.key)}（円）`} inputMode="numeric" className="w-32" value={st.amount} onChange={(e) => set(p.key, { amount: digits(e.target.value) })} />
                <span className="text-sm">円</span>
                <Button
                  disabled={busy || !st.amount}
                  onClick={async () => {
                    const r = await act<{ reward: number }>("/api/incomes", body(p));
                    if (r) await done(1, r.reward);
                  }}
                >
                  保存
                </Button>
              </div>
              {diff !== 0 && (
                <div className="mt-2 space-y-2">
                  <button type="button" className="text-xs underline" onClick={() => set(p.key, { open: !st.open })}>
                    {diff > 0 ? `＋差分 ${fmt(diff)}円（雛形 ${yen(p.base)} より多い）` : `−差分 ${fmt(-diff)}円（雛形 ${yen(p.base)} より少ない）`}
                    {st.open ? " ▲" : " ▼"}
                  </button>
                  <div className={st.open ? "space-y-2" : "hidden"}>
                    <AllocationEditor
                      kind="MONTHLY"
                      monthKey={p.key}
                      amount={amount}
                      defaultPreset="ratio"
                      rows={st.rows}
                      onRows={(rows) => set(p.key, { rows })}
                      onQuote={(quote) => set(p.key, { quote })}
                    />
                    {diff < 0 && st.quote?.reduction && (
                      <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
                        <div className="mb-0.5 font-medium">−差分は当期の未配当分から減らし、足りない分は債券から</div>
                        <span className="num">
                          残りの採掘 −{fmt(st.quote.reduction.cutMining)}G ・ ユーザ通貨の未発生分 −{fmt(st.quote.reduction.cutCustom.reduce((a, c) => a + c.amount, 0))}
                        </span>
                        {st.quote.reduction.shortfall && <ResolutionPreview r={st.quote.reduction.shortfall} />}
                      </div>
                    )}
                    {diff > 0 && (
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" className="w-auto" checked={st.autoExchange} onChange={(e) => set(p.key, { autoExchange: e.target.checked })} />
                        即時に入る金貨で、おまかせで資源を買う（手数料 5S、銀貨が足りなければなし）
                      </label>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {periods.length > 1 && (
        <Button
          variant="secondary"
          className="w-full"
          disabled={busy || periods.some((p) => !state[p.key]?.amount)}
          onClick={async () => {
            const r = await act<{ items: { reward: number }[] }>("/api/incomes", { items: periods.map(body) });
            if (r) await done(r.items.length, r.items.reduce((a, x) => a + x.reward, 0));
          }}
        >
          一括保存（{periods.length}件）
        </Button>
      )}
      <p className="text-xs text-muted">
        ベースは今の月間自由予算です。雛形の分はこれまでどおり金鉱の採掘とユーザ通貨で配当され、差分だけが追加で配当されます。記録しない月も雛形で配当は続きます。報酬は1件 {REWARD_PURCHASE}S（月ごとに1回）。
      </p>
    </div>
  );
}

/** 臨時の収入：全額を振り分ける（初期値は即時貯蓄） */
function ExtraIncomeForm({ onDone }: { onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const tz = v?.user.timezone ?? "Asia/Tokyo";
  const [f, setF] = useState({ amount: "", date: todayIn(tz), name: "", memo: "", autoExchange: false });
  const [rows, setRows] = useState<AllocationRow[] | null>(null);
  const [key, setKey] = useState(0);
  const amount = Number(f.amount || 0);
  const goldNow = (rows ?? []).some((r) => r.currency === "GOLD" && r.when === "now");
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act<{ reward: number }>("/api/incomes", { kind: "EXTRA", ...f, amount, ...(rows ? { allocation: rows } : {}) });
        if (!r) return;
        toast(r.reward > 0 ? `臨時の収入を記録しました！ 銀貨 +${r.reward}S` : "臨時の収入を記録しました", r.reward > 0 ? "reward" : "info");
        setF((p) => ({ ...p, amount: "", name: "", memo: "", autoExchange: false }));
        setRows(null);
        setKey((k) => k + 1);
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="金額（円）">
          <input inputMode="numeric" required value={f.amount} onChange={(e) => setF({ ...f, amount: digits(e.target.value) })} />
        </Field>
        <Field label="日付" hint="過去の日付でも、記録した時点から配当します。">
          <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
      </div>
      <Field label="名称">
        <input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例：ボーナス・お祝い" />
      </Field>
      <Field label="メモ（任意）">
        <input maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      </Field>
      {v && amount > 0 && <AllocationEditor key={key} kind="EXTRA" amount={amount} defaultPreset="save" rows={rows} onRows={setRows} />}
      {goldNow && (
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="w-auto" checked={f.autoExchange} onChange={(e) => setF({ ...f, autoExchange: e.target.checked })} />
          即時に入る金貨で、おまかせで資源を買う（手数料 5S、銀貨が足りなければなし）
        </label>
      )}
      <Button type="submit" className="w-full" disabled={busy || amount <= 0 || !f.name.trim() || !f.date}>
        臨時の収入を記録（+{REWARD_PURCHASE}S）
      </Button>
    </form>
  );
}

export function IncomeTab({ onDone }: { onDone: () => void }) {
  const v = useSeasonView();
  return (
    <div className="space-y-4">
      <Card title="月の収入">
        {v ? <MonthlyIncomes onDone={onDone} /> : <p className="text-sm text-muted">進行中のシーズンがないため、月の収入は記録できません。</p>}
      </Card>
      <Card title="臨時の収入">
        <ExtraIncomeForm onDone={onDone} />
      </Card>
    </div>
  );
}
