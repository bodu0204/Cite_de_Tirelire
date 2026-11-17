import { describe, expect, it } from "vitest";
import { MICRO_PER_GOLD } from "../config";
import { newMine } from "../mine";
import { depositToBond, lotOrder, pay, payableSources, refund, summarize, type Lot, type Payment, type Purse } from "../settle";
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

// 外食のジャンルに 食費コイン 1,200（3日後に期限）と 外食コイン 800（期限なし）が使える。未回収 300G、所持 1,000G
function twoCoins(o: Partial<{ bond: number; silver: number; freeBond: number }> = {}) {
  const { p } = purse({ uncollected: 300, gold: 1000, bond: o.bond ?? 0, silver: o.silver ?? 100 });
  p.mine = { ...p.mine, freeBond: o.freeBond ?? 0 };
  const lots: Lot[] = [
    { id: "f1", currencyId: "food", issuedAt: T, expiresAt: T + 3 * 86_400_000, amount: 1200, remaining: 1200 },
    { id: "e1", currencyId: "eat", issuedAt: T, expiresAt: null, amount: 800, remaining: 800 },
  ];
  const left = () => ({ food: lots[0].remaining, eat: lots[1].remaining, gold: p.gold + uncollected(p), bond: p.bond });
  return { p, lots, left };
}

describe("AT-094 使う通貨を選ぶ（§6.3）", () => {
  const FOOD = { currency: "CUSTOM", currencyId: "food" } as const;
  const EAT = { currency: "CUSTOM", currencyId: "eat" } as const;
  const GOLD = { currency: "GOLD" } as const;

  it("選ばなければ、使える通貨をすべて使う（期限の近いユーザ通貨 → 金貨）", () => {
    const { p, lots, left } = twoCoins();
    pay(p, 2500, lots, []);
    expect(left()).toEqual({ food: 0, eat: 0, gold: 800, bond: 0 });
  });

  it("選んだ通貨だけを使う（選ばなかった通貨は残る）", () => {
    const { p, lots, left } = twoCoins();
    const payments: Payment[] = [];
    pay(p, 500, lots, payments, [EAT]);
    expect(left()).toEqual({ food: 1200, eat: 300, gold: 1300, bond: 0 });
    expect(summarize(payments).custom).toEqual([{ currencyId: "eat", lotId: "e1", amount: 500 }]);
  });

  it("いくつも選べる：選んだ通貨の中では、期限の近いユーザ通貨 → 金貨の順", () => {
    const { p, lots, left } = twoCoins();
    pay(p, 1500, lots, [], [GOLD, FOOD]);
    expect(left()).toEqual({ food: 0, eat: 800, gold: 1000, bond: 0 });
  });

  it("選んだ通貨で足りない分は債券で払う（手数料あり）。選ばなかった通貨は使わない", () => {
    const { p, lots, left } = twoCoins();
    const payments: Payment[] = [];
    pay(p, 1000, lots, payments, [EAT]);
    expect(left()).toEqual({ food: 1200, eat: 0, gold: 1300, bond: -200 });
    expect(summarize(payments)).toMatchObject({ gold: 0, bond: 200, feeSilver: 20 });
    expect(p.overspend).toBe(200);
  });

  it("金貨を選ぶと、未回収 → 所持 → 同じ期間に確定した債券の取り崩し（手数料なし）の順に払う", () => {
    const { p, lots, left } = twoCoins({ bond: 5000, freeBond: 2000 });
    const payments: Payment[] = [];
    pay(p, 2000, lots, payments, [GOLD]);
    expect(left()).toEqual({ food: 1200, eat: 800, gold: 0, bond: 4300 });
    expect(summarize(payments)).toMatchObject({ gold: 1300, draw: 700, bond: 0, feeSilver: 0, feeBond: 0 });
    expect(p.overspend).toBe(0);
  });

  it("足りない分を債券で払うときも、同じ期間に確定した分の取り崩し（手数料なし）が先", () => {
    const { p, lots, left } = twoCoins({ bond: 5000, freeBond: 300 });
    const payments: Payment[] = [];
    pay(p, 1500, lots, payments, [EAT]);
    expect(left()).toEqual({ food: 1200, eat: 0, gold: 1300, bond: 4300 });
    expect(summarize(payments)).toMatchObject({ gold: 0, draw: 300, bond: 400, feeSilver: 40 });
  });
});

describe("AT-095 通貨ごとに額を決める（§6.3）", () => {
  const mix = [
    { currency: "CUSTOM", currencyId: "food", amount: 500 },
    { currency: "CUSTOM", currencyId: "eat", amount: 300 },
    { currency: "GOLD", amount: 200 },
  ] as const;

  it("通貨ごとに決めた額で払う", () => {
    const { p, lots, left } = twoCoins();
    const payments: Payment[] = [];
    pay(p, 1000, lots, payments, [...mix]);
    expect(left()).toEqual({ food: 700, eat: 500, gold: 1100, bond: 0 });
    expect(summarize(payments)).toMatchObject({ gold: 200, bond: 0 });
    expect(summarize(payments).custom).toEqual([
      { currencyId: "food", lotId: "f1", amount: 500 },
      { currencyId: "eat", lotId: "e1", amount: 300 },
    ]);
  });

  it("決めた額の合計が足りない分は債券で払う", () => {
    const { p, lots, left } = twoCoins();
    const payments: Payment[] = [];
    pay(p, 1000, lots, payments, [mix[1], mix[2]]);
    expect(left()).toEqual({ food: 1200, eat: 500, gold: 1100, bond: -500 });
    expect(summarize(payments)).toMatchObject({ gold: 200, bond: 500, feeSilver: 50 });
  });

  it("残高を超える額を決めても、残高までしか使わない（マイナスにしない）", () => {
    const { p, lots, left } = twoCoins();
    pay(p, 3000, lots, [], [
      { currency: "CUSTOM", currencyId: "eat", amount: 2000 },
      { currency: "GOLD", amount: 1000 },
    ]);
    expect(left()).toEqual({ food: 1200, eat: 0, gold: 300, bond: -1200 });
  });

  it("払い戻すと、それぞれの通貨と債券・手数料が元に戻る", () => {
    const { p, lots, left } = twoCoins();
    const payments: Payment[] = [];
    pay(p, 1500, lots, payments, [...mix]);
    refund(p, 1500, payments, (id) => ({ lot: lots.find((l) => l.id === id) }));
    expect(left()).toEqual({ food: 1200, eat: 800, gold: 1300, bond: 0 });
    expect(p.silver).toBe(100);
    expect(payments).toEqual([]);
  });
});

describe("AT-096 支払いに使える通貨の一覧（§6.3）", () => {
  it("ユーザ通貨（通貨の並び順）→ 金貨。金貨は 未回収 ＋ 所持 ＋ 手数料なしで取り崩せる債券", () => {
    const { p, lots } = twoCoins({ bond: 5000, freeBond: 2000 });
    expect(payableSources(p, lots, ["eat", "food"])).toEqual([
      { currency: "CUSTOM", currencyId: "eat", available: 800 },
      // 初めに選ばれているのは、いつもの順で最初に使う（期限の近い）食費コイン
      { currency: "CUSTOM", currencyId: "food", available: 1200, first: true },
      { currency: "GOLD", currencyId: null, available: 3300, draw: 2000 },
    ]);
  });

  it("払える額のない通貨は出さない。債券がマイナスなら取り崩せない", () => {
    const { p, lots } = purse({ coin: 1000, bond: -500 });
    p.mine = { ...p.mine, freeBond: 2000 };
    lots[0].remaining = 0;
    expect(payableSources(p, lots, ["food"])).toEqual([]);
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
