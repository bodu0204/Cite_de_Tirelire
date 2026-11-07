import { levelCap } from "@/game/city/sim";
import { HOUSING_VACANCY_TARGET } from "@/game/config";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";

/**
 * 街が建設資金ではなく何を待っているか（sim.ts plansFor・develop の条件の裏返し）。上ほど近い目標。
 * 具体的な計画がない時に出す。always なら、計画があっても出す（交換画面で、交換後に今ある計画をすべて払える時）
 */
export function waitingFor(v: ActiveView, always = false): string[] {
  if (!always && v.exchange.planQueue.plans.length > 0) return [];
  const c = v.city;
  const m = v.metrics;
  const t = v.tech;
  const d = v.dev;
  const out: string[] = [];
  const busy = c.jobs.length;
  // 同時に進める工事は発展Lvごとに上限がある（GRW-03）。空きがなければ、払える計画も完成を待つ
  if (busy >= d.concurrentJobs) out.push(`工事の空き：同時に${d.concurrentJobs}件まで（今 ${busy}件が工事中。完成しだい次を着工）`);
  else if (always && v.exchange.planQueue.plans.length > 0) out.push(`払える計画は10分以内に着工（工事の空き ${d.concurrentJobs - busy}件）`);
  else if (busy > 0) out.push(`工事中 ${busy}件の完成`);
  if (t.next !== null && t.nextBuildable.length > 0)
    out.push(`技術Lv${t.level + 1}：あと${yen(t.remaining)}の貯金で ${t.nextBuildable.slice(0, 3).join("・")} が建てられる`);
  const atCap = c.buildings.some((b) => b.line && b.level >= d.levelCap);
  if (d.next !== null && atCap && levelCap(d.level + 1) > d.levelCap)
    out.push(`発展Lv${d.level + 1}：あと${fmt(Math.ceil(d.next - d.points))}pt で建物のLv上限が ${levelCap(d.level + 1)} に上がる`);
  const vacancy = m.housingCap > 0 ? (m.housingCap - m.population) / m.housingCap : 0;
  if (vacancy >= HOUSING_VACANCY_TARGET)
    out.push(`人口の増加：住宅の空き ${Math.round(vacancy * 100)}%（${Math.round(HOUSING_VACANCY_TARGET * 100)}%を切ると住宅を増やす）`);
  return out;
}
