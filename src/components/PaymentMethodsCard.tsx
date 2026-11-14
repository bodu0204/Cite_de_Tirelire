"use client";

// 設定（SCR-10）の「支払い方法」（docs/payment-method-sync.md §4.1）
import { useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Field, Modal } from "@/components/ui";
import { cardTermsText, dayLabel, KIND_LABELS, usePaymentMethods, type PaymentMethod } from "@/components/records/payment";
import { REWARD_PAYMENT } from "@/game/config";

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

function MethodForm({ initial, onDone }: { initial?: PaymentMethod; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const [f, setF] = useState({
    name: initial?.name ?? "",
    kind: (initial?.kind ?? "CARD") as PaymentMethod["kind"],
    closingDay: String(initial?.closingDay ?? 15),
    paymentDay: String(initial?.paymentDay ?? 10),
    paymentMonths: String(initial?.paymentMonths ?? 1),
  });
  const card = f.kind === "CARD";
  const cash = f.kind === "CASH";
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { name: f.name, ...(initial ? {} : { kind: f.kind }), ...(card ? { closingDay: Number(f.closingDay), paymentDay: Number(f.paymentDay), paymentMonths: Number(f.paymentMonths) } : {}) };
        const r = initial ? await act(`/api/payment-methods/${initial.id}`, body, "PATCH") : await act("/api/payment-methods", body);
        if (!r) return;
        toast(initial ? "保存しました" : "支払い方法を登録しました");
        if (!initial) setF({ ...f, name: "" });
        onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="名前">
          <input required maxLength={50} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={card ? "例：〇〇カード" : "例：交通系IC"} />
        </Field>
        <Field label="種類" hint={cash ? undefined : card ? "引き落とされるまでの額を手元のお金の推測に足します" : "デビット・電子マネー・QR決済など。現金と同じく使った時に減ったものとして扱います"}>
          <select disabled={!!initial} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as PaymentMethod["kind"] })}>
            {cash && <option value="CASH">現金</option>}
            <option value="CARD">クレカ</option>
            <option value="OTHER">その他</option>
          </select>
        </Field>
      </div>
      {card && (
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
      )}
      {card && <p className="text-xs text-muted">31日は末日として扱います。土日祝日による引き落とし日のずれは数えません。</p>}
      <Button type="submit" disabled={busy || !f.name.trim()}>
        {initial ? "保存" : "登録"}
      </Button>
    </form>
  );
}

export function PaymentMethodsCard() {
  const { act, toast } = useGame();
  const { items, reload } = usePaymentMethods();
  const [edit, setEdit] = useState<PaymentMethod | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const archived = (items ?? []).filter((m) => m.archivedAt);
  const list = (items ?? []).filter((m) => showArchived || !m.archivedAt);
  return (
    <Card title="支払い方法">
      <p className="mb-3 text-xs text-muted">
        支出に支払い方法を記入すると、1件につき銀貨 +{REWARD_PAYMENT}S。記入しない支出は現金で払ったものとして扱います。クレカを登録すると、引き落とされるまでの額を手元のお金の推測に足すので、口座残高のまま誤差調整できます。支払い方法で精算・貯金額は変わりません。
      </p>
      <ul className="mb-4 divide-y divide-line">
        {list.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className={`min-w-0 flex-1 font-medium ${m.archivedAt ? "text-muted" : ""}`}>
              {m.name}
              <span className="ml-2 text-xs font-normal text-muted">
                {KIND_LABELS[m.kind]}
                {m.kind === "CARD" && `・${cardTermsText(m)}`}
                {m.archivedAt && "・使わない"}
              </span>
            </span>
            <span className="flex gap-3 text-xs">
              <button className="underline" onClick={() => setEdit(m)}>
                編集
              </button>
              {m.kind !== "CASH" && (
                <button
                  className="underline"
                  onClick={async () => {
                    if (await act(`/api/payment-methods/${m.id}`, { archived: !m.archivedAt }, "PATCH")) reload();
                  }}
                >
                  {m.archivedAt ? "使う" : "使わない"}
                </button>
              )}
              {m.kind !== "CASH" && (
                <button
                  className="text-danger underline"
                  onClick={async () => {
                    if (!confirm(`${m.name}を削除しますか？（記入した支出があるときは削除できません。「使わない」にしてください）`)) return;
                    if (await act(`/api/payment-methods/${m.id}`, undefined, "DELETE")) {
                      toast("削除しました");
                      reload();
                    }
                  }}
                >
                  削除
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {archived.length > 0 && (
        <button className="mb-3 text-xs text-muted underline" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? "使わないものを隠す" : `使わないもの（${archived.length}件）も表示`}
        </button>
      )}
      <MethodForm onDone={reload} />
      <Modal open={!!edit} onClose={() => setEdit(null)} title="支払い方法を編集">
        {edit && <MethodForm key={edit.id} initial={edit} onDone={() => (setEdit(null), reload())} />}
      </Modal>
    </Card>
  );
}
