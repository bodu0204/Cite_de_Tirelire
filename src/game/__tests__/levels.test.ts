import { describe, expect, it } from "vitest";
import { STATUE_GOLD_FROM } from "../config";
import { exchangeRate, quoteResourceExchange } from "../exchange";
import { achievementRate, bankLevel, bankLevelBand, DISPLAYED, JUDGED, projectedRate, savingsAmount, savingsProgress, statueRank, techLevel } from "../levels";

describe("AT-003 貯金記録と銀行", () => {
  it("目標100,000円に20,000円で達成率20%・銀行Lv2", () => {
    const { net } = savingsProgress([{ kind: "DEPOSIT", amount: 20000 }]);
    const rate = achievementRate(net, 100000);
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

describe("見込み貯金", () => {
  it("表示の達成率は記録した純増額に見込みを上乗せする", () => {
    expect(projectedRate(20000, 5000, 100000)).toBe(25);
  });

  it("純増額が負でも見込みだけは表示に乗る", () => {
    expect(projectedRate(-3000, 5000, 100000)).toBe(5);
  });

  it("見込みを含めると銀行Lvが変わってしまうため、判定には実額の達成率を使う", () => {
    expect(bankLevel(achievementRate(15000, 100000))).toBe(1);
    expect(bankLevel(projectedRate(15000, 10000, 100000))).toBe(2);
  });
});

describe("BND-08 債券は表示の達成率にだけ含める", () => {
  it("純増額 ＋ 見込み ＋ 債券", () => {
    expect(projectedRate(20000, 5000, 100000, 10000)).toBe(35);
  });

  it("債券がマイナスなら減らすが、全体は0未満にしない", () => {
    expect(projectedRate(20000, 0, 100000, -5000)).toBe(15);
    expect(projectedRate(1000, 0, 100000, -5000)).toBe(0);
  });

  it("判定に使う額には含めない（切り替えは include で1か所）", () => {
    const parts = { net: 20000, estimated: 5000, bond: 10000 };
    expect(savingsAmount(parts, JUDGED)).toBe(20000);
    expect(savingsAmount(parts, DISPLAYED)).toBe(35000);
  });
});

describe("技術Lv", () => {
  it("AT-010 15,000円で技術Lv3", () => {
    expect(techLevel(savingsProgress([{ kind: "DEPOSIT", amount: 15000 }]).max)).toBe(3);
  });

  it("引出しても最高到達額で判定するので下がらない", () => {
    const p = savingsProgress([
      { kind: "DEPOSIT", amount: 30000 },
      { kind: "WITHDRAW", amount: 20000 },
    ]);
    expect(p.net).toBe(10000);
    expect(techLevel(p.max)).toBe(4);
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
