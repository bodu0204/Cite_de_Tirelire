// 支出のベース（docs/record-input-redesign.md §6.2・§6.3、docs/take-home-and-fixed-costs.md §5.3）：
// 未記録の固定費・サブスクの支払いと、全額貯まった未購入のほしい物。
// 以前の誤差調整（手元のお金の推測 E1〜E7）は、置き場所ごとの照合に置き換えた（docs/money-accounts.md RC-08。src/server/accounts.ts）。
import { duePayments, suggestedAmount } from "@/game/recurring";
import { periodKey } from "@/game/time";
import type { GameCtx } from "./game";
import { seasonPeriods } from "./incomes";

export interface RecurringRow {
  subscriptionId: string;
  /** 固定費か、サブスクか */
  kind: "SUBSCRIPTION" | "FIXED";
  name: string;
  amount: number;
  cycle: string;
  periodKey: string;
  date: string;
  accountId: string | null;
  /** 直近2回の支払いがどちらも登録額と違うとき、直近の支払いの額（登録額の変更の案内。FC-17）。それ以外は null */
  suggest: number | null;
}

/**
 * 未記録の固定費・サブスクの支払いの行（当期まで。固定費を先に並べる）。
 * 支払日があれば、その日が来てから並べる。「この回は記録しない」にした回は並べない（FC-11・12・15）
 */
export async function recurringRows(ctx: GameCtx): Promise<RecurringRow[]> {
  if (!ctx.season) return [];
  const tz = ctx.user.timezone;
  const periods = seasonPeriods(ctx);
  const subs = await ctx.tx.subscription.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  const payments = await ctx.tx.purchase.findMany({
    where: { userId: ctx.user.id, subscriptionId: { not: null }, deletedAt: null },
    select: { subscriptionId: true, periodKey: true, amount: true },
    orderBy: { periodKey: "desc" },
  });
  const paid = new Set(payments.map((p) => `${p.subscriptionId}:${p.periodKey}`));
  /** 登録ごとの、直近の支払いの額（新しい順。取り消しは除く） */
  const recent = (id: string) => payments.filter((p) => p.subscriptionId === id && p.amount > 0).map((p) => p.amount);
  const seasonStart = ctx.season.startedAt.getTime();
  const rows: RecurringRow[] = [];
  for (const s of [...subs.filter((x) => x.kind === "FIXED"), ...subs.filter((x) => x.kind !== "FIXED")]) {
    const suggest = suggestedAmount(s.amount, recent(s.id));
    for (const d of duePayments(s, periods, { tz, now: ctx.now, seasonStart, paid: (key) => paid.has(`${s.id}:${key}`) })) {
      rows.push({ subscriptionId: s.id, kind: s.kind, name: s.name, amount: s.amount, cycle: s.cycle, periodKey: d.periodKey, date: d.date, accountId: s.accountId, suggest });
    }
  }
  return rows;
}

// ---- 支出のベース：未記録の固定費・サブスクの支払いと、全額貯まった未購入のほしい物 ----

export async function purchaseBase(ctx: GameCtx) {
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
  return { subscriptions: await recurringRows(ctx), wishes: wishRows, currentPeriod: periodKey(ctx.now, ctx.cal) };
}
