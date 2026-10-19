import { describe, expect, it } from "vitest";
import { bondCap } from "../bond";
import { createCity } from "../city/init";
import { DAY, HOUR, MICRO_PER_GOLD } from "../config";
import { BudgetPlan, type CurrencyDefLite, type Rule } from "../currency";
import { advance, type Accrual, type World } from "../idle";
import { newMine } from "../mine";
import { lotOrder, pay, type Lot } from "../settle";
import { dayKey, zonedTimeToUtc } from "../time";

const TZ = "Asia/Tokyo";
// 2026-10-19 は月曜
const MON = zonedTimeToUtc(2026, 10, 19, TZ);
const START = MON - DAY + 9 * HOUR; // 日曜 9:00 にシーズン開始

function def(id: string, rules: Rule[], extra: Partial<CurrencyDefLite> = {}): CurrencyDefLite {
  return {
    id,
    name: id,
    icon: "🪙",
    categoryIds: ["c-" + id],
    rules,
    remainder: "KEEP",
    remainderDays: null,
    startDate: "2026-10-01",
    endDate: null,
    sortOrder: 0,
    createdAt: 0,
    ...extra,
  };
}

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

describe("AT-020 余りを N 日後に債券へ", () => {
  const food = def("food", [{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }], { remainder: "TO_BOND", remainderDays: 3 });
  const plan = new BudgetPlan(60000, [{ monthly: 6000, startAt: 0, endAt: null }], [food], TZ);

  it("月曜 7,000 発生 → 食費 2,000 の購入でコイン 5,000 → 3日後の0:00に債券 +5,000", () => {
    const w = world([food]);
    advance(w, { plan, bondRate: 0, until: MON + 10 * HOUR, newId }, []);
    expect(w.lots).toHaveLength(1);
    expect(dayKey(w.lots[0].issuedAt, TZ)).toBe("2026-10-19");
    expect(w.lots[0].remaining).toBe(7000);
    pay(w.purse, 2000, w.lots, []);
    expect(w.lots[0].remaining).toBe(5000);

    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY - 1, newId }, []);
    expect(w.purse.bond).toBe(0);
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.lots[0].remaining).toBe(0);
    expect(w.purse.bond).toBe(5000);
  });

  it("債券が上限なら、超えた分は所持金貨へ", () => {
    const w = world([food], { bond: bondCap(60000) - 1000 });
    advance(w, { plan, bondRate: 0, until: MON + 3 * DAY, newId }, []);
    expect(w.purse.bond).toBe(bondCap(60000));
    expect(w.purse.gold).toBe(6000);
  });
});

describe("毎分ルール", () => {
  it("月あたりの量を毎分発生し、日ごとに1ロットにまとめる", () => {
    const d = def("snack", [{ kind: "minute", monthlyAmount: 31000 }]); // 10月は1日 1,000
    const plan = new BudgetPlan(60000, [], [d], TZ);
    const w = world([d]);
    advance(w, { plan, bondRate: 0, until: MON + DAY, newId }, []);
    // 日曜 9:00〜24:00 は 15時間ぶん（625）、月曜は丸1日（1,000）。µ単位の切り捨てで1少なくなることがある
    expect(w.lots.map((l) => dayKey(l.issuedAt, TZ))).toEqual(["2026-10-18", "2026-10-19"]);
    expect(w.lots[0].amount).toBeGreaterThanOrEqual(624);
    expect(w.lots[0].amount).toBeLessThanOrEqual(625);
    expect(w.lots[0].amount + w.lots[1].amount).toBeGreaterThanOrEqual(1624);
    expect(w.lots[0].amount + w.lots[1].amount).toBeLessThanOrEqual(1625);
    // 採掘からは同じ額が差し引かれている（60,000 − 31,000）
    expect(plan.netAt(MON)).toBe(29000);
  });
});

describe("AT-026 ユーザ通貨を20種類", () => {
  it("7日放置の計算が正しく、精算は並び順どおり", () => {
    const defs = Array.from({ length: 20 }, (_, i) =>
      def(`c${i}`, [{ kind: "weekly", every: 1, weekdays: [1, 4], amount: 100 + i }], { sortOrder: i, categoryIds: ["shared"] }),
    );
    const plan = new BudgetPlan(200000, [], defs, TZ);
    const w = world(defs);
    advance(w, { plan, bondRate: 0, until: START + 7 * DAY, newId }, []);
    // 月曜・木曜の2回ずつ
    expect(w.lots).toHaveLength(40);
    for (let i = 0; i < 20; i++) expect(w.lots.filter((l) => l.currencyId === `c${i}`).reduce((a, l) => a + l.amount, 0)).toBe(2 * (100 + i));
    const order = w.lots.sort(lotOrder((id) => Number(id.slice(1))));
    // 期限なし同士は通貨の並び順、同じ通貨は発生の早い順
    expect(order.slice(0, 3).map((l) => l.currencyId)).toEqual(["c0", "c0", "c1"]);
  });
});

describe("AT-027 放置を1回で計算しても、1時間ごとに計算しても同じ", () => {
  it("債券倍率・期限の債券化・通貨の発生を含めて一致する", () => {
    const defs = [
      def("food", [{ kind: "weekly", every: 1, weekdays: [1], amount: 7000 }], { remainder: "TO_BOND", remainderDays: 2 }),
      def("snack", [{ kind: "minute", monthlyAmount: 5000 }], { remainder: "TO_BOND", remainderDays: 1, sortOrder: 1 }),
    ];
    const plan = new BudgetPlan(60000, [{ monthly: 6000, startAt: 0, endAt: null }], defs, TZ);
    const opts = { plan, bondRate: 30, newId };
    const a = world(defs, { bond: 50000 });
    const b = world(defs, { bond: 50000 });
    // シーズン開始の次のティック境界から始める
    const end = START + 7 * DAY;
    advance(a, { ...opts, until: end }, []);
    for (let t = START + HOUR; t <= end; t += HOUR) advance(b, { ...opts, until: t }, []);

    expect(b.purse.bond).toBe(a.purse.bond);
    expect(b.purse.gold).toBe(a.purse.gold);
    expect(Number(b.purse.mine.uncollected / MICRO_PER_GOLD)).toBeCloseTo(Number(a.purse.mine.uncollected / MICRO_PER_GOLD), -1);
    const sum = (w: World, k: keyof Lot) => w.lots.reduce((s, l) => s + (l[k] as number), 0);
    expect(sum(b, "amount")).toBe(sum(a, "amount"));
    expect(sum(b, "remaining")).toBe(sum(a, "remaining"));
    expect(b.city.devPoints).toBeCloseTo(a.city.devPoints, 6);
    expect(b.city.population).toBeCloseTo(a.city.population, 6);
    expect(b.city.buildings.length).toBe(a.city.buildings.length);
    // 債券が増えているので時間発展は倍率ぶん速い
    expect(a.purse.bond).toBeGreaterThan(50000);
  });
});
