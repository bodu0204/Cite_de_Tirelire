"use client";

import { useCallback, useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal, Tabs } from "@/components/ui";
import { REWARD_SAVINGS } from "@/game/config";
import { api, fmt, todayIn, yen } from "@/lib/api";
import { digits } from "./shared";

interface Savings {
  id: string;
  kind: "DEPOSIT" | "WITHDRAW";
  amount: number;
  date: string;
  memo: string | null;
}

function SavingsForm({ initial, onDone, tz, disabled }: { initial?: Savings; onDone: () => void; tz: string; disabled?: boolean }) {
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
          { value: "DEPOSIT", label: "別口座へ移した（追加）" },
          { value: "WITHDRAW", label: "手元へ戻した（引出）" },
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
      <Button type="submit" className="w-full" disabled={busy || disabled || Number(f.amount) <= 0 || !f.date}>
        {initial ? "保存" : `記録（+${REWARD_SAVINGS}S）`}
      </Button>
    </form>
  );
}

/** 貯金管理：手元の財布と別口座の間の出し入れ（docs/record-input-redesign.md §7.2）。判定には使わず、手元のお金の推測に使う */
export function SavingsTab({ tz }: { tz: string }) {
  const { act } = useGame();
  const v = useSeasonView();
  const [data, setData] = useState<{ items: Savings[]; today: number; limit: number } | null>(null);
  const [edit, setEdit] = useState<Savings | null>(null);
  const load = useCallback(async () => setData(await api("/api/savings")), []);
  useEffect(() => {
    load().catch(() => setData({ items: [], today: 0, limit: 3 }));
  }, [load]);
  const left = data ? Math.max(0, data.limit - data.today) : 0;
  return (
    <div className="space-y-4">
      <Card title="貯金管理">
        <p className="mb-3 text-xs text-muted">
          現実の貯金を別口座へ移したり、手元へ戻したりしたときに記録します。技術Lv・銀行Lv・目標達成は貯金額（債券 ＋ 都市に使った金貨）で決まるので、この記録では変わりません。手元のお金の推測に使えます。
        </p>
        {v && (
          <dl className="num mb-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <dt className="text-muted">貯金額</dt>
              <dd className="text-sm font-medium">{yen(v.season.savings)}</dd>
            </div>
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <dt className="text-muted">うち債券</dt>
              <dd className="text-sm font-medium">{yen(v.season.bond)}</dd>
            </div>
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <dt className="text-muted">貯金管理の増減</dt>
              <dd className="text-sm font-medium">{yen(v.season.managed)}</dd>
            </div>
          </dl>
        )}
        <p className={`mb-2 text-sm ${left === 0 ? "font-medium text-danger" : ""}`}>{data ? (left > 0 ? `今日はあと${left}回登録できます` : `今日の登録は上限（${data.limit}回）に達しました`) : ""}</p>
        <SavingsForm tz={tz} disabled={left === 0} onDone={load} />
      </Card>
      <Card title="貯金管理の履歴">
        {!data?.items.length ? (
          <Empty>まだ記録がありません</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="num w-20 shrink-0 text-xs text-muted">{s.date}</span>
                <span className="flex-1">{s.kind === "DEPOSIT" ? "別口座へ移した" : "手元へ戻した"}</span>
                <span className="num font-medium">
                  {s.kind === "DEPOSIT" ? "+" : "−"}
                  {fmt(s.amount)}円
                </span>
                <button className="text-xs underline" onClick={() => setEdit(s)}>
                  編集
                </button>
                <button
                  className="text-xs text-danger underline"
                  onClick={async () => {
                    if (!confirm("この記録を削除しますか？（登録回数は戻りません）")) return;
                    await act(`/api/savings/${s.id}`, undefined, "DELETE");
                    load();
                  }}
                >
                  削除
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="貯金管理の記録を編集">
        {edit && <SavingsForm key={edit.id} initial={edit} tz={tz} onDone={() => (setEdit(null), load())} />}
      </Modal>
    </div>
  );
}
