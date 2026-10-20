// 必要資源の割合による交換と、債券化につく資源（docs/needs-based-exchange.md §11）
import { describe, expect, it } from "vitest";
import { bondCap, bondResourceEligible } from "../bond";
import { createCity } from "../city/init";
import { computeMetrics } from "../city/economy";
import { cityNeeds, expansionPlan } from "../city/sim";
import { DAY, GOLD_RESOURCE_VALUE, HOUR } from "../config";
import { BudgetPlan, type CurrencyDefLite } from "../currency";
import { needShares, quoteNeedsExchange, splitAmount } from "../exchange";
import { advance, type Accrual, type World } from "../idle";
import { newMine } from "../mine";
import { pay } from "../settle";
import { zonedTimeToUtc } from "../time";
import type { Stock } from "../types";

const TZ = "Asia/Tokyo";
const MON = zonedTimeToUtc(2026, 10, 19, TZ);
const START = MON - DAY + 9 * HOUR;
const LV1 = { bank: 1, goldMine: 1, silverMine: 1 };
/** 資源を金貨換算した額（Lvボーナスなし） */
const goldOf = (s: Stock) => s.wood / GOLD_RESOURCE_VALUE.wood + s.stone / GOLD_RESOURCE_VALUE.stone + s.food / GOLD_RESOURCE_VALUE.food;

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
  const needs = { wood: 300, stone: 200, food: 100 };

  it("必要割合は金貨換算の比", () => {
    const s = needShares(needs);
    expect(s.wood).toBeCloseTo(0.375);
    expect(s.stone).toBeCloseTo(0.5);
    expect(s.food).toBeCloseTo(0.125);
  });

  it("AT-030 1,000G → 木材 3,750・石材 2,500・食料 1,250、手数料 5S", () => {
    const q = quoteNeedsExchange("gold", 1000, needs, LV1);
    expect(q.split).toEqual({ wood: 375, stone: 500, food: 125 });
    expect(q.gains).toEqual({ wood: 3750, stone: 2500, food: 1250 });
    expect(q.silverCost).toBe(5);
    expect(q.goldCost).toBe(1000);
  });

  it("AT-031 1,000S → 木材 375・石材 250・食料 125、銀貨 1,005", () => {
    const q = quoteNeedsExchange("silver", 1000, needs, LV1);
    expect(q.gains).toEqual({ wood: 375, stone: 250, food: 125 });
    expect(q.silverCost).toBe(1005);
    expect(q.goldCost).toBe(0);
  });

  it("振り分けは最大剰余法で合計が交換額と一致する", () => {
    const s = splitAmount(1000, { wood: 1 / 3, stone: 1 / 3, food: 1 / 3 });
    expect(s).toEqual({ wood: 334, stone: 333, food: 333 });
    const t = splitAmount(7, needShares({ wood: 10, stone: 30, food: 0 }));
    expect(t.wood + t.stone + t.food).toBe(7);
  });

  it("債券化の資源は手数料なし・小数のまま", () => {
    const q = quoteNeedsExchange("gold", 3, needs, LV1, { fee: false, floor: false });
    expect(q.silverCost).toBe(0);
    expect(goldOf(q.gains)).toBeCloseTo(3, 9);
  });
});

describe("計画列と必要資源", () => {
  it("初期の街でも必要資源がある", () => {
    const n = cityNeeds(createCity(START)).needs;
    expect(n.wood + n.stone + n.food).toBeGreaterThan(0);
  });

  it("AT-032/033 在庫が非常に多くても拡張計画で必要資源が正（ループしない）", () => {
    const city = createCity(START);
    city.stock = { wood: 1_000_000, stone: 1_000_000, food: 1_000_000 };
    const r = cityNeeds(city);
    expect(r.next.expansion).toBe(true);
    expect(r.needs.wood + r.needs.stone).toBeGreaterThan(0);
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
    expect(goldOf(w.city.bondResourceTotal ?? { wood: 0, stone: 0, food: 0 })).toBe(0);
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
