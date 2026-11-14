"use client";

import Link from "next/link";
import { coverPlans, firstShort, PLAN_KEYS, type PlanStock } from "@/game/planQueue";
import { fmt } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { GoldNeed, goldForOf } from "../exchange/GoldNeed";
import { planLabel, shortText } from "../exchange/PlanList";
import { Gauge } from "../ui";
import { waitingFor } from "./waiting";

/**
 * 次の目標：計画列に今の在庫を先頭から割り当て、最初に足りなくなる計画（交換画面の「次の1件」と同じ）。
 * 進み具合は木材・石材・都市資金を金貨に換算して1本のバーにする
 */
export function NextGoal({ v }: { v: ActiveView }) {
  const c = v.city;
  const m = v.metrics;
  const rate = v.exchange.rates.gold;
  const stock: PlanStock = { wood: c.stock.wood, stone: c.stock.stone, treasury: c.treasury };
  const cov = coverPlans(v.exchange.planQueue, stock);
  const { coverage, expansion } = firstShort(cov);
  // 在庫で払える計画は、次のティック（10分ごと）に街が工事を始める
  const ready = cov.plans.filter((x) => x.ok).length;
  const p = coverage.plan;
  const gold = (s: PlanStock) => PLAN_KEYS.reduce((a, k) => a + (rate[k] > 0 ? s[k] / rate[k] : 0), 0);
  const shortGold = Math.ceil(gold(coverage.short));
  // 交換に要る金貨（開拓期ボーナスの間は ~~92G~~ → 46G）
  const need = goldForOf(v)(coverage.short.treasury);
  // 同時に進める工事の空きがなければ、払える計画も今の工事の完成を待つ
  const full = c.jobs.length >= v.dev.concurrentJobs;
  // 交換しなくても、街の生産だけで貯まるまでの時間（作れない資源があれば出さない）
  const hours = PLAN_KEYS.reduce((h, k) => {
    if (coverage.short[k] <= 0) return h;
    const r = m.production[k];
    return r > 1e-9 ? Math.max(h, coverage.short[k] / r) : Infinity;
  }, 0);
  const waiting = waitingFor(v);
  const wait = !Number.isFinite(hours) ? null : hours < 1 ? "1時間以内" : hours < 48 ? `約${Math.ceil(hours)}時間` : `約${Math.ceil(hours / 24)}日`;

  // 具体的な計画がなければ、資源ではなく待っているもの（技術Lv・発展Lv・人口など）を目標にする
  if (waiting.length > 0)
    return (
      <div>
        <span className="text-sm font-medium">次の目標</span>
        <p className="mt-1 text-sm">街は今、資源ではなく次を待っています。</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
          {waiting.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          資源は備蓄中です（拡張計画 {p.name}相当{shortGold > 0 ? `、次の1件まで あと ${shortText(coverage.short)}` : ""}）。
        </p>
      </div>
    );

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
      {ready > 0 && (
        <p className="mt-1 text-xs text-muted">
          {full
            ? `今の在庫で実施できる計画 ${fmt(ready)}件は、工事の空き（同時に${v.dev.concurrentJobs}件まで）ができしだい着工します。`
            : `今の在庫で実施できる計画 ${fmt(ready)}件は、まもなく着工します。`}
        </p>
      )}
      {shortGold > 0 && (
        <p className="mt-1 text-xs">
          金貨 <GoldNeed need={need} /> 分の交換で届きます。
          <Link href="/exchange" className="ml-1 text-muted underline">
            交換する
          </Link>
        </p>
      )}
    </div>
  );
}
