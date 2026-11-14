// カードの請求の区切りと未払い（docs/payment-method-sync.md §5、AT-084）
import { describe, expect, it } from "vitest";
import { billingDate, cardUnpaid, isUnpaid, unpaidSince } from "../billing";

const t15 = { closingDay: 15, paymentDay: 10, paymentMonths: 1 };

describe("AT-084 カードの引き落とし日", () => {
  it("15日締め・翌月10日払い：10/14 は 11/10、10/15 も 11/10、10/16 は 12/10", () => {
    expect(billingDate("2026-10-14", t15)).toBe("2026-11-10");
    expect(billingDate("2026-10-15", t15)).toBe("2026-11-10");
    expect(billingDate("2026-10-16", t15)).toBe("2026-12-10");
  });

  it("年をまたぐ", () => {
    expect(billingDate("2026-12-20", t15)).toBe("2027-02-10");
    expect(billingDate("2026-12-01", { closingDay: 31, paymentDay: 27, paymentMonths: 1 })).toBe("2027-01-27");
  });

  it("末日締め（31）は短い月で末日になり、引き落とし日も末日に寄せる", () => {
    const t = { closingDay: 31, paymentDay: 31, paymentMonths: 1 };
    expect(billingDate("2026-02-28", t)).toBe("2026-03-31");
    expect(billingDate("2026-03-31", t)).toBe("2026-04-30");
    expect(billingDate("2026-01-31", t)).toBe("2026-02-28");
  });

  it("翌々月払い", () => {
    expect(billingDate("2026-10-14", { closingDay: 15, paymentDay: 10, paymentMonths: 2 })).toBe("2026-12-10");
  });

  it("引き落とし日になったら未払いから外れる", () => {
    expect(isUnpaid("2026-10-14", t15, "2026-11-09")).toBe(true);
    expect(isUnpaid("2026-10-14", t15, "2026-11-10")).toBe(false);
  });
});

describe("カードの未払い", () => {
  it("引き落とし日がまだ来ていない分の合計と、次回の引き落とし", () => {
    const list = [
      { date: "2026-10-01", amount: 1000 }, // 11/10
      { date: "2026-10-14", amount: 2000 }, // 11/10
      { date: "2026-10-20", amount: 4000 }, // 12/10
      { date: "2026-10-21", amount: 0 }, // 取り消し
      { date: "2026-09-10", amount: 8000 }, // 10/10（引き落とし済み）
    ];
    expect(cardUnpaid(list, t15, "2026-10-25")).toEqual({ amount: 7000, next: { date: "2026-11-10", amount: 3000 } });
    expect(cardUnpaid(list, t15, "2026-11-10")).toEqual({ amount: 4000, next: { date: "2026-12-10", amount: 4000 } });
    expect(cardUnpaid(list, t15, "2026-12-10")).toEqual({ amount: 0, next: null });
  });

  it("探す範囲の下限は3か月前の1日（翌々月末払いでも漏れない）", () => {
    expect(unpaidSince("2026-11-14")).toBe("2026-08-01");
    expect(unpaidSince("2026-02-03")).toBe("2025-11-01");
    // 8/1 の利用を末日締め・翌々月末払いにしても 10/31 で、11/14 には引き落とし済み
    expect(isUnpaid("2026-07-31", { closingDay: 31, paymentDay: 31, paymentMonths: 2 }, "2026-11-14")).toBe(false);
  });
});
