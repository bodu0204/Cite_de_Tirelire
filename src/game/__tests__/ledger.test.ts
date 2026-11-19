// お金の置き場所の残高と貯金用の振替（docs/money-accounts.md AT-083〜089・091）
import { describe, expect, it } from "vitest";
import { balances, ledgerMoves, savingsMoves, type LedgerRecords } from "../ledger";

const empty: LedgerRecords = { incomes: [], purchases: [], transfers: [], adjustments: [] };
const accounts = [
  { id: "bankA", openingBalance: 100_000, openingDate: "2026-11-01" },
  { id: "walletA", openingBalance: 5_000, openingDate: "2026-11-01" },
  { id: "cardA", openingBalance: -12_000, openingDate: "2026-11-01" },
  { id: "savings", openingBalance: 0, openingDate: "2026-11-01", isSavings: true },
];
const defaults = { spend: "walletA", income: "bankA" };
const bal = (r: Partial<LedgerRecords>, until?: string) => Object.fromEntries(balances(accounts, ledgerMoves({ ...empty, ...r }, defaults), until));

describe("置き場所の残高", () => {
  it("AT-083 開始残高から始まり、開始日より前の記録は数えない。クレカはマイナス", () => {
    expect(bal({ purchases: [{ accountId: "walletA", date: "2026-10-31", amount: 999 }] })).toEqual({ bankA: 100_000, walletA: 5_000, cardA: -12_000, savings: 0 });
  });

  it("AT-084 支出は出どころを、収入は入金先を動かす。null はいつもの置き場所・入金先", () => {
    const r = bal({
      purchases: [
        { accountId: null, date: "2026-11-02", amount: 800 },
        { accountId: "cardA", date: "2026-11-03", amount: 3_000 },
      ],
      incomes: [{ accountId: null, date: "2026-11-25", amount: 60_000 }],
    });
    expect(r).toEqual({ bankA: 160_000, walletA: 4_200, cardA: -15_000, savings: 0 });
  });

  it("AT-085・086 振替は出元を減らし入れ先を増やす。取り消し（0）は動かさない。カードの引き落としで 0 に戻る", () => {
    const r = bal({
      purchases: [{ accountId: "cardA", date: "2026-11-03", amount: 3_000 }],
      transfers: [
        { fromAccountId: "bankA", toAccountId: "walletA", date: "2026-11-02", amount: 10_000 },
        { fromAccountId: "bankA", toAccountId: "cardA", date: "2026-11-10", amount: 15_000 },
        { fromAccountId: "bankA", toAccountId: "walletA", date: "2026-11-11", amount: 0 },
      ],
    });
    expect(r).toEqual({ bankA: 75_000, walletA: 15_000, cardA: 0, savings: 0 });
  });

  it("照合の調整も残高を動かす。until でその日までに絞れる", () => {
    const r = { purchases: [{ accountId: "bankA", date: "2026-11-27", amount: 70_000 }], adjustments: [{ accountId: "walletA", date: "2026-11-05", diff: -800 }] };
    expect(bal(r)).toMatchObject({ bankA: 30_000, walletA: 4_200 });
    expect(bal(r, "2026-11-20")).toMatchObject({ bankA: 100_000, walletA: 4_200 });
  });

  it("AT-119 月の収入・固定費の支払い・支出・振替だけで残高が合う（予算外の入出金はない。docs/take-home-and-fixed-costs.md §8）", () => {
    const r = bal({
      // 手取り月収は振り込まれた額のまま1件。家賃は固定費の支払い（支出と同じ形の記録）
      incomes: [{ accountId: "bankA", date: "2026-11-25", amount: 250_000 }],
      purchases: [
        { accountId: "bankA", date: "2026-11-27", amount: 80_000 },
        { accountId: null, date: "2026-11-26", amount: 1_200 },
      ],
      transfers: [{ fromAccountId: "bankA", toAccountId: "savings", date: "2026-11-25", amount: 30_000 }],
    });
    expect(r).toEqual({ bankA: 240_000, walletA: 3_800, cardA: -12_000, savings: 30_000 });
  });

  it("AT-120 立替を支出、その戻りを臨時の収入で同じ置き場所に記録すると、残高は元に戻る", () => {
    const r = bal({ purchases: [{ accountId: "walletA", date: "2026-11-10", amount: 5_000 }], incomes: [{ accountId: "walletA", date: "2026-11-12", amount: 5_000 }] });
    expect(r).toMatchObject({ walletA: 5_000 });
  });
});

describe("AT-091 貯金用の置き場所への振替", () => {
  it("入れば追加、出れば引出、貯金用どうし・取り消しは数えない", () => {
    const ids = new Set(["savings", "savings2"]);
    const list = [
      { fromAccountId: "bankA", toAccountId: "savings", amount: 20_000 },
      { fromAccountId: "savings", toAccountId: "walletA", amount: 5_000 },
      { fromAccountId: "savings", toAccountId: "savings2", amount: 1_000 },
      { fromAccountId: "bankA", toAccountId: "walletA", amount: 3_000 },
      { fromAccountId: "bankA", toAccountId: "savings", amount: 0 },
    ];
    expect(savingsMoves(list, ids).map((m) => [m.kind, m.amount])).toEqual([
      ["DEPOSIT", 20_000],
      ["WITHDRAW", 5_000],
    ]);
  });
});
