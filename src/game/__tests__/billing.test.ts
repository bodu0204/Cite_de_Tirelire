// カードの請求の区切りと未払い（docs/money-accounts.md §7）
import { describe, expect, it } from "vitest";
import { billingDate, billsByDue, isUnpaid, unpaidSince } from "../billing";

const t15 = { closingDay: 15, paymentDay: 10, paymentMonths: 1 };

describe("AT-087 カードの引き落とし日", () => {
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

describe("AT-087 引き落とし予定の請求額", () => {
  it("利用日を引き落とし日ごとにまとめる（取り消しは除く）", () => {
    const list = [
      { date: "2026-10-01", amount: 1000 }, // 11/10
      { date: "2026-10-15", amount: 2000 }, // 11/10
      { date: "2026-10-20", amount: 4000 }, // 12/10
      { date: "2026-10-21", amount: 0 }, // 取り消し
      { date: "2026-09-10", amount: 8000 }, // 10/10
    ];
    expect([...billsByDue(list, t15)]).toEqual([
      ["2026-10-10", 8000],
      ["2026-11-10", 3000],
      ["2026-12-10", 4000],
    ]);
  });

  it("探す範囲の下限は3か月前の1日（翌々月末払いでも漏れない）", () => {
    expect(unpaidSince("2026-11-14")).toBe("2026-08-01");
    expect(unpaidSince("2026-02-03")).toBe("2025-11-01");
    expect(isUnpaid("2026-07-31", { closingDay: 31, paymentDay: 31, paymentMonths: 2 }, "2026-11-14")).toBe(false);
  });
});
