"use client";

import { useState } from "react";
import { coverPlans, PLAN_KEYS, type PlanCoverage, type PlanQueue, type PlanStock, type QueuePlan } from "@/game/planQueue";
import type { Gains } from "@/game/types";
import { fmt } from "@/lib/api";
import { Card, Gauge } from "../ui";

/** 最初に表示する計画の数（交換後に足りなくなる計画がそれより後ろなら、そこまで表示する） */
const INITIAL_ROWS = 6;

const LABEL: Record<keyof PlanStock, string> = { wood: "木材", stone: "石材", treasury: "都市資金" };

const planLabel = (p: QueuePlan) => (p.kind === "build" ? `${p.name}を新築` : p.kind === "evolve" ? `${p.name}へ進化` : `${p.name} Lv${p.level}へ`);

type Tone = "ok" | "new" | "short";

const statusOf = (before: PlanCoverage, after: PlanCoverage): { text: string; tone: Tone } =>
  !after.ok ? { text: "資源が不足", tone: "short" } : before.ok ? { text: "実施できる", tone: "ok" } : { text: "交換で実施できる", tone: "new" };

const TONE: Record<Tone, string> = {
  ok: "border-dev text-dev",
  new: "border-accent bg-accent text-accent-ink font-semibold",
  short: "border-danger text-danger",
};

/** 木材・石材・都市資金のゲージ（コストが0のものは出さない） */
function Bars({ plan, before, after }: { plan: QueuePlan; before: PlanStock; after: PlanStock }) {
  const keys = PLAN_KEYS.filter((k) => plan.cost[k] > 0);
  return (
    <div className="mt-1 grid grid-cols-3 gap-2">
      {keys.map((k) => (
        <div key={k}>
          <div className="flex justify-between gap-1 text-xs text-muted">
            <span>{LABEL[k]}</span>
            <span className="num">
              {fmt(Math.floor(after[k]))}/{fmt(plan.cost[k])}
            </span>
          </div>
          <Gauge value={before[k]} extra={Math.max(0, after[k] - before[k])} max={plan.cost[k]} color="var(--accent)" label={`${LABEL[k]}の充足`} />
        </div>
      ))}
    </div>
  );
}

const shortText = (s: PlanStock) =>
  PLAN_KEYS.filter((k) => s[k] > 0)
    .map((k) => `${LABEL[k]} ${fmt(Math.ceil(s[k]))}`)
    .join("・");

/**
 * 計画列と、交換で入る資源・都市資金を足した在庫で実施できるか。入力（gains）が変わるたびに計算し直す。
 * 在庫は計画列の先頭から順に割り当てる（必要資源の計算と同じ。docs/needs-based-exchange.md §4.2）。
 */
export function PlanList({
  queue,
  stock,
  foodNeed,
  gains,
}: {
  queue: PlanQueue;
  /** 今の在庫（木材・石材・都市資金） */
  stock: PlanStock;
  /** 食料の24時間分の不足（交換前） */
  foodNeed: number;
  /** この交換で街に入る資源と都市資金 */
  gains: Gains;
}) {
  const [all, setAll] = useState(false);
  /** 交換しなくても実施できる計画を隠す（交換で実施できるようになる計画は隠さない） */
  const [hideOk, setHideOk] = useState(false);
  const before = coverPlans(queue, stock);
  const after = coverPlans(queue, { wood: stock.wood + gains.wood, stone: stock.stone + gains.stone, treasury: stock.treasury + gains.treasury });
  const enabled = after.plans.filter((p, i) => p.ok && !before.plans[i].ok).length;
  const okCount = before.plans.filter((p) => p.ok).length;
  const moreExpansion = after.expansion.count - before.expansion.count;

  const rows = after.plans.map((a, i) => ({ a, b: before.plans[i], i })).filter((r) => !(hideOk && r.b.ok));
  const firstShort = rows.findIndex((r) => !r.a.ok);
  const shown = all ? rows : rows.slice(0, Math.max(INITIAL_ROWS, firstShort + 1));
  const hidden = rows.length - shown.length;

  const x = after.expansion;
  // 払える件数が増えたら次の1件は交換前と比べられないので、すべて交換で入った分として示す
  const xBefore = moreExpansion > 0 ? { wood: 0, stone: 0, treasury: 0 } : before.expansion.next.covered;
  const foodAfter = Math.max(0, foodNeed - gains.food);

  return (
    <Card
      title="開発計画と交換後の資源"
      action={
        okCount > 0 && (
          <button type="button" aria-pressed={hideOk} className="shrink-0 text-xs text-muted underline" onClick={() => setHideOk(!hideOk)}>
            {hideOk ? "すべて表示" : "実施できるものを隠す"}
          </button>
        )
      }
    >
      <p className="text-sm" aria-live="polite">
        {enabled > 0 || moreExpansion > 0 ? (
          <>
            この交換で
            {enabled > 0 && <span className="font-semibold">計画 {enabled}件が実施できるように</span>}
            {enabled > 0 && moreExpansion > 0 && "、"}
            {moreExpansion > 0 && <span className="font-semibold">拡張計画 {moreExpansion}件分の資源がそろうように</span>}
            なります。
          </>
        ) : (
          <span className="text-muted">交換額を入力すると、交換後の在庫で実施できる計画がわかります。</span>
        )}
      </p>
      <p className="mt-1 text-xs text-muted">在庫は上の計画から順に割り当てます。斜線は交換で入る分です。</p>

      <ol className="mt-3 space-y-3">
        {hideOk && okCount > 0 && <li className="text-xs text-muted">実施できる計画 {okCount}件を隠しています。</li>}
        {shown.map(({ a, b, i }) => {
          const st = statusOf(b, a);
          return (
            <li key={i} className="rounded-lg border border-line p-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm">
                  <span className="num mr-1 text-muted">{i + 1}.</span>
                  {planLabel(a.plan)}
                </span>
                <span className={`shrink-0 rounded-md border px-1.5 text-xs ${TONE[st.tone]}`}>{st.text}</span>
              </div>
              <Bars plan={a.plan} before={b.covered} after={a.covered} />
              {!a.ok && <p className="mt-1 text-xs text-danger">ここまで実施するには あと {shortText(a.short)}</p>}
            </li>
          );
        })}
        {hidden > 0 && (
          <li>
            <button type="button" className="text-sm text-muted underline" onClick={() => setAll(true)}>
              ほかの計画 {hidden}件を表示
            </button>
          </li>
        )}
        <li className="rounded-lg border border-dashed border-line p-2">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm">
              拡張計画（{x.next.plan.name}相当）
              <span className="block text-xs text-muted">具体的な計画のあとに続く備蓄の目標</span>
            </span>
            <span className={`shrink-0 rounded-md border px-1.5 text-xs ${TONE[moreExpansion > 0 ? "new" : x.count > 0 ? "ok" : "short"]}`}>
              <span className="num">{fmt(x.count)}</span>件分
              {moreExpansion > 0 && <span className="num">（+{fmt(moreExpansion)}）</span>}
            </span>
          </div>
          <Bars plan={x.next.plan} before={xBefore} after={x.next.covered} />
          <p className="mt-1 text-xs text-muted">次の1件まで あと {shortText(x.next.short) || "なし"}</p>
        </li>
      </ol>

      <div className="mt-3 flex justify-between text-sm">
        <span className="text-muted">食料（24時間分の備え）</span>
        <span className={foodAfter > 0 ? "text-danger" : foodNeed > 0 ? "font-semibold" : "text-dev"}>
          {foodNeed <= 0 ? "足りている" : foodAfter <= 0 ? "交換で足りる" : <span className="num">あと {fmt(Math.ceil(foodAfter))}</span>}
        </span>
      </div>
    </Card>
  );
}
