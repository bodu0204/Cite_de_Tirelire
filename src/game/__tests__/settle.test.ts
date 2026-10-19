import { describe, expect, it } from "vitest";
import { MICRO_PER_GOLD } from "../config";
import { newMine } from "../mine";
import { depositToBond, lotOrder, pay, refund, summarize, type Lot, type Payment, type Purse } from "../settle";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const T = zonedTimeToUtc(2026, 10, 19, TZ);

function purse(o: Partial<{ coin: number; uncollected: number; gold: number; bond: number; silver: number; cap: number }> = {}) {
  const p: Purse = {
    mine: { ...newMine(T, TZ), uncollected: BigInt(o.uncollected ?? 0) * MICRO_PER_GOLD },
    gold: o.gold ?? 0,
    silver: o.silver ?? 0,
    bond: o.bond ?? 0,
    bondCap: o.cap ?? 180000,
    moves: [],
    overspend: 0,
  };
  const lots: Lot[] = o.coin ? [{ id: "lot1", currencyId: "food", issuedAt: T, expiresAt: null, amount: o.coin, remaining: o.coin }] : [];
  return { p, lots };
}

const uncollected = (p: Purse) => Number(p.mine.uncollected / MICRO_PER_GOLD);

describe("AT-016 精算順（§6.1 の例）", () => {
  it("食費 5,000円：コイン 1,200 → 未回収 300 → 所持 1,000 → 債券 2,500 ＋ 手数料 50（銀貨 30・債券 20）", () => {
    const { p, lots } = purse({ coin: 1200, uncollected: 300, gold: 1000, bond: 10000, silver: 30 });
    const payments: Payment[] = [];
    pay(p, 5000, lots, payments);
    expect(summarize(payments)).toMatchObject({ gold: 1300, bond: 2500, feeSilver: 30, feeBond: 20 });
    expect(summarize(payments).custom).toEqual([{ currencyId: "food", lotId: "lot1", amount: 1200 }]);
    expect(lots[0].remaining).toBe(0);
    expect(uncollected(p)).toBe(0);
    expect(p.gold).toBe(0);
    expect(p.silver).toBe(0);
    expect(p.bond).toBe(7480);
    expect(p.overspend).toBe(2500);
  });

  it("債券 0 から不足 300：手数料 30S、債券 −300", () => {
    const { p } = purse({ silver: 100 });
    pay(p, 300, [], []);
    expect(p.bond).toBe(-300);
    expect(p.silver).toBe(70);
  });

  it("債券 0 から不足 3,000・銀貨 0：手数料 50 を債券から引き −3,050", () => {
    const { p } = purse();
    pay(p, 3000, [], []);
    expect(p.bond).toBe(-3050);
    expect(p.silver).toBe(0);
  });

  it("金貨・銀貨・ユーザ通貨は負にならない", () => {
    const { p, lots } = purse({ coin: 10, gold: 5, silver: 3 });
    pay(p, 100000, lots, []);
    expect(Math.min(p.gold, p.silver, lots[0].remaining, uncollected(p))).toBe(0);
  });
});

describe("AT-021 ジャンルが一致しないユーザ通貨は使わない", () => {
  it("使えるロットを渡さなければ金貨から払う（呼び出し側がジャンルで絞る）", () => {
    const { p, lots } = purse({ coin: 1000, gold: 2000 });
    pay(p, 500, [], []);
    expect(lots[0].remaining).toBe(1000);
    expect(p.gold).toBe(1500);
  });
});

describe("ロットの使う順", () => {
  it("期限の近い順、同じなら通貨の並び順", () => {
    const lots: Lot[] = [
      { id: "a", currencyId: "x", issuedAt: 1, expiresAt: null, amount: 1, remaining: 1 },
      { id: "b", currencyId: "y", issuedAt: 1, expiresAt: 500, amount: 1, remaining: 1 },
      { id: "c", currencyId: "x", issuedAt: 2, expiresAt: 500, amount: 1, remaining: 1 },
      { id: "d", currencyId: "x", issuedAt: 0, expiresAt: 100, amount: 1, remaining: 1 },
    ];
    const order: Record<string, number> = { x: 0, y: 1 };
    expect(lots.sort(lotOrder((id) => order[id])).map((l) => l.id)).toEqual(["d", "c", "b", "a"]);
  });
});

describe("AT-028 払い戻しは内訳の逆順", () => {
  const setup = () => {
    const { p, lots } = purse({ coin: 1200, uncollected: 300, gold: 1000, bond: 10000, silver: 30 });
    const payments: Payment[] = [];
    pay(p, 5000, lots, payments);
    return { p, lots, payments, resolve: (id: string) => ({ lot: lots.find((l) => l.id === id) }) };
  };

  it("削除すると 債券・手数料（銀貨と債券）・金貨・コイン が戻り、残高が購入前と一致する", () => {
    const { p, lots, payments, resolve } = setup();
    refund(p, 5000, payments, resolve);
    expect(p.bond).toBe(10000);
    expect(p.silver).toBe(30);
    // 未回収から払った分も所持金貨へ戻る（金貨の合計は購入前と同じ）
    expect(p.gold + uncollected(p)).toBe(1300);
    expect(lots[0].remaining).toBe(1200);
    expect(p.overspend).toBe(0);
    expect(payments).toEqual([]);
  });

  it("5,000 → 4,500 に減額すると債券の支払いは 2,000、手数料は 50 のまま", () => {
    const { p, payments, resolve } = setup();
    refund(p, 500, payments, resolve);
    expect(summarize(payments)).toMatchObject({ bond: 2000, feeSilver: 30, feeBond: 20 });
    expect(p.bond).toBe(7980);
  });

  it("債券 2,500 → 400 に減らすと手数料は 50 → 40 になり、債券から引いた分から先に 10 を返す", () => {
    const { p, payments, resolve } = setup();
    refund(p, 2100, payments, resolve);
    expect(summarize(payments)).toMatchObject({ bond: 400, feeSilver: 30, feeBond: 10 });
    expect(p.silver).toBe(0);
  });

  it("増額で債券の支払いが増えても上限 50S を超えて取らない", () => {
    const { p, lots, payments } = setup();
    pay(p, 3000, lots, payments);
    expect(summarize(payments)).toMatchObject({ bond: 5500, feeSilver: 30, feeBond: 20 });
  });

  it("期限切れのロットへの払い戻しは、その場で債券へ（上限を超える分は金貨）", () => {
    const { p, lots } = purse({ coin: 1000, bond: 179500, cap: 180000 });
    const payments: Payment[] = [];
    pay(p, 800, lots, payments);
    refund(p, 800, payments, (id) => ({ lot: lots.find((l) => l.id === id), expiredToBond: true }));
    expect(lots[0].remaining).toBe(200);
    expect(p.bond).toBe(180000);
    expect(p.gold).toBe(300);
  });

  it("削除済みの通貨のロットへの払い戻しは所持金貨へ", () => {
    const { p, lots } = purse({ coin: 1000 });
    const payments: Payment[] = [];
    pay(p, 600, lots, payments);
    refund(p, 600, payments, () => ({}));
    expect(p.gold).toBe(600);
  });
});

describe("債券への預け入れ", () => {
  it("上限を超える分は所持金貨へ", () => {
    const { p } = purse({ bond: 179000, cap: 180000 });
    depositToBond(p, 5000, "currency_expire_bond");
    expect(p.bond).toBe(180000);
    expect(p.gold).toBe(4000);
  });
});
