"use client";

// 固定費・サブスク（SCR-06。docs/take-home-and-fixed-costs.md §5・§11.4）
import { useState } from "react";
import Link from "next/link";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { isActiveOn, KIND_NAMES, monthlyOf, RecurringForm, type RecurringItem, type RecurringKind } from "@/components/Recurring";
import { dayLabel } from "@/components/records/accounts";
import { Card, Empty, Modal, Tabs } from "@/components/ui";
import { parkSize } from "@/game/city/actions";
import { tileLabel } from "@/game/city/layout";
import { PARK_DESCRIPTION, PARK_SIZE_LABELS as SIZE } from "@/game/describe";
import { todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

/** 次の大きさまでの月額（parkSize の段階：500円・1,500円・3,000円） */
function nextSize(m: number): string {
  const next = [500, 1500, 3000].find((t) => m < t);
  return next ? `（月額があと${yen(next - m)}で${SIZE[parkSize(next)]}）` : "（最大の大きさ）";
}

export default function RecurringPage() {
  const { view, act } = useGame();
  const v = useSeasonView();
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const { items, reload } = useList<RecurringItem>("/api/subscriptions");
  const [edit, setEdit] = useState<RecurringItem | null>(null);
  const [kind, setKind] = useState<RecurringKind>("FIXED");
  const today = todayIn(tz);
  const active = (s: RecurringItem) => isActiveOn(s, today);
  const fixed = (items ?? []).filter((s) => s.kind === "FIXED");
  const subs = (items ?? []).filter((s) => s.kind !== "FIXED");
  const sum = (list: RecurringItem[]) => list.filter(active).reduce((a, s) => a + monthlyOf(s), 0);
  const fixedTotal = sum(fixed);
  const subsTotal = sum(subs);
  const income = view?.user.monthlyIncome ?? 0;
  const free = Math.max(0, income - fixedTotal);
  const custom = v?.mine.breakdown.custom ?? 0;
  const parks = v?.city.buildings.filter((b) => b.special === "park") ?? [];

  const actions = (s: RecurringItem) => {
    const fx = s.kind === "FIXED";
    return (
      <span className="flex gap-3 text-xs">
        <button className="underline" onClick={() => setEdit(s)}>
          編集
        </button>
        {active(s) && (
          <button
            className="underline"
            onClick={async () => {
              if (confirm(fx ? `${s.name}を今日付けで終了にしますか？` : `${s.name}を今日付けで解約にしますか？公園は閉園になります。`)) {
                if (await act(`/api/subscriptions/${s.id}`, { endDate: today }, "PATCH")) reload();
              }
            }}
          >
            {fx ? "終了" : "解約"}
          </button>
        )}
        <button
          className="text-danger underline"
          onClick={async () => {
            if (confirm(fx ? `${s.name}の登録を削除しますか？` : `${s.name}の登録を削除しますか？公園も取り壊されます。`)) {
              if (await act(`/api/subscriptions/${s.id}`, undefined, "DELETE")) reload();
            }
          }}
        >
          削除
        </button>
      </span>
    );
  };
  /** 金額・期間・支払日と、「この回は記録しない」にした回（戻せる） */
  const details = (s: RecurringItem) => (
    <>
      <span className="num">
        {yen(s.amount)}/{s.cycle === "YEARLY" ? "年" : "月"}
        {s.cycle === "YEARLY" && <span className="text-xs text-muted">（月{yen(monthlyOf(s))}）</span>}
      </span>
      <span className="w-full text-xs text-muted">
        {s.kind === "FIXED" ? "期間" : "契約期間"} {s.startDate}〜{s.endDate ?? ""}
        {s.cycle === "MONTHLY" && s.payDay ? `・支払日 毎月${dayLabel(s.payDay)}` : ""}
      </span>
      {s.skippedPeriods.length > 0 && (
        <span className="w-full text-xs text-muted">
          記録しない回：
          {s.skippedPeriods.map((key) => (
            <span key={key} className="mr-2">
              {key}
              <button
                className="ml-1 underline"
                onClick={async () => {
                  if (await act(`/api/subscriptions/${s.id}/skip`, { periodKey: key, undo: true })) reload();
                }}
              >
                戻す
              </button>
            </span>
          ))}
        </span>
      )}
    </>
  );
  const state = (s: RecurringItem) => !active(s) && <span className="ml-2 text-xs text-muted">{s.startDate > today ? "開始前" : s.kind === "FIXED" ? "終了" : "解約済み"}</span>;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">固定費・サブスク</h1>
        <p className="mt-1 text-sm text-muted">
          毎月決まって出ていくお金を登録します。固定費（家賃・光熱費・通信費など）は手取り月収から先に引き、残りが自由予算になります。サブスクは自由予算の内訳で、街の公園になります。どちらも月額の分だけ金貨の配当が減り、支払いは収支記録の支出タブに並びます。
        </p>
      </div>
      <Card>
        <dl className="num grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="text-muted">
            手取り月収
            <Link href="/settings" className="ml-2 text-xs underline">
              設定で変える
            </Link>
          </dt>
          <dd className="text-right">{yen(income)}</dd>
          <dt className="text-muted">固定費</dt>
          <dd className="text-right">−{yen(fixedTotal)}</dd>
          <dt className="border-t border-line pt-1 font-medium">自由予算</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">{yen(free)}</dd>
          <dt className="pt-2 text-muted">サブスク</dt>
          <dd className="pt-2 text-right">−{yen(subsTotal)}</dd>
          {custom > 0 && (
            <>
              <dt className="text-muted">ユーザ通貨（今月の発生額）</dt>
              <dd className="text-right">−{yen(custom)}</dd>
            </>
          )}
          <dt className="border-t border-line pt-1 font-medium">金貨の配当（月）</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">{yen(Math.max(0, free - subsTotal - custom))}</dd>
        </dl>
        {income > 0 && fixedTotal > income && <p className="mt-2 text-xs text-danger">固定費が手取り月収を超えています。自由予算と金貨の配当は0になります。</p>}
        <p className="mt-2 text-xs text-muted">債券の上限と備えLv は手取り月収で決まり、固定費やサブスクを登録しても変わりません。</p>
      </Card>

      <Card title={`固定費（月 ${yen(fixedTotal)}）`}>
        <p className="mb-2 text-xs text-muted">
          月によって額が変わるもの（光熱費など）は目安の額を登録し、支払いを記録するときに実際の額を入れます。登録額より安ければ＋差分（債券へ）、高ければ−差分（債券から）になります。登録していない置き場所への積立（iDeCo・積立NISA など）も固定費として登録できます。
        </p>
        {!fixed.length ? (
          <Empty>登録された固定費はありません</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {fixed.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1 font-medium">
                  {s.name}
                  {state(s)}
                </span>
                {details(s)}
                {actions(s)}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`サブスク（月 ${yen(subsTotal)}）`}>
        <p className="mb-2 text-xs text-muted">{PARK_DESCRIPTION}</p>
        {!subs.length ? (
          <Empty>登録されたサブスクはありません</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {subs.map((s) => {
              const park = parks.find((p) => p.refId === s.id);
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 font-medium">
                    {s.name}
                    {state(s)}
                  </span>
                  {details(s)}
                  <span className="w-full rounded-md bg-surface-2 px-2 py-1 text-xs">
                    <span className="font-medium">{s.name}の公園</span>
                    <span className="text-muted">
                      {" ・ "}
                      {park ? (park.closed ? "閉園中" : "開園中") : s.startDate > today ? "契約開始日に開園" : "閉園"}
                      {" ・ "}
                      {SIZE[park?.tier ?? parkSize(monthlyOf(s))]}
                      {park && ` ・ ${park.placed !== false ? tileLabel(park.x, park.y) : "置く場所の空き待ち"}`}
                      {nextSize(monthlyOf(s))}
                    </span>
                  </span>
                  {actions(s)}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="登録する">
        <div className="mb-3">
          <Tabs
            value={kind}
            onChange={setKind}
            items={[
              { value: "FIXED", label: "固定費" },
              { value: "SUBSCRIPTION", label: "サブスク", note: "公園" },
            ]}
          />
        </div>
        <RecurringForm key={kind} kind={kind} tz={tz} onDone={reload} />
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `${KIND_NAMES[edit.kind]}を編集` : ""}>
        {edit && <RecurringForm key={edit.id} kind={edit.kind} initial={edit} tz={tz} onDone={() => (setEdit(null), reload())} />}
      </Modal>
    </div>
  );
}
