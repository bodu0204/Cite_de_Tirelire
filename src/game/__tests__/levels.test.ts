import { describe, expect, it } from "vitest";
import { STATUE_GOLD_FROM } from "../config";
import { exchangeRate, quoteResourceExchange } from "../exchange";
import { achievementRate, bankLevel, bankLevelBand, savingsProgress, savingsRate, savingsTotal, statueRank, techLevel } from "../levels";

describe("AT-003 貯金額と銀行", () => {
  it("目標100,000円に貯金額20,000円で達成率20%・銀行Lv2", () => {
    const rate = savingsRate({ bond: 12000, citySpent: 8000 }, 100000);
    expect(rate).toBe(20);
    expect(bankLevel(rate)).toBe(2);
  });

  it("銀行Lvの区間を金額で返す", () => {
    expect(bankLevelBand(100000, 2)).toEqual({ from: 20000, next: 40000 });
    expect(bankLevelBand(100000, 1)).toEqual({ from: 0, next: 20000 });
    expect(bankLevelBand(100000, 6)).toEqual({ from: 100000, next: null });
  });

  it("100%で銀行は完成（Lv6）", () => {
    expect(bankLevel(achievementRate(100000, 100000))).toBe(6);
  });
});

describe("AT-053 貯金額 ＝ 債券 ＋ 都市に使った金貨", () => {
  it("債券と都市に使った金貨を足す", () => {
    expect(savingsTotal({ bond: 10000, citySpent: 5000 })).toBe(15000);
  });

  it("債券がマイナスなら減らし、達成率は0未満にしない", () => {
    expect(savingsTotal({ bond: -5000, citySpent: 20000 })).toBe(15000);
    expect(savingsRate({ bond: -5000, citySpent: 1000 }, 100000)).toBe(0);
  });

  it("技術Lvは最高到達額で決まり、債券を使って貯金額が下がっても下がらない", () => {
    const max = Math.max(savingsTotal({ bond: 30000, citySpent: 0 }), savingsTotal({ bond: 10000, citySpent: 0 }));
    expect(techLevel(max)).toBe(4);
  });
});

describe("技術Lv", () => {
  it("AT-010 15,000円で技術Lv3", () => {
    expect(techLevel(15000)).toBe(3);
  });

  it("貯金管理の純増額と最高到達額（推測 E5 用）", () => {
    const p = savingsProgress([
      { kind: "DEPOSIT", amount: 30000 },
      { kind: "WITHDRAW", amount: 20000 },
    ]);
    expect(p.net).toBe(10000);
    expect(p.max).toBe(30000);
  });

  it("純増額が負なら達成率は0", () => {
    expect(achievementRate(-5000, 100000)).toBe(0);
  });
});

describe("資源交換", () => {
  const levels = [
    { bank: 1, goldMine: 1, silverMine: 1 },
    { bank: 6, goldMine: 1, silverMine: 6 },
    { bank: 6, goldMine: 6, silverMine: 6 },
  ];
  it("基準状態で 1G→木材10、1S→木材1", () => {
    expect(exchangeRate("gold", "wood", levels[0])).toBe(10);
    expect(exchangeRate("silver", "wood", levels[0])).toBe(1);
  });

  it("どのレベルでも 金貨→銀貨→資源 は 金貨→資源 より有利にならない", () => {
    for (const lv of levels) {
      for (const r of ["wood", "stone", "food"] as const) {
        expect(exchangeRate("silver", r, lv)).toBeLessThanOrEqual(exchangeRate("gold", r, lv));
      }
    }
  });

  it("銀貨払いは代金＋手数料、金貨払いは手数料のみ銀貨", () => {
    expect(quoteResourceExchange("silver", "wood", 50, levels[0]).silverCost).toBe(55);
    expect(quoteResourceExchange("gold", "wood", 50, levels[0]).silverCost).toBe(5);
  });
});

describe("像の分類", () => {
  it("価格で銅・銀・金", () => {
    expect(statueRank(4999)).toBe("bronze");
    expect(statueRank(5000)).toBe("silver");
    expect(statueRank(STATUE_GOLD_FROM)).toBe("gold");
  });
});
