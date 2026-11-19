// 手取り月収と固定費（docs/take-home-and-fixed-costs.md）：自由予算 ＝ 手取り月収 − 固定費、M ＝ 手取り月収、支払いの行
import { describe, expect, it } from "vitest";
import { bondCap, splitCarried } from "../bond";
import { createCity, seasonBase } from "../city/init";
import { HOUR, MINUTE, RESERVE_LEVEL_MONTHS } from "../config";
import { BudgetPlan, budgetOverruns, type CurrencyDefLite } from "../currency";
import { nextReserveAt, reserveLevel } from "../fund";
import { advance, type World } from "../idle";
import { accrue, collect, newMine, ratePerMinute, type SubWindow } from "../mine";
import { duePayments, monthlyEquivalent, payDayIn, suggestedAmount, type DuePeriod, type Recurring } from "../recurring";
import { monthCal, periodKey, periodRange, zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const at = (y: number, m: number, d: number) => zonedTimeToUtc(y, m, d, TZ);
// 2026年9月は30日間
const SEP1 = at(2026, 9, 1);
const always = (monthly: number): SubWindow => ({ monthly, startAt: 0, endAt: null });

describe("AT-108・109 自由予算 ＝ 手取り月収 − 固定費", () => {
  // 手取り月収 180,000円・固定費 120,000円・サブスク 6,000円
  const plan = new BudgetPlan(180_000, [always(6_000)], [], TZ, [always(80_000), always(40_000)]);

  it("自由予算 60,000円、配当 1.25G/分（30日の期間）", () => {
    expect(plan.fixedAt(SEP1)).toBe(120_000);
    expect(plan.budgetAt(SEP1)).toBe(60_000);
    expect(plan.netAt(SEP1)).toBe(54_000);
    expect(ratePerMinute(plan, SEP1 + HOUR, TZ)).toBeCloseTo(1.25, 10);
  });

  it("債券の上限と備えLv は手取り月収で決まる（固定費では下げない）：上限 540,000、備えLv1 は 90,000 から", () => {
    expect(bondCap(plan.income)).toBe(540_000);
    expect(reserveLevel(89_999, plan.income)).toBe(0);
    expect(reserveLevel(90_000, plan.income)).toBe(1);
    expect(nextReserveAt(0, plan.income)).toBe(90_000);
    expect(RESERVE_LEVEL_MONTHS.map((m) => m * plan.income)).toEqual([90_000, 180_000, 360_000, 540_000]);
  });

  it("基準額と持ち込みの備えの分け方も手取り月収で決まる", () => {
    expect(seasonBase(plan.income, 1_000_000)).toBe(180_000);
    expect(seasonBase(plan.income, 100_000)).toBe(100_000);
    expect(splitCarried(1_000_000, plan.income)).toEqual({ reserve: 540_000, savings: 460_000 });
  });

  it("AT-109 固定費がなければ 自由予算 ＝ 手取り月収 で、AT-001 と同じ配当になる", () => {
    const p = new BudgetPlan(60_000, [always(6_000)], [], TZ);
    expect(p.budgetAt(SEP1)).toBe(60_000);
    expect(ratePerMinute(p, SEP1 + HOUR, TZ)).toBeCloseTo(1.25, 10);
    const start = SEP1 + 3 * HOUR;
    expect(collect(accrue(newMine(start, TZ), { plan: p, tz: TZ, until: start + 60 * MINUTE }).mine).gold).toBe(75);
  });

  it("月の内訳（固定費・自由予算・サブスク・配当）", () => {
    expect(plan.monthSummary(SEP1)).toEqual({ fixed: 120_000, budget: 60_000, subs: 6_000, custom: 0, net: 54_000 });
  });
});

describe("AT-110 期間の途中で固定費を足す", () => {
  it("その時刻から配当の速度が下がり、それまでの配当は変わらない", () => {
    const start = SEP1;
    const late: SubWindow[] = [{ monthly: 43_200, startAt: start + 30 * MINUTE, endAt: null }];
    const plan = new BudgetPlan(86_400, [], [], TZ, late);
    // 30日 ＝ 43,200分。前半30分は 86,400/43,200 ＝ 2G/分、後半30分は 43,200/43,200 ＝ 1G/分
    const { mine } = accrue(newMine(start, TZ), { plan, tz: TZ, until: start + 60 * MINUTE });
    expect(collect(mine).gold).toBe(30 * 2 + 30 * 1);
    expect(plan.changePoints()).toEqual([start + 30 * MINUTE]);
  });

  it("放置計算の債券の上限と備えLv は、固定費があっても手取り月収のまま", () => {
    const M = 100_000;
    const T0 = at(2026, 9, 1) + 9 * HOUR;
    const plan = new BudgetPlan(M, [], [], TZ, [always(60_000)]);
    const w: World = {
      purse: { mine: newMine(T0, TZ), gold: 0, silver: 100, bond: 50_000, bondCap: 0, moves: [], overspend: 0 },
      city: createCity(T0, M),
      lots: [],
      accruals: new Map(),
    };
    advance(w, { plan, bondRate: 0, newId: () => "l", until: T0 + 2 * HOUR, estimatePerDay: 1e9 }, []);
    expect(w.purse.bondCap).toBe(300_000);
    // 債券 50,000 は手取り月収の 0.5 か月分 → 備えLv1（自由予算 40,000 で数えれば Lv2 になってしまう）
    expect(w.city.reserveLevel).toBe(1);
  });
});

describe("AT-116 固定費が手取り月収を超える", () => {
  const now = at(2026, 9, 10);

  it("自由予算と配当は 0 になり、超える月として返る（保存は拒否しない。警告に使う）", () => {
    const plan = new BudgetPlan(100_000, [always(3_000)], [], TZ, [always(120_000)]);
    expect(plan.budgetAt(now)).toBe(0);
    expect(plan.netAt(now)).toBe(0);
    const over = budgetOverruns(plan, now);
    expect(over.length).toBeGreaterThan(0);
    expect(over[0]).toEqual({ monthKey: "2026-09", deduction: 123_000, over: 23_000, fixedOver: 20_000 });
  });

  it("手取り月収を下げて B − S − C が負になる月があると、超える月が返る（保存できない判定に使う）", () => {
    const food: CurrencyDefLite = {
      id: "food",
      name: "食費",
      icon: "🍚",
      categoryIds: [],
      rules: [{ kind: "monthDays", days: [1], amount: 30_000 }],
      remainder: "KEEP",
      remainderDays: null,
      startDate: "2026-01-01",
      endDate: null,
      sortOrder: 0,
      createdAt: 0,
    };
    const fixed = [always(120_000)];
    expect(budgetOverruns(new BudgetPlan(160_000, [always(6_000)], [food], TZ, fixed), now)).toEqual([]);
    const over = budgetOverruns(new BudgetPlan(150_000, [always(6_000)], [food], TZ, fixed), now);
    expect(over[0]).toMatchObject({ monthKey: "2026-09", deduction: 156_000, over: 6_000, fixedOver: 0 });
  });
});

describe("支払いの行（AT-111・113・114）", () => {
  const cal = monthCal(TZ, 25);
  /** start を含む期間から n 期間 */
  const periodsFrom = (start: number, n: number): DuePeriod[] => {
    const out: DuePeriod[] = [];
    let t = periodRange(start, cal).start;
    for (let i = 0; i < n; i++) {
      const r = periodRange(t, cal);
      out.push({ key: periodKey(r.start, cal), start: r.start, end: r.end });
      t = r.end;
    }
    return out;
  };
  const rent: Recurring = { cycle: "MONTHLY", startDate: "2026-01-01", endDate: null, payDay: 27, skippedPeriods: [] };
  const none = () => false;

  it("payDayIn：収入日25日の期間（10/25〜11/24）の27日は 10/27。31日は月末になる", () => {
    const p = periodRange(at(2026, 11, 3), cal);
    expect(payDayIn(p, 27, TZ)).toBe(at(2026, 10, 27));
    expect(payDayIn(p, 10, TZ)).toBe(at(2026, 11, 10));
    expect(payDayIn(p, 31, TZ)).toBe(at(2026, 10, 31));
    // 2月の31日は 2/28
    expect(payDayIn(periodRange(at(2027, 2, 10), cal), 31, TZ)).toBe(at(2027, 1, 31));
    expect(payDayIn({ start: at(2027, 2, 1), end: at(2027, 3, 1) }, 31, TZ)).toBe(at(2027, 2, 28));
    // 期間の中にその日がなければ null（収入日を変えて短くなった期間など）
    expect(payDayIn({ start: at(2026, 10, 25), end: at(2026, 10, 27) }, 27, TZ)).toBeNull();
  });

  it("AT-113 支払日 27日の固定費は、27日 0:00 以降に行が出て、日付が 27日になる", () => {
    const seasonStart = at(2026, 10, 1);
    const periods = periodsFrom(at(2026, 10, 25), 1);
    const before = duePayments(rent, periods, { tz: TZ, now: at(2026, 10, 27) - MINUTE, seasonStart, paid: none });
    expect(before).toEqual([]);
    const after = duePayments(rent, periods, { tz: TZ, now: at(2026, 10, 27), seasonStart, paid: none });
    expect(after).toEqual([{ periodKey: "2026-10", date: "2026-10-27" }]);
  });

  it("AT-113 シーズンの開始日・固定費の開始日より前の支払日の分は出ない。同じ期間は1件だけ", () => {
    // 11/10 に始めたシーズン：10/27 の支払い（期間 10/25〜11/24）は開始前なので出ない。次の 11/27 から出る
    const seasonStart = at(2026, 11, 10) + 9 * HOUR;
    const periods = periodsFrom(seasonStart, 2);
    const now = at(2026, 12, 1);
    expect(duePayments(rent, periods, { tz: TZ, now, seasonStart, paid: none })).toEqual([{ periodKey: "2026-11", date: "2026-11-27" }]);
    // 開始日と同じ日の支払日は出る
    expect(duePayments({ ...rent, payDay: 10 }, periods, { tz: TZ, now, seasonStart, paid: none })[0]).toEqual({ periodKey: "2026-10", date: "2026-11-10" });
    // 固定費の開始日（12/1）より前の支払日は出ない
    expect(duePayments({ ...rent, startDate: "2026-12-01" }, periods, { tz: TZ, now, seasonStart, paid: none })).toEqual([]);
    // 記録済みの期間は出ない
    expect(duePayments(rent, periods, { tz: TZ, now, seasonStart, paid: (k) => k === "2026-11" })).toEqual([]);
    // 終了日より後の支払日は出ない
    expect(duePayments({ ...rent, endDate: "2026-11-20" }, periods, { tz: TZ, now, seasonStart, paid: none })).toEqual([]);
  });

  it("支払日を決めなければ今のサブスクと同じ：期間の初めから並び、日付は期間の初め（開始日が後ならその日）", () => {
    const seasonStart = at(2026, 10, 1);
    const periods = periodsFrom(at(2026, 9, 25), 2);
    const sub: Recurring = { cycle: "MONTHLY", startDate: "2026-10-03", endDate: null, payDay: null, skippedPeriods: [] };
    expect(duePayments(sub, periods, { tz: TZ, now: at(2026, 10, 26), seasonStart, paid: none })).toEqual([
      { periodKey: "2026-09", date: "2026-10-03" },
      { periodKey: "2026-10", date: "2026-10-25" },
    ]);
  });

  it("支払日を決めていない行の日付は、シーズンの開始日より前にしない（置き場所の開始残高にもう入っている日付にならない）", () => {
    const seasonStart = at(2026, 11, 10) + 9 * HOUR;
    const sub: Recurring = { cycle: "MONTHLY", startDate: "2026-01-01", endDate: null, payDay: null, skippedPeriods: [] };
    expect(duePayments(sub, periodsFrom(seasonStart, 1), { tz: TZ, now: seasonStart + HOUR, seasonStart, paid: none })).toEqual([{ periodKey: "2026-10", date: "2026-11-10" }]);
  });

  it("AT-111 年額 120,000円の固定費は月 10,000円。支払いの行は開始日と同じ月日がある期間にだけ出る", () => {
    expect(monthlyEquivalent({ amount: 120_000, cycle: "YEARLY" })).toBe(10_000);
    expect(monthlyEquivalent({ amount: 80_000, cycle: "MONTHLY" })).toBe(80_000);
    const tax: Recurring = { cycle: "YEARLY", startDate: "2025-11-30", endDate: null, payDay: null, skippedPeriods: [] };
    const seasonStart = at(2026, 9, 1);
    const periods = periodsFrom(at(2026, 9, 1), 4);
    const rows = duePayments(tax, periods, { tz: TZ, now: at(2026, 12, 20), seasonStart, paid: none });
    // 11/30 は期間 11/25〜12/24（2026-11）にある
    expect(rows).toEqual([{ periodKey: "2026-11", date: "2026-11-25" }]);
  });

  it("AT-114 「この回は記録しない」にした期間は並ばない", () => {
    const seasonStart = at(2026, 9, 1);
    const periods = periodsFrom(at(2026, 9, 25), 2);
    const now = at(2026, 11, 20);
    expect(duePayments(rent, periods, { tz: TZ, now, seasonStart, paid: none }).map((r) => r.periodKey)).toEqual(["2026-09", "2026-10"]);
    expect(duePayments({ ...rent, skippedPeriods: ["2026-09"] }, periods, { tz: TZ, now, seasonStart, paid: none }).map((r) => r.periodKey)).toEqual(["2026-10"]);
  });
});

describe("FC-17 差分が続いたら登録額の変更を案内する", () => {
  it("直近2回の支払いがどちらも登録額と違えば、直近の額を返す。1回だけ・どちらかが登録額どおりなら返さない", () => {
    expect(suggestedAmount(8_000, [9_500, 9_200])).toBe(9_500);
    expect(suggestedAmount(8_000, [7_000, 9_200, 8_000])).toBe(7_000);
    expect(suggestedAmount(8_000, [9_500])).toBeNull();
    expect(suggestedAmount(8_000, [9_500, 8_000])).toBeNull();
    expect(suggestedAmount(8_000, [8_000, 9_500])).toBeNull();
    expect(suggestedAmount(8_000, [])).toBeNull();
  });
});
