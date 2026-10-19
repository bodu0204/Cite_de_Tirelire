import { describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "../config";
import { BudgetPlan } from "../currency";
import { accrue, collect, newMine, payWithGold, ratePerMinute } from "../mine";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
// 2026年9月は30日間
const SEP1 = zonedTimeToUtc(2026, 9, 1, TZ);
const subs = [{ monthly: 6000, startAt: 0, endAt: null }];
const plan = (budget = 60000, s = subs) => new BudgetPlan(budget, s, [], TZ);

describe("AT-001 金貨の採掘", () => {
  it("予算60,000円・サブスク6,000円・30日の月で 1.25G/分", () => {
    expect(ratePerMinute(plan(), SEP1 + HOUR, TZ)).toBeCloseTo(1.25, 10);
  });

  it("60分で75G蓄積し、回収で所持に75G。二重回収はできない", () => {
    const start = SEP1 + 3 * HOUR;
    const { mine } = accrue(newMine(start, TZ), { plan: plan(), tz: TZ, until: start + 60 * MINUTE });
    const first = collect(mine);
    expect(first.gold).toBe(75);
    const second = collect(first.mine);
    expect(second.gold).toBe(0);
  });

  it("採掘を何回に分けても結果は（端数の丸めを除き）同じ", () => {
    const start = SEP1 + 3 * HOUR;
    let m = newMine(start, TZ);
    for (let i = 1; i <= 60; i++) m = accrue(m, { plan: plan(), tz: TZ, until: start + i * MINUTE }).mine;
    expect(collect(m).gold).toBe(75);
  });

  it("サブスクの開始時刻で採掘速度が変わる", () => {
    const start = SEP1;
    const late = [{ monthly: 6000, startAt: start + 30 * MINUTE, endAt: null }];
    const { mine } = accrue(newMine(start, TZ), { plan: plan(60000, late), tz: TZ, until: start + 60 * MINUTE });
    // 前半30分は 60000/43200、後半30分は 54000/43200
    expect(collect(mine).gold).toBe(Math.floor((60000 * 30 + 54000 * 30) / 43200));
  });

  it("月が変わると当月の採掘累計と精算額を0に戻す", () => {
    const start = zonedTimeToUtc(2026, 9, 30, TZ) + 23 * HOUR;
    const r = accrue({ ...newMine(start, TZ), settledThisMonth: 5000 }, { plan: plan(), tz: TZ, until: start + 2 * HOUR });
    expect(r.mine.monthKey).toBe("2026-10");
    expect(r.mine.settledThisMonth).toBe(0);
    // 10月の1時間ぶん（10月は31日）
    expect(Math.floor(Number(r.mine.minedThisMonth) / 1e6)).toBe(Math.floor((54000 * 60) / 44640));
  });
});

describe("購入の金貨での支払い", () => {
  it("未回収 → 所持 の順に整数単位で差し引き、足りない分を返す", () => {
    const start = SEP1;
    const { mine } = accrue(newMine(start, TZ), { plan: plan(), tz: TZ, until: start + 60 * MINUTE }); // 75G
    const r = payWithGold(mine, 100, 1000);
    expect(r.fromUncollected).toBe(75);
    expect(r.fromHeld).toBe(100);
    expect(r.rest).toBe(825);
    expect(r.mine.uncollected).toBe(0n);
  });

  it("所持金貨はマイナスにしない", () => {
    const r = payWithGold(newMine(SEP1, TZ), 300, 1000);
    expect(r.fromHeld).toBe(300);
    expect(r.rest).toBe(700);
  });
});
