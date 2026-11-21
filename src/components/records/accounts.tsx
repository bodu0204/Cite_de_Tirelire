"use client";

// お金の置き場所（docs/money-accounts.md）：一覧の取得、選ぶチップ、表示名
import { useCallback, useEffect, useState } from "react";
import { REWARD_EXTRA } from "@/game/config";
import { api } from "@/lib/api";

export type AccountKind = "BANK" | "CASH" | "CARD" | "EMONEY";

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  openingBalance: number;
  openingDate: string;
  isSavings: boolean;
  closingDay: number | null;
  paymentDay: number | null;
  paymentMonths: number | null;
  debitAccountId: string | null;
  sortOrder: number;
  archivedAt: string | null;
  balance: number;
  lastReconciled: string | null;
}

export interface CardBill {
  id: string;
  cardId: string;
  cardName: string;
  dueDate: string;
  amount: number;
  debitAccountId: string | null;
  /** 開始残高の未払い（最初の引き落とし予定だけ。それ以外は 0。docs/season-start-settings.md OA-06） */
  openingUnpaid: number;
}

export interface ExtraReward {
  amount: number;
  dailyCap: number;
  todayRewarded: number;
  remaining: number;
}

export interface AccountsData {
  items: Account[];
  defaults: { spend: string | null; income: string | null };
  total: number;
  pairs: { fromAccountId: string; toAccountId: string }[];
  bills: CardBill[];
  /** 当期までの未記録の固定費・サブスクの支払いの行の数（docs/take-home-and-fixed-costs.md FC-18） */
  unrecorded: number;
  reward: ExtraReward;
}

export const KIND_LABELS: Record<AccountKind, string> = { BANK: "口座", CASH: "現金", CARD: "クレカ", EMONEY: "電子マネー" };

/** 末日（31）は「末日」と書く */
export const dayLabel = (d: number | null) => (d === null ? "—" : d >= 31 ? "末日" : `${d}日`);

/** カードの請求の区切りの説明（例：15日締め・翌月10日払い） */
export const cardTermsText = (a: Pick<Account, "kind" | "closingDay" | "paymentDay" | "paymentMonths">) =>
  a.kind === "CARD" ? `${dayLabel(a.closingDay)}締め・${a.paymentMonths === 2 ? "翌々月" : "翌月"}${dayLabel(a.paymentDay)}払い` : "";

/** 残高の表示。クレカはマイナスを「未払い」と書く */
export const balanceText = (a: Pick<Account, "kind" | "balance">) =>
  a.kind === "CARD"
    ? a.balance < 0
      ? `未払い ${Math.round(-a.balance).toLocaleString("ja-JP")}円`
      : `${Math.round(a.balance).toLocaleString("ja-JP")}円`
    : `${Math.round(a.balance).toLocaleString("ja-JP")}円`;

/** 置き場所の一覧（残高つき）・いつもの置き場所・よく使う振替・引き落とし予定・別枠の報酬 */
export function useAccounts(reloadKey = 0) {
  const [data, setData] = useState<AccountsData | null>(null);
  const reload = useCallback(async () => {
    try {
      setData(await api<AccountsData>("/api/accounts"));
    } catch {
      setData(null);
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload, reloadKey]);
  const active = (data?.items ?? []).filter((a) => !a.archivedAt);
  return { data, reload, active, name: (id: string | null) => data?.items.find((a) => a.id === id)?.name ?? null };
}

/**
 * 置き場所を選ぶチップ。reward：いつもの置き場所以外を選ぶと銀貨がもらえるときに「+10S」を添える
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  label,
  defaultId,
  reward = false,
  exclude,
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  defaultId?: string | null;
  reward?: boolean;
  exclude?: (a: Account) => boolean;
}) {
  const list = accounts.filter((a) => !exclude?.(a));
  return (
    <div role="group" aria-label={label}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {reward && value && value !== defaultId && <span className="text-xs text-muted">自分で選ぶと銀貨 +{REWARD_EXTRA}S</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={value === a.id}
            onClick={() => onChange(a.id)}
            className={`min-h-9 rounded-full border px-3 py-1 text-sm transition ${value === a.id ? "border-ink bg-ink text-bg" : "border-line bg-surface-2 hover:border-ink"}`}
          >
            {a.name}
            {a.id === defaultId && <span className="ml-1 text-xs opacity-70">いつもの</span>}
            {a.kind === "CARD" && <span className="ml-1 text-xs opacity-70">クレカ</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 引き落とし・チャージを支出として記録しそうなとき。保存は止めない */
const DOUBLE_WORDS = ["引き落とし", "引落", "チャージ", "カード代", "ATM", "送金"];
export const doubleCountWarning = (name: string) =>
  DOUBLE_WORDS.some((w) => name.includes(w))
    ? "カードの引き落とし・チャージ・ATM・自分の口座への送金は、支出ではなく「お金の管理」の振替で記録してください（お金の置き場所が変わるだけです）。"
    : null;

/** 報酬のトーストの文言（記録の報酬と、別枠の報酬） */
export function rewardText(reward: number, extra: number) {
  if (reward + extra <= 0) return null;
  return extra > 0 ? `銀貨 +${reward + extra}S（出どころの記入 +${extra}S を含む）` : `銀貨 +${reward}S`;
}
