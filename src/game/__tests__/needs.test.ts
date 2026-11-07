// 建設資金への交換と、債券化につく建設資金（docs/savings-driven-growth.md GRW-02・RSV-01・ERL-01。
// 以前の「必要資源の割合で木材・石材・食料に振り分ける交換」（docs/needs-based-exchange.md §11）を置き換えた）
import { describe, expect, it } from "vitest";
import { bondCap, bondResourceEligible } from "../bond";
import { createCity } from "../city/init";
import { computeMetrics } from "../city/economy";
import { cityNeeds, expansionPlan, priceOf } from "../city/sim";
import { DAY, HOUR } from "../config";
import { BudgetPlan, type CurrencyDefLite } from "../currency";
import { exchangeRate, needShares, quoteBondGains, quoteNeedsExchange, quoteResourceExchange, splitAmount, ZERO_GAINS } from "../exchange";
import { creditFund, earlyBonusRate } from "../fund";
import { advance, type Accrual, type World } from "../idle";
import { newMine } from "../mine";
import { coverPlans, type PlanQueue } from "../planQueue";
import { pay } from "../settle";
import { zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
const MON = zonedTimeToUtc(2026, 10, 19, TZ);
const START = MON - DAY + 9 * HOUR;
const LV1 = { bank: 1, goldMine: 1, silverMine: 1 };

/** 開拓期ボーナスの外（シーズン開始から30日後）で確かめる街。early を true にするとシーズンの初日から */
function world(defs: CurrencyDefLite[], o: { bond?: number; early?: boolean } = {}): World {
  const accruals = new Map<string, Accrual>(defs.map((d) => [d.id, { currencyId: d.id, lastAccrualAt: START, fraction: 0n }]));
  const city = createCity(START, 60000);
  if (!o.early) city.startedAt = START - 30 * DAY;
  return {
    purse: { mine: newMine(START, TZ), gold: 0, silver: 0, bond: o.bond ?? 0, bondCap: 0, moves: [], overspend: 0 },
    city,
    lots: [],
    accruals,
  };
}

let seq = 0;
const newId = () => `l${++seq}`;

describe("おまかせ交換（全額が建設資金。GRW-02）", () => {
  const needs = { wood: 300, stone: 200, food: 100, treasury: 0 };
  it("必要割合はいつも建設資金が1", () => {
    expect(needShares(needs)).toEqual({ ...ZERO_GAINS, treasury: 1 });
  });

  it("AT-030 1,000G → 建設資金 1,000円、手数料 5S", () => {
    const q = quoteNeedsExchange("gold", 1000, needs, LV1);
    expect(q.split).toEqual({ ...ZERO_GAINS, treasury: 1000 });
    expect(q.gains).toEqual({ ...ZERO_GAINS, treasury: 1000 });
    expect(q.silverCost).toBe(5);
    expect(q.goldCost).toBe(1000);
  });

  it("AT-031 1,000S → 建設資金 100円、銀貨 1,005", () => {
    const q = quoteNeedsExchange("silver", 1000, needs, LV1);
    expect(q.gains).toEqual({ ...ZERO_GAINS, treasury: 100 });
    expect(q.silverCost).toBe(1005);
    expect(q.goldCost).toBe(0);
  });

  it("振り分けは最大剰余法で合計が交換額と一致する", () => {
    const s = splitAmount(1000, { wood: 1 / 3, stone: 1 / 3, food: 1 / 3, treasury: 0 });
    expect(s).toEqual({ wood: 334, stone: 333, food: 333, treasury: 0 });
    const t = splitAmount(7, needShares({ wood: 10, stone: 30, food: 0, treasury: 50 }));
    expect(t).toEqual({ ...ZERO_GAINS, treasury: 7 });
  });

  it("債券化の建設資金は手数料なし・小数のまま", () => {
    const q = quoteNeedsExchange("gold", 3.5, needs, LV1, { fee: false, floor: false });
    expect(q.silverCost).toBe(0);
    expect(q.gains.treasury).toBeCloseTo(3.5, 9);
  });
});

describe("種類を選んだ交換も建設資金になる", () => {
  it("1G → 1円。Lvボーナスは種類によらない", () => {
    expect(quoteResourceExchange("gold", "wood", 100, LV1)).toMatchObject({ gain: 100, goldCost: 100, silverCost: 5 });
    const lv = { bank: 1, goldMine: 6, silverMine: 1 };
    expect(exchangeRate("gold", "treasury", lv)).toBeCloseTo(exchangeRate("gold", "wood", lv));
    expect(exchangeRate("gold", "treasury", lv)).toBeCloseTo(1.2);
  });

  it("1S → 0.1円。手数料 5S と代金", () => {
    expect(quoteResourceExchange("silver", "treasury", 100, LV1)).toMatchObject({ gain: 10, goldCost: 0, silverCost: 105 });
  });

  it("債券につく建設資金は、種類を選んでもおまかせでも同じ（手数料なし）", () => {
    const needs = { wood: 100, stone: 50, food: 0, treasury: 200 };
    expect(quoteBondGains(300, "stone", needs, LV1)).toEqual({ ...ZERO_GAINS, treasury: 300 });
    expect(quoteBondGains(300, "auto", needs, LV1)).toEqual(quoteNeedsExchange("gold", 300, needs, LV1, { fee: false }).gains);
  });
});

describe("計画列と必要な建設資金", () => {
  it("初期の街でも必要な建設資金がある（木材・石材・食料はお金で買わない）", () => {
    const n = cityNeeds(createCity(START, 60000)).needs;
    expect(n.treasury).toBeGreaterThan(0);
    expect(n.wood + n.stone + n.food).toBe(0);
  });

  it("計画列の値段は円で、建設資金だけを使う", () => {
    const city = createCity(START, 60000);
    const q = cityNeeds(city).queue;
    expect(q.plans.length).toBeGreaterThan(0);
    for (const p of [...q.plans, q.expansion]) {
      expect(p.cost.wood + p.cost.stone).toBe(0);
      expect(Number.isInteger(p.cost.treasury) && p.cost.treasury > 0).toBe(true);
    }
  });

  it("AT-032/033 建設資金が非常に多くても拡張計画で必要額が正（ループしない）", () => {
    const city = createCity(START, 60000);
    city.treasury = 1e9;
    const r = cityNeeds(city);
    expect(r.next.expansion).toBe(true);
    expect(r.needs.treasury).toBeGreaterThan(0);
    const x = expansionPlan(city, computeMetrics(city).devLevel);
    expect(r.needs.treasury).toBeLessThanOrEqual(x.cost.treasury);
  });

  it("値段は基準額に比例する（PRC-01）", () => {
    const a = createCity(START, 50000);
    const b = createCity(START, 100000);
    const cost = { wood: 40, stone: 0, treasury: 160 };
    expect(priceOf(b, cost)).toBeCloseTo(priceOf(a, cost) * 2, -1);
  });

  it("街の状態を変えない", () => {
    const city = createCity(START, 60000);
    const before = JSON.stringify(city);
    cityNeeds(city);
    expect(JSON.stringify(city)).toBe(before);
  });
});

describe("交換後の在庫で実施できる計画", () => {
  const plan = (name: string, wood: number, stone: number, treasury = 0) => ({ kind: "build" as const, line: "housing" as const, tier: 0, level: 1, name, cost: { wood, stone, treasury } });
  const queue: PlanQueue = { plans: [plan("A", 100, 50), plan("B", 200, 0), plan("C", 50, 50, 1_000)], expansion: plan("X", 100, 100) };

  it("在庫を先頭から割り当て、足りない計画までの不足分を積み上げる", () => {
    const c = coverPlans(queue, { wood: 250, stone: 30, treasury: 0 });
    expect(c.plans.map((p) => p.ok)).toEqual([false, false, false]);
    expect(c.plans[0].short).toEqual({ wood: 0, stone: 20, treasury: 0 });
    expect(c.plans[1]).toMatchObject({ covered: { wood: 150, stone: 0 }, short: { wood: 50, stone: 20 } });
    expect(c.plans[2].short).toEqual({ wood: 100, stone: 70, treasury: 1_000 });
    expect(c.expansion).toMatchObject({ count: 0, next: { short: { wood: 200, stone: 170 } } });
  });

  it("交換で入る資源・都市資金を足すと実施できる計画が増える", () => {
    const short = coverPlans(queue, { wood: 650, stone: 280, treasury: 500 });
    expect(short.plans.map((p) => p.ok)).toEqual([true, true, false]);
    expect(short.plans[2].short).toEqual({ wood: 0, stone: 0, treasury: 500 });
    const after = coverPlans(queue, { wood: 650, stone: 280, treasury: 500 + 600 });
    expect(after.plans.map((p) => p.ok)).toEqual([true, true, true]);
    // 残り 木材 300・石材 180・都市資金 100 → 拡張計画（都市資金 0）1件分、次の1件まで 石材 20
    expect(after.expansion).toMatchObject({ count: 1, next: { covered: { wood: 100, stone: 80 }, short: { wood: 0, stone: 20 } } });
  });

  it("必要な建設資金は最初に足りなくなる計画の不足分と一致する", () => {
    const city = createCity(START, 60000);
    const r = cityNeeds(city);
    const c = coverPlans(r.queue, { wood: city.stock.wood, stone: city.stock.stone, treasury: city.treasury });
    const first = c.plans.find((p) => !p.ok) ?? c.expansion.next;
    expect(first.short).toEqual({ wood: r.needs.wood, stone: r.needs.stone, treasury: r.needs.treasury });
  });
});

describe("AT-035 建設資金つき対象額", () => {
  const cap = bondCap(60000);
  it.each([
    [10000, 5000, 5000],
    [-3000, 5000, 2000],
    [-1000, 500, 0],
    [179000, 5000, 1000],
    [-2000, 200000, 180000],
    [200000, 5000, 0],
  ])("債券 %i に %i 入る → %i", (bond, amount, expected) => {
    expect(bondResourceEligible(bond, amount, cap)).toBe(expected);
  });
  it("M ＝ 0 なら建設資金はつかない", () => {
    expect(bondResourceEligible(0, 5000, bondCap(0))).toBe(0);
  });
});

describe("AT-036 採掘の債券化につく建設資金", () => {
  const plan = new BudgetPlan(60000, [], [], TZ);

  it("債券化率 50%・債券 179,990：入った 10 の分だけ建設資金がつく", () => {
    const w = world([], { bond: bondCap(60000) - 10 });
    advance(w, { plan, bondRate: 50, until: START + DAY, newId }, []);
    expect(w.purse.bond).toBe(bondCap(60000));
    expect(w.city.bondResourceTotal!.treasury).toBeCloseTo(10, 6);
  });

  it("債券 −3,050・債券化率 0%：0で止まるので建設資金は一度もつかない", () => {
    const w = world([], { bond: -3050 });
    // 8日目で 0 に戻る。その先も 0 のままなのを見るため 10 日
    advance(w, { plan, bondRate: 0, until: START + 10 * DAY, newId }, []);
    expect(w.purse.bond).toBe(0);
    expect((w.city.bondResourceTotal ?? ZERO_GAINS).treasury).toBe(0);
  });

  it("債券 −100・債券化率 50%：0に戻るまでの 100 は建設資金なし", () => {
    const w = world([], { bond: -100 });
    advance(w, { plan, bondRate: 50, until: START + DAY, newId }, []);
    expect(w.city.bondResourceTotal!.treasury).toBeCloseTo(w.purse.bond, 6);
  });
});

describe("AT-037 余りの債券化につく建設資金", () => {
  const food: CurrencyDefLite = {
    id: "food",
    name: "food",
    icon: "🪙",
    categoryIds: ["c-food"],
    rules: [{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }],
    remainder: "TO_BOND",
    remainderDays: 3,
    startDate: "2026-10-01",
    endDate: null,
    sortOrder: 0,
    createdAt: 0,
  };
  const plan = new BudgetPlan(60000, [{ monthly: 6000, startAt: 0, endAt: null }], [food], TZ);

  it("食費コインの余り 5,000 が債券に入ると、5,000円の建設資金がつく", () => {
    const w = world([food]);
    advance(w, { plan, bondRate: 0, until: MON + 10 * HOUR, newId }, []);
    pay(w.purse, 2000, w.lots, []);
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.purse.bond).toBe(5000);
    expect(w.city.bondResourceTotal!.treasury).toBeCloseTo(5000, 6);
  });

  it("上限を超えて金貨になった分には建設資金がつかない", () => {
    const w = world([food], { bond: bondCap(60000) - 1000 });
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.purse.gold).toBe(6000);
    expect(w.city.bondResourceTotal!.treasury).toBeCloseTo(1000, 6);
  });

  it("1回で計算しても1時間ごとに計算しても、債券化の建設資金・利息・街が一致する", () => {
    const opts = { plan, bondRate: 30, newId };
    const a = world([food], { bond: 50000, early: true });
    const b = world([food], { bond: 50000, early: true });
    const end = START + 7 * DAY;
    advance(a, { ...opts, until: end }, []);
    for (let t = START + HOUR; t <= end; t += HOUR) advance(b, { ...opts, until: t }, []);
    expect(b.city.bondResourceTotal!.treasury).toBeCloseTo(a.city.bondResourceTotal!.treasury, 6);
    expect(b.city.interestTotal!).toBeCloseTo(a.city.interestTotal!, 6);
    expect(b.city.treasury).toBeCloseTo(a.city.treasury, 6);
    expect(b.city.completed).toBeCloseTo(a.city.completed, 6);
    expect(a.city.bondResourceTotal!.treasury).toBeGreaterThan(0);
  });
});

describe("ERL-01・02 開拓期ボーナス", () => {
  it("シーズン1〜7日目の貯金は ×2、8〜14日目は ×1.5、15日目からは ×1", () => {
    const c = createCity(START, 100000);
    expect([0, 6, 7, 13, 14].map((d) => earlyBonusRate(c, c.startedAt + d * DAY + HOUR))).toEqual([2, 2, 1.5, 1.5, 1]);
    expect(creditFund(c, 1000, c.startedAt + HOUR)).toBe(1000);
    expect(creditFund(c, 1000, c.startedAt + 8 * DAY)).toBe(500);
    expect(creditFund(c, 1000, c.startedAt + 20 * DAY)).toBe(0);
    expect(c.treasury).toBe(2000 + 1500 + 1000);
  });

  it("増える分はシーズンで基準額の0.3倍まで", () => {
    const c = createCity(START, 100000);
    expect(creditFund(c, 50000, c.startedAt + HOUR)).toBe(30000);
    expect(creditFund(c, 1000, c.startedAt + 2 * HOUR)).toBe(0);
    expect(c.earlyBonus).toBe(30000);
  });

  it("採掘の債券化でも開拓期ボーナスがつく", () => {
    const plan = new BudgetPlan(60000, [], [], TZ);
    const w = world([], { early: true });
    advance(w, { plan, bondRate: 50, until: START + DAY, newId }, []);
    expect(w.purse.bond).toBeGreaterThan(0);
    expect(w.city.bondResourceTotal!.treasury).toBeCloseTo(w.purse.bond * 2, 0);
  });
});
