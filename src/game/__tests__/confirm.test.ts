// 記録による貯金の確定（docs/savings-driven-growth.md REC-01・RSV-01）
import { describe, expect, it } from "vitest";
import { bondCap, bondFee } from "../bond";
import { createCity } from "../city/init";
import { DAY, HOUR, MICRO_PER_GOLD } from "../config";
import { autoConfirm, confirmByRecord, noteMined, unconfirmedGold } from "../confirm";
import { BudgetPlan } from "../currency";
import { advance, type World } from "../idle";
import { accrue, newMine } from "../mine";
import { pay, refund, summarize, type Payment, type Purse } from "../settle";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const OCT1 = zonedTimeToUtc(2026, 10, 1, TZ);
const M = 60000;
const CAP = bondCap(M);

function purse(o: { uncollected?: number; bond?: number; gold?: number; silver?: number } = {}): Purse {
  const mine = newMine(OCT1, TZ);
  mine.uncollected = BigInt(o.uncollected ?? 0) * MICRO_PER_GOLD;
  return { mine, gold: o.gold ?? 0, silver: o.silver ?? 100, bond: o.bond ?? 0, bondCap: CAP, moves: [], overspend: 0 };
}

describe("REC-01 記録で確定する", () => {
  it("使わなかった配当（未回収の金貨）がすべて確定し、債券と建設資金に入る", () => {
    const p = purse({ uncollected: 5000 });
    const c = confirmByRecord(p, OCT1 + HOUR);
    expect(c).toEqual({ amount: 5000, toBond: 5000, eligible: 5000, overflow: 0, days: 0 });
    expect(p.bond).toBe(5000);
    expect(p.bondResource).toBe(5000);
    expect(p.mine.uncollected).toBe(0n);
    expect(p.mine.freeBond).toBe(5000);
    expect(p.mine.confirmedAt).toBe(OCT1 + HOUR);
    // 確定した配当も配当Lvの経験値に数える
    expect(p.mine.totalCollected).toBe(5000);
  });

  it("RSV-01：債券が上限に届いたら、入りきらない分は建設資金になる（overflow）", () => {
    const p = purse({ uncollected: 5000, bond: CAP - 1000 });
    const c = confirmByRecord(p, OCT1);
    expect(c).toEqual({ amount: 5000, toBond: 1000, eligible: 1000, overflow: 4000, days: 0 });
    expect(p.bond).toBe(CAP);
  });

  it("債券がマイナスなら、確定した配当で先に返す（その分は建設資金をつけない）", () => {
    const p = purse({ uncollected: 3000, bond: -1000 });
    const c = confirmByRecord(p, OCT1);
    expect(c).toEqual({ amount: 3000, toBond: 3000, eligible: 2000, overflow: 0, days: 0 });
    expect(p.bond).toBe(2000);
  });
});

describe("REC-01 同じ期間に確定した債券は手数料なしで取り崩せる", () => {
  it("確定した分までは取り崩し（手数料なし・使い過ぎに数えない）、超えた分は使い過ぎ", () => {
    const p = purse({ uncollected: 5000 });
    confirmByRecord(p, OCT1);
    const a: Payment[] = [];
    pay(p, 3000, [], a);
    expect(summarize(a)).toMatchObject({ draw: 3000, bond: 0, feeSilver: 0, feeBond: 0 });
    expect(p.overspend).toBe(0);
    expect(p.mine.freeBond).toBe(2000);
    const b: Payment[] = [];
    pay(p, 4000, [], b);
    expect(summarize(b)).toMatchObject({ draw: 2000, bond: 2000, feeSilver: bondFee(2000) });
    expect(p.overspend).toBe(2000);
    expect(p.bond).toBe(5000 - 3000 - 4000);
  });

  it("払い戻すと、取り崩した分はまた手数料なしで取り崩せる", () => {
    const p = purse({ uncollected: 5000 });
    confirmByRecord(p, OCT1);
    const a: Payment[] = [];
    pay(p, 3000, [], a);
    refund(p, 3000, a, () => ({}));
    expect(p.bond).toBe(5000);
    expect(p.mine.freeBond).toBe(5000);
  });

  it("収入期間が替わると、前の期間に確定した債券はもう手数料なしでは取り崩せない", () => {
    const p = purse({ uncollected: 5000 });
    confirmByRecord(p, OCT1);
    const plan = new BudgetPlan(M, [], [], TZ);
    p.mine = accrue(p.mine, { plan, tz: TZ, until: OCT1 + 32 * DAY }).mine;
    expect(p.mine.freeBond).toBe(0);
  });
});

describe("REC-01 記録のない日の自動の確定", () => {
  it("その日から7日たった配当を、推定の支出を引いて確定する。引いた分は未回収に残る", () => {
    const p = purse({ uncollected: 2000 });
    p.mine = noteMined(p.mine, OCT1 + HOUR, 2000n * MICRO_PER_GOLD, TZ);
    expect(unconfirmedGold(p.mine)).toBe(2000);
    // 7日目まではまだ
    expect(autoConfirm(p, OCT1 + 7 * DAY, TZ, 500).amount).toBe(0);
    const c = autoConfirm(p, OCT1 + 8 * DAY, TZ, 500);
    expect(c.amount).toBe(1500);
    // 自動で確定した日の数（貯金日に数える。docs/saving-habit-balance.md HAB-01）
    expect(c.days).toBe(1);
    expect(p.bond).toBe(1500);
    expect(Number(p.mine.uncollected / MICRO_PER_GOLD)).toBe(500);
    expect(unconfirmedGold(p.mine)).toBe(0);
  });

  it("収入期間が終わった日の配当は、7日たっていなくても確定する", () => {
    const p = purse({ uncollected: 1000 });
    const lastDay = zonedTimeToUtc(2026, 10, 31, TZ);
    p.mine = noteMined(p.mine, lastDay + HOUR, 1000n * MICRO_PER_GOLD, TZ);
    expect(autoConfirm(p, zonedTimeToUtc(2026, 11, 1, TZ) + HOUR, TZ, 0).amount).toBe(1000);
  });

  it("放置中も確定する：記録しない10日間で、最初の数日分の配当が債券に入る", () => {
    const plan = new BudgetPlan(M, [], [], TZ);
    const city = createCity(OCT1, M);
    const w: World = { purse: purse(), city, lots: [], accruals: new Map() };
    advance(w, { plan, bondRate: 0, until: OCT1 + 10 * DAY, newId: () => "l", estimatePerDay: 1000 }, []);
    // 1日の配当は 60,000 ÷ 31 ≒ 1,935G。10日目の終わりまでに1〜3日目の分が7日たち、推定の支出 1,000 を引いた分が確定する
    expect(w.purse.bond).toBeCloseTo(3 * (60000 / 31 - 1000), -1);
    expect(unconfirmedGold(w.purse.mine)).toBeGreaterThan(7 * 1900);
  });

  it("1回で計算しても1時間ごとに計算しても、自動の確定は同じになる", () => {
    const plan = new BudgetPlan(M, [], [], TZ);
    const make = (): World => ({ purse: purse(), city: createCity(OCT1, M), lots: [], accruals: new Map() });
    const a = make();
    const b = make();
    const opts = { plan, bondRate: 0, newId: () => "l", estimatePerDay: 800 };
    advance(a, { ...opts, until: OCT1 + 12 * DAY }, []);
    for (let t = OCT1 + HOUR; t <= OCT1 + 12 * DAY; t += HOUR) advance(b, { ...opts, until: t }, []);
    expect(b.purse.bond).toBe(a.purse.bond);
    expect(b.purse.mine.uncollected).toBe(a.purse.mine.uncollected);
    expect(b.city.treasury).toBeCloseTo(a.city.treasury, 6);
  });
});
