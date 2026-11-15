"use client";

// 設定（SCR-10）の「お金の置き場所」（docs/money-accounts.md §4）
import { useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Field, Modal, NumberInput } from "@/components/ui";
import { balanceText, cardTermsText, dayLabel, KIND_LABELS, useAccounts, type Account, type AccountKind } from "@/components/records/accounts";
import { todayIn } from "@/lib/api";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const KIND_HINTS: Record<AccountKind, string> = {
  BANK: "銀行口座。給料の入金先・カードの引き落とし口座になります",
  CASH: "財布の現金",
  CARD: "使うと未払い（マイナス）が増え、引き落としで 0 に戻ります",
  EMONEY: "Suica・PayPay などチャージして使うもの",
};

function AccountForm({
  initial,
  accounts,
  defaults,
  tz,
  onDone,
}: {
  initial?: Account;
  accounts: Account[];
  defaults: { spend: string | null; income: string | null };
  tz: string;
  onDone: () => void;
}) {
  const { act, toast, busy } = useGame();
  const [f, setF] = useState({
    name: initial?.name ?? "",
    kind: (initial?.kind ?? "BANK") as AccountKind,
    // クレカは未払いを正の数で入れる
    openingBalance: initial ? String(initial.kind === "CARD" ? -initial.openingBalance : initial.openingBalance) : "0",
    openingDate: initial?.openingDate ?? todayIn(tz),
    isSavings: initial?.isSavings ?? false,
    closingDay: String(initial?.closingDay ?? 15),
    paymentDay: String(initial?.paymentDay ?? 10),
    paymentMonths: String(initial?.paymentMonths ?? 1),
    debitAccountId: initial?.debitAccountId ?? "",
    defaultSpend: initial ? defaults.spend === initial.id : false,
    defaultIncome: initial ? defaults.income === initial.id : false,
  });
  const card = f.kind === "CARD";
  const debitOptions = accounts.filter((a) => !a.archivedAt && a.kind !== "CARD" && a.id !== initial?.id);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = {
          name: f.name,
          ...(initial ? {} : { kind: f.kind }),
          openingBalance: Number(f.openingBalance || 0),
          openingDate: f.openingDate,
          isSavings: f.isSavings,
          ...(card ? { closingDay: Number(f.closingDay), paymentDay: Number(f.paymentDay), paymentMonths: Number(f.paymentMonths), debitAccountId: f.debitAccountId || null } : {}),
          ...(f.defaultSpend ? { defaultSpend: true } : {}),
          ...(f.defaultIncome ? { defaultIncome: true } : {}),
        };
        const r = initial ? await act(`/api/accounts/${initial.id}`, body, "PATCH") : await act("/api/accounts", body);
        if (!r) return;
        toast(initial ? "保存しました" : "置き場所を登録しました");
        if (!initial) setF({ ...f, name: "", openingBalance: "0", isSavings: false, defaultSpend: false, defaultIncome: false });
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名前">
          <input
            required
            maxLength={50}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            placeholder={card ? "例：クレカA" : f.kind === "EMONEY" ? "例：Suica" : f.kind === "CASH" ? "例：財布B" : "例：口座A"}
          />
        </Field>
        <Field label="種類" hint={KIND_HINTS[f.kind]}>
          <select disabled={!!initial} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as AccountKind })}>
            {(Object.keys(KIND_LABELS) as AccountKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={card ? "今の未払い（円）" : "今の残高（円）"} hint={card ? "カード会社の画面の「ご利用額」（未確定分を含む）" : "この日の時点の実際の残高"}>
          <NumberInput allowNegative={!card} value={f.openingBalance} onValueChange={(v) => setF({ ...f, openingBalance: v })} />
        </Field>
        <Field label="残高の日付" hint="この日より前の記録は、この置き場所の残高に数えません">
          <input type="date" required value={f.openingDate} onChange={(e) => setF({ ...f, openingDate: e.target.value })} />
        </Field>
      </div>
      {card && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Field label="締め日">
              <select value={f.closingDay} onChange={(e) => setF({ ...f, closingDay: e.target.value })}>
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(d)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="引き落とし">
              <select value={f.paymentMonths} onChange={(e) => setF({ ...f, paymentMonths: e.target.value })}>
                <option value="1">翌月</option>
                <option value="2">翌々月</option>
              </select>
            </Field>
            <Field label="引き落とし日">
              <select value={f.paymentDay} onChange={(e) => setF({ ...f, paymentDay: e.target.value })}>
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(d)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="引き落とし口座" hint="設定すると、引き落とし日に「口座 → クレカ」の引き落とし予定が出ます。31日は末日、土日祝日のずれは数えません">
            <select value={f.debitAccountId} onChange={(e) => setF({ ...f, debitAccountId: e.target.value })}>
              <option value="">設定しない（引き落としは振替として記録）</option>
              {debitOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="w-auto" checked={f.isSavings} onChange={(e) => setF({ ...f, isSavings: e.target.checked })} />
          貯金用（ここへの振替を貯金として数える）
        </label>
        {!card && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="w-auto"
              disabled={initial && defaults.spend === initial.id}
              checked={f.defaultSpend}
              onChange={(e) => setF({ ...f, defaultSpend: e.target.checked })}
            />
            いつもの置き場所（支出の初期値）
          </label>
        )}
        {!card && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="w-auto"
              disabled={initial && defaults.income === initial.id}
              checked={f.defaultIncome}
              onChange={(e) => setF({ ...f, defaultIncome: e.target.checked })}
            />
            いつもの入金先（収入の初期値）
          </label>
        )}
      </div>
      <Button type="submit" disabled={busy || !f.name.trim()}>
        {initial ? "保存" : "登録"}
      </Button>
    </form>
  );
}

export function AccountsCard({ tz }: { tz: string }) {
  const { act, toast } = useGame();
  const { data, reload } = useAccounts();
  const [edit, setEdit] = useState<Account | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const items = data?.items ?? [];
  const archived = items.filter((a) => a.archivedAt);
  const list = items.filter((a) => showArchived || !a.archivedAt);
  const defaults = data?.defaults ?? { spend: null, income: null };
  const name = (id: string | null) => items.find((a) => a.id === id)?.name;
  return (
    <div id="accounts">
      <Card title="お金の置き場所">
        <p className="mb-3 text-xs text-muted">
          口座・財布・クレカ・電子マネーごとに残高を持ち、収入・支出・振替で動かします。「お金の管理」で実際の残高に合わせると、収入・支出の記録漏れだけが債券で解消されます。どの置き場所で払っても、精算・貯金額は変わりません。
        </p>
        <ul className="mb-4 divide-y divide-line">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className={`min-w-0 flex-1 font-medium ${a.archivedAt ? "text-muted" : ""}`}>
                {a.name}
                <span className="ml-2 text-xs font-normal text-muted">
                  {KIND_LABELS[a.kind]}
                  {a.kind === "CARD" && `・${cardTermsText(a)}${a.debitAccountId ? `・${name(a.debitAccountId) ?? "口座"}から` : ""}`}
                  {a.isSavings && "・貯金用"}
                  {a.id === defaults.spend && "・いつもの置き場所"}
                  {a.id === defaults.income && "・いつもの入金先"}
                  {a.archivedAt && "・使わない"}
                </span>
              </span>
              <span className="num text-xs">{balanceText(a)}</span>
              <span className="flex gap-3 text-xs">
                <button className="underline" onClick={() => setEdit(a)}>
                  編集
                </button>
                <button
                  className="underline"
                  onClick={async () => {
                    if (await act(`/api/accounts/${a.id}`, { archived: !a.archivedAt }, "PATCH")) reload();
                  }}
                >
                  {a.archivedAt ? "使う" : "使わない"}
                </button>
                <button
                  className="text-danger underline"
                  onClick={async () => {
                    if (!confirm(`${a.name}を削除しますか？（記録に使った置き場所は削除できません。「使わない」にしてください）`)) return;
                    if (await act(`/api/accounts/${a.id}`, undefined, "DELETE")) {
                      toast("削除しました");
                      reload();
                    }
                  }}
                >
                  削除
                </button>
              </span>
            </li>
          ))}
        </ul>
        {archived.length > 0 && (
          <button className="mb-3 text-xs text-muted underline" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "使わないものを隠す" : `使わないもの（${archived.length}件）も表示`}
          </button>
        )}
        <h3 className="mb-2 text-sm font-semibold">登録する</h3>
        {data && <AccountForm accounts={items} defaults={defaults} tz={tz} onDone={reload} />}
        <Modal open={!!edit} onClose={() => setEdit(null)} title="置き場所を編集">
          {edit && <AccountForm key={edit.id} initial={edit} accounts={items} defaults={defaults} tz={tz} onDone={() => (setEdit(null), reload())} />}
        </Modal>
      </Card>
    </div>
  );
}
