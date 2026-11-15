// お金の置き場所の残高と、貯金用の置き場所への振替（docs/money-accounts.md §12.2）。DB に依存しない。
// 日付は "YYYY-MM-DD"（ユーザーのタイムゾーンの暦日）。

export interface LedgerAccount {
  id: string;
  openingBalance: number;
  openingDate: string;
  isSavings?: boolean;
}

/** 置き場所の残高を動かす記録。delta は置き場所から見た増減（支出は −） */
export interface LedgerMove {
  accountId: string;
  date: string;
  delta: number;
}

export interface LedgerRecords {
  /** 収入（入金先。null はいつもの入金先） */
  incomes: { accountId: string | null; date: string; amount: number }[];
  /** 支出（出どころ。null はいつもの置き場所） */
  purchases: { accountId: string | null; date: string; amount: number }[];
  transfers: { fromAccountId: string; toAccountId: string; date: string; amount: number }[];
  /** 予算外の入出金（入金は＋） */
  outside: { accountId: string; date: string; amount: number }[];
  /** 照合の調整（実際 − 計算） */
  adjustments: { accountId: string; date: string; diff: number }[];
}

/** 記録を置き場所ごとの増減に直す。出どころ・入金先が null の記録は、いつもの置き場所・いつもの入金先として数える */
export function ledgerMoves(r: LedgerRecords, defaults: { spend: string | null; income: string | null }): LedgerMove[] {
  const moves: LedgerMove[] = [];
  for (const i of r.incomes) {
    const id = i.accountId ?? defaults.income;
    if (id && i.amount) moves.push({ accountId: id, date: i.date, delta: i.amount });
  }
  for (const p of r.purchases) {
    const id = p.accountId ?? defaults.spend;
    if (id && p.amount) moves.push({ accountId: id, date: p.date, delta: -p.amount });
  }
  for (const t of r.transfers) {
    if (!t.amount) continue;
    moves.push({ accountId: t.fromAccountId, date: t.date, delta: -t.amount });
    moves.push({ accountId: t.toAccountId, date: t.date, delta: t.amount });
  }
  for (const o of r.outside) if (o.amount) moves.push({ accountId: o.accountId, date: o.date, delta: o.amount });
  for (const a of r.adjustments) if (a.diff) moves.push({ accountId: a.accountId, date: a.date, delta: a.diff });
  return moves;
}

/** 残高 ＝ 開始残高 ＋ 開始日以後の増減（H3）。until を渡すとその日まで */
export function balances(accounts: LedgerAccount[], moves: LedgerMove[], until?: string): Map<string, number> {
  const out = new Map(accounts.map((a) => [a.id, a.openingBalance]));
  const opening = new Map(accounts.map((a) => [a.id, a.openingDate]));
  for (const m of moves) {
    const from = opening.get(m.accountId);
    if (from === undefined || m.date < from || (until !== undefined && m.date > until)) continue;
    out.set(m.accountId, out.get(m.accountId)! + m.delta);
  }
  return out;
}

/**
 * 貯金用の置き場所への振替を、貯金の追加（DEPOSIT）・引出（WITHDRAW）に直す（H7）。
 * 貯金用どうしの振替は増減なし。並びは渡した順
 */
export function savingsMoves<T extends { fromAccountId: string; toAccountId: string; amount: number }>(
  transfers: T[],
  savingIds: Set<string>,
): (T & { kind: "DEPOSIT" | "WITHDRAW" })[] {
  const out: (T & { kind: "DEPOSIT" | "WITHDRAW" })[] = [];
  for (const t of transfers) {
    if (!t.amount) continue;
    const into = savingIds.has(t.toAccountId);
    const outOf = savingIds.has(t.fromAccountId);
    if (into && !outOf) out.push({ ...t, kind: "DEPOSIT" });
    else if (outOf && !into) out.push({ ...t, kind: "WITHDRAW" });
  }
  return out;
}
