// 計画列（具体的な計画のあとに拡張計画が無限に続く）への在庫の割り当て。
// 必要資源の計算（sim.ts cityNeeds）と交換画面のプレビュー（交換後の在庫で実施できる計画）で同じ計算を使う。
// 都市資金も金貨で交換できるので、木材・石材と同じく割り当てる。
import type { Cost, LineId } from "./catalog";
import type { JobKind } from "./types";

export interface QueuePlan {
  kind: JobKind;
  line: LineId;
  tier: number;
  level: number;
  name: string;
  cost: Cost;
}

export interface PlanQueue {
  /** 具体的な計画（着手したい順） */
  plans: QueuePlan[];
  /** 具体的な計画のあとに無限に続く拡張計画1件 */
  expansion: QueuePlan;
}

/** 計画に割り当てるもの（Cost と同じ並び） */
export type PlanStock = Cost;
export const PLAN_KEYS: (keyof Cost)[] = ["wood", "stone", "treasury"];

export interface PlanCoverage {
  plan: QueuePlan;
  /** この計画のコストのうち、在庫でまかなえる分（前の計画に先に割り当てたあと） */
  covered: PlanStock;
  /** この計画までを実施するのに足りない分（前の計画の不足分を含む） */
  short: PlanStock;
  /** 木材・石材・都市資金がすべて足りる */
  ok: boolean;
}

export interface QueueCoverage {
  plans: PlanCoverage[];
  /** 拡張計画：在庫で払える件数と、その次の1件 */
  expansion: { count: number; next: PlanCoverage };
}

const each = (f: (k: keyof Cost) => number): PlanStock => ({ wood: f("wood"), stone: f("stone"), treasury: f("treasury") });

/** 在庫を計画列の先頭から順に割り当てる。足りない計画があっても、後ろの計画はその分を先に払う前提で求める */
export function coverPlans(queue: PlanQueue, stock: PlanStock): QueueCoverage {
  let rest = { ...stock };
  const cover = (plan: QueuePlan, r: PlanStock): PlanCoverage => {
    const short = each((k) => Math.max(0, plan.cost[k] - r[k]));
    return {
      plan,
      covered: each((k) => Math.max(0, Math.min(plan.cost[k], r[k]))),
      short,
      ok: PLAN_KEYS.every((k) => short[k] === 0),
    };
  };
  const plans = queue.plans.map((p) => {
    const c = cover(p, rest);
    rest = each((k) => rest[k] - p.cost[k]);
    return c;
  });
  // 拡張計画は同じコストが無限に並ぶので、払える件数を割り算で求める
  const x = queue.expansion;
  const fits = PLAN_KEYS.filter((k) => x.cost[k] > 0).map((k) => Math.floor(rest[k] / x.cost[k]));
  const count = fits.length > 0 ? Math.max(0, Math.min(...fits)) : 0;
  const next = cover(x, each((k) => rest[k] - count * x.cost[k]));
  return { plans, expansion: { count, next } };
}

/** 在庫が最初に足りなくなる計画（すべて足りれば拡張計画の次の1件） */
export function firstShort(c: QueueCoverage): { coverage: PlanCoverage; expansion: boolean } {
  const p = c.plans.find((x) => !x.ok);
  return p ? { coverage: p, expansion: false } : { coverage: c.expansion.next, expansion: true };
}
