"use client";

import { useCallback, useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal } from "@/components/ui";
import { api, fmt, yen } from "@/lib/api";
import { PaymentLine, type PaymentRow } from "./ExpenseTab";
import { CurrencyChip, digits, ResolutionLine, ResolutionPreview, type Resolution } from "./shared";

interface Purchase {
  id: string;
  amount: number;
  date: string;
  name: string;
  category: string | null;
  isSubscription: boolean;
  subscriptionId: string | null;
  wishItemId: string | null;
  baseAmount: number | null;
  payments?: PaymentRow[];
  resolutions: Resolution[];
}
interface Income {
  id: string;
  kind: "MONTHLY" | "EXTRA";
  amount: number;
  baseAmount: number;
  date: string;
  name: string;
  resolutions: Resolution[];
  pending: { at: number; currency: string; currencyId: string | null; amount: number }[];
}

type Row = { type: "income"; item: Income } | { type: "purchase"; item: Purchase };

interface EditQuote {
  diff: number;
  canceled?: number;
  cutMining?: number;
  surplus: Resolution | null;
  shortfall: Resolution | null;
}

/** 金額だけの編集（0 で取り消し）。変化分は差分の解消ルールで解消する（docs/record-input-redesign.md §9.3） */
function AmountEditor({ row, onDone }: { row: Row; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const [amount, setAmount] = useState(String(row.item.amount));
  const [quote, setQuote] = useState<EditQuote | null>(null);
  const n = Number(amount || 0);
  useEffect(() => {
    if (n === row.item.amount) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setQuote(await api<EditQuote>("/api/records/quote-edit", { body: { refType: row.type, id: row.item.id, amount: n } }));
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [n, row]);
  const path = row.type === "income" ? `/api/incomes/${row.item.id}` : `/api/purchases/${row.item.id}`;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act(path, { amount: n }, "PATCH");
        if (!r) return;
        toast(n === 0 ? "取り消しました" : "金額を変更しました");
        onDone();
      }}
    >
      <p className="text-sm">
        {row.item.name}（{row.item.date}）
      </p>
      <Field label="金額（円）" hint="日付・名称などは変更できません。間違えたときは取り消して記録し直してください。">
        <input inputMode="numeric" autoFocus value={amount} onChange={(e) => setAmount(digits(e.target.value))} />
      </Field>
      {quote && (quote.canceled ?? 0) > 0 && <p className="num text-xs text-muted">予約中の振り分けを {fmt(quote.canceled!)} 取りやめます。</p>}
      {quote && (quote.cutMining ?? 0) > 0 && <p className="num text-xs text-muted">当期の残りの配当を {fmt(quote.cutMining!)}G 減らします。</p>}
      {quote?.surplus && <ResolutionPreview r={quote.surplus} />}
      {quote?.shortfall && <ResolutionPreview r={quote.shortfall} />}
      <Button type="submit" className="w-full" disabled={busy || amount === "" || n === row.item.amount}>
        {n === 0 ? "取り消す（金額を0にする）" : "金額を変更"}
      </Button>
    </form>
  );
}

/** 収入・支出の履歴。取り消した記録（金額0）は取り消し線で表示する */
export function HistoryTab({ reloadKey }: { reloadKey: number }) {
  const { act, toast } = useGame();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const load = useCallback(async () => {
    const [inc, pur] = await Promise.all([api<{ items: Income[] }>("/api/incomes"), api<{ items: Purchase[] }>("/api/purchases")]);
    setRows(
      [...inc.items.map((item) => ({ type: "income" as const, item })), ...pur.items.map((item) => ({ type: "purchase" as const, item }))].sort((a, b) =>
        b.item.date.localeCompare(a.item.date),
      ),
    );
  }, []);
  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load, reloadKey]);

  return (
    <Card>
      {!rows ? (
        <p className="text-sm text-muted">読み込み中…</p>
      ) : rows.length === 0 ? (
        <Empty>まだ記録がありません</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const canceled = r.item.amount === 0;
            const original = r.item.resolutions.find((x) => x.before != null)?.before ?? null;
            const income = r.type === "income";
            const label = income ? (r.item.kind === "MONTHLY" ? "月の収入" : "臨時の収入") : r.item.isSubscription ? "サブスク" : r.item.wishItemId ? "ほしい物" : "支出";
            return (
              <li key={`${r.type}${r.item.id}`} className="py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <span className="num w-20 shrink-0 text-xs text-muted">{r.item.date}</span>
                  <span className={`min-w-0 flex-1 truncate ${canceled ? "text-muted line-through" : ""}`}>
                    {r.item.name}
                    <span className="ml-1 text-xs text-muted">{label}</span>
                    {!income && r.item.category && <span className="ml-1 text-xs text-muted">#{r.item.category}</span>}
                  </span>
                  {canceled && <span className="text-xs text-muted">取り消し</span>}
                  <span className={`num shrink-0 font-medium ${canceled ? "text-muted line-through" : income ? "text-dev" : ""}`}>
                    {income ? "+" : "−"}
                    {fmt(canceled && original !== null ? original : r.item.amount)}円
                  </span>
                </div>
                <div className="space-y-0.5 pl-[5.75rem]">
                  <div className="flex justify-end gap-3">
                    <button className="text-xs underline" onClick={() => setEdit(r)}>
                      金額を変更
                    </button>
                    {!canceled && (
                      <button
                        className="text-xs text-danger underline"
                        onClick={async () => {
                          if (!confirm("この記録を取り消しますか？（金額が0になり、記録は取り消し線で残ります。獲得した銀貨は戻りません）")) return;
                          const ok = await act(r.type === "income" ? `/api/incomes/${r.item.id}` : `/api/purchases/${r.item.id}`, { amount: 0 }, "PATCH");
                          if (ok) {
                            toast("取り消しました");
                            load();
                          }
                        }}
                      >
                        取り消す
                      </button>
                    )}
                  </div>
                  {!income && r.item.payments && <PaymentLine rows={r.item.payments} />}
                  {income && r.item.kind === "MONTHLY" && <span className="num block text-xs text-muted">雛形 {yen(r.item.baseAmount)}</span>}
                  {r.item.resolutions.map((x, i) => (
                    <ResolutionLine key={i} r={x} prefix={x.before != null ? `金額を変更：${fmt(x.before)}円 → ${fmt(x.after ?? 0)}円` : undefined} />
                  ))}
                  {income && r.item.pending.length > 0 && (
                    <span className="num flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      予定：
                      {r.item.pending.slice(0, 6).map((g, i) => (
                        <span key={i} className="inline-flex items-center gap-0.5">
                          {new Date(g.at).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}
                          <CurrencyChip currency={g.currency} currencyId={g.currencyId} />
                          {fmt(g.amount)}
                        </span>
                      ))}
                      {r.item.pending.length > 6 && <span>ほか{r.item.pending.length - 6}回</span>}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="金額を変更">
        {edit && <AmountEditor key={`${edit.type}${edit.item.id}`} row={edit} onDone={() => (setEdit(null), load())} />}
      </Modal>
    </Card>
  );
}
