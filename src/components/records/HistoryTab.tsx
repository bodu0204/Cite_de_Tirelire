"use client";

import { useCallback, useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal, NumberInput } from "@/components/ui";
import { api, fmt, yen } from "@/lib/api";
import { PaymentLine, type PaymentRow } from "./ExpenseTab";
import { AccountPicker, useAccounts, type Account } from "./accounts";
import { CurrencyChip, ResolutionLine, ResolutionPreview, type Resolution } from "./shared";

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
  seasonId: string | null;
  accountId: string | null;
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
  accountId: string | null;
  resolutions: Resolution[];
  pending: {
    at: number;
    currency: string;
    currencyId: string | null;
    amount: number;
  }[];
}
interface Transfer {
  id: string;
  date: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  memo: string | null;
  kind: "MANUAL" | "CARD_PAYMENT";
}
interface Outside {
  id: string;
  date: string;
  accountId: string;
  name: string;
  amount: number;
}
interface Reconciled {
  id: string;
  date: string;
  diff: number;
  items: { accountId: string; name: string; diff: number }[] | Record<string, number>;
}

type Row = { type: "income"; item: Income } | { type: "purchase"; item: Purchase };
type Other = { type: "transfer"; item: Transfer } | { type: "outside"; item: Outside } | { type: "adjustment"; item: Reconciled };

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
        setQuote(
          await api<EditQuote>("/api/records/quote-edit", {
            body: { refType: row.type, id: row.item.id, amount: n },
          }),
        );
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
        <NumberInput autoFocus value={amount} onValueChange={setAmount} />
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

/** 出どころ・入金先の変更（docs/money-accounts.md RS-04）。ゲームの判定は変わらない。支出の出どころを初めて自分で選ぶと銀貨の報酬つき */
function AccountEditor({ row, accounts, defaults, onDone }: { row: Row; accounts: Account[]; defaults: { spend: string | null; income: string | null }; onDone: () => void }) {
  const { act, toast, busy, view } = useGame();
  const income = row.type === "income";
  const current = row.item.accountId ?? (income ? defaults.income : defaults.spend) ?? "";
  const [id, setId] = useState(current);
  const rewardable = !income && view?.season?.id === (row.item as Purchase).seasonId;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act<{ paymentReward?: number }>(income ? `/api/incomes/${row.item.id}` : `/api/purchases/${row.item.id}`, { accountId: id }, "PATCH");
        if (!r) return;
        const got = r.paymentReward ?? 0;
        toast(got > 0 ? `出どころを変更しました！ 銀貨 +${got}S` : income ? "入金先を変更しました" : "出どころを変更しました", got > 0 ? "reward" : "info");
        onDone();
      }}
    >
      <p className="text-sm">
        {row.item.name}（{row.item.date}・{yen(row.item.amount)}）
      </p>
      <AccountPicker
        label={income ? "入金先" : "出どころ"}
        accounts={accounts}
        value={id}
        onChange={setId}
        defaultId={income ? defaults.income : defaults.spend}
        reward={rewardable}
        exclude={income ? (a) => a.kind === "CARD" : undefined}
      />
      <p className="text-xs text-muted">置き場所を変えても、精算・手数料・貯金額は変わりません。置き場所の残高だけが移ります。</p>
      <Button type="submit" className="w-full" disabled={busy || !id || id === current}>
        変更する
      </Button>
    </form>
  );
}

/** 振替・予算外の入出金の金額の編集（0 で取り消し）。ゲームの通貨は動かない */
function SimpleAmountEditor({ row, onDone }: { row: Other; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const item = row.item as Transfer | Outside;
  const [amount, setAmount] = useState(String(Math.abs(item.amount)));
  const n = Number(amount || 0);
  const path = row.type === "transfer" ? `/api/transfers/${item.id}` : `/api/outside/${item.id}`;
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await act(path, { amount: n }, "PATCH")) {
          toast(n === 0 ? "取り消しました" : "金額を変更しました");
          onDone();
        }
      }}
    >
      <Field label="金額（円）" hint="置き場所の残高だけが変わります（ゲームの通貨は動きません）。0 にすると取り消しになります。">
        <NumberInput autoFocus value={amount} onValueChange={setAmount} />
      </Field>
      <Button type="submit" className="w-full" disabled={busy || amount === "" || n === Math.abs(item.amount)}>
        {n === 0 ? "取り消す（金額を0にする）" : "金額を変更"}
      </Button>
    </form>
  );
}

/** 収入・支出の履歴。取り消した記録（金額0）は取り消し線で表示する */
export function HistoryTab({ reloadKey }: { reloadKey: number }) {
  const { act, toast } = useGame();
  const [rows, setRows] = useState<(Row | Other)[] | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const [accEdit, setAccEdit] = useState<Row | null>(null);
  const [otherEdit, setOtherEdit] = useState<Other | null>(null);
  const [filter, setFilter] = useState("");
  const { data, active, reload: reloadAccounts } = useAccounts(reloadKey);
  const accounts = data?.items ?? [];
  const defaults = data?.defaults ?? { spend: null, income: null };
  const showAccounts = accounts.length > 1;
  const nameOf = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "—";
  const load = useCallback(async () => {
    const [inc, pur, tr, out, adj] = await Promise.all([
      api<{ items: Income[] }>("/api/incomes"),
      api<{ items: Purchase[] }>("/api/purchases"),
      api<{ items: Transfer[] }>("/api/transfers"),
      api<{ items: Outside[] }>("/api/outside"),
      api<{ items: Reconciled[] }>("/api/adjustments"),
    ]);
    setRows(
      [
        ...inc.items.map((item) => ({ type: "income" as const, item })),
        ...pur.items.map((item) => ({ type: "purchase" as const, item })),
        ...tr.items.map((item) => ({ type: "transfer" as const, item })),
        ...out.items.map((item) => ({ type: "outside" as const, item })),
        ...adj.items.map((item) => ({ type: "adjustment" as const, item })),
      ].sort((a, b) => b.item.date.localeCompare(a.item.date)),
    );
  }, []);
  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load, reloadKey]);
  /** その置き場所を動かした記録か（置き場所で絞る。RC-06） */
  const touches = (r: Row | Other, id: string) => {
    if (r.type === "income") return (r.item.accountId ?? defaults.income) === id;
    if (r.type === "purchase") return (r.item.accountId ?? defaults.spend) === id;
    if (r.type === "transfer") return r.item.fromAccountId === id || r.item.toAccountId === id;
    if (r.type === "outside") return r.item.accountId === id;
    return Array.isArray(r.item.items) && r.item.items.some((x) => x.accountId === id && x.diff !== 0);
  };
  const shown = (rows ?? []).filter((r) => !filter || touches(r, filter));
  const otherRow = (r: Other) => {
    const canceled = r.type !== "adjustment" && r.item.amount === 0;
    const line = canceled ? "text-muted line-through" : "";
    if (r.type === "adjustment") {
      const parts = Array.isArray(r.item.items) ? r.item.items.filter((x) => x.diff !== 0) : [];
      return (
        <li key={`a${r.item.id}`} className="py-2.5 text-sm">
          <div className="flex items-center gap-3">
            <span className="num w-20 shrink-0 text-xs text-muted">{r.item.date}</span>
            <span className="min-w-0 flex-1 truncate">
              残高を合わせた
              <span className="ml-1 text-xs text-muted">照合</span>
            </span>
            <span className={`num shrink-0 font-medium ${r.item.diff > 0 ? "text-dev" : r.item.diff < 0 ? "text-danger" : ""}`}>
              {r.item.diff === 0 ? "±0" : `${r.item.diff > 0 ? "+" : "−"}${fmt(Math.abs(r.item.diff))}`}円
            </span>
          </div>
          {parts.length > 0 && <p className="num pl-[5.75rem] text-xs text-muted">{parts.map((x) => `${x.name} ${x.diff > 0 ? "+" : "−"}${fmt(Math.abs(x.diff))}`).join("・")}</p>}
        </li>
      );
    }
    const isT = r.type === "transfer";
    return (
      <li key={`${r.type}${r.item.id}`} className="py-2.5 text-sm">
        <div className="flex items-center gap-3">
          <span className="num w-20 shrink-0 text-xs text-muted">{r.item.date}</span>
          <span className={`min-w-0 flex-1 truncate ${line}`}>
            {isT ? `${nameOf((r.item as Transfer).fromAccountId)} → ${nameOf((r.item as Transfer).toAccountId)}` : (r.item as Outside).name}
            <span className="ml-1 text-xs text-muted">
              {isT ? ((r.item as Transfer).kind === "CARD_PAYMENT" ? "引き落とし" : "振替") : `予算外・${nameOf((r.item as Outside).accountId)}`}
            </span>
            {isT && (r.item as Transfer).memo && <span className="ml-1 text-xs text-muted">{(r.item as Transfer).memo}</span>}
          </span>
          {canceled && <span className="text-xs text-muted">取り消し</span>}
          <span className={`num shrink-0 font-medium ${line} ${!isT && r.item.amount > 0 ? "text-dev" : ""}`}>
            {isT ? "" : r.item.amount >= 0 ? "+" : "−"}
            {fmt(Math.abs(r.item.amount))}円
          </span>
        </div>
        <div className="flex justify-end gap-3 pl-[5.75rem]">
          <button className="text-xs underline" onClick={() => setOtherEdit(r)}>
            金額を変更
          </button>
          {!canceled && (
            <button
              className="text-xs text-danger underline"
              onClick={async () => {
                if (!confirm("この記録を取り消しますか？（金額が0になり、記録は取り消し線で残ります。獲得した銀貨は戻りません）")) return;
                if (await act(isT ? `/api/transfers/${r.item.id}` : `/api/outside/${r.item.id}`, { amount: 0 }, "PATCH")) {
                  toast("取り消しました");
                  load();
                }
              }}
            >
              取り消す
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <Card>
      {!rows ? (
        <p className="text-sm text-muted">読み込み中…</p>
      ) : rows.length === 0 ? (
        <Empty>まだ記録がありません</Empty>
      ) : (
        <>
          {showAccounts && (
            <label className="mb-2 flex items-center gap-2 text-sm">
              置き場所で絞る
              <select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="">すべて</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {shown.length === 0 && <Empty>この置き場所の記録はありません</Empty>}
          <ul className="divide-y divide-line">
            {shown.map((r) => {
              if (r.type === "transfer" || r.type === "outside" || r.type === "adjustment") return otherRow(r);
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
                      {showAccounts && <span className="ml-1 text-xs text-muted">{nameOf(r.item.accountId ?? (income ? defaults.income : defaults.spend))}</span>}
                    </span>
                    {canceled && <span className="text-xs text-muted">取り消し</span>}
                    <span className={`num shrink-0 font-medium ${canceled ? "text-muted line-through" : income ? "text-dev" : ""}`}>
                      {income ? "+" : "−"}
                      {fmt(canceled && original !== null ? original : r.item.amount)}円
                    </span>
                  </div>
                  <div className="space-y-0.5 pl-[5.75rem]">
                    <div className="flex justify-end gap-3">
                      {showAccounts && !canceled && (
                        <button className="text-xs underline" onClick={() => (setAccEdit(r), reloadAccounts())}>
                          {income ? "入金先を変更" : "出どころを変更"}
                        </button>
                      )}
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
                            {new Date(g.at).toLocaleDateString("ja-JP", {
                              month: "numeric",
                              day: "numeric",
                            })}
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
        </>
      )}
      <Modal open={!!accEdit} onClose={() => setAccEdit(null)} title={accEdit?.type === "income" ? "入金先" : "出どころ"}>
        {accEdit && (
          <AccountEditor
            key={`${accEdit.type}${accEdit.item.id}`}
            row={accEdit}
            accounts={active}
            defaults={defaults}
            onDone={() => (setAccEdit(null), load(), reloadAccounts())}
          />
        )}
      </Modal>
      <Modal open={!!otherEdit} onClose={() => setOtherEdit(null)} title="金額を変更">
        {otherEdit && <SimpleAmountEditor key={`${otherEdit.type}${otherEdit.item.id}`} row={otherEdit} onDone={() => (setOtherEdit(null), load(), reloadAccounts())} />}
      </Modal>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="金額を変更">
        {edit && <AmountEditor key={`${edit.type}${edit.item.id}`} row={edit} onDone={() => (setEdit(null), load())} />}
      </Modal>
    </Card>
  );
}
