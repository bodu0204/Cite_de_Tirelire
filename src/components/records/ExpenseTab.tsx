"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, CustomIcon, Empty, Field } from "@/components/ui";
import { REWARD_PURCHASE } from "@/game/config";
import { api, fmt, todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";
import { digits } from "./shared";

export interface PaymentRow {
  currency: "GOLD" | "SILVER" | "BOND" | "CUSTOM" | "RESERVED";
  kind: "pay" | "fee";
  currencyId: string | null;
  amount: number;
}

interface Category {
  id: string;
  name: string;
}

interface Quote {
  settleable: boolean;
  payment: { reserved: number; custom: { currencyId: string; amount: number }[]; gold: number; bond: number; feeSilver: number; feeBond: number };
  after: { gold: number; uncollected: number; silver: number; bond: number } | null;
}

const NEW_CATEGORY = "__new__";

/** 支払い内訳の1行表示（ユーザ通貨はアイコンで） */
export function PaymentLine({ rows }: { rows: PaymentRow[] }) {
  const v = useSeasonView();
  const icon = (id: string | null) => v?.currencies.custom.find((c) => c.id === id)?.icon ?? "🪙";
  const sum = (c: PaymentRow["currency"], k: PaymentRow["kind"]) => rows.filter((r) => r.currency === c && r.kind === k).reduce((a, r) => a + r.amount, 0);
  const custom = rows.filter((r) => r.currency === "CUSTOM");
  const fee = sum("SILVER", "fee") + sum("BOND", "fee");
  if (!rows.length) return null;
  return (
    <span className="num flex flex-wrap gap-x-2 text-xs text-muted">
      {sum("RESERVED", "pay") > 0 && <span>像 {fmt(sum("RESERVED", "pay"))}G</span>}
      {custom.map((r, i) => (
        <span key={i}>
          {icon(r.currencyId)}
          {fmt(r.amount)}
        </span>
      ))}
      {sum("GOLD", "pay") > 0 && <span>金貨 {fmt(sum("GOLD", "pay"))}G</span>}
      {sum("BOND", "pay") > 0 && <span className="text-danger">債券 {fmt(sum("BOND", "pay"))}</span>}
      {fee > 0 && <span>手数料 {fmt(fee)}</span>}
    </span>
  );
}

/** 記録前の支払い内訳（確定前に債券・手数料が見える） */
function QuoteView({ q }: { q: Quote }) {
  const v = useSeasonView();
  if (!q.settleable) return <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">この支出は金鉱の精算対象外です（当期以外の日付・シーズン外）。</p>;
  const p = q.payment;
  const cur = (id: string) => v?.currencies.custom.find((c) => c.id === id);
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${p.bond > 0 ? "bg-danger/10" : "bg-surface-2"}`}>
      <div className="mb-1 text-xs font-medium">支払いの内訳</div>
      <dl className="num grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">
        {p.custom.map((c, i) => (
          <div key={i} className="contents">
            <dt className="flex items-center gap-1">
              <CustomIcon icon={cur(c.currencyId)?.icon ?? "🪙"} />
              {cur(c.currencyId)?.name ?? "ユーザ通貨"}
            </dt>
            <dd className="text-right">{fmt(c.amount)}</dd>
          </div>
        ))}
        {p.gold > 0 && (
          <>
            <dt className="flex items-center gap-1">
              <Coin kind="gold" />
              金貨（未回収→所持）
            </dt>
            <dd className="text-right">{fmt(p.gold)}G</dd>
          </>
        )}
        {p.bond > 0 && (
          <>
            <dt className="flex items-center gap-1 font-medium">
              <BondIcon />
              債券（足りない分）
            </dt>
            <dd className="text-right font-medium">{fmt(p.bond)}</dd>
            <dt>手数料（銀貨{p.feeBond > 0 ? "・不足分は債券" : ""}）</dt>
            <dd className="text-right">
              {fmt(p.feeSilver)}S{p.feeBond > 0 && ` ＋ ${fmt(p.feeBond)}`}
            </dd>
          </>
        )}
      </dl>
      {q.after && p.bond > 0 && (
        <p className="mt-1 text-xs">
          記録後の債券は <span className={`num font-semibold ${q.after.bond < 0 ? "text-danger" : ""}`}>{fmt(q.after.bond)}</span>
          {q.after.bond < 0 && "。0に戻るまで採掘の20%以上が債券に回ります（発展速度は変わりません）"}
        </p>
      )}
    </div>
  );
}

/** 普通の支出 */
function PurchaseForm({ onDone, tz }: { onDone: () => void; tz: string }) {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const categories = useList<Category>("/api/categories");
  const [f, setF] = useState({ amount: "", date: todayIn(tz), name: "", categoryId: "", memo: "" });
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const set = (k: keyof typeof f, val: string) => setF((p) => ({ ...p, [k]: val }));
  const usable = f.categoryId ? (v?.currencies.custom ?? []).filter((c) => c.categoryIds.includes(f.categoryId)) : [];

  useEffect(() => {
    if (!v || Number(f.amount) <= 0 || !f.date) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setQuote(await api<Quote>("/api/purchases/quote", { body: { amount: Number(f.amount), date: f.date, categoryId: f.categoryId || undefined } }));
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [v, f.amount, f.date, f.categoryId]);

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    const r = await act<{ id: string }>("/api/categories", { name });
    if (!r) return;
    await categories.reload();
    setNewCategory("");
    setAdding(false);
    set("categoryId", r.id);
  };

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act<{ reward: number; payment?: Quote["payment"] }>("/api/purchases", { ...f, amount: Number(f.amount), categoryId: f.categoryId || null });
        if (!r) return;
        const bond = r.payment && r.payment.bond > 0 ? `（債券から ${fmt(r.payment.bond)} を支払いました）` : "";
        toast(r.reward > 0 ? `記録しました！ 銀貨 +${r.reward}S${bond}` : `記録しました（今日の記録報酬は上限に達しています）${bond}`, r.reward > 0 ? "reward" : "info");
        setF((p) => ({ ...p, amount: "", name: "", memo: "" }));
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="金額（円）">
          <input inputMode="numeric" required value={f.amount} onChange={(e) => set("amount", digits(e.target.value))} />
        </Field>
        <Field label="日付">
          <input type="date" required value={f.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
      </div>
      <Field label="内容">
        <input required maxLength={100} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="例：ランチ" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ジャンル（任意）" hint={usable.length ? `使える通貨：${usable.map((c) => `${c.icon}${c.name}（${fmt(c.balance)}）`).join("・")}` : undefined}>
          <select
            value={adding ? NEW_CATEGORY : f.categoryId}
            onChange={(e) => {
              setAdding(e.target.value === NEW_CATEGORY);
              if (e.target.value !== NEW_CATEGORY) set("categoryId", e.target.value);
            }}
          >
            <option value="">選ばない</option>
            {categories.items?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={NEW_CATEGORY}>＋ 新しいジャンル</option>
          </select>
        </Field>
        <Field label="メモ（任意）">
          <input maxLength={500} value={f.memo} onChange={(e) => set("memo", e.target.value)} />
        </Field>
      </div>
      {adding && (
        <div className="flex gap-2">
          <input aria-label="新しいジャンル名" autoFocus maxLength={50} value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="例：食費" />
          <Button type="button" variant="secondary" disabled={busy || !newCategory.trim()} onClick={addCategory}>
            追加
          </Button>
        </div>
      )}
      {quote && <QuoteView q={quote} />}
      <p className="text-xs text-muted">登録したあとは金額だけ変更できます（減額は＋差分、増額は−差分として解消します）。</p>
      <Button type="submit" className="w-full" disabled={busy || Number(f.amount) <= 0 || !f.date || !f.name.trim()}>
        支出を記録（+{REWARD_PURCHASE}S）
      </Button>
    </form>
  );
}

interface SubRow {
  subscriptionId: string;
  name: string;
  amount: number;
  cycle: string;
  periodKey: string;
  date: string;
}
interface WishRow {
  id: string;
  name: string;
  price: number;
  reserved: number;
}

/** ＋差分・−差分の説明 */
function DiffNote({ base, amount }: { base: number; amount: number }) {
  const d = base - amount;
  if (d === 0 || !Number.isFinite(d)) return null;
  return (
    <span className={`num text-xs ${d > 0 ? "text-dev" : "text-danger"}`}>
      {d > 0 ? `＋差分 ${fmt(d)}（債券 → おまかせ交換）` : `−差分 ${fmt(-d)}（債券から・手数料あり）`}
    </span>
  );
}

/** サブスク・ほしい物：設定から作ったベースを保存ボタンひとつで記録する（docs/record-input-redesign.md §6.2・§6.3） */
function BaseRows({ onDone, tz }: { onDone: () => void; tz: string }) {
  const { act, toast, busy } = useGame();
  const [base, setBase] = useState<{ subscriptions: SubRow[]; wishes: WishRow[] } | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const r = await api<{ subscriptions: SubRow[]; wishes: WishRow[] }>("/api/purchases/base");
    setBase(r);
    setAmounts((prev) => ({
      ...Object.fromEntries(r.subscriptions.map((s) => [`s:${s.subscriptionId}:${s.periodKey}`, String(s.amount)])),
      ...Object.fromEntries(r.wishes.map((w) => [`w:${w.id}`, String(w.price)])),
      ...prev,
    }));
  }, []);
  useEffect(() => {
    load().catch(() => setBase({ subscriptions: [], wishes: [] }));
  }, [load]);
  if (!base) return <p className="text-sm text-muted">読み込み中…</p>;
  const subBody = (s: SubRow) => ({ subscriptionId: s.subscriptionId, periodKey: s.periodKey, date: s.date, amount: Number(amounts[`s:${s.subscriptionId}:${s.periodKey}`] || 0) });
  const wishBody = (w: WishRow) => ({ wishItemId: w.id, date: todayIn(tz), amount: Number(amounts[`w:${w.id}`] || 0) });
  const finish = async (n: number, reward: number) => {
    toast(reward > 0 ? `${n}件記録しました！ 銀貨 +${reward}S` : `${n}件記録しました`, reward > 0 ? "reward" : "info");
    await load();
    onDone();
  };
  const all = [...base.subscriptions.map(subBody), ...base.wishes.map(wishBody)];
  if (!all.length) return <Empty>未記録のサブスクの支払い・未購入のほしい物はありません</Empty>;
  const row = (key: string, label: ReactNode, sub: ReactNode, baseAmount: number, body: () => Record<string, unknown>) => {
    const amount = Number(amounts[key] || 0);
    return (
      <li key={key} className="rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-28 flex-1">
            <div className="text-sm font-medium">{label}</div>
            <div className="num text-xs text-muted">{sub}</div>
          </div>
          <input aria-label="金額（円）" inputMode="numeric" className="w-28" value={amounts[key] ?? ""} onChange={(e) => setAmounts((a) => ({ ...a, [key]: digits(e.target.value) }))} />
          <span className="text-sm">円</span>
          <Button
            disabled={busy || amounts[key] === "" || amount <= 0}
            onClick={async () => {
              const r = await act<{ reward: number }>("/api/purchases", body());
              if (r) await finish(1, r.reward);
            }}
          >
            保存
          </Button>
        </div>
        <DiffNote base={baseAmount} amount={amount} />
      </li>
    );
  };
  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {base.subscriptions.map((s) =>
          row(`s:${s.subscriptionId}:${s.periodKey}`, `${Number(s.periodKey.slice(5, 7))}月 ${s.name}`, `サブスク（登録額 ${yen(s.amount)}${s.cycle === "YEARLY" ? "・年額" : ""}）`, s.amount, () => subBody(s)),
        )}
        {base.wishes.map((w) => row(`w:${w.id}`, w.name, `ほしい物（価格 ${yen(w.price)}・積立 ${fmt(w.reserved)}G）`, w.price, () => wishBody(w)))}
      </ul>
      {all.length > 1 && (
        <Button
          variant="secondary"
          className="w-full"
          disabled={busy || all.some((b) => !b.amount)}
          onClick={async () => {
            const r = await act<{ items: { reward: number }[] }>("/api/purchases", { items: all });
            if (r) await finish(r.items.length, r.items.reduce((a, x) => a + x.reward, 0));
          }}
        >
          一括保存（{all.length}件）
        </Button>
      )}
      <p className="text-xs text-muted">
        サブスクの登録額はすでに採掘から差し引かれているので精算しません。登録額・価格より安ければ＋差分（債券 → おまかせ交換）、高ければ−差分（債券から）として解消します。ほしい物は積立金貨から価格を精算します。
      </p>
    </div>
  );
}

export function ExpenseTab({ onDone, tz }: { onDone: () => void; tz: string }) {
  const v = useSeasonView();
  return (
    <div className="space-y-4">
      {v && (
        <Card title="サブスク・ほしい物">
          <BaseRows onDone={onDone} tz={tz} />
        </Card>
      )}
      <Card title="普通の支出">
        <PurchaseForm tz={tz} onDone={onDone} />
      </Card>
    </div>
  );
}
