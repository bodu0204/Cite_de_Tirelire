"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal, Tabs } from "@/components/ui";
import { REWARD_PURCHASE, REWARD_SAVINGS } from "@/game/config";
import { fmt, todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface Purchase {
  id: string;
  amount: number;
  date: string;
  name: string;
  category: string | null;
  memo: string | null;
  isSubscription: boolean;
  wishItemId: string | null;
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
  const wishes = useList<Wish>("/api/wishes");
  const [f, setF] = useState({
    amount: initial ? String(initial.amount) : "",
    date: initial?.date ?? todayIn(tz),
    name: initial?.name ?? "",
    category: initial?.category ?? "",
    memo: initial?.memo ?? "",
    isSubscription: initial?.isSubscription ?? false,
    wishItemId: "",
  });
  const set = (k: keyof typeof f, val: string | boolean) => setF((p) => ({ ...p, [k]: val }));

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...f, amount: Number(f.amount), wishItemId: f.wishItemId || undefined };
        const r = initial
          ? await act(`/api/purchases/${initial.id}`, body, "PATCH")
          : await act<{ reward: number; settled: number }>("/api/purchases", body);
        if (!r) return;
        if (!initial) {
          const rr = r as { reward: number };
          toast(rr.reward > 0 ? `記録しました！ 銀貨 +${rr.reward}S` : "記録しました（今日の記録報酬は上限に達しています）", rr.reward > 0 ? "reward" : "info");
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
        <Field label="カテゴリ（任意）">
          <input maxLength={50} value={f.category} onChange={(e) => set("category", e.target.value)} placeholder="食費" />
        </Field>
        <Field label="メモ（任意）">
          <input maxLength={500} value={f.memo} onChange={(e) => set("memo", e.target.value)} />
        </Field>
      </div>
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
      <Button type="submit" className="w-full" disabled={busy}>
        {initial ? "保存" : `購入を記録（+${REWARD_PURCHASE}S）`}
      </Button>
    </form>
  );
}

function SavingsForm({ initial, onDone, tz }: { initial?: Savings; onDone: () => void; tz: string }) {
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
          const rr = r as { reward: number };
          toast(rr.reward > 0 ? `記録しました！ 銀貨 +${rr.reward}S` : "記録しました（今日の記録報酬は上限に達しています）", rr.reward > 0 ? "reward" : "info");
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
      <Button type="submit" className="w-full" disabled={busy}>
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
          <SavingsForm tz={tz} onDone={reload} />
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
