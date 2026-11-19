"use client";

// 固定費・サブスクの登録（docs/take-home-and-fixed-costs.md §5）。
// どちらも同じ記録で、種類（kind）だけが違う：固定費は手取り月収から先に引いて公園を建てず、サブスクは自由予算の内訳で公園が建つ。
import { useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Field, NumberInput } from "@/components/ui";
import { dayLabel, useAccounts } from "@/components/records/accounts";
import { monthlyEquivalent } from "@/game/recurring";
import { todayIn, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

export type RecurringKind = "SUBSCRIPTION" | "FIXED";

export interface RecurringItem {
  id: string;
  kind: RecurringKind;
  name: string;
  amount: number;
  cycle: "MONTHLY" | "YEARLY";
  startDate: string;
  endDate: string | null;
  payDay: number | null;
  skippedPeriods: string[];
  memo: string | null;
  accountId: string | null;
}

export const KIND_NAMES: Record<RecurringKind, string> = { FIXED: "固定費", SUBSCRIPTION: "サブスク" };
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export const monthlyOf = monthlyEquivalent;
export const isActiveOn = (s: Pick<RecurringItem, "startDate" | "endDate">, today: string) => s.startDate <= today && (!s.endDate || s.endDate > today);

/** 支払日の選択肢（決めなければ、支払いの行は期間の初めから並ぶ） */
function PayDaySelect({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">決めない</option>
      {DAYS.map((d) => (
        <option key={d} value={d}>
          毎月{dayLabel(d)}
        </option>
      ))}
    </select>
  );
}

/**
 * 固定費・サブスクの登録・編集のフォーム。
 * quiet：保存のあとの警告（手取り月収・自由予算を超える月）を出さない（開始画面は手取り月収をまだ保存していないため）
 */
export function RecurringForm({ kind: initialKind, initial, onDone, tz, quiet = false }: { kind: RecurringKind; initial?: RecurringItem; onDone: () => void; tz: string; quiet?: boolean }) {
  const { act, busy, toast } = useGame();
  const { data, active } = useAccounts();
  const [f, setF] = useState({
    kind: initial?.kind ?? initialKind,
    accountId: initial?.accountId ?? "",
    name: initial?.name ?? "",
    amount: initial ? String(initial.amount) : "",
    cycle: initial?.cycle ?? ("MONTHLY" as RecurringItem["cycle"]),
    startDate: initial?.startDate ?? todayIn(tz),
    endDate: initial?.endDate ?? "",
    payDay: initial?.payDay ? String(initial.payDay) : "",
    memo: initial?.memo ?? "",
  });
  const fixed = f.kind === "FIXED";
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...f, amount: Number(f.amount), endDate: f.endDate || null, accountId: f.accountId || null, payDay: f.cycle === "MONTHLY" && f.payDay ? Number(f.payDay) : null };
        const r = initial
          ? await act<{ warning: string | null }>(`/api/subscriptions/${initial.id}`, body, "PATCH")
          : await act<{ warning: string | null }>("/api/subscriptions", body);
        if (r) {
          // 現実の契約の記録なので保存はする。手取り月収・自由予算を超える月があれば知らせる
          if (r.warning && !quiet) toast(r.warning, "error");
          if (!initial) setF({ ...f, name: "", amount: "", memo: "" });
          onDone();
        }
      }}
    >
      {initial && (
        <Field label="種類" hint={fixed ? "固定費は手取り月収から先に引き、公園は建ちません。" : "サブスクは自由予算の内訳で、街の公園になります。"}>
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as RecurringKind })}>
            <option value="FIXED">固定費</option>
            <option value="SUBSCRIPTION">サブスク</option>
          </select>
        </Field>
      )}
      <Field label={fixed ? "名前" : "サービス名"}>
        <input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={fixed ? "例：家賃・電気代・通信費" : "例：動画配信"} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="金額（円）" hint={fixed ? "月によって変わるものは目安の額を入れます。" : undefined}>
          <NumberInput required value={f.amount} onValueChange={(v) => setF({ ...f, amount: v })} />
        </Field>
        <Field label="支払い周期" hint={f.cycle === "YEARLY" && f.amount ? `月額換算 ${yen(Math.round(Number(f.amount) / 12))}` : undefined}>
          <select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value as RecurringItem["cycle"] })}>
            <option value="MONTHLY">月額</option>
            <option value="YEARLY">年額</option>
          </select>
        </Field>
        <Field label={fixed ? "開始日" : "契約開始日"}>
          <input type="date" required value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </Field>
        <Field label={fixed ? "終了日（任意）" : "解約日（任意）"}>
          <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </Field>
      </div>
      <Field
        label="支払日（任意）"
        hint={f.cycle === "YEARLY" ? "年額は、開始日と同じ月日がある月に支払いの行が出ます。" : "入れると、その日が来てから支出タブに支払いの行が出ます。決めなければ、月の初め（収入日）から並びます。"}
      >
        <PayDaySelect value={f.cycle === "YEARLY" ? "" : f.payDay} disabled={f.cycle === "YEARLY"} onChange={(v) => setF({ ...f, payDay: v })} />
      </Field>
      <Field label="メモ（任意）">
        <input maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      </Field>
      {active.length > 1 && (
        <Field label="出どころ（任意）" hint="支出タブの支払いの行に初期値として入ります。">
          <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
            <option value="">いつもの置き場所</option>
            {/* 使わないにした置き場所も、今の設定なら残して見せる */}
            {(data?.items ?? [])
              .filter((m) => !m.archivedAt || m.id === initial?.accountId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </Field>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {initial ? "保存" : `${KIND_NAMES[f.kind]}を登録`}
      </Button>
    </form>
  );
}

/**
 * 開始画面の固定費（docs/take-home-and-fixed-costs.md ST-12）：一覧と、名前・金額・支払日・出どころだけの追加。
 * 開始のフォームの中に置くので form 要素は使わない。細かい登録（年額・終了日など）は「固定費・サブスク」の画面で行う
 */
export function FixedCostsInline({ tz, reloadKey = 0, onChange }: { tz: string; reloadKey?: number; onChange: () => void }) {
  const { act, busy } = useGame();
  const { items, reload } = useList<RecurringItem>("/api/subscriptions");
  const { data, active } = useAccounts(reloadKey);
  const [f, setF] = useState({ name: "", amount: "", payDay: "", accountId: "" });
  const today = todayIn(tz);
  const fixed = (items ?? []).filter((s) => s.kind === "FIXED" && isActiveOn(s, today));
  const total = fixed.reduce((a, s) => a + monthlyOf(s), 0);
  const ready = f.name.trim() !== "" && Number(f.amount) > 0;
  const add = async () => {
    if (!ready || busy) return;
    const r = await act("/api/subscriptions", {
      kind: "FIXED",
      name: f.name,
      amount: Number(f.amount),
      cycle: "MONTHLY",
      startDate: today,
      payDay: f.payDay ? Number(f.payDay) : null,
      accountId: f.accountId || null,
    });
    if (!r) return;
    setF({ name: "", amount: "", payDay: "", accountId: "" });
    await reload();
    onChange();
  };
  // Enter で開始のフォームを送らない（固定費を足す）
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  };
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium">固定費（任意）</span>
        <span className="num">{fixed.length ? `月 ${yen(total)}（${fixed.length}件）` : "未登録"}</span>
      </div>
      <p className="text-xs text-muted">家賃・光熱費・通信費・保険など、毎月決まって出ていくお金。手取り月収から先に引いて、残りを自由予算にします。入れないと、手取りの全額が自由予算になります。</p>
      {fixed.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {fixed.map((s) => (
            <li key={s.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1 truncate">
                {s.name}
                {s.payDay && <span className="ml-1 text-xs text-muted">毎月{dayLabel(s.payDay)}</span>}
              </span>
              <span className="num">{yen(monthlyOf(s))}</span>
              <button
                type="button"
                className="text-xs text-danger underline"
                disabled={busy}
                onClick={async () => {
                  if (await act(`/api/subscriptions/${s.id}`, undefined, "DELETE")) {
                    await reload();
                    onChange();
                  }
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <input aria-label="固定費の名前" maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={onEnter} placeholder="例：家賃" />
        <NumberInput aria-label="固定費の金額（円）" value={f.amount} onValueChange={(v) => setF({ ...f, amount: v })} onKeyDown={onEnter} placeholder="金額（円）" />
        <label className="text-xs text-muted">
          支払日（任意）
          <PayDaySelect value={f.payDay} onChange={(v) => setF({ ...f, payDay: v })} />
        </label>
        {active.length > 1 && (
          <label className="text-xs text-muted">
            出どころ（任意）
            <select value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
              <option value="">いつもの置き場所</option>
              {(data?.items ?? [])
                .filter((m) => !m.archivedAt)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <Button type="button" variant="secondary" className="w-full" disabled={busy || !ready} onClick={add}>
        固定費を足す
      </Button>
      <p className="text-xs text-muted">年額の固定費や終了日は、あとで「固定費・サブスク」の画面から登録できます。</p>
    </div>
  );
}
