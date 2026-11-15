// 支出のベース（docs/record-input-redesign.md §6.2・§6.3）：未記録のサブスクの支払いと、全額貯まった未購入のほしい物。
// 以前の誤差調整（手元のお金の推測 E1〜E7）は、置き場所ごとの照合に置き換えた（docs/money-accounts.md RC-08。src/server/accounts.ts）。
import { dayKey, parseDateInTz, periodKey } from "@/game/time";
import type { GameCtx } from "./game";
import { seasonPeriods } from "./incomes";

// ---- 支出のベース：未記録のサブスクの支払いと、全額貯まった未購入のほしい物 ----

export async function purchaseBase(ctx: GameCtx) {
  const tz = ctx.user.timezone;
  const wishes = await ctx.tx.wishItem.findMany({
    where: { userId: ctx.user.id, purchasedAt: null },
    include: ctx.season ? { contributions: { where: { seasonId: ctx.season.id }, select: { amount: true } } } : undefined,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  // ほしい物は積立が価格に達したもの（全額貯まったもの）だけを並べる
  const wishRows = wishes
    .map((w) => ({
      id: w.id,
      name: w.name,
      price: w.price,
      reserved: ((w as { contributions?: { amount: number }[] }).contributions ?? []).reduce((a, c) => a + c.amount, 0),
    }))
    .filter((w) => w.reserved >= w.price);
  if (!ctx.season) return { subscriptions: [], wishes: wishRows };

  const periods = seasonPeriods(ctx);
  const subs = await ctx.tx.subscription.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  const paid = new Set(
    (await ctx.tx.purchase.findMany({ where: { userId: ctx.user.id, subscriptionId: { not: null }, deletedAt: null }, select: { subscriptionId: true, periodKey: true } })).map(
      (p) => `${p.subscriptionId}:${p.periodKey}`,
    ),
  );
  const rows: { subscriptionId: string; name: string; amount: number; cycle: string; periodKey: string; date: string; accountId: string | null }[] = [];
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
      rows.push({ subscriptionId: s.id, name: s.name, amount: s.amount, cycle: s.cycle, periodKey: p.key, date: dayKey(Math.min(due, ctx.now), tz), accountId: s.accountId });
    }
  }
  return { subscriptions: rows, wishes: wishRows, currentPeriod: periodKey(ctx.now, ctx.cal) };
}

