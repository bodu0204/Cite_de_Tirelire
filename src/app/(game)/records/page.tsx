"use client";

import { useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, CustomIcon, Empty, Field, Modal, Tabs } from "@/components/ui";
import { REWARD_PURCHASE, REWARD_SAVINGS } from "@/game/config";
import { api, fmt, todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface PaymentRow {
  currency: "GOLD" | "SILVER" | "BOND" | "CUSTOM" | "RESERVED";
  kind: "pay" | "fee";
  currencyId: string | null;
  amount: number;
}
interface Purchase {
  id: string;
  amount: number;
  date: string;
  name: string;
  category: string | null;
  categoryId: string | null;
  memo: string | null;
  isSubscription: boolean;
  wishItemId: string | null;
  payments?: PaymentRow[];
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
function PaymentLine({ rows }: { rows: PaymentRow[] }) {
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
  if (!q.settleable) return <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">この購入は金鉱の精算対象外です（サブスク・当月以外の日付・シーズン外）。</p>;
  const p = q.payment;
  const cur = (id: string) => v?.currencies.custom.find((c) => c.id === id);
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${p.bond > 0 ? "bg-danger/10" : "bg-surface-2"}`}>
      <div className="mb-1 text-xs font-medium">支払いの内訳</div>
      <dl className="num grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">
        {p.reserved > 0 && (
          <>
            <dt>像の積立金貨</dt>
            <dd className="text-right">{fmt(p.reserved)}G</dd>
          </>
        )}
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
interface Savings {
  id: string;
  kind: "DEPOSIT" | "WITHDRAW";
  amount: number;
  date: string;
  memo: string | null;
}
interface Wish {
  id: string;
  name: string;
  price: number;
  purchasedAt: string | null;
}

type Tab = "purchase" | "savings" | "history";

const digits = (s: string) => s.replace(/\D/g, "");

function PurchaseForm({ initial, onDone, tz }: { initial?: Purchase; onDone: () => void; tz: string }) {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const wishes = useList<Wish>("/api/wishes");
  const categories = useList<Category>("/api/categories");
  const [f, setF] = useState({
    amount: initial ? String(initial.amount) : "",
    date: initial?.date ?? todayIn(tz),
    name: initial?.name ?? "",
    categoryId: initial?.categoryId ?? "",
    memo: initial?.memo ?? "",
    isSubscription: initial?.isSubscription ?? false,
    wishItemId: "",
  });
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const set = (k: keyof typeof f, val: string | boolean) => setF((p) => ({ ...p, [k]: val }));
  const usable = f.categoryId ? (v?.currencies.custom ?? []).filter((c) => c.categoryIds.includes(f.categoryId)) : [];

  // 記録前に支払い内訳を確かめる（新規のときだけ）
  useEffect(() => {
    if (initial || !v || Number(f.amount) <= 0 || !f.date) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setQuote(
          await api<Quote>("/api/purchases/quote", {
            body: { amount: Number(f.amount), date: f.date, categoryId: f.categoryId || undefined, isSubscription: f.isSubscription, wishItemId: f.wishItemId || undefined },
          }),
        );
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [initial, v, f.amount, f.date, f.categoryId, f.isSubscription, f.wishItemId]);

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
        const body = { ...f, amount: Number(f.amount), categoryId: f.categoryId || null, wishItemId: f.wishItemId || undefined };
        const r = initial
          ? await act(`/api/purchases/${initial.id}`, body, "PATCH")
          : await act<{ reward: number; settled: number }>("/api/purchases", body);
        if (!r) return;
        if (!initial) {
          const rr = r as { reward: number; payment?: Quote["payment"] };
          const bond = rr.payment && rr.payment.bond > 0 ? `（債券から ${fmt(rr.payment.bond)} を支払いました）` : "";
          toast(rr.reward > 0 ? `記録しました！ 銀貨 +${rr.reward}S${bond}` : `記録しました（今日の記録報酬は上限に達しています）${bond}`, rr.reward > 0 ? "reward" : "info");
          setF((p) => ({ ...p, amount: "", name: "", memo: "", wishItemId: "" }));
        }
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="購入金額（円）">
          <input inputMode="numeric" required value={f.amount} onChange={(e) => set("amount", digits(e.target.value))} />
        </Field>
        <Field label="購入日">
          <input type="date" required value={f.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
      </div>
      <Field label="購入内容">
        <input required maxLength={100} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="例：ランチ" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="ジャンル（任意）"
          hint={usable.length ? `使える通貨：${usable.map((c) => `${c.icon}${c.name}（${fmt(c.balance)}）`).join("・")}` : undefined}
        >
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
            {initial?.categoryId && !categories.items?.some((c) => c.id === initial.categoryId) && <option value={initial.categoryId}>{initial.category}</option>}
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
      {!initial && (wishes.items?.filter((w) => !w.purchasedAt).length ?? 0) > 0 && (
        <Field label="ほしい物の購入（任意）" hint="選ぶと像が完成し、積立済みの金貨を購入の精算に充てます。">
          <select value={f.wishItemId} onChange={(e) => set("wishItemId", e.target.value)}>
            <option value="">選ばない</option>
            {wishes.items!.filter((w) => !w.purchasedAt).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}（{yen(w.price)}）
              </option>
            ))}
          </select>
        </Field>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 w-auto" checked={f.isSubscription} onChange={(e) => set("isSubscription", e.target.checked)} />
        <span>
          サブスクの支払いとして記録する
          <span className="block text-xs text-muted">サブスク料金はすでに金鉱の採掘から差し引かれているため、金貨の精算から外します（二重計上の防止）。</span>
        </span>
      </label>
      {quote && <QuoteView q={quote} />}
      <Button type="submit" className="w-full" disabled={busy || Number(f.amount) <= 0 || !f.date || !f.name.trim()}>
        {initial ? "保存" : `購入を記録（+${REWARD_PURCHASE}S）`}
      </Button>
    </form>
  );
}

function SavingsForm({ initial, onDone, tz, estimated = 0 }: { initial?: Savings; onDone: () => void; tz: string; estimated?: number }) {
  const { act, toast, busy } = useGame();
  const [f, setF] = useState({
    kind: initial?.kind ?? ("DEPOSIT" as Savings["kind"]),
    amount: initial ? String(initial.amount) : "",
    date: initial?.date ?? todayIn(tz),
    memo: initial?.memo ?? "",
  });
  const set = (k: keyof typeof f, val: string) => setF((p) => ({ ...p, [k]: val }));
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...f, amount: Number(f.amount) };
        const r = initial ? await act(`/api/savings/${initial.id}`, body, "PATCH") : await act<{ reward: number }>("/api/savings", body);
        if (!r) return;
        if (!initial) {
          const rr = r as { reward: number; replacedEstimate?: number };
          const fix = rr.replacedEstimate ? `見込み ${fmt(rr.replacedEstimate)}円を実額に置き換えました。` : "";
          toast(rr.reward > 0 ? `記録しました！ 銀貨 +${rr.reward}S ${fix}` : `記録しました（今日の記録報酬は上限に達しています）${fix}`, rr.reward > 0 ? "reward" : "info");
          setF((p) => ({ ...p, amount: "", memo: "" }));
        }
        onDone();
      }}
    >
      <Tabs
        value={f.kind}
        onChange={(k) => set("kind", k)}
        items={[
          { value: "DEPOSIT", label: "貯金追加" },
          { value: "WITHDRAW", label: "貯金引出" },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="金額（円）">
          <input inputMode="numeric" required value={f.amount} onChange={(e) => set("amount", digits(e.target.value))} />
        </Field>
        <Field label="記録日">
          <input type="date" required value={f.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
      </div>
      <Field label="メモ（任意）">
        <input maxLength={500} value={f.memo} onChange={(e) => set("memo", e.target.value)} />
      </Field>
      {f.kind === "WITHDRAW" && <p className="text-xs text-muted">引出は目標の達成率を下げますが、解放済みの技術や建物は失われません。</p>}
      {!initial && estimated > 0 && (
        <p className="rounded-lg bg-gold-soft px-3 py-2 text-xs">
          今の見込み貯金は {yen(estimated)} です（金貨で資源を得た分）。この記録で見込みは消え、記録した実額が貯金目標に反映されます。
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || Number(f.amount) <= 0 || !f.date}>
        {initial ? "保存" : `${f.kind === "DEPOSIT" ? "貯金" : "引出"}を記録（+${REWARD_SAVINGS}S）`}
      </Button>
    </form>
  );
}

export default function RecordsPage() {
  const { view, act } = useGame();
  const v = useSeasonView();
  const [tab, setTab] = useState<Tab>("purchase");
  const purchases = useList<Purchase>("/api/purchases");
  const savings = useList<Savings>("/api/savings");
  const [editP, setEditP] = useState<Purchase | null>(null);
  const [editS, setEditS] = useState<Savings | null>(null);
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const reload = () => {
    purchases.reload();
    savings.reload();
  };

  type Row = { kind: "p"; item: Purchase } | { kind: "s"; item: Savings };
  const rows: Row[] = [
    ...(purchases.items ?? []).map((item) => ({ kind: "p" as const, item })),
    ...(savings.items ?? []).map((item) => ({ kind: "s" as const, item })),
  ].sort((a, b) => b.item.date.localeCompare(a.item.date));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">銀鉱</h1>
        <p className="mt-1 text-sm text-muted">
          現実の購入と貯金を記録すると銀貨がもらえます（購入 {REWARD_PURCHASE}S・貯金 {REWARD_SAVINGS}S、1日 {v?.silverMine.dailyCap ?? 300}S まで）。金額の大小で報酬は変わりません。
        </p>
        {v && (
          <p className="mt-1 text-xs text-muted">
            銀鉱 Lv{v.silverMine.level}（有効な記録 {v.silverMine.records}件{v.silverMine.nextLevelAt !== null && ` ・ 次のLvまで ${v.silverMine.nextLevelAt - v.silverMine.records}件`}） ・ 今日の報酬 {v.silverMine.todayRewarded}/{v.silverMine.dailyCap}S
          </p>
        )}
        {view && !v && <p className="mt-2 text-sm">進行中のシーズンがないため、記録は家計履歴にのみ残り、銀貨は付与されません。</p>}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "purchase", label: "購入を記録" },
          { value: "savings", label: "貯金を記録" },
          { value: "history", label: "記録履歴" },
        ]}
      />
      {tab === "purchase" && (
        <Card>
          <PurchaseForm tz={tz} onDone={reload} />
        </Card>
      )}
      {tab === "savings" && (
        <Card>
          <SavingsForm tz={tz} onDone={reload} estimated={v?.season.estimated ?? 0} />
        </Card>
      )}
      {tab === "history" && (
        <Card>
          {rows.length === 0 ? (
            <Empty>まだ記録がありません</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={`${r.kind}${r.item.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="num w-20 shrink-0 text-xs text-muted">{r.item.date}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {r.kind === "p" ? (
                      <>
                        {r.item.name}
                        {r.item.isSubscription && <span className="ml-1 text-xs text-muted">サブスク</span>}
                        {r.item.category && <span className="ml-1 text-xs text-muted">#{r.item.category}</span>}
                        {r.item.payments && <PaymentLine rows={r.item.payments} />}
                      </>
                    ) : r.item.kind === "DEPOSIT" ? (
                      "貯金追加"
                    ) : (
                      "貯金引出"
                    )}
                  </span>
                  <span className={`num shrink-0 font-medium ${r.kind === "s" && r.item.kind === "DEPOSIT" ? "text-dev" : ""}`}>
                    {r.kind === "s" ? (r.item.kind === "DEPOSIT" ? "+" : "−") : ""}
                    {fmt(r.item.amount)}円
                  </span>
                  <button className="text-xs underline" onClick={() => (r.kind === "p" ? setEditP(r.item) : setEditS(r.item))}>
                    編集
                  </button>
                  <button
                    className="text-xs text-danger underline"
                    onClick={async () => {
                      if (!confirm("この記録を削除しますか？（獲得した銀貨は戻りません）")) return;
                      await act(`/api/${r.kind === "p" ? "purchases" : "savings"}/${r.item.id}`, undefined, "DELETE");
                      reload();
                    }}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <Modal open={!!editP} onClose={() => setEditP(null)} title="購入記録を編集">
        {editP && <PurchaseForm key={editP.id} initial={editP} tz={tz} onDone={() => (setEditP(null), reload())} />}
      </Modal>
      <Modal open={!!editS} onClose={() => setEditS(null)} title="貯金記録を編集">
        {editS && <SavingsForm key={editS.id} initial={editS} tz={tz} onDone={() => (setEditS(null), reload())} />}
      </Modal>
    </div>
  );
}
