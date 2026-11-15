"use client";

// お金の管理（docs/money-accounts.md）：置き場所と残高、クレカの引き落とし予定、振替、予算外の入出金、残高を合わせる（照合）
import { useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, NumberInput } from "@/components/ui";
import { REWARD_EXTRA } from "@/game/config";
import { api, todayIn, yen } from "@/lib/api";
import { balanceText, KIND_LABELS, useAccounts, type Account, type AccountsData } from "./accounts";
import { confirmedText, ResolutionPreview, type Confirmed, type Resolution } from "./shared";

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${yen(Math.abs(n))}`;

/** 置き場所と残高（AC-08） */
function Balances({ data }: { data: AccountsData }) {
  const v = useSeasonView();
  const live = data.items.filter((a) => !a.archivedAt);
  const onlyWallet = live.length === 1 && live[0].openingBalance === 0;
  return (
    <Card
      title="置き場所と残高"
      action={
        <a href="/settings#accounts" className="text-xs underline">
          置き場所を登録・編集
        </a>
      }
    >
      {onlyWallet && (
        <p className="mb-3 rounded-lg bg-gold-soft px-3 py-2 text-sm">
          口座・クレカ・電子マネーと今の残高を登録すると、どこにいくらあるかがわかります（設定の「お金の置き場所」）。
        </p>
      )}
      <ul className="divide-y divide-line">
        {live.map((a) => (
          <li key={a.id} className="flex items-baseline gap-2 py-2 text-sm">
            <span className="min-w-0 flex-1">
              {a.name}
              <span className="ml-1 text-xs text-muted">
                {KIND_LABELS[a.kind]}
                {a.isSavings && "・貯金用"}
                {a.id === data.defaults.spend && "・いつもの置き場所"}
                {a.id === data.defaults.income && "・いつもの入金先"}
              </span>
            </span>
            <span className={`num font-medium ${a.balance < 0 ? "text-danger" : ""}`}>{balanceText(a)}</span>
          </li>
        ))}
      </ul>
      <div className="num mt-2 flex items-baseline justify-between border-t border-line pt-2 text-sm">
        <span className="text-muted">合計（クレカの未払いを引いた額）</span>
        <span className="font-pixel text-lg">{yen(data.total)}</span>
      </div>
      {v && <p className="num mt-1 text-xs text-muted">このシーズンの貯金管理の増減（貯金用の置き場所への振替）：{signed(v.season.managed)}</p>}
    </Card>
  );
}

/** クレカの引き落とし予定（§7）：金額を確かめて確定すると振替になる */
function Bills({ data, onDone }: { data: AccountsData; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  if (!data.bills.length) return null;
  const name = (id: string | null) => data.items.find((a) => a.id === id)?.name ?? "口座";
  return (
    <Card title="クレカの引き落とし予定">
      <ul className="space-y-2">
        {data.bills.map((b) => {
          const value = amounts[b.id] ?? String(b.amount);
          return (
            <li key={b.id} className="rounded-lg border border-line p-3">
              <div className="mb-2 text-sm">
                <span className="num">
                  {Number(b.dueDate.slice(5, 7))}/{Number(b.dueDate.slice(8))}
                </span>{" "}
                {b.cardName}の引き落とし
                <span className="ml-1 text-xs text-muted">
                  {name(b.debitAccountId)} → {b.cardName}（記録から計算 {yen(b.amount)}）
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <NumberInput aria-label={`${b.cardName}の請求額（円）`} className="w-32" value={value} onValueChange={(x) => setAmounts((p) => ({ ...p, [b.id]: x }))} />
                <span className="text-sm">円</span>
                <Button
                  disabled={busy || Number(value) <= 0}
                  onClick={async () => {
                    const r = await act<{ reward: number }>(`/api/card-bills/${b.id}/confirm`, { amount: Number(value) });
                    if (!r) return;
                    toast(r.reward > 0 ? `引き落としを記録しました！ 銀貨 +${r.reward}S` : "引き落としを記録しました", r.reward > 0 ? "reward" : "info");
                    onDone();
                  }}
                >
                  確定（+{REWARD_EXTRA}S）
                </Button>
                <button
                  className="text-xs text-muted underline"
                  onClick={async () => {
                    if (!confirm("この引き落とし予定を消しますか？（同じ日の予定はもう作られません。引き落としは振替として記録できます）")) return;
                    if (await act(`/api/card-bills/${b.id}/dismiss`)) onDone();
                  }}
                >
                  予定を消す
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-muted">カード会社の請求額と違うとき（年会費・分割・記録していない利用）は、金額を直してから確定してください。</p>
    </Card>
  );
}

/** 振替（§6）：置き場所どうしのお金の移動。ゲームの通貨は動かない */
function TransferForm({ data, tz, onDone }: { data: AccountsData; tz: string; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const live = data.items.filter((a) => !a.archivedAt);
  const [f, setF] = useState({ from: "", to: "", amount: "", date: todayIn(tz), memo: "" });
  const nameOf = (id: string) => live.find((a) => a.id === id)?.name ?? "";
  const savingOf = (id: string) => live.find((a) => a.id === id)?.isSavings ?? false;
  const note = f.from && f.to ? (savingOf(f.to) && !savingOf(f.from) ? "貯金の追加として数えます" : savingOf(f.from) && !savingOf(f.to) ? "貯金の引出として数えます" : null) : null;
  if (live.length < 2) return null;
  const options = (exclude: string) =>
    live
      .filter((a) => a.id !== exclude)
      .map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}（{KIND_LABELS[a.kind]}）
        </option>
      ));
  return (
    <Card title="振替">
      <p className="mb-3 text-xs text-muted">
        ATM で下ろした・チャージした・カードの引き落とし・自分の口座へ送金した・貯金した、を記録します。お金は増えも減りもしないので、ゲームの通貨は動きません。
      </p>
      {data.pairs.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {data.pairs.map((p) => (
            <button
              key={`${p.fromAccountId}>${p.toAccountId}`}
              type="button"
              className="min-h-9 rounded-full border border-line bg-surface-2 px-3 py-1 text-sm hover:border-ink"
              onClick={() => setF((x) => ({ ...x, from: p.fromAccountId, to: p.toAccountId }))}
            >
              {nameOf(p.fromAccountId)} → {nameOf(p.toAccountId)}
            </button>
          ))}
        </div>
      )}
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act<{ reward: number; confirmed?: Confirmed | null }>("/api/transfers", {
            fromAccountId: f.from,
            toAccountId: f.to,
            amount: Number(f.amount),
            date: f.date,
            memo: f.memo,
          });
          if (!r) return;
          toast(
            r.reward > 0 ? `振替を記録しました！ 銀貨 +${r.reward}S${confirmedText(r.confirmed)}` : `振替を記録しました${confirmedText(r.confirmed)}`,
            r.reward > 0 ? "reward" : "info",
          );
          setF((x) => ({ ...x, amount: "", memo: "" }));
          onDone();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="出元">
            <select required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })}>
              <option value="">選ぶ</option>
              {options(f.to)}
            </select>
          </Field>
          <Field label="入れ先">
            <select required value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
              <option value="">選ぶ</option>
              {options(f.from)}
            </select>
          </Field>
          <Field label="金額（円）">
            <NumberInput required value={f.amount} onValueChange={(x) => setF({ ...f, amount: x })} />
          </Field>
          <Field label="日付">
            <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
        </div>
        <Field label="メモ（任意）">
          <input maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} placeholder="例：ATM" />
        </Field>
        {note && <p className="text-xs font-medium">{note}</p>}
        <p className="text-xs text-muted">ATM・送金の手数料は、振替ではなく支出として記録してください（出どころはその口座）。</p>
        <Button type="submit" className="w-full" disabled={busy || !f.from || !f.to || Number(f.amount) <= 0}>
          振替を記録（+{REWARD_EXTRA}S）
        </Button>
        <p className="text-xs text-muted">
          振替と出どころの記入の報酬は、記録の報酬とは別に1日 {data.reward.dailyCap}S まで（今日はあと {data.reward.remaining}S）。
        </p>
      </form>
    </Card>
  );
}

/** 予算外の入出金：家賃・固定費の引き落とし、給料のうち自由予算でない分など。残高だけを動かし、ゲームには使わない */
function OutsideForm({ data, tz, onDone }: { data: AccountsData; tz: string; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const live = data.items.filter((a) => !a.archivedAt);
  const [f, setF] = useState({ accountId: "", direction: "out", amount: "", date: todayIn(tz), name: "" });
  const accountId = f.accountId || data.defaults.income || "";
  return (
    <Card title="予算外の入出金">
      <p className="mb-3 text-xs text-muted">
        自由予算の外のお金（家賃・固定費の引き落とし、給料のうち自由予算でない分など）を記録します。置き場所の残高だけが動き、ゲームの通貨・報酬はありません。記録しないと、残高を合わせるときに誤差として債券に入ってしまいます。
      </p>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await act("/api/outside", { ...f, accountId, amount: Number(f.amount) });
          if (!r) return;
          toast("予算外の入出金を記録しました");
          setF((x) => ({ ...x, amount: "", name: "" }));
          onDone();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="置き場所">
            <select required value={accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
              {live.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="入金・出金">
            <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
              <option value="out">出金</option>
              <option value="in">入金</option>
            </select>
          </Field>
          <Field label="金額（円）">
            <NumberInput required value={f.amount} onValueChange={(x) => setF({ ...f, amount: x })} />
          </Field>
          <Field label="日付">
            <input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
        </div>
        <Field label="内容">
          <input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="例：家賃・給料（自由予算以外）" />
        </Field>
        <Button type="submit" variant="secondary" className="w-full" disabled={busy || !accountId || Number(f.amount) <= 0 || !f.name.trim()}>
          予算外の入出金を記録
        </Button>
      </form>
    </Card>
  );
}

interface ReconcileQuote {
  rows: { accountId: string; name: string; kind: Account["kind"]; computed: number; actual: number; diff: number }[];
  total: number;
  partial: boolean;
  pendingBills: number;
  resolution: Resolution | null;
}

/** 残高を合わせる（照合。§9）：置き場所ごとに実際の残高を入れ、誤差の合計だけを差分の解消ルールで解消する */
function Reconcile({ data, onDone }: { data: AccountsData; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const live = data.items.filter((a) => !a.archivedAt);
  const [actual, setActual] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<ReconcileQuote | null>(null);
  const entered = live.filter((a) => (actual[a.id] ?? "") !== "" && actual[a.id] !== "-");
  const body = { accounts: entered.map((a) => ({ accountId: a.id, actual: Number(actual[a.id]) })) };
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!entered.length) {
      setQuote(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setQuote(await api<ReconcileQuote>("/api/adjustments/quote", { body: JSON.parse(key) }));
      } catch {
        setQuote(null);
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const diffOf = (id: string) => quote?.rows.find((r) => r.accountId === id)?.diff ?? null;
  const anyDiff = quote?.rows.some((r) => r.diff !== 0) ?? false;
  return (
    <Card title="残高を合わせる">
      <p className="mb-3 text-xs text-muted">
        財布の中身・口座のアプリ・カード会社の画面で確かめた、実際の残高を入れてください（クレカは今の未払い）。置き場所どうしのずれ（振替の記録し忘れ）はゲームに影響せず、誤差の合計（収入・支出の記録漏れ）だけが債券で解消されます。報酬はありません。
      </p>
      {data.bills.length > 0 && (
        <p className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs">確定していない引き落とし予定があります。先に確定してから合わせると、口座とクレカの残高が合います。</p>
      )}
      <ul className="space-y-2">
        {live.map((a) => {
          const d = diffOf(a.id);
          return (
            <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 text-sm">
              <span>
                {a.name}
                <span className="num ml-1 text-xs text-muted">
                  計算 {balanceText(a)}
                  {a.lastReconciled && `・最後に合わせた日 ${a.lastReconciled}`}
                </span>
              </span>
              <NumberInput
                aria-label={`${a.name}の実際の${a.kind === "CARD" ? "未払い" : "残高"}（円）`}
                className="w-32"
                allowNegative={a.kind !== "CARD"}
                placeholder={a.kind === "CARD" ? "未払い" : "実際の残高"}
                value={actual[a.id] ?? ""}
                onValueChange={(x) => setActual((p) => ({ ...p, [a.id]: x }))}
              />
              {d !== null && d !== 0 && <span className={`num col-span-2 text-right text-xs ${d > 0 ? "text-dev" : "text-danger"}`}>誤差 {signed(d)}</span>}
            </li>
          );
        })}
      </ul>
      {quote && (
        <div className="mt-3 space-y-2 border-t border-line pt-2">
          <p className={`num text-sm font-medium ${quote.total > 0 ? "text-dev" : quote.total < 0 ? "text-danger" : ""}`}>
            誤差の合計 {quote.total === 0 ? "なし" : signed(quote.total)}
          </p>
          {quote.total === 0 && anyDiff && <p className="text-xs text-muted">置き場所どうしのずれだけです。振替の記録し忘れかもしれません（ゲームには影響しません）。</p>}
          {quote.partial && <p className="text-xs text-muted">一部の置き場所だけで合わせています。振替の記録し忘れがあると、誤差の合計に入ることがあります。</p>}
          {quote.resolution && <ResolutionPreview r={quote.resolution} title={quote.total > 0 ? "＋誤差の解消（債券 → おまかせ交換）" : "−誤差の解消（債券から・手数料あり）"} />}
        </div>
      )}
      <Button
        className="mt-3 w-full"
        disabled={busy || !quote || !anyDiff}
        onClick={async () => {
          if (!quote) return;
          if (
            !confirm(`入れた置き場所の残高を実際に合わせます${quote.total !== 0 ? `（誤差の合計 ${signed(quote.total)} を解消）` : ""}。あとから編集できません。よろしいですか？`)
          )
            return;
          const r = await act<{ total: number; confirmed?: Confirmed | null }>("/api/adjustments", body);
          if (!r) return;
          toast(`残高を合わせました${r.total !== 0 ? `（誤差の合計 ${signed(r.total)} を解消）` : ""}${confirmedText(r.confirmed)}`);
          setActual({});
          onDone();
        }}
      >
        残高を合わせる
      </Button>
    </Card>
  );
}

export function MoneyTab({ tz, reloadKey, onDone }: { tz: string; reloadKey: number; onDone: () => void }) {
  const { data, reload } = useAccounts(reloadKey);
  if (!data) return <Card>読み込み中…</Card>;
  const done = () => {
    reload();
    onDone();
  };
  return (
    <div className="space-y-4">
      <Balances data={data} />
      <Bills data={data} onDone={done} />
      <TransferForm data={data} tz={tz} onDone={done} />
      <OutsideForm data={data} tz={tz} onDone={done} />
      <Reconcile key={reloadKey} data={data} onDone={done} />
      {data.items.filter((a) => !a.archivedAt).length < 2 && <Empty>置き場所が2つ以上になると、振替を記録できます</Empty>}
    </div>
  );
}
