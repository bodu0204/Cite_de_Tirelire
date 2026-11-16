// シーズン開始時の設定（docs/season-start-settings.md）：持ち込みの備え・今期の残りの自由予算
import { describe, expect, it } from "vitest";
import { bondCap, bondMiningStatus, bondResourceEligible, bondShare, carriedDrawn, splitCarried } from "../bond";
import { createCity } from "../city/init";
import { BOND_FORCED_RATE, DAY, HOUR } from "../config";
import { BudgetPlan } from "../currency";
import { bondInterestPerDay, reserveLevel } from "../fund";
import { advance, type World } from "../idle";
import { accrue, microToGold, newMine, remainingMining, withStartRemaining } from "../mine";
import { monthCal, periodRange, zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const M = 60000;
// 2026年9月は30日間
const SEP1 = zonedTimeToUtc(2026, 9, 1, TZ);
const plan = (budget = M) => new BudgetPlan(budget, [], [], TZ);

describe("AT-095・096 すでにある貯金の分け方", () => {
  it("債券の上限（3M）までは持ち込みの備え、超える分は持ち込みの貯金", () => {
    expect(splitCarried(120_000, M)).toEqual({ reserve: 120_000, savings: 0 });
    expect(splitCarried(1_000_000, M)).toEqual({ reserve: bondCap(M), savings: 1_000_000 - bondCap(M) });
    expect(splitCarried(0, M)).toEqual({ reserve: 0, savings: 0 });
  });

  it("持ち込みの備え 12万円（M＝6万円）は、債券 0 でも備えLv3。利息と同額の建設資金はつかない", () => {
    const carried = splitCarried(120_000, M).reserve;
    expect(reserveLevel(0 + carried, M)).toBe(3);
    expect(bondInterestPerDay(0, bondCap(M))).toBe(0);
    // 債券が 0 から増える分にだけ建設資金がつく（持ち込みの備えは債券ではない）
    expect(bondResourceEligible(0, 5000, bondCap(M))).toBe(5000);
  });

  it("取り崩すと備えLvが下がる（債券のマイナスが取り崩しを表す）", () => {
    expect(reserveLevel(-15_000 + 120_000, M)).toBe(2);
    expect(carriedDrawn(-15_000, 120_000)).toBe(15_000);
    expect(carriedDrawn(-150_000, 120_000)).toBe(120_000);
    expect(carriedDrawn(3000, 120_000)).toBe(0);
    expect(reserveLevel(-150_000 + 120_000, M)).toBe(0);
  });
});

describe("AT-097 持ち込みの備えの範囲内は借金として扱わない", () => {
  it("債券が −持ち込みの備え 以上なら強制の債券化をしない。下回るとする", () => {
    const cap = bondCap(M);
    expect(bondShare(-15_000, 0, cap, 120_000)).toBe(0);
    expect(bondShare(-15_000, 30, cap, 120_000)).toBe(30);
    expect(bondMiningStatus(-15_000, 0, cap, 120_000)).toBe("off");
    expect(bondShare(-130_000, 0, cap, 120_000)).toBe(BOND_FORCED_RATE);
    expect(bondMiningStatus(-130_000, 0, cap, 120_000)).toBe("forced");
    // 持ち込みの備えがなければ今までどおり
    expect(bondShare(-1, 0, cap)).toBe(BOND_FORCED_RATE);
  });

  it("採掘：範囲内のマイナスでは債券に回らず、下回っている間だけ −持ち込みの備え まで回る", () => {
    const start = SEP1 + 3 * HOUR;
    const within = accrue(newMine(start, TZ), { plan: plan(), tz: TZ, until: start + 5 * DAY, bond: { balance: -15_000, rate: 0, cap: bondCap(M), carried: 120_000 } });
    expect(within.bond).toBe(-15_000);
    expect(within.toBond).toBe(0);

    // 5日で 10,000G の採掘。20% ＝ 2,000 まで回るが、境目（−120,000）までの 500 で止まる
    const below = accrue(newMine(start, TZ), { plan: plan(), tz: TZ, until: start + 5 * DAY, bond: { balance: -120_500, rate: 0, cap: bondCap(M), carried: 120_000 } });
    expect(below.bond).toBeGreaterThanOrEqual(-120_000);
    expect(below.bond).toBeLessThanOrEqual(-119_999);
    expect(below.toBond).toBe(below.bond + 120_500);

    // 持ち込みの備えがなければ 0 に戻るまで強制
    const plain = accrue(newMine(start, TZ), { plan: plan(), tz: TZ, until: start + 5 * DAY, bond: { balance: -15_000, rate: 0, cap: bondCap(M) } });
    expect(plain.toBond).toBe(2000);
  });
});

describe("AT-095・098 放置計算での備えLvと利息", () => {
  const world = (bond: number, carried: number): World => ({
    purse: { mine: newMine(SEP1, TZ), gold: 0, silver: 0, bond, bondCap: 0, carried, moves: [], overspend: 0 },
    city: createCity(SEP1, M),
    lots: [],
    accruals: new Map(),
  });
  let seq = 0;
  const opts = (until: number) => ({ plan: plan(), bondRate: 0, until, newId: () => `l${++seq}` });

  it("持ち込みの備えだけで備えLvがつき、利息・建設資金・債券は増えない", () => {
    const w = world(0, 120_000);
    advance(w, opts(SEP1 + 2 * HOUR), []);
    expect(w.city.reserveLevel).toBe(3);
    expect(w.purse.bond).toBe(0);
    expect(w.city.interestTotal ?? 0).toBe(0);
    expect(w.city.treasury).toBe(0);
  });

  it("債券がマイナスの間は、持ち込みの備えがあっても利息がつかない", () => {
    const w = world(-15_000, 120_000);
    advance(w, opts(SEP1 + DAY), []);
    expect(w.purse.bond).toBe(-15_000);
    expect(w.city.reserveLevel).toBe(2);
    expect(w.city.interestTotal ?? 0).toBe(0);
  });
});

describe("AT-101・102 今期の残りの自由予算", () => {
  const cal = monthCal(TZ);
  // 30日の期間の20日目に開始：按分は 2万円
  const start = SEP1 + 20 * DAY;
  const end = periodRange(start, cal).end;
  const prorated = () => microToGold(remainingMining(newMine(start, cal), plan(), cal, start).natural);
  /** 期間の終わりまでに配当される金貨（未回収。債券化なし） */
  const minedToEnd = (remaining?: number) => {
    let m = newMine(start, cal);
    if (remaining !== undefined) m = withStartRemaining(m, plan(), cal, start, remaining);
    // 何回かに分けて進める（途中のアクセス）
    for (const t of [start + 3 * HOUR, start + 4 * DAY + 7 * HOUR, end]) m = accrue(m, { plan: plan(), tz: cal, until: t }).mine;
    return microToGold(m.uncollected);
  };

  it("入れなければ按分のまま（2万円）", () => {
    expect(prorated()).toBeCloseTo(20_000, 6);
    expect(minedToEnd()).toBeCloseTo(20_000, 0);
  });

  it("残り 8,000円（按分より少ない）なら、期間の終わりまでの配当は 8,000G", () => {
    expect(minedToEnd(8000)).toBeCloseTo(8000, 0);
  });

  it("残り 35,000円（按分より多い）なら、差が期間の終わりまで均等に上乗せされる", () => {
    expect(minedToEnd(35_000)).toBeCloseTo(35_000, 0);
    // 半分の時点でおよそ半分
    const m = accrue(withStartRemaining(newMine(start, cal), plan(), cal, start, 35_000), { plan: plan(), tz: cal, until: start + 5 * DAY }).mine;
    expect(microToGold(m.uncollected)).toBeCloseTo(17_500, 0);
  });

  it("残り 0円なら、最初の期間は配当されない。次の期間は月間自由予算のとおり", () => {
    let m = withStartRemaining(newMine(start, cal), plan(), cal, start, 0);
    m = accrue(m, { plan: plan(), tz: cal, until: end }).mine;
    expect(microToGold(m.uncollected)).toBeCloseTo(0, 0);
    const next = periodRange(end, cal);
    m = accrue(m, { plan: plan(), tz: cal, until: next.end }).mine;
    expect(microToGold(m.uncollected)).toBeCloseTo(M, 0);
  });

  it("按分と同じ額なら何も変えない", () => {
    const m = newMine(start, cal);
    expect(withStartRemaining(m, plan(), cal, start, 20_000)).toBe(m);
  });
});
