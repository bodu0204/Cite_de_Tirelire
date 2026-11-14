"use client";

// 支出の支払い方法（docs/payment-method-sync.md）：選ぶチップ、表示名、未記入の支出の一覧（記入で銀貨）
import { useCallback, useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Modal } from "@/components/ui";
import { REWARD_PAYMENT } from "@/game/config";
import { api, yen } from "@/lib/api";

export interface PaymentMethod {
  id: string;
  name: string;
  kind: "CASH" | "CARD" | "OTHER";
  closingDay: number | null;
  paymentDay: number | null;
  paymentMonths: number | null;
  sortOrder: number;
  archivedAt: string | null;
}

export interface PaymentRewardStatus {
  amount: number;
  dailyCap: number;
  todayRewarded: number;
  remaining: number;
}

export const KIND_LABELS: Record<PaymentMethod["kind"], string> = { CASH: "現金", CARD: "クレカ", OTHER: "その他" };

/** 末日（31）は「末日」と書く */
export const dayLabel = (d: number | null) => (d === null ? "—" : d >= 31 ? "末日" : `${d}日`);

/** カードの請求の区切りの説明（例：15日締め・翌月10日払い） */
export const cardTermsText = (m: PaymentMethod) =>
  m.kind === "CARD" ? `${dayLabel(m.closingDay)}締め・${m.paymentMonths === 2 ? "翌々月" : "翌月"}${dayLabel(m.paymentDay)}払い` : "";

/** 支払い方法の一覧と記入の報酬の今日の残り */
export function usePaymentMethods() {
  const [items, setItems] = useState<PaymentMethod[] | null>(null);
  const [reward, setReward] = useState<PaymentRewardStatus | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ items: PaymentMethod[]; reward: PaymentRewardStatus }>("/api/payment-methods");
      setItems(r.items);
      setReward(r.reward);
    } catch {
      setItems([]);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { items, reward, reload, active: (items ?? []).filter((m) => !m.archivedAt) };
}

/** 支出の行に出す支払い方法の名前。未記入は現金として扱う（G3） */
export function methodLabel(methods: PaymentMethod[] | null, id: string | null): { text: string; unset: boolean } {
  if (!id) return { text: "現金（未記入）", unset: true };
  const m = methods?.find((x) => x.id === id);
  return { text: m ? m.name : "支払い方法", unset: false };
}

/** 引き落とし・チャージを支出として記録しそうなとき（PM-16）。保存は止めない */
const DOUBLE_WORDS = ["引き落とし", "引落", "チャージ", "カード代"];
export const doubleCountWarning = (name: string) =>
  DOUBLE_WORDS.some((w) => name.includes(w)) ? "カードの引き落とし・電子マネーのチャージは支出として記録しないでください（お金の置き場所が変わるだけで、使った時に記録した支出と二重になります）。" : null;

/**
 * 支払い方法を選ぶチップ。allowUnset で「未記入」も選べる（記録するとき）。
 * reward：記入で銀貨がもらえるときに「+10S」を添える
 */
export function PaymentPicker({
  methods,
  value,
  onChange,
  allowUnset = true,
  reward = false,
  label = "支払い方法",
}: {
  methods: PaymentMethod[];
  value: string;
  onChange: (id: string) => void;
  allowUnset?: boolean;
  reward?: boolean;
  label?: string;
}) {
  const chip = (id: string, text: string, sub?: string) => (
    <button
      key={id || "unset"}
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={`min-h-9 rounded-full border px-3 py-1 text-sm transition ${value === id ? "border-ink bg-ink text-bg" : "border-line bg-surface-2 hover:border-ink"}`}
    >
      {text}
      {sub && <span className="ml-1 text-xs opacity-70">{sub}</span>}
    </button>
  );
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}（任意）</span>
        {reward && <span className="text-xs text-muted">記入すると銀貨 +{REWARD_PAYMENT}S</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {allowUnset && chip("", "未記入", "現金として扱う")}
        {methods.map((m) => chip(m.id, m.name, m.kind === "CARD" ? "クレカ" : undefined))}
      </div>
    </div>
  );
}

interface Unfilled {
  id: string;
  date: string;
  name: string;
  amount: number;
  category: string | null;
}

/** 記入して銀貨がもらえたときのトースト */
export function paymentRewardText(n: number) {
  return n > 0 ? `支払い方法を記入しました！ 銀貨 +${n}S` : "支払い方法を記入しました（今日の記入の報酬は上限に達しています）";
}

/**
 * 支払い方法が未記入の支出（今のシーズン）の帯と、続けて記入する一覧（RW-08）。
 * 記入すると1件につき1回、銀貨がもらえる（1日の上限は記録の報酬とは別枠）
 */
export function UnfilledPayments({ reloadKey, onDone }: { reloadKey: number; onDone: () => void }) {
  const { act, toast, busy } = useGame();
  const { active, reload: reloadMethods } = usePaymentMethods();
  const [data, setData] = useState<{ items: Unfilled[]; reward: PaymentRewardStatus } | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      setData(await api("/api/purchases/unfilled"));
    } catch {
      setData(null);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, reloadKey]);
  if (!data || data.items.length === 0) return null;
  const { items, reward } = data;
  return (
    <>
      <button
        type="button"
        onClick={() => (setOpen(true), reloadMethods())}
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-line bg-surface-2 px-3 py-2 text-left text-sm hover:border-ink"
      >
        <span className="flex-1">
          支払い方法が未記入の支出 <span className="num font-semibold">{items.length}</span> 件
          <span className="ml-1 text-xs text-muted">（記入で +{reward.amount}S{reward.remaining < reward.dailyCap && `・今日はあと ${reward.remaining}S`}）</span>
        </span>
        <span className="text-xs underline">記入する</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="支払い方法を記入">
        <p className="mb-2 text-xs text-muted">
          記入すると1件につき銀貨 +{reward.amount}S（1日 {reward.dailyCap}S まで・今日はあと {reward.remaining}S）。未記入のままなら現金で払ったものとして扱います。カードを登録すると、引き落とされるまでの額を手元のお金の推測に足せます（設定の「支払い方法」）。
        </p>
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {items.map((p) => (
            <li key={p.id} className="rounded-lg border border-line p-2.5">
              <div className="mb-1.5 flex items-baseline gap-2 text-sm">
                <span className="num text-xs text-muted">{p.date}</span>
                <span className="min-w-0 flex-1 truncate">
                  {p.name}
                  {p.category && <span className="ml-1 text-xs text-muted">#{p.category}</span>}
                </span>
                <span className="num font-medium">{yen(p.amount)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex-1">
                  <PaymentPicker label={`${p.name}の支払い方法`} methods={active} value={picked[p.id] ?? ""} allowUnset={false} onChange={(id) => setPicked((x) => ({ ...x, [p.id]: id }))} />
                </div>
                <Button
                  disabled={busy || !picked[p.id]}
                  onClick={async () => {
                    const r = await act<{ paymentReward: number }>(`/api/purchases/${p.id}`, { paymentMethodId: picked[p.id] }, "PATCH");
                    if (!r) return;
                    toast(paymentRewardText(r.paymentReward), r.paymentReward > 0 ? "reward" : "info");
                    await load();
                    onDone();
                  }}
                >
                  記入
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
