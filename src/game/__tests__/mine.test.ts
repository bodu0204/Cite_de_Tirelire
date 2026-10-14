import { describe, expect, it } from "vitest";
import { HOUR, MINUTE } from "../config";
import { accrue, collect, goldBalance, newMine, ratePerMinute, refundPurchase, repayDebtFromHeld, settlePurchase } from "../mine";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
// 2026年9月は30日間
const SEP1 = zonedTimeToUtc(2026, 9, 1, TZ);
const subs = [{ monthly: 6000, startAt: 0, endAt: null }];

describe("AT-001 金貨の採掘", () => {
  it("予算60,000円・サブスク6,000円・30日の月で 1.25G/分", () => {
    expect(ratePerMinute(60000, subs, SEP1 + HOUR, TZ)).toBeCloseTo(1.25, 10);
  });

  it("60分で75G蓄積し、回収で所持に75G。二重回収はできない", () => {
    const start = SEP1 + 3 * HOUR;
    const { mine } = accrue(newMine(start, TZ), { budget: 60000, subs, tz: TZ, until: start + 60 * MINUTE });
    const first = collect(mine);
    expect(first.gold).toBe(75);
    const second = collect(first.mine);
    expect(second.gold).toBe(0);
  });

  it("採掘を何回に分けても結果は（端数の丸めを除き）同じ", () => {
    const start = SEP1 + 3 * HOUR;
    let m = newMine(start, TZ);
    for (let i = 1; i <= 60; i++) m = accrue(m, { budget: 60000, subs, tz: TZ, until: start + i * MINUTE }).mine;
    expect(collect(m).gold).toBe(75);
  });

  it("サブスクの開始時刻で採掘速度が変わる", () => {
    const start = SEP1;
    const late = [{ monthly: 6000, startAt: start + 30 * MINUTE, endAt: null }];
    const { mine } = accrue(newMine(start, TZ), { budget: 60000, subs: late, tz: TZ, until: start + 60 * MINUTE });
    // 前半30分は 60000/43200、後半30分は 54000/43200
    expect(collect(mine).gold).toBe(Math.floor((60000 * 30 + 54000 * 30) / 43200));
  });
});

describe("購入の精算", () => {
  it("未回収 → 所持 → 今後の採掘 の順に差し引く", () => {
    const start = SEP1;
    let { mine } = accrue(newMine(start, TZ), { budget: 60000, subs, tz: TZ, until: start + 60 * MINUTE }); // 75G
    const r = settlePurchase(mine, 100, 1000);
    expect(r.fromHeld).toBe(100);
    expect(r.toDebt).toBe(825);
    mine = r.mine;
    expect(mine.uncollected).toBe(0n);
    // その後の採掘はまず負債の返済に充てる
    mine = accrue(mine, { budget: 60000, subs, tz: TZ, until: start + 120 * MINUTE }).mine;
    expect(collect(mine).gold).toBe(0);
  });

  it("月内に精算できない分は予算超過として記録し、翌月へ繰り越さない", () => {
    const start = zonedTimeToUtc(2026, 9, 30, TZ) + 23 * HOUR;
    let mine = accrue(newMine(start, TZ), { budget: 60000, subs, tz: TZ, until: start }).mine;
    mine = settlePurchase(mine, 0, 5000).mine;
    const r = accrue(mine, { budget: 60000, subs, tz: TZ, until: start + 2 * HOUR });
    expect(r.overspends).toHaveLength(1);
    expect(r.overspends[0].monthKey).toBe("2026-09");
    expect(r.overspends[0].amount).toBe(5000 - 75);
    expect(r.mine.debt).toBe(0n);
    expect(r.mine.monthKey).toBe("2026-10");
    // 10月の1時間ぶんはそのまま採掘される（10月は31日）
    expect(collect(r.mine).gold).toBe(Math.floor((54000 * 60) / 44640));
  });

  it("減額修正の払い戻しは負債から先に減らす", () => {
    const mine = settlePurchase(newMine(SEP1, TZ), 0, 1000).mine;
    const r = refundPurchase(mine, 1500);
    expect(r.mine.debt).toBe(0n);
    expect(r.toHeld).toBe(500);
  });
});

describe("所持金貨のマイナス", () => {
  it("所持金貨を超える購入はマイナスで表示され、採掘で戻っていく", () => {
    const start = SEP1;
    const r = settlePurchase(newMine(start, TZ), 300, 1000);
    const held = 300 - r.fromHeld;
    expect(goldBalance(held, r.mine)).toBe(-700);
    // 60分で75G採掘 → 負債の返済に充てられる
    const later = accrue(r.mine, { budget: 60000, subs, tz: TZ, until: start + 60 * MINUTE }).mine;
    expect(goldBalance(held, later)).toBe(-625);
  });

  it("マイナスの間に手持ちへ入った金貨は返済に充てる", () => {
    const mine = settlePurchase(newMine(SEP1, TZ), 0, 1000).mine;
    const r = repayDebtFromHeld(mine, 400);
    expect(r.used).toBe(400);
    expect(goldBalance(0, r.mine)).toBe(-600);
    const all = repayDebtFromHeld(mine, 5000);
    expect(all.used).toBe(1000);
    expect(goldBalance(5000 - all.used, all.mine)).toBe(4000);
  });
});
