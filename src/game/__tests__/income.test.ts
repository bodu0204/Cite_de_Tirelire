// 記録入力の再設計（docs/record-input-redesign.md）：収入期間・採掘への上乗せと−差分・予約した振り分け・差分の解消
import { describe, expect, it } from "vitest";
import { createCity } from "../city/init";
import { DAY, HOUR, MICRO_PER_GOLD, MINUTE } from "../config";
import { BudgetPlan, budgetOverruns, type CurrencyDefLite } from "../currency";
import { advance, type Accrual, type Grant, type World } from "../idle";
import { accrue, newMine, ratePerMinute, remainingMining, type MineState } from "../mine";
import { absorbShortfall, absorbSurplus, type Payment, type Purse } from "../settle";
import { changePayday, dayKey, monthCal, periodKey, periodRange, zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const at = (y: number, m: number, d: number) => zonedTimeToUtc(y, m, d, TZ);

describe("AT-048 収入日と収入期間", () => {
  const cal = monthCal(TZ, 25);

  it("収入日25日：10/25〜11/24 が「10月の月収」の期間", () => {
    const r = periodRange(at(2026, 11, 3), cal);
    expect(r).toEqual({ start: at(2026, 10, 25), end: at(2026, 11, 25) });
    expect(periodKey(at(2026, 11, 3), cal)).toBe("2026-10");
    expect(periodKey(at(2026, 11, 25), cal)).toBe("2026-11");
  });

  it("収入日31日は短い月で末日になる", () => {
    const c = monthCal(TZ, 31);
    expect(periodRange(at(2026, 11, 10), c)).toEqual({ start: at(2026, 10, 31), end: at(2026, 11, 30) });
    expect(periodRange(at(2026, 12, 1), c)).toEqual({ start: at(2026, 11, 30), end: at(2026, 12, 31) });
  });

  it("収入日1日は暦の月と同じ", () => {
    expect(periodRange(at(2026, 10, 19), monthCal(TZ))).toEqual({ start: at(2026, 10, 1), end: at(2026, 11, 1) });
  });

  it("採掘の速度は収入期間の分数で割る（31日 ＝ 44,640分に 26,000G）", () => {
    const plan = new BudgetPlan(60000, [{ monthly: 6000, startAt: 0, endAt: null }], [], cal);
    const minutes = (at(2026, 11, 25) - at(2026, 10, 25)) / MINUTE;
    expect(minutes).toBe(44640);
    // ユーザ通貨なしなので 54,000G
    expect(ratePerMinute(plan, at(2026, 11, 1), cal)).toBeCloseTo(54000 / 44640, 10);
  });

  it("予算超過の確かめも収入期間ごと", () => {
    const plan = new BudgetPlan(60000, [{ monthly: 6000, startAt: 0, endAt: null }], [], cal);
    expect(budgetOverruns(plan, at(2026, 10, 20))).toEqual([]);
  });
});

describe("AT-049 収入日の変更は次の収入日から", () => {
  it("1日 → 25日（10/3 に変更）：今の期間は 10/1〜11/25 に延び、そのあとは25日区切り", () => {
    const c = changePayday(monthCal(TZ), 25, at(2026, 10, 3));
    expect(periodRange(at(2026, 10, 20), c)).toEqual({ start: at(2026, 10, 1), end: at(2026, 11, 25) });
    expect(periodRange(at(2026, 9, 10), c)).toEqual({ start: at(2026, 9, 1), end: at(2026, 10, 1) });
    expect(periodRange(at(2026, 12, 1), c)).toEqual({ start: at(2026, 11, 25), end: at(2026, 12, 25) });
    expect(periodKey(at(2026, 12, 1), c)).toBe("2026-11");
  });

  it("25日 → 1日（10/27 に変更）：今の期間は 10/25〜11/1 に縮む", () => {
    const c = changePayday(monthCal(TZ, 25), 1, at(2026, 10, 27));
    expect(periodRange(at(2026, 10, 30), c)).toEqual({ start: at(2026, 10, 25), end: at(2026, 11, 1) });
    expect(periodRange(at(2026, 11, 3), c)).toEqual({ start: at(2026, 11, 1), end: at(2026, 12, 1) });
  });

  it("効く前にもう一度変えたら、前の変更を置き換える（元に戻すと変更なし）", () => {
    const c1 = changePayday(monthCal(TZ), 25, at(2026, 10, 3));
    const c2 = changePayday(c1, 10, at(2026, 10, 5));
    expect(c2.eras).toHaveLength(2);
    expect(periodRange(at(2026, 10, 20), c2)).toEqual({ start: at(2026, 10, 1), end: at(2026, 11, 10) });
    expect(changePayday(c1, 1, at(2026, 10, 5)).eras).toHaveLength(1);
  });

  it("期間の合計の採掘額は変わらない（延びた期間は分数で割り直す）", () => {
    const c = changePayday(monthCal(TZ), 25, at(2026, 10, 3));
    const plan = new BudgetPlan(60000, [], [], c);
    const start = at(2026, 10, 1);
    const { mine } = accrue(newMine(start, c), { plan, tz: c, until: at(2026, 11, 25) - MINUTE });
    expect(mine.monthKey).toBe("2026-10");
    expect(Math.round(Number(mine.minedThisMonth) / Number(MICRO_PER_GOLD))).toBeGreaterThanOrEqual(59998);
  });
});

describe("採掘への上乗せ（期間で均等・毎分）と−差分の減らし", () => {
  const plan = new BudgetPlan(60000, [], [], TZ);
  const start = at(2026, 9, 1);

  it("AT-045 区間の上乗せは、何回に分けて採掘しても合計が同じ", () => {
    const window = { incomeId: "i1", dividend: true, start: start + HOUR, end: start + 10 * DAY, total: 5000n * MICRO_PER_GOLD };
    const m0: MineState = { ...newMine(start, TZ), windows: [window] };
    const once = accrue(m0, { plan, tz: TZ, until: start + 12 * DAY }).mine;
    let m = m0;
    for (let h = 1; h <= 12 * 24; h++) m = accrue(m, { plan, tz: TZ, until: start + h * HOUR }).mine;
    const base = (60000n * MICRO_PER_GOLD * BigInt(12 * DAY)) / BigInt(30 * DAY);
    expect(once.uncollected - base).toBe(5000n * MICRO_PER_GOLD);
    expect(Number((m.uncollected - once.uncollected) / MICRO_PER_GOLD)).toBe(0);
    expect(once.windows).toEqual([]);
  });

  it("AT-043 −差分（cut）は残りの採掘から減り、期間が替わると持ち越さない", () => {
    const m0: MineState = { ...newMine(start, TZ), cut: 1000n * MICRO_PER_GOLD };
    const r = accrue(m0, { plan, tz: TZ, until: start + DAY });
    // 1日の採掘 2,000G から 1,000G を減らす
    expect(Number(r.mine.uncollected / MICRO_PER_GOLD)).toBe(1000);
    expect(r.mine.cut).toBe(0n);
    const left = remainingMining({ ...newMine(start, TZ), cut: 30000n * MICRO_PER_GOLD }, plan, monthCal(TZ), start + 15 * DAY);
    expect(Number(left.natural / MICRO_PER_GOLD)).toBe(0);
  });

  it("その月の配当分（dividend）は採掘で増え、臨時の収入の上乗せは数えない", () => {
    const other = { incomeId: "x", dividend: false, start, end: start + DAY, total: 3000n * MICRO_PER_GOLD };
    const r = accrue({ ...newMine(start, TZ), windows: [other] }, { plan, tz: TZ, until: start + DAY });
    expect(Number(r.mine.uncollected / MICRO_PER_GOLD)).toBe(5000);
    expect(Number(r.mine.dividend! / MICRO_PER_GOLD)).toBe(2000);
  });
});

describe("予約した振り分け", () => {
  const START = at(2026, 10, 19) + 9 * HOUR;
  const food: CurrencyDefLite = {
    id: "food",
    name: "食費",
    icon: "🍙",
    categoryIds: [],
    rules: [{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }],
    remainder: "KEEP",
    remainderDays: null,
    startDate: "2026-10-01",
    endDate: null,
    sortOrder: 0,
    createdAt: 0,
  };
  const world = (grants: Grant[], cuts = [] as World["cuts"]): World => ({
    purse: { mine: newMine(START, TZ), gold: 0, silver: 0, bond: 0, bondCap: 180000, moves: [], overspend: 0 },
    city: createCity(START),
    lots: [],
    accruals: new Map<string, Accrual>([["food", { currencyId: "food", lastAccrualAt: START, fraction: 0n }]]),
    grants,
    cuts,
  });
  let seq = 0;
  const newId = () => `l${++seq}`;
  const plan = new BudgetPlan(60000, [], [food], TZ);

  it("期日が来たティックで金貨・債券・ユーザ通貨に入る", () => {
    const g = (id: string, currency: Grant["currency"], when: number, amount: number): Grant => ({ id, at: when, currency, currencyId: currency === "CUSTOM" ? "food" : null, amount, dividend: false, grantedAt: null });
    const grants = [g("a", "GOLD", START + DAY, 1000), g("b", "BOND", START + DAY, 2000), g("c", "CUSTOM", START + 2 * DAY, 500), g("d", "GOLD", START + 10 * DAY, 9)];
    const w = world(grants);
    advance(w, { plan, bondRate: 0, until: START + 3 * DAY, newId }, []);
    expect(w.purse.gold).toBe(1000);
    expect(w.purse.bond).toBe(2000);
    expect(w.lots.find((l) => dayKey(l.issuedAt, TZ) === "2026-10-21")?.remaining).toBe(500);
    expect(grants.filter((x) => x.grantedAt !== null).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("ユーザ通貨の未発生分から減らす（cut）。振り分けの分は減らさない", () => {
    const w = world([], [{ currencyId: "food", periodKey: "2026-10", remaining: 3000 }]);
    advance(w, { plan, bondRate: 0, until: START + 8 * DAY, newId }, []);
    // 10/26 の 7,000 から 3,000 を減らす
    expect(w.lots.reduce((a, l) => a + l.remaining, 0)).toBe(4000);
    expect(w.cuts![0].remaining).toBe(0);
  });
});

describe("差分の解消", () => {
  const purse = (bond: number, silver = 100): Purse => ({ mine: newMine(at(2026, 10, 1), TZ), gold: 0, silver, bond, bondCap: 180000, moves: [], overspend: 0 });

  it("AT-046 ＋差分：上限まで債券（資源つき）、残りはおまかせ交換へ", () => {
    const p = purse(175000);
    expect(absorbSurplus(p, 8000, "x")).toEqual({ toBond: 5000, eligible: 5000, rest: 3000 });
    expect(p.bond).toBe(180000);
  });

  it("＋差分：債券がマイナスなら返済にも充たり、その分は資源をつけない", () => {
    const p = purse(-3000);
    expect(absorbSurplus(p, 5000, "x")).toEqual({ toBond: 5000, eligible: 2000, rest: 0 });
  });

  it("AT-047 −差分：全額を債券から減らし、手数料（10%・上限50S、足りない銀貨は債券から）", () => {
    const p = purse(10000, 30);
    const payments: Payment[] = [];
    absorbShortfall(p, 2000, payments, "x");
    expect(p.silver).toBe(0);
    expect(p.bond).toBe(10000 - 2000 - 20);
    expect(p.overspend).toBe(2000);
    expect(p.gold).toBe(0);
  });
});
