// 誤差調整と手元のお金の推測（docs/record-input-redesign.md §8）、支出のベース（同 §6.2・§6.3）。
import { MICRO_PER_GOLD } from "@/game/config";
import { dayEvents, minuteRule, validWindow } from "@/game/currency";
import { fail } from "@/game/errors";
import { savingsProgress } from "@/game/levels";
import { remainingMining } from "@/game/mine";
import { dayKey, parseDateInTz, periodKey, periodRange } from "@/game/time";
import { budgetPlan, requireSeason, type GameCtx } from "./game";
import { seasonPeriods } from "./incomes";
import { previewDiff, resolveDiff } from "./resolve";
import { int } from "./validate";

type Body = Record<string, unknown>;

export const ESTIMATE_KEYS = ["E1", "E2", "E3a", "E3b", "E4a", "E4b", "E5"] as const;
export type EstimateKey = (typeof ESTIMATE_KEYS)[number];
export type EstimateChecks = Record<EstimateKey, boolean>;

/** 初回のチェック：貯金管理の増減（E5）だけ外す（Q9） */
export const DEFAULT_CHECKS: EstimateChecks = { E1: true, E2: true, E3a: true, E3b: true, E4a: true, E4b: true, E5: false };

export function checksOf(v: unknown): EstimateChecks {
  const raw = (v ?? {}) as Record<string, unknown>;
  return Object.fromEntries(ESTIMATE_KEYS.map((k) => [k, typeof raw[k] === "boolean" ? raw[k] : DEFAULT_CHECKS[k]])) as EstimateChecks;
}

const toGold = (v: bigint) => Number(v / MICRO_PER_GOLD);

/** §8.2 の項目の額（チェックによらず全部） */
export async function estimateItems(ctx: GameCtx): Promise<Record<EstimateKey, number>> {
  requireSeason(ctx);
  const { mine, season } = ctx;
  const tz = ctx.user.timezone;
  const { start, end } = periodRange(ctx.now, ctx.cal);
  const len = end - start;
  const key = mine.monthKey;

  // E1：当期の月の収入のうち、まだ通貨になっていない分（残りの採掘・ユーザ通貨の未発生分・差分の予約）
  const rest = remainingMining(mine, budgetPlan(ctx), ctx.cal, mine.lastAccrualAt);
  let custom = 0;
  for (const def of ctx.defs) {
    const w = validWindow(def, tz);
    const from = Math.max(ctx.now, w.startAt);
    const to = Math.min(end, w.endAt ?? Infinity);
    const minute = to > from ? Math.floor((minuteRule(def) * (to - from)) / len) : 0;
    const days = dayEvents(def, ctx.now, end - 1, tz).reduce((a, e) => a + e.amount, 0);
    const cut = ctx.cuts.filter((c) => c.currencyId === def.id && c.periodKey === key).reduce((a, c) => a + c.remaining, 0);
    custom += Math.max(0, minute + days - cut);
  }
  const pending = await ctx.tx.scheduledGrant.findMany({ where: { seasonId: season.id, grantedAt: null, canceled: false } });
  const incomes = await ctx.tx.income.findMany({ where: { id: { in: [...new Set(pending.map((g) => g.incomeId))] } }, select: { id: true, kind: true } });
  const monthly = new Set(incomes.filter((i) => i.kind === "MONTHLY").map((i) => i.id));
  const pendingMonthly = pending.filter((g) => monthly.has(g.incomeId)).reduce((a, g) => a + g.amount, 0);
  const pendingExtra = pending.filter((g) => !monthly.has(g.incomeId)).reduce((a, g) => a + g.amount, 0);
  const E1 = toGold(rest.natural + rest.dividendWindows) + custom + pendingMonthly;
  // E2：臨時の収入の予約・採掘への上乗せで、まだ入っていない分
  const E2 = pendingExtra + toGold(rest.otherWindows);

  // E3：債券・銀貨を除く所持通貨。当期の配当で入った分（先入れ先出しで最後まで残る分）とそれ以外
  const customBalance = ctx.lots.filter((l) => l.remaining > 0 && (l.expiresAt === null || l.expiresAt > ctx.now)).reduce((a, l) => a + l.remaining, 0);
  const E3 = toGold(mine.uncollected) + ctx.balances.gold + ctx.balances.reserved + customBalance;
  const E3a = Math.min(E3, toGold(mine.dividend ?? 0n));

  // E5：貯金管理の 引出 − 追加（別口座へ移した分を手元から引く）
  const savings = await ctx.tx.savingsTransaction.findMany({ where: { seasonId: season.id, deletedAt: null }, select: { kind: true, amount: true } });
  const E5 = -savingsProgress(savings).net;
  return { E1, E2, E3a, E3b: E3 - E3a, E4a: ctx.balances.bond, E4b: ctx.citySpent, E5 };
}

export const estimateOf = (items: Record<EstimateKey, number>, checks: EstimateChecks) => ESTIMATE_KEYS.reduce((a, k) => a + (checks[k] ? items[k] : 0), 0);

/** 手元のお金の推測：全項目の額・保存済みのチェック・これまでの誤差調整 */
export async function estimate(ctx: GameCtx) {
  const checks = checksOf(ctx.user.estimateChecks);
  const history = await ctx.tx.cashAdjustment.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "desc" }, take: 50 });
  if (!ctx.season) return { items: null, checks, estimated: 0, history };
  const items = await estimateItems(ctx);
  return { items, checks, estimated: estimateOf(items, checks), periodKey: ctx.mine!.monthKey, history };
}

function adjustmentInput(ctx: GameCtx, body: Body, estimated: number) {
  if (body.actual !== undefined && body.actual !== null && body.actual !== "") {
    const actual = int(body.actual, "実際の手元の額", { min: -100_000_000, max: 1_000_000_000 });
    return { actual, diff: actual - estimated };
  }
  const diff = int(body.diff, "誤差", { min: -100_000_000, max: 100_000_000 });
  return { actual: estimated + diff, diff };
}

/** 誤差調整のプレビュー */
export async function quoteAdjustment(ctx: GameCtx, body: Body) {
  requireSeason(ctx);
  const checks = checksOf(body.checks ?? ctx.user.estimateChecks);
  const items = await estimateItems(ctx);
  const estimated = estimateOf(items, checks);
  const { actual, diff } = adjustmentInput(ctx, body, estimated);
  return { estimated, actual, diff, resolution: previewDiff(ctx, diff) };
}

/** 誤差調整の記録：＋誤差は債券 → おまかせ交換、−誤差は債券（手数料あり）。報酬なし・あとから編集しない */
export async function recordAdjustment(ctx: GameCtx, body: Body) {
  requireSeason(ctx);
  const checks = checksOf(body.checks ?? ctx.user.estimateChecks);
  const items = await estimateItems(ctx);
  const estimated = estimateOf(items, checks);
  const { actual, diff } = adjustmentInput(ctx, body, estimated);
  if (diff === 0) fail("invalid", "誤差がありません");
  const row = await ctx.tx.cashAdjustment.create({
    data: { userId: ctx.user.id, seasonId: ctx.season.id, date: dayKey(ctx.now, ctx.user.timezone), checks, items, estimated, actual, diff },
  });
  const resolution = await resolveDiff(ctx, diff, { type: "adjustment", id: row.id });
  return { id: row.id, estimated, actual, diff, resolution };
}

// ---- 支出のベース：未記録のサブスクの支払いと未購入のほしい物 ----

export async function purchaseBase(ctx: GameCtx) {
  const tz = ctx.user.timezone;
  const wishes = await ctx.tx.wishItem.findMany({
    where: { userId: ctx.user.id, purchasedAt: null },
    include: ctx.season ? { contributions: { where: { seasonId: ctx.season.id }, select: { amount: true } } } : undefined,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  const wishRows = wishes.map((w) => ({
    id: w.id,
    name: w.name,
    price: w.price,
    reserved: ((w as { contributions?: { amount: number }[] }).contributions ?? []).reduce((a, c) => a + c.amount, 0),
  }));
  if (!ctx.season) return { subscriptions: [], wishes: wishRows };

  const periods = seasonPeriods(ctx);
  const subs = await ctx.tx.subscription.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  const paid = new Set(
    (await ctx.tx.purchase.findMany({ where: { userId: ctx.user.id, subscriptionId: { not: null }, deletedAt: null }, select: { subscriptionId: true, periodKey: true } })).map(
      (p) => `${p.subscriptionId}:${p.periodKey}`,
    ),
  );
  const rows: { subscriptionId: string; name: string; amount: number; cycle: string; periodKey: string; date: string }[] = [];
  for (const s of subs) {
    const startAt = parseDateInTz(s.startDate, tz) ?? 0;
    const endAt = s.endDate ? parseDateInTz(s.endDate, tz) : null;
    const anniversary = s.startDate.slice(5);
    for (const p of periods) {
      if (startAt >= p.end || (endAt !== null && endAt <= p.start)) continue;
      // 年額は開始日の記念日がある期間だけ
      if (s.cycle === "YEARLY") {
        const y = Number(dayKey(p.start, tz).slice(0, 4));
        const hit = [y, y + 1].map((yy) => parseDateInTz(`${yy}-${anniversary}`, tz)).some((t) => t !== null && t >= p.start && t < p.end && t >= startAt);
        if (!hit) continue;
      }
      if (paid.has(`${s.id}:${p.key}`)) continue;
      const due = Math.max(p.start, startAt);
      rows.push({ subscriptionId: s.id, name: s.name, amount: s.amount, cycle: s.cycle, periodKey: p.key, date: dayKey(Math.min(due, ctx.now), tz) });
    }
  }
  return { subscriptions: rows, wishes: wishRows, currentPeriod: periodKey(ctx.now, ctx.cal) };
}

