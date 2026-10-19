import { describe, expect, it } from "vitest";
import { DAY } from "../config";
import { BudgetPlan, budgetOverruns, dayEvents, nextOccurrences, type CurrencyDefLite, type Rule } from "../currency";
import { dayKey, monthRange, zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const at = (y: number, m: number, d: number) => zonedTimeToUtc(y, m, d, TZ);

function def(rules: Rule[], extra: Partial<CurrencyDefLite> = {}): CurrencyDefLite {
  return {
    id: "food",
    name: "食費コイン",
    icon: "🍙",
    categoryIds: ["c-food"],
    rules,
    remainder: "KEEP",
    remainderDays: null,
    startDate: "2026-01-01",
    endDate: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra,
  };
}

const days = (d: CurrencyDefLite, from: number, to: number) => dayEvents(d, from, to, TZ).map((e) => `${dayKey(e.at, TZ)}:${e.amount}`);

describe("AT-022 周期ルール", () => {
  it("毎月31日 → 2月は末日", () => {
    const d = def([{ kind: "monthDays", days: [31], amount: 100 }]);
    expect(days(d, at(2026, 1, 31), at(2026, 4, 1))).toEqual(["2026-02-28:100", "2026-03-31:100"]);
  });

  it("第2火曜", () => {
    const d = def([{ kind: "monthNth", nth: [2], weekdays: [2], amount: 1 }]);
    expect(days(d, at(2026, 9, 30), at(2026, 12, 31))).toEqual(["2026-10-13:1", "2026-11-10:1", "2026-12-08:1"]);
  });

  it("最終金曜", () => {
    const d = def([{ kind: "monthNth", nth: [-1], weekdays: [5], amount: 1 }]);
    expect(days(d, at(2026, 9, 30), at(2027, 1, 1))).toEqual(["2026-10-30:1", "2026-11-27:1", "2026-12-25:1"]);
  });

  it("起点 1/15 の2か月ごと15日 → 3/15・5/15", () => {
    const d = def([{ kind: "everyMonths", every: 2, days: [15], amount: 1 }], { startDate: "2026-01-15" });
    expect(days(d, at(2026, 1, 15), at(2026, 6, 30))).toEqual(["2026-03-15:1", "2026-05-15:1"]);
  });

  it("N週ごと：起点日を含む週から数える（月曜始まり）", () => {
    // 2026-10-07（水）起点、2週ごとの月・木
    const d = def([{ kind: "weekly", every: 2, weekdays: [1, 4], amount: 1 }], { startDate: "2026-10-07" });
    expect(days(d, at(2026, 10, 1), at(2026, 10, 31))).toEqual(["2026-10-08:1", "2026-10-19:1", "2026-10-22:1"]);
  });
});

describe("AT-023 カレンダー指定日だけの通貨", () => {
  const d = def([{ kind: "dates", dates: ["2026-12-24", "2026-12-31"], amount: 5000 }]);

  it("その日の0:00に発生し、他の日は発生しない", () => {
    expect(days(d, at(2026, 12, 1), at(2027, 1, 31))).toEqual(["2026-12-24:5000", "2026-12-31:5000"]);
  });

  it("始点（シーズン開始・作成時刻）より前の日付は発生しない", () => {
    expect(days(d, at(2026, 12, 25), at(2027, 1, 31))).toEqual(["2026-12-31:5000"]);
  });
});

describe("AT-024 同じ日に当たったルールは合算して1ロット", () => {
  it("毎週月曜 7,000 と 12/28 に 3,000：2026-12-28（月曜）は 10,000", () => {
    const d = def([
      { kind: "weekly", every: 1, weekdays: [1], amount: 7000 },
      { kind: "dates", dates: ["2026-12-28"], amount: 3000 },
    ]);
    expect(days(d, at(2026, 12, 27), at(2026, 12, 29))).toEqual(["2026-12-28:10000"]);
  });
});

describe("有効期間", () => {
  it("開始日より前・終了日以降は発生しない", () => {
    const d = def([{ kind: "weekly", every: 1, weekdays: [1], amount: 1 }], { startDate: "2026-10-06", endDate: "2026-10-26" });
    expect(days(d, at(2026, 10, 1), at(2026, 11, 30))).toEqual(["2026-10-12:1", "2026-10-19:1"]);
  });

  it("次の5回の発生日", () => {
    const d = def([{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }]);
    expect(nextOccurrences(d, at(2026, 10, 19) + 1000, TZ).map((o) => o.date)).toEqual(["2026-10-26", "2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"]);
  });
});

describe("AT-025 採掘から差し引く月の発生額 C", () => {
  const subs = [{ monthly: 6000, startAt: 0, endAt: null }];
  const food = def([{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }]);

  it("B＝60,000、S＝6,000、毎週月曜 7,000：2026-10 の採掘は 26,000、2026-11 は 19,000", () => {
    const plan = new BudgetPlan(60000, subs, [food], TZ);
    expect(plan.customAt(at(2026, 10, 15))).toBe(28000);
    expect(plan.netAt(at(2026, 10, 15))).toBe(26000);
    expect(plan.customAt(at(2026, 11, 15))).toBe(35000);
    expect(plan.netAt(at(2026, 11, 15))).toBe(19000);
  });

  it("毎分ルールは月あたりの量そのもの（有効な間だけ）", () => {
    const d = def([{ kind: "minute", monthlyAmount: 10000 }], { startDate: "2026-10-10" });
    const plan = new BudgetPlan(60000, [], [d], TZ);
    expect(plan.netAt(at(2026, 10, 5))).toBe(60000);
    expect(plan.netAt(at(2026, 10, 15))).toBe(50000);
    expect(plan.changePoints()).toContain(at(2026, 10, 10));
  });
});

describe("AT-025a 自由予算を超える設定", () => {
  const subs = [{ monthly: 6000, startAt: 0, endAt: null }];
  const now = at(2026, 10, 19);

  it("毎週月曜 11,000 は 2026-11（月曜5回、C＝55,000 > 54,000）で超える", () => {
    const plan = new BudgetPlan(60000, subs, [def([{ kind: "weekly", every: 1, weekdays: [1], amount: 11000 }])], TZ);
    const over = budgetOverruns(plan, now);
    expect(over.map((o) => o.monthKey)).toContain("2026-11");
    expect(over.find((o) => o.monthKey === "2026-11")!.over).toBe(1000);
    expect(over.map((o) => o.monthKey)).not.toContain("2026-10");
  });

  it("毎週月曜 7,000 は超えないが、予算を 40,000 に下げると超える", () => {
    const food = def([{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }]);
    expect(budgetOverruns(new BudgetPlan(60000, subs, [food], TZ), now)).toEqual([]);
    expect(budgetOverruns(new BudgetPlan(40000, subs, [food], TZ), now).length).toBeGreaterThan(0);
  });

  it("確かめるのは今月から12か月先まで、それより先はカレンダー指定日のある月", () => {
    const far = def([{ kind: "dates", dates: ["2028-05-01"], amount: 100000 }]);
    const over = budgetOverruns(new BudgetPlan(60000, subs, [far], TZ), now);
    expect(over.map((o) => o.monthKey)).toEqual(["2028-05"]);
  });

  it("月の途中で終わるサブスクと始まる毎分ルールが重ならなければ超えない", () => {
    const novStart = monthRange(at(2026, 11, 1), TZ).start;
    const sub = [{ monthly: 30000, startAt: 0, endAt: novStart + 10 * DAY }];
    const d = def([{ kind: "minute", monthlyAmount: 40000 }], { startDate: "2026-11-15" });
    const over = budgetOverruns(new BudgetPlan(60000, sub, [d], TZ), now);
    expect(over).toEqual([]);
  });
});
