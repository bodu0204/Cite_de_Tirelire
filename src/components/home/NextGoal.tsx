"use client";

import Link from "next/link";
import { coverPlans, firstShort, PLAN_KEYS, type PlanStock } from "@/game/planQueue";
import { fmt } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { planLabel, shortText } from "../exchange/PlanList";
import { Gauge } from "../ui";

/**
 * 次の目標：計画列に今の在庫を先頭から割り当て、最初に足りなくなる計画（交換画面の「次の1件」と同じ）。
 * 進み具合は木材・石材・都市資金を金貨に換算して1本のバーにする
 */
export function NextGoal({ v }: { v: ActiveView }) {
  const c = v.city;
  const m = v.metrics;
  const rate = v.exchange.rates.gold;
  const stock: PlanStock = { wood: c.stock.wood, stone: c.stock.stone, treasury: c.treasury };
  const { coverage, expansion } = firstShort(coverPlans(v.exchange.planQueue, stock));
  const p = coverage.plan;
  const gold = (s: PlanStock) => PLAN_KEYS.reduce((a, k) => a + (rate[k] > 0 ? s[k] / rate[k] : 0), 0);
  const shortGold = Math.ceil(gold(coverage.short));
  // 交換しなくても、街の生産だけで貯まるまでの時間（作れない資源があれば出さない）
  const hours = PLAN_KEYS.reduce((h, k) => {
    if (coverage.short[k] <= 0) return h;
    const r = m.production[k];
    return r > 1e-9 ? Math.max(h, coverage.short[k] / r) : Infinity;
  }, 0);
  const wait = !Number.isFinite(hours) ? null : hours < 1 ? "1時間以内" : hours < 48 ? `約${Math.ceil(hours)}時間` : `約${Math.ceil(hours / 24)}日`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">次の目標</span>
        <span className="min-w-0 truncate text-right text-sm font-semibold">{expansion ? `拡張計画（${p.name}相当）` : planLabel(p)}</span>
      </div>
      <Gauge value={gold(coverage.covered)} max={gold(p.cost)} color="var(--accent)" label="次の目標までの資源の充足" />
      <div className="mt-1 flex flex-wrap justify-between gap-x-2 text-xs text-muted">
        <span className="num">あと {shortText(coverage.short) || "なし"}</span>
        {wait && <span>街の生産だけなら{wait}</span>}
      </div>
      {shortGold > 0 && (
        <p className="mt-1 text-xs">
          金貨 <span className="num font-semibold">約{fmt(shortGold)}G</span> 分の交換で届きます。
          <Link href="/exchange" className="ml-1 text-muted underline">
            交換する
          </Link>
        </p>
      )}
    </div>
  );
}
