"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { confirmedText, sumConfirmed, type Confirmed } from "./shared";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, CustomIcon, Empty, Field, NumberInput } from "@/components/ui";
import { REWARD_PURCHASE } from "@/game/config";
import { api, ApiError, fmt, todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";
import { AccountPicker, doubleCountWarning, rewardText, useAccounts, type Account } from "./accounts";

export interface PaymentRow {
  currency: "GOLD" | "SILVER" | "BOND" | "CUSTOM" | "RESERVED";
  /** draw：同じ期間に確定した債券の取り崩し（手数料なし） */
  kind: "pay" | "fee" | "draw";
  currencyId: string | null;
  amount: number;
}

interface Category {
  id: string;
  name: string;
}

/** この支出に使える通貨と、その通貨で払える額（サーバーの SourceBalance） */
interface Source {
  currency: "GOLD" | "CUSTOM";
  currencyId: string | null;
  available: number;
  /** 金貨：available のうち、今月貯めた債券の取り崩し（手数料なし）の分 */
  draw?: number;
  /** いつもの順で最初に使うユーザ通貨（初めに選ばれている通貨） */
  first?: boolean;
}

/** 使う通貨の指定（ここに並べた通貨だけを使い、足りない分は債券。額を省くと、その通貨で払えるだけ払う） */
interface PayWith {
  currency: "GOLD" | "CUSTOM";
  currencyId: string | null;
  amount?: number;
}

interface Quote {
  settleable: boolean;
  payment: { reserved: number; custom: { currencyId: string; amount: number }[]; gold: number; bond: number; draw: number; feeSilver: number; feeBond: number };
  sources: Source[];
  after: { gold: number; uncollected: number; silver: number; bond: number } | null;
}

const NEW_CATEGORY = "__new__";

const sourceKey = (s: { currency: string; currencyId: string | null }) => s.currencyId ?? s.currency;

/** ユーザ通貨の支払い（ロットごと）を通貨ごとにまとめる */
function byCurrency(rows: { currencyId: string; amount: number }[]) {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.currencyId, (out.get(r.currencyId) ?? 0) + r.amount);
  return [...out].map(([currencyId, amount]) => ({ currencyId, amount }));
}

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
      {sum("BOND", "draw") > 0 && <span>債券の取り崩し {fmt(sum("BOND", "draw"))}（手数料なし）</span>}
      {sum("BOND", "pay") > 0 && <span className="text-danger">債券 {fmt(sum("BOND", "pay"))}</span>}
      {fee > 0 && <span>手数料 {fmt(fee)}</span>}
    </span>
  );
}

/** 記録前の支払い内訳（確定前に債券・手数料が見える） */
function QuoteView({ q }: { q: Quote }) {
  const v = useSeasonView();
  if (!q.settleable) return <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">この支出は金貨の精算対象外です（当期以外の日付・シーズン外）。</p>;
  const p = q.payment;
  const cur = (id: string) => v?.currencies.custom.find((c) => c.id === id);
  // 持ち込みの備え（この範囲のマイナスは借金として扱わない。docs/season-start-settings.md RC-07）
  const carried = v?.season.carried.reserve ?? 0;
  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${p.bond > 0 ? "bg-danger/10" : "bg-surface-2"}`}>
      <div className="mb-1 text-xs font-medium">支払いの内訳</div>
      <dl className="num grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">
        {byCurrency(p.custom).map((c) => (
          <div key={c.currencyId} className="contents">
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
              金貨（未受取→所持）
            </dt>
            <dd className="text-right">{fmt(p.gold)}G</dd>
          </>
        )}
        {p.draw > 0 && (
          <>
            <dt className="flex items-center gap-1">
              <BondIcon />
              今月貯めた債券（手数料なし）
            </dt>
            <dd className="text-right">{fmt(p.draw)}</dd>
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
          記録後の債券は <span className={`num font-semibold ${q.after.bond < -carried ? "text-danger" : ""}`}>{fmt(q.after.bond)}</span>
          {q.after.bond < -carried
            ? carried > 0
              ? `。持ち込みの備え（${fmt(carried)}）を超えるので、そこに戻るまで配当の20%以上が債券に回ります（0に戻るまで債券の利息はつきません）`
              : "。0に戻るまで配当の20%以上が債券に回ります（その間は債券の利息がつきません）"
            : q.after.bond < 0 && `。持ち込みの備え（${fmt(carried)}）から取り崩します（0に戻るまで債券の利息はつきません）`}
        </p>
      )}
    </div>
  );
}

const CHIP = "min-h-9 rounded-full border px-3 py-1 text-sm transition";

/**
 * 使う通貨（docs/bond-and-custom-currency.md §6.3）。この支出に使える通貨が2つ以上あるときに出す。
 * 使う通貨をいくつでも選ぶ（初めはユーザ通貨を1つ）。選んだ通貨だけを使い、足りない分は債券で払う。
 * 詳細設定にすると、通貨ごとに額を決められる。
 */
function PayWithField({
  sources,
  amount,
  on,
  onToggle,
  mix,
  onMix,
  amounts,
  onAmounts,
}: {
  sources: Source[];
  /** 支出の金額（未入力は 0） */
  amount: number;
  /** 使う通貨 */
  on: Source[];
  onToggle: (key: string) => void;
  mix: boolean;
  onMix: (on: boolean) => void;
  /** 詳細設定：通貨ごとの額（sourceKey → 入力） */
  amounts: Record<string, string>;
  onAmounts: (a: Record<string, string>) => void;
}) {
  const v = useSeasonView();
  const cur = (id: string | null) => v?.currencies.custom.find((c) => c.id === id);
  const name = (s: Source) => (s.currency === "GOLD" ? "金貨" : (cur(s.currencyId)?.name ?? "ユーザ通貨"));
  const sum = sources.reduce((a, s) => a + Number(amounts[sourceKey(s)] || 0), 0);
  const draw = sources.find((s) => s.currency === "GOLD")?.draw ?? 0;
  const short = amount - on.reduce((a, s) => a + s.available, 0);
  return (
    <div role="group" aria-label="使う通貨" className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">使う通貨</span>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" className="w-auto" checked={mix} onChange={(e) => onMix(e.target.checked)} />
          詳細設定：通貨ごとに額を決める
        </label>
      </div>
      {mix ? (
        <>
          <ul className="space-y-1.5">
            {sources.map((s) => {
              const key = sourceKey(s);
              const over = Number(amounts[key] || 0) > s.available;
              return (
                <li key={key}>
                  <div className="flex items-center gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1 text-sm">
                      {s.currency === "GOLD" ? <Coin kind="gold" /> : <CustomIcon icon={cur(s.currencyId)?.icon ?? "🪙"} />}
                      <span className="truncate">{name(s)}</span>
                      <span className="num shrink-0 text-xs text-muted">（{fmt(s.available)}）</span>
                    </span>
                    <NumberInput aria-label={`${name(s)}で払う額`} className="w-28" placeholder="0" value={amounts[key] ?? ""} onValueChange={(val) => onAmounts({ ...amounts, [key]: val })} />
                  </div>
                  {over && <p className="num text-right text-xs font-medium text-danger">払えるのは {fmt(s.available)} までです</p>}
                </li>
              );
            })}
          </ul>
          {sum === 0 ? (
            <p className="text-xs text-muted">通貨ごとに払う額を入れてください。入れないときは、ボタンで選んだ通貨を使います。</p>
          ) : (
            amount > 0 && (
              <p className={`num text-xs ${sum !== amount ? "font-medium text-danger" : "text-muted"}`}>
                合計 {fmt(sum)} / {fmt(amount)}円
                {sum > amount && "（支出の金額を超えています）"}
                {sum < amount && ` ・ 足りない ${fmt(amount - sum)}円は、債券で払います`}
              </p>
            )
          )}
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {sources.map((s) => {
              const key = sourceKey(s);
              const used = on.includes(s);
              return (
                <button key={key} type="button" aria-pressed={used} onClick={() => onToggle(key)} className={`${CHIP} ${used ? "border-ink bg-ink text-bg" : "border-line bg-surface-2 hover:border-ink"}`}>
                  <span className="inline-flex items-center gap-1">
                    {s.currency === "GOLD" ? <Coin kind="gold" /> : <CustomIcon icon={cur(s.currencyId)?.icon ?? "🪙"} />}
                    {name(s)}
                    <span className="num text-xs opacity-70">{fmt(s.available)}</span>
                  </span>
                </button>
              );
            })}
            {/* 債券は選ぶものではなく、足りない分を払う。足りないときに色が付く */}
            <span className={`${CHIP} inline-flex items-center gap-1 border-dashed ${short > 0 ? "border-danger bg-danger/10 font-medium text-danger" : "border-line text-muted"}`}>
              <BondIcon />
              債券
              <span className="num text-xs">{short > 0 ? `不足 ${fmt(short)}` : "不足分"}</span>
            </span>
          </div>
          <p className="text-xs text-muted">色の付いた通貨を使います（期限の近いユーザ通貨 → 金貨の順）。タップで使う・使わないを切り替えられます。足りない分は債券で払います。</p>
        </>
      )}
      {draw > 0 && <p className="num text-xs text-muted">金貨には、今月貯めた債券の取り崩し（手数料なし）{fmt(draw)} を含みます。</p>}
    </div>
  );
}

/** 普通の支出 */
function PurchaseForm({ onDone, tz, accounts, defaultId }: { onDone: () => void; tz: string; accounts: Account[]; defaultId: string | null }) {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const categories = useList<Category>("/api/categories");
  // 出どころは続けて記録するあいだ直前に選んだものを引き継ぐ。初期値はいつもの置き場所（docs/money-accounts.md RS-01）
  const [f, setF] = useState({ amount: "", date: todayIn(tz), name: "", categoryId: "", memo: "", accountId: "" });
  const accountId = f.accountId || defaultId || "";
  const warning = doubleCountWarning(f.name);
  const [adding, setAdding] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  // 使う通貨：この支出に使える通貨（プレビューで取り直す）、使わない通貨、詳細設定の通貨ごとの額
  const [sources, setSources] = useState<Source[]>([]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [mix, setMix] = useState(false);
  const [mixAmounts, setMixAmounts] = useState<Record<string, string>>({});
  const set = (k: keyof typeof f, val: string) => setF((p) => ({ ...p, [k]: val }));
  const usable = f.categoryId ? (v?.currencies.custom ?? []).filter((c) => c.categoryIds.includes(f.categoryId)) : [];
  const amount = Number(f.amount);

  const resetPay = () => {
    setChosen(null);
    setMix(false);
    setMixAmounts({});
  };
  // ジャンルを変えると使える通貨が変わるので、選び直す
  const setCategory = (id: string) => {
    set("categoryId", id);
    setSources([]);
    resetPay();
  };

  // 使える通貨が1つだけなら選ぶものがない
  const choosable = sources.length >= 2;
  const mixRows = sources.map((s) => ({ ...s, use: Number(mixAmounts[sourceKey(s)] || 0) }));
  const mixInvalid = choosable && mix && (mixRows.some((r) => r.use > r.available) || mixRows.reduce((a, r) => a + r.use, 0) > amount);
  // 初めは、いつもの順で最初に使うユーザ通貨を1つだけ選んだ状態にする
  const initial = sources.find((s) => s.first) ?? sources[0];
  const kept = chosen ? sources.filter((s) => chosen.includes(sourceKey(s))) : [];
  const on = kept.length ? kept : initial ? [initial] : [];
  const picked = mixRows.filter((r) => r.use > 0);
  const payWith: PayWith[] | undefined = !choosable
    ? undefined
    : mix && picked.length
      ? picked.map((r) => ({ currency: r.currency, currencyId: r.currencyId, amount: r.use }))
      : on.map((s) => ({ currency: s.currency, currencyId: s.currencyId }));
  // 最後の1つは外せない（全部を債券で払うことになるため）
  const toggle = (key: string) => {
    const keys = on.map(sourceKey);
    if (!keys.includes(key)) setChosen([...keys, key]);
    else if (keys.length > 1) setChosen(keys.filter((k) => k !== key));
  };
  // 併用の額が残高や支出の金額を超えている間は、内訳を取り直さない
  const payKey = mixInvalid ? null : JSON.stringify(payWith ?? null);

  useEffect(() => {
    if (!v || !f.date) {
      setQuote(null);
      setSources([]);
      return;
    }
    if (payKey === null) {
      setQuote(null);
      return;
    }
    let stale = false;
    const t = setTimeout(async () => {
      const chosen = JSON.parse(payKey) as PayWith[] | null;
      try {
        const q = await api<Quote>("/api/purchases/quote", { body: { amount: Number(f.amount) || 0, date: f.date, categoryId: f.categoryId || undefined, payWith: chosen ?? undefined } });
        if (stale) return;
        // 金額がまだなければ、使える通貨だけを受け取る（内訳は出さない）
        setQuote(Number(f.amount) > 0 ? q : null);
        setSources(q.sources);
      } catch (e) {
        if (stale) return;
        setQuote(null);
        // 選んだ通貨が使えなくなっていたら（残高がなくなったなど）、初めの選択に戻して使える通貨を取り直す
        if (chosen && e instanceof ApiError && e.status >= 400 && e.status < 500) {
          setChosen(null);
          setMix(false);
          setMixAmounts({});
        }
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [v, f.amount, f.date, f.categoryId, payKey]);

  // 詳細設定に切り替えたときは、今の内訳（選んだ通貨での払い方）を通貨ごとの額の出発点にする
  const toggleMix = (on: boolean) => {
    if (on && quote?.settleable) {
      const p = quote.payment;
      setMixAmounts({
        ...Object.fromEntries(byCurrency(p.custom).map((c) => [c.currencyId, String(c.amount)])),
        ...(p.gold + p.draw > 0 ? { GOLD: String(p.gold + p.draw) } : {}),
      });
    }
    setMix(on);
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    const r = await act<{ id: string }>("/api/categories", { name });
    if (!r) return;
    await categories.reload();
    setNewCategory("");
    setAdding(false);
    setCategory(r.id);
  };

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await act<{ reward: number; paymentReward: number; payment?: Quote["payment"]; confirmed?: Confirmed | null }>("/api/purchases", {
          ...f,
          amount: Number(f.amount),
          categoryId: f.categoryId || null,
          accountId: accountId || null,
          payWith,
        });
        if (!r) return;
        // 債券の肩代わり（docs/savings-driven-growth.md RSV-05）。同じ期間に確定した分の取り崩しは手数料なし
        const draw = r.payment?.draw ?? 0;
        const bond =
          r.payment && r.payment.bond > 0
            ? `（債券から ${fmt(r.payment.bond + draw)} を支払いました。債券のおかげで、街の工事は止まりませんでした）`
            : draw > 0
              ? `（今月貯めた債券から ${fmt(draw)} を取り崩しました。手数料はかかりません）`
              : "";
        const done = confirmedText(r.confirmed);
        const got = rewardText(r.reward, r.paymentReward);
        toast(got ? `記録しました！ ${got}${done}${bond}` : `記録しました（今日の記録報酬は上限に達しています）${done}${bond}`, got ? "reward" : "info");
        setF((p) => ({ ...p, amount: "", name: "", memo: "" }));
        resetPay();
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="金額（円）">
          <NumberInput required value={f.amount} onValueChange={(v) => set("amount", v)} />
        </Field>
        <Field label="日付">
          <input type="date" required value={f.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
      </div>
      <Field label="内容">
        <input required maxLength={100} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="例：ランチ" />
      </Field>
      {warning && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs">{warning}</p>}
      {accounts.length > 1 && <AccountPicker label="出どころ" accounts={accounts} value={accountId} defaultId={defaultId} onChange={(id) => set("accountId", id)} reward={!!v} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="ジャンル（任意）" hint={usable.length ? `使える通貨：${usable.map((c) => `${c.icon}${c.name}（${fmt(c.balance + c.pending)}）`).join("・")}` : undefined}>
          <select
            value={adding ? NEW_CATEGORY : f.categoryId}
            onChange={(e) => {
              setAdding(e.target.value === NEW_CATEGORY);
              if (e.target.value !== NEW_CATEGORY) setCategory(e.target.value);
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
      {choosable && <PayWithField sources={sources} amount={amount} on={on} onToggle={toggle} mix={mix} onMix={toggleMix} amounts={mixAmounts} onAmounts={setMixAmounts} />}
      {quote && <QuoteView q={quote} />}
      <p className="text-xs text-muted">
        登録したあとは金額だけ変更できます（減額は＋差分、増額は−差分として解消します）。出どころはあとからでも変えられます。カードでも現金でも、使った日に記録してください。
      </p>
      <Button type="submit" className="w-full" disabled={busy || Number(f.amount) <= 0 || !f.date || !f.name.trim() || mixInvalid}>
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
  accountId: string | null;
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
function BaseRows({ onDone, tz, accounts, defaultId }: { onDone: () => void; tz: string; accounts: Account[]; defaultId: string | null }) {
  const { act, toast, busy } = useGame();
  const [base, setBase] = useState<{ subscriptions: SubRow[]; wishes: WishRow[] } | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // 行ごとの出どころ。サブスクは登録した出どころが初期値（RS-03）。空はいつもの置き場所
  const [pays, setPays] = useState<Record<string, string>>({});
  const [openPay, setOpenPay] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ subscriptions: SubRow[]; wishes: WishRow[] }>("/api/purchases/base");
    setBase(r);
    setAmounts((prev) => ({
      ...Object.fromEntries(r.subscriptions.map((s) => [`s:${s.subscriptionId}:${s.periodKey}`, String(s.amount)])),
      ...Object.fromEntries(r.wishes.map((w) => [`w:${w.id}`, String(w.price)])),
      ...prev,
    }));
    setPays((prev) => ({ ...Object.fromEntries(r.subscriptions.map((s) => [`s:${s.subscriptionId}:${s.periodKey}`, s.accountId ?? ""])), ...prev }));
  }, []);
  useEffect(() => {
    load().catch(() => setBase({ subscriptions: [], wishes: [] }));
  }, [load]);
  if (!base) return <p className="text-sm text-muted">読み込み中…</p>;
  const payOf = (key: string) => pays[key] || defaultId;
  const subBody = (s: SubRow) => {
    const key = `s:${s.subscriptionId}:${s.periodKey}`;
    return { subscriptionId: s.subscriptionId, periodKey: s.periodKey, date: s.date, amount: Number(amounts[key] || 0), accountId: payOf(key) };
  };
  const wishBody = (w: WishRow) => ({ wishItemId: w.id, date: todayIn(tz), amount: Number(amounts[`w:${w.id}`] || 0), accountId: payOf(`w:${w.id}`) });
  const finish = async (n: number, reward: number, paymentReward: number, confirmed?: Confirmed | null) => {
    const done = confirmedText(confirmed);
    const got = rewardText(reward, paymentReward);
    toast(got ? `${n}件記録しました！ ${got}${done}` : `${n}件記録しました${done}`, got ? "reward" : "info");
    await load();
    onDone();
  };
  const all = [...base.subscriptions.map(subBody), ...base.wishes.map(wishBody)];
  if (!all.length) return <Empty>未記録のサブスクの支払い・全額貯まったほしい物はありません</Empty>;
  const row = (key: string, label: ReactNode, sub: ReactNode, baseAmount: number, body: () => Record<string, unknown>) => {
    const amount = Number(amounts[key] || 0);
    const method = accounts.find((m) => m.id === payOf(key));
    return (
      <li key={key} className="rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-28 flex-1">
            <div className="text-sm font-medium">{label}</div>
            <div className="num text-xs text-muted">{sub}</div>
          </div>
          <NumberInput aria-label="金額（円）" className="w-28" value={amounts[key] ?? ""} onValueChange={(v) => setAmounts((a) => ({ ...a, [key]: v }))} />
          <span className="text-sm">円</span>
          <Button
            disabled={busy || amounts[key] === "" || amount <= 0}
            onClick={async () => {
              const r = await act<{ reward: number; paymentReward: number; confirmed?: Confirmed | null }>("/api/purchases", body());
              if (r) await finish(1, r.reward, r.paymentReward, r.confirmed);
            }}
          >
            保存
          </Button>
        </div>
        <DiffNote base={baseAmount} amount={amount} />
        {accounts.length > 1 && (
          <div className="mt-1 text-xs">
            <button type="button" className="text-muted underline" aria-expanded={openPay === key} onClick={() => setOpenPay(openPay === key ? null : key)}>
              出どころ：{method?.name ?? "いつもの置き場所"}
            </button>
            {openPay === key && (
              <div className="mt-1.5">
                <AccountPicker label="出どころ" accounts={accounts} value={payOf(key) ?? ""} defaultId={defaultId} onChange={(id) => setPays((p) => ({ ...p, [key]: id }))} reward />
              </div>
            )}
          </div>
        )}
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
            const r = await act<{ items: { reward: number; paymentReward: number; confirmed?: Confirmed | null }[] }>("/api/purchases", { items: all });
            if (r)
              await finish(
                r.items.length,
                r.items.reduce((a, x) => a + x.reward, 0),
                r.items.reduce((a, x) => a + x.paymentReward, 0),
                sumConfirmed(r.items.map((x) => x.confirmed)),
              );
          }}
        >
          一括保存（{all.length}件）
        </Button>
      )}
      <p className="text-xs text-muted">
        サブスクの登録額はすでに配当から差し引かれているので精算しません。登録額・価格より安ければ＋差分（債券 → おまかせ交換）、高ければ−差分（債券から）として解消します。ほしい物は積立が全額貯まったものだけが並び、積立金貨から価格を精算します。
      </p>
    </div>
  );
}

export function ExpenseTab({ onDone, tz, reloadKey }: { onDone: () => void; tz: string; reloadKey: number }) {
  const v = useSeasonView();
  const { data, active } = useAccounts(reloadKey);
  // 置き場所が1つ（財布Aだけ）のときは選ぶ欄を出さない（RS-06）。クレカも支出の出どころに選べる
  const defaultId = data?.defaults.spend ?? null;
  return (
    <div className="space-y-4">
      {v && (
        <Card title="サブスク・ほしい物">
          <BaseRows onDone={onDone} tz={tz} accounts={active} defaultId={defaultId} />
        </Card>
      )}
      <Card title="普通の支出">
        <PurchaseForm tz={tz} onDone={onDone} accounts={active} defaultId={defaultId} />
      </Card>
      <p className="text-xs text-muted">カードの引き落とし・チャージ・ATM・自分の口座への送金は支出ではなく、「お金の管理」の振替で記録します（お金の置き場所が変わるだけです）。</p>
    </div>
  );
}
