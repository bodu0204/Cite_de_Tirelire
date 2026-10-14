"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal } from "@/components/ui";
import { parkSize } from "@/game/city/actions";
import { todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface Sub {
  id: string;
  name: string;
  amount: number;
  cycle: "MONTHLY" | "YEARLY";
  startDate: string;
  endDate: string | null;
  memo: string | null;
}

const monthly = (s: Pick<Sub, "amount" | "cycle">) => (s.cycle === "YEARLY" ? Math.round(s.amount / 12) : s.amount);
const SIZE = ["小さな広場", "公園", "大きな公園", "噴水のある庭園"];

function SubForm({ initial, onDone, tz }: { initial?: Sub; onDone: () => void; tz: string }) {
  const { act, busy } = useGame();
  const [f, setF] = useState({
    name: initial?.name ?? "",
    amount: initial ? String(initial.amount) : "",
    cycle: initial?.cycle ?? ("MONTHLY" as Sub["cycle"]),
    startDate: initial?.startDate ?? todayIn(tz),
    endDate: initial?.endDate ?? "",
    memo: initial?.memo ?? "",
  });
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...f, amount: Number(f.amount), endDate: f.endDate || null };
        const r = initial ? await act(`/api/subscriptions/${initial.id}`, body, "PATCH") : await act("/api/subscriptions", body);
        if (r) {
          if (!initial) setF({ ...f, name: "", amount: "", memo: "" });
          onDone();
        }
      }}
    >
      <Field label="サービス名">
        <input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="金額（円）">
          <input inputMode="numeric" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="支払い周期" hint={f.cycle === "YEARLY" && f.amount ? `月額換算 ${yen(Math.round(Number(f.amount) / 12))}` : undefined}>
          <select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value as Sub["cycle"] })}>
            <option value="MONTHLY">月額</option>
            <option value="YEARLY">年額</option>
          </select>
        </Field>
        <Field label="契約開始日">
          <input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label="解約日（任意）">
          <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
      </div>
      <Field label="メモ（任意）">
        <input maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      </Field>
      <Button type="submit" className="w-full" disabled={busy}>
        {initial ? "保存" : "サブスクを登録"}
      </Button>
    </form>
  );
}

export default function SubscriptionsPage() {
  const { view, act } = useGame();
  const v = useSeasonView();
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const { items, reload } = useList<Sub>("/api/subscriptions");
  const [edit, setEdit] = useState<Sub | null>(null);
  const today = todayIn(tz);
  const active = (s: Sub) => s.startDate <= today && (!s.endDate || s.endDate > today);
  const total = (items ?? []).filter(active).reduce((a, s) => a + monthly(s), 0);
  const budget = view?.user.monthlyBudget ?? 0;
  const parks = v?.city.buildings.filter((b) => b.special === "park") ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">サブスク</h1>
        <p className="mt-1 text-sm text-muted">契約中のサブスクは街の公園になり、周りの幸福度を少し上げます。月額は金鉱の採掘量から差し引かれます。</p>
      </div>
      <Card>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">月額換算の合計</span>
          <span className="num font-pixel text-2xl">{yen(total)}</span>
        </div>
        {budget > 0 && (
          <p className="mt-1 text-xs text-muted">
            金鉱の採掘は月 {yen(Math.max(0, budget - total))}（自由予算 {yen(budget)} − サブスク）。サブスクがなければ月 {yen(total)} 分多く金貨を採掘できます。
          </p>
        )}
      </Card>
      <Card title="契約一覧">
        {!items?.length ? (
          <Empty>登録されたサブスクはありません</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((s) => {
              const park = parks.find((p) => p.refId === s.id);
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 font-medium">
                    {s.name}
                    {!active(s) && <span className="ml-2 text-xs text-muted">{s.startDate > today ? "開始前" : "解約済み"}</span>}
                  </span>
                  <span className="num">
                    {yen(s.amount)}/{s.cycle === "YEARLY" ? "年" : "月"}
                    {s.cycle === "YEARLY" && <span className="text-xs text-muted">（月{yen(monthly(s))}）</span>}
                  </span>
                  <span className="w-full text-xs text-muted">
                    {s.startDate}〜{s.endDate ?? ""} ・ {park ? `${park.closed ? "閉園した" : ""}${SIZE[park.tier]}（マス ${park.x >= 0 ? `${park.x + 1},${park.y + 1}` : "空き待ち"}）` : `公園：${SIZE[parkSize(monthly(s))]}`}
                  </span>
                  <span className="flex gap-3 text-xs">
                    <button className="underline" onClick={() => setEdit(s)}>
                      編集
                    </button>
                    {active(s) && (
                      <button
                        className="underline"
                        onClick={async () => {
                          if (confirm(`${s.name}を今日付けで解約にしますか？公園は閉園になります。`)) {
                            if (await act(`/api/subscriptions/${s.id}`, { endDate: today }, "PATCH")) reload();
                          }
                        }}
                      >
                        解約
                      </button>
                    )}
                    <button
                      className="text-danger underline"
                      onClick={async () => {
                        if (confirm(`${s.name}の登録を削除しますか？公園も取り壊されます。`)) {
                          if (await act(`/api/subscriptions/${s.id}`, undefined, "DELETE")) reload();
                        }
                      }}
                    >
                      削除
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="登録する">
        <SubForm tz={tz} onDone={reload} />
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="サブスクを編集">
        {edit && <SubForm key={edit.id} initial={edit} tz={tz} onDone={() => (setEdit(null), reload())} />}
      </Modal>
    </div>
  );
}
