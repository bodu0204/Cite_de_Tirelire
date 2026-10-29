"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Modal } from "@/components/ui";
import { parkSize } from "@/game/city/actions";
import { tileLabel } from "@/game/city/layout";
import { PARK_DESCRIPTION, PARK_SIZE_LABELS as SIZE } from "@/game/describe";
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

/** 次の大きさまでの月額（parkSize の段階：500円・1,500円・3,000円） */
function nextSize(m: number): string {
  const next = [500, 1500, 3000].find((t) => m < t);
  return next ? `（月額があと${yen(next - m)}で${SIZE[parkSize(next)]}）` : "（最大の大きさ）";
}

function SubForm({ initial, onDone, tz }: { initial?: Sub; onDone: () => void; tz: string }) {
  const { act, busy, toast } = useGame();
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
        const r = initial
          ? await act<{ warning: string | null }>(`/api/subscriptions/${initial.id}`, body, "PATCH")
          : await act<{ warning: string | null }>("/api/subscriptions", body);
        if (r) {
          // 現実の契約の記録なので保存はする。自由予算を超える月があれば知らせる
          if (r.warning) toast(r.warning, "error");
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
        <p className="mt-1 text-sm text-muted">契約中のサブスクは街の公園になり、周りの幸福度を少し上げます。月額は金貨の配当額から差し引かれます。</p>
      </div>
      <Card>
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">月額換算の合計</span>
          <span className="num font-pixel text-2xl">{yen(total)}</span>
        </div>
        {budget > 0 && (
          <p className="mt-1 text-xs text-muted">
            金貨の配当は月 {yen(v?.mine.breakdown.net ?? Math.max(0, budget - total))}（自由予算 {yen(budget)} − サブスク{v && v.mine.breakdown.custom > 0 && ` − ユーザ通貨 ${yen(v.mine.breakdown.custom)}`}）。サブスクがなければ月 {yen(total)} 分多く金貨が配当されます。
          </p>
        )}
      </Card>
      <Card title="契約一覧">
        <p className="mb-2 text-xs text-muted">{PARK_DESCRIPTION}</p>
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
                  <span className="w-full text-xs text-muted">契約期間 {s.startDate}〜{s.endDate ?? ""}</span>
                  <span className="w-full rounded-md bg-surface-2 px-2 py-1 text-xs">
                    <span className="font-medium">{s.name}の公園</span>
                    <span className="text-muted">
                      {" ・ "}
                      {park ? (park.closed ? "閉園中" : "開園中") : s.startDate > today ? "契約開始日に開園" : "閉園"}
                      {" ・ "}
                      {SIZE[park?.tier ?? parkSize(monthly(s))]}
                      {park && ` ・ ${park.placed !== false ? tileLabel(park.x, park.y) : "置く場所の空き待ち"}`}
                      {nextSize(monthly(s))}
                    </span>
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
