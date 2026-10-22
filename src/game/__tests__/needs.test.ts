// 必要資源の割合による交換と、債券化につく資源（docs/needs-based-exchange.md §11）
import { describe, expect, it } from "vitest";
import { bondCap, bondResourceEligible } from "../bond";
import { createCity } from "../city/init";
import { computeMetrics } from "../city/economy";
import { cityNeeds, expansionPlan } from "../city/sim";
import { DAY, GOLD_RESOURCE_VALUE, HOUR } from "../config";
import { BudgetPlan, type CurrencyDefLite } from "../currency";
import { exchangeRate, needShares, quoteNeedsExchange, quoteResourceExchange, splitAmount, ZERO_GAINS } from "../exchange";
import { advance, type Accrual, type World } from "../idle";
import { newMine } from "../mine";
import { coverPlans, type PlanQueue } from "../planQueue";
import { pay } from "../settle";
import { zonedTimeToUtc } from "../time";
import type { Gains } from "../types";

const TZ = "Asia/Tokyo";
const MON = zonedTimeToUtc(2026, 10, 19, TZ);
const START = MON - DAY + 9 * HOUR;
const LV1 = { bank: 1, goldMine: 1, silverMine: 1 };
/** 資源・都市資金を金貨換算した額（Lvボーナスなし） */
const goldOf = (s: Gains) =>
  s.wood / GOLD_RESOURCE_VALUE.wood + s.stone / GOLD_RESOURCE_VALUE.stone + s.food / GOLD_RESOURCE_VALUE.food + s.treasury / GOLD_RESOURCE_VALUE.treasury;

function world(defs: CurrencyDefLite[], o: { bond?: number } = {}): World {
  const accruals = new Map<string, Accrual>(defs.map((d) => [d.id, { currencyId: d.id, lastAccrualAt: START, fraction: 0n }]));
  return {
    purse: { mine: newMine(START, TZ), gold: 0, silver: 0, bond: o.bond ?? 0, bondCap: 0, moves: [], overspend: 0 },
    city: createCity(START),
    lots: [],
    accruals,
  };
}

let seq = 0;
const newId = () => `l${++seq}`;

describe("おまかせ交換", () => {
  const needs = { wood: 300, stone: 200, food: 100, treasury: 0 };

  it("必要割合は金貨換算の比", () => {
    const s = needShares(needs);
    expect(s.wood).toBeCloseTo(0.375);
    expect(s.stone).toBeCloseTo(0.5);
    expect(s.food).toBeCloseTo(0.125);
    expect(s.treasury).toBe(0);
  });

  it("AT-030 1,000G → 木材 3,750・石材 2,500・食料 1,250、手数料 5S", () => {
    const q = quoteNeedsExchange("gold", 1000, needs, LV1);
    expect(q.split).toEqual({ wood: 375, stone: 500, food: 125, treasury: 0 });
    expect(q.gains).toEqual({ wood: 3750, stone: 2500, food: 1250, treasury: 0 });
    expect(q.silverCost).toBe(5);
    expect(q.goldCost).toBe(1000);
  });

  it("AT-031 1,000S → 木材 375・石材 250・食料 125、銀貨 1,005", () => {
    const q = quoteNeedsExchange("silver", 1000, needs, LV1);
    expect(q.gains).toEqual({ wood: 375, stone: 250, food: 125, treasury: 0 });
    expect(q.silverCost).toBe(1005);
    expect(q.goldCost).toBe(0);
  });

  it("振り分けは最大剰余法で合計が交換額と一致する", () => {
    const s = splitAmount(1000, { wood: 1 / 3, stone: 1 / 3, food: 1 / 3, treasury: 0 });
    expect(s).toEqual({ wood: 334, stone: 333, food: 333, treasury: 0 });
    const t = splitAmount(7, needShares({ wood: 10, stone: 30, food: 0, treasury: 50 }));
    expect(t.wood + t.stone + t.food + t.treasury).toBe(7);
  });

  it("債券化の資源は手数料なし・小数のまま", () => {
    const q = quoteNeedsExchange("gold", 3, needs, LV1, { fee: false, floor: false });
    expect(q.silverCost).toBe(0);
    expect(goldOf(q.gains)).toBeCloseTo(3, 9);
  });
});

describe("金貨・銀貨→都市資金（docs/needs-based-exchange.md §13）", () => {
  it("1G → 都市資金 10（Lvボーナスは資源と同じ）", () => {
    expect(quoteResourceExchange("gold", "treasury", 100, LV1)).toMatchObject({ gain: 1000, goldCost: 100, silverCost: 5 });
    expect(exchangeRate("gold", "treasury", { bank: 1, goldMine: 6, silverMine: 1 })).toBeCloseTo(exchangeRate("gold", "wood", { bank: 1, goldMine: 6, silverMine: 1 }));
  });

  it("1S → 都市資金 1（銀鉱Lvのボーナスも資源と同じ）。手数料 5S と代金、貯金額には加えない", () => {
    expect(quoteResourceExchange("silver", "treasury", 100, LV1)).toMatchObject({ gain: 100, goldCost: 0, silverCost: 105 });
    const lv = { bank: 1, goldMine: 1, silverMine: 6 };
    expect(exchangeRate("silver", "treasury", lv)).toBeCloseTo(exchangeRate("silver", "wood", lv));
  });

  it("おまかせは都市資金の不足も含めた割合で振り分ける", () => {
    // 金貨換算 木材 30G・石材 40G・食料 10G・都市資金 20G
    const needs = { wood: 300, stone: 200, food: 100, treasury: 200 };
    const q = quoteNeedsExchange("gold", 1000, needs, LV1);
    expect(q.split).toEqual({ wood: 300, stone: 400, food: 100, treasury: 200 });
    expect(q.gains.treasury).toBe(2000);
  });

  it("銀貨のおまかせも都市資金の不足を含めた同じ割合", () => {
    const needs = { wood: 300, stone: 200, food: 100, treasury: 200 };
    const q = quoteNeedsExchange("silver", 1000, needs, LV1);
    expect(q.split).toEqual({ wood: 300, stone: 400, food: 100, treasury: 200 });
    expect(q.gains).toEqual({ wood: 300, stone: 200, food: 100, treasury: 200 });
    expect(q.silverCost).toBe(1005);
  });
});

describe("計画列と必要資源", () => {
  it("初期の街でも必要資源がある", () => {
    const n = cityNeeds(createCity(START)).needs;
    expect(n.wood + n.stone + n.food + n.treasury).toBeGreaterThan(0);
  });

  it("AT-032/033 在庫が非常に多くても拡張計画で必要資源が正（ループしない）", () => {
    const city = createCity(START);
    city.stock = { wood: 1_000_000, stone: 1_000_000, food: 1_000_000 };
    const r = cityNeeds(city);
    expect(r.next.expansion).toBe(true);
    expect(r.needs.wood + r.needs.stone + r.needs.treasury).toBeGreaterThan(0);
    const x = expansionPlan(city, computeMetrics(city).devLevel);
    expect(r.needs.wood).toBeLessThanOrEqual(x.cost.wood);
    expect(r.needs.stone).toBeLessThanOrEqual(x.cost.stone);
  });

  it("街の状態を変えない", () => {
    const city = createCity(START);
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

  it("必要資源は最初に足りなくなる計画の不足分と一致する", () => {
    const city = createCity(START);
    const r = cityNeeds(city);
    const c = coverPlans(r.queue, { wood: city.stock.wood, stone: city.stock.stone, treasury: city.treasury });
    const first = c.plans.find((p) => !p.ok) ?? c.expansion.next;
    expect(first.short).toEqual({ wood: r.needs.wood, stone: r.needs.stone, treasury: r.needs.treasury });
  });
});

describe("AT-035 資源つき対象額", () => {
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
  it("M ＝ 0 なら資源はつかない", () => {
    expect(bondResourceEligible(0, 5000, bondCap(0))).toBe(0);
  });
});

describe("AT-036 採掘の債券化につく資源", () => {
  const plan = new BudgetPlan(60000, [], [], TZ);

  it("債券化率 50%・債券 179,990：入った 10 の分だけ資源がつく", () => {
    const w = world([], { bond: bondCap(60000) - 10 });
    advance(w, { plan, bondRate: 50, until: START + DAY, newId }, []);
    expect(w.purse.bond).toBe(bondCap(60000));
    expect(goldOf(w.city.bondResourceTotal!)).toBeCloseTo(10, 6);
  });

  it("債券 −3,050・債券化率 0%：0で止まるので資源は一度もつかない", () => {
    const w = world([], { bond: -3050 });
    advance(w, { plan, bondRate: 0, until: START + 30 * DAY, newId }, []);
    expect(w.purse.bond).toBe(0);
    expect(goldOf(w.city.bondResourceTotal ?? ZERO_GAINS)).toBe(0);
  });

  it("債券 −100・債券化率 50%：0に戻るまでの 100 は資源なし", () => {
    const w = world([], { bond: -100 });
    advance(w, { plan, bondRate: 50, until: START + DAY, newId }, []);
    expect(goldOf(w.city.bondResourceTotal!)).toBeCloseTo(w.purse.bond, 6);
  });
});

describe("AT-037 余りの債券化につく資源", () => {
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

  it("食費コインの余り 5,000 が債券に入ると、5,000 ぶんの資源がつく", () => {
    const w = world([food]);
    advance(w, { plan, bondRate: 0, until: MON + 10 * HOUR, newId }, []);
    pay(w.purse, 2000, w.lots, []);
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.purse.bond).toBe(5000);
    expect(goldOf(w.city.bondResourceTotal!)).toBeCloseTo(5000, 6);
  });

  it("上限を超えて金貨になった分には資源がつかない", () => {
    const w = world([food], { bond: bondCap(60000) - 1000 });
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.purse.gold).toBe(6000);
    expect(goldOf(w.city.bondResourceTotal!)).toBeCloseTo(1000, 6);
  });

  it("1回で計算しても1時間ごとに計算しても、債券化で得た資源が一致する", () => {
    const opts = { plan, bondRate: 30, newId };
    const a = world([food], { bond: 50000 });
    const b = world([food], { bond: 50000 });
    const end = START + 7 * DAY;
    advance(a, { ...opts, until: end }, []);
    for (let t = START + HOUR; t <= end; t += HOUR) advance(b, { ...opts, until: t }, []);
    for (const k of ["wood", "stone", "food"] as const) {
      expect(b.city.bondResourceTotal![k]).toBeCloseTo(a.city.bondResourceTotal![k], 6);
      expect(b.city.stock[k]).toBeCloseTo(a.city.stock[k], 6);
    }
    expect(goldOf(a.city.bondResourceTotal!)).toBeGreaterThan(0);
  });
});
