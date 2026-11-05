import { describe, expect, it } from "vitest";
import { bondCap, bondFee, bondMultiplier } from "../bond";
import { createCity } from "../city/init";
import { tick } from "../city/sim";
import { DAY, HOUR, MINUTE, TICK_MS } from "../config";
import { BudgetPlan } from "../currency";
import { accrue, collect, newMine } from "../mine";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const OCT1 = zonedTimeToUtc(2026, 10, 1, TZ);
const M = 60000;

describe("AT-015 債券倍率（目標を基準にする。GB-07）", () => {
  const GOAL = 100000;
  it("目標10万円：債券 −3,000 / 0 / 25,000 / 50,000 / 300,000 で 1.0 / 1.0 / 1.25 / 1.5 / 1.5", () => {
    expect([-3000, 0, 25000, 50000, 300000].map((b) => bondMultiplier(b, GOAL))).toEqual([1, 1, 1.25, 1.5, 1.5]);
  });

  it("目標が0なら倍率は1.0", () => {
    expect(bondMultiplier(10000, 0)).toBe(1);
  });

  it("目標の半分の債券で最大。予算（債券化の上限 3M）にはよらない", () => {
    expect(bondCap(M)).toBe(180000);
    expect(bondMultiplier(GOAL / 2, GOAL)).toBe(1.5);
    expect(bondMultiplier(GOAL / 2 - 1, GOAL)).toBeLessThan(1.5);
  });
});

describe("AT-015a 債券倍率は時間発展・人口増加・自動開発の工事に掛かる", () => {
  it("k＝1.25 で、同じ状態からの1ティックの時間発展と人口の増え方が1.25倍", () => {
    const a = createCity(OCT1);
    const b = createCity(OCT1);
    // 時間発展と人口だけを比べるため自動開発を止める
    a.policy.autoEnabled = false;
    b.policy.autoEnabled = false;
    tick(a, OCT1 + TICK_MS, [], 1);
    tick(b, OCT1 + TICK_MS, [], 1.25);
    expect(b.population - 4).toBeCloseTo((a.population - 4) * 1.25, 10);
    expect(b.devPoints).toBeCloseTo(a.devPoints * 1.25, 10);
    expect(b.buildings.length).toBe(a.buildings.length);
  });

  it("k＝1.5 なら自動開発の工事の時間が 1/1.5 になる", () => {
    const a = createCity(OCT1);
    const b = createCity(OCT1);
    tick(a, OCT1 + TICK_MS, [], 1);
    tick(b, OCT1 + TICK_MS, [], 1.5);
    const ja = a.jobs[0];
    const jb = b.jobs.find((j) => j.line === ja.line && j.kind === ja.kind)!;
    expect(jb.finishAt - jb.startedAt).toBe(Math.round((ja.finishAt - ja.startedAt) / 1.5));
  });
});

describe("AT-016a 債券を使ったときの手数料", () => {
  it("300 → 30S、500 → 50S、2,500 → 50S", () => {
    expect([300, 500, 2500, 0, 1].map(bondFee)).toEqual([30, 50, 50, 0, 1]);
  });
});

describe("採掘の債券化", () => {
  const plan = new BudgetPlan(M, [], [], TZ);
  // 10月は31日：60,000 / 44,640分
  const perMinute = M / 44640;

  it("AT-017 債券 −3,050・債券化率 0%：採掘の20%が債券に入り、0に達したら止まる", () => {
    const r = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + 10 * DAY, bond: { balance: -3050, rate: 0, cap: bondCap(M) } });
    expect(r.bond).toBe(0);
    expect(r.toBond).toBe(3050);
    // 0 に戻るまで（3,050 ÷ 20%）の採掘以外はすべて金貨
    const minedTotal = Math.floor(perMinute * 10 * 1440);
    expect(collect(r.mine).gold).toBeGreaterThanOrEqual(minedTotal - 3050 - 2);
    expect(collect(r.mine).gold).toBeLessThanOrEqual(minedTotal - 3050);
  });

  it("債券がマイナスの間は約8日で0に戻る（月60,000なら1日400）", () => {
    const r = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + 7 * DAY, bond: { balance: -3050, rate: 0, cap: bondCap(M) } });
    expect(r.bond).toBeLessThan(0);
    const r2 = accrue(r.mine, { plan, tz: TZ, until: OCT1 + 8 * DAY, bond: { balance: r.bond, rate: 0, cap: bondCap(M) } });
    expect(r2.bond).toBe(0);
  });

  it("債券化率が20%より大きければマイナスの間もその率", () => {
    const r = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + 60 * MINUTE, bond: { balance: -100000, rate: 50, cap: bondCap(M) } });
    expect(r.toBond).toBe(Math.floor(perMinute * 60 * 0.5));
  });

  it("AT-018 債券化率 50%・債券 179,990：債券は 180,000 で止まり、以後の採掘は全額金貨", () => {
    const r = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + DAY, bond: { balance: 179990, rate: 50, cap: bondCap(M) } });
    expect(r.bond).toBe(180000);
    expect(r.toBond).toBe(10);
    expect(collect(r.mine).gold).toBe(Math.floor(perMinute * 1440) - 10);
  });

  it("BND-09 債券化した採掘は累計配当（totalCollected）に含める（配当Lvは貯金額の最高到達額で決まる）", () => {
    const r = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + DAY, bond: { balance: 0, rate: 100, cap: bondCap(M) } });
    expect(collect(r.mine).gold).toBe(0);
    expect(r.mine.totalCollected).toBe(r.toBond);
    expect(r.toBond).toBe(Math.floor(perMinute * 1440));
  });

  it("債券化を何回に分けても結果は同じ", () => {
    const opts = { balance: 1000, rate: 30, cap: bondCap(M) };
    const once = accrue(newMine(OCT1, TZ), { plan, tz: TZ, until: OCT1 + DAY, bond: opts });
    let m = newMine(OCT1, TZ);
    let bond = opts.balance;
    for (let h = 1; h <= 24; h++) {
      const r = accrue(m, { plan, tz: TZ, until: OCT1 + h * HOUR, bond: { ...opts, balance: bond } });
      m = r.mine;
      bond = r.bond;
    }
    expect(bond).toBe(once.bond);
    expect(collect(m).gold).toBe(collect(once.mine).gold);
  });
});
