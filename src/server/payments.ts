// 支出の支払い方法（docs/payment-method-sync.md）。未記入は現金として扱い、初めて記入すると銀貨の報酬を出す。
// 支払い方法はゲームの判定（精算・手数料・貯金額）に使わない。カードの未払いだけを手元のお金の推測（E7）に足す。
import type { PaymentMethod, Purchase } from "@prisma/client";
import { cardUnpaid, unpaidSince, type CardTerms, type CardUnpaid } from "@/game/billing";
import { REWARD_PAYMENT, REWARD_PAYMENT_DAILY_CAP } from "@/game/config";
import { fail } from "@/game/errors";
import { dayKey } from "@/game/time";
import type { GameCtx } from "./game";
import { grantReward, PAYMENT_REWARD_PREFIX } from "./ops";
import { int, oneOf, str } from "./validate";

type Body = Record<string, unknown>;

const KINDS = ["CARD", "OTHER"] as const;

/** 現金はユーザーごとに1件。最初に読むときに作る（PM-01） */
async function ensureCash(ctx: GameCtx) {
  const cash = await ctx.tx.paymentMethod.findFirst({ where: { userId: ctx.user.id, kind: "CASH" } });
  return cash ?? ctx.tx.paymentMethod.create({ data: { userId: ctx.user.id, name: "現金", kind: "CASH", sortOrder: -1 } });
}

const order = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

/** 支払い方法の一覧（使わないにしたものも含む。記入済みの支出の名前に使う）と、記入の報酬の今日の残り */
export async function listPaymentMethods(ctx: GameCtx) {
  await ensureCash(ctx);
  const items = await ctx.tx.paymentMethod.findMany({ where: { userId: ctx.user.id }, orderBy: order });
  return { items, reward: await paymentRewardStatus(ctx) };
}

function cardTerms(body: Body, prev?: PaymentMethod) {
  const v = (k: "closingDay" | "paymentDay" | "paymentMonths") => (body[k] !== undefined ? body[k] : prev?.[k]);
  return {
    closingDay: int(v("closingDay"), "締め日", { min: 1, max: 31 }),
    paymentDay: int(v("paymentDay"), "引き落とし日", { min: 1, max: 31 }),
    paymentMonths: int(v("paymentMonths") ?? 1, "引き落としの月", { min: 1, max: 2 }),
  };
}

export async function createPaymentMethod(ctx: GameCtx, body: Body) {
  await ensureCash(ctx);
  const kind = oneOf(body.kind, KINDS, "種類");
  const name = str(body.name, "名前", { max: 50 });
  const last = await ctx.tx.paymentMethod.aggregate({ where: { userId: ctx.user.id }, _max: { sortOrder: true } });
  const m = await ctx.tx.paymentMethod.create({
    data: { userId: ctx.user.id, name, kind, ...(kind === "CARD" ? cardTerms(body) : {}), sortOrder: (last._max.sortOrder ?? 0) + 1 },
  });
  return { id: m.id };
}

async function ownMethod(ctx: GameCtx, id: string) {
  const m = await ctx.tx.paymentMethod.findFirst({ where: { id, userId: ctx.user.id } });
  return m ?? fail("not_found", "支払い方法が見つかりません", 404);
}

/** 名前・カードの締め日と引き落とし日・並び順・使わないにする（archived）。種類は変えない */
export async function updatePaymentMethod(ctx: GameCtx, id: string, body: Body) {
  const m = await ownMethod(ctx, id);
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = str(body.name, "名前", { max: 50 });
  if (body.sortOrder !== undefined) data.sortOrder = int(body.sortOrder, "並び順", { min: -1, max: 10_000 });
  if (m.kind === "CARD" && (body.closingDay !== undefined || body.paymentDay !== undefined || body.paymentMonths !== undefined)) Object.assign(data, cardTerms(body, m));
  if (body.archived !== undefined) {
    if (m.kind === "CASH") fail("invalid", "現金は使わないにできません");
    data.archivedAt = body.archived ? new Date(ctx.now) : null;
  }
  await ctx.tx.paymentMethod.update({ where: { id }, data });
  return { id };
}

/** 使っていない支払い方法だけ削除できる。記入済みの支出があれば「使わない」にする（PM-04） */
export async function deletePaymentMethod(ctx: GameCtx, id: string) {
  const m = await ownMethod(ctx, id);
  if (m.kind === "CASH") fail("invalid", "現金は削除できません");
  const used = await ctx.tx.purchase.count({ where: { paymentMethodId: id } });
  if (used > 0) fail("in_use", "この支払い方法で記録した支出があるため削除できません。「使わない」にしてください", 409);
  await ctx.tx.paymentMethod.delete({ where: { id } });
  return { id };
}

/** 入力の支払い方法（null・空は未記入）。使わないにしたものは新しく選べない */
export async function resolvePaymentMethod(ctx: GameCtx, v: unknown): Promise<PaymentMethod | null> {
  if (v === undefined || v === null || v === "") return null;
  const m = await ownMethod(ctx, str(v, "支払い方法"));
  if (m.archivedAt) fail("invalid", `${m.name}は使わないにしています`);
  return m;
}

/** 記入の報酬の今日の状況（RW-04・RW-08） */
export async function paymentRewardStatus(ctx: GameCtx) {
  const today = await ctx.tx.rewardClaim.aggregate({
    where: { userId: ctx.user.id, dayKey: dayKey(ctx.now, ctx.user.timezone), recordKey: { startsWith: PAYMENT_REWARD_PREFIX } },
    _sum: { amount: true },
  });
  const used = today._sum.amount ?? 0;
  return { amount: REWARD_PAYMENT, dailyCap: REWARD_PAYMENT_DAILY_CAP, todayRewarded: used, remaining: Math.max(0, REWARD_PAYMENT_DAILY_CAP - used) };
}

/** 初めて記入したときの報酬（RW-01〜05）：今のシーズンの、金額が 0 でない支出だけ */
export async function grantPaymentReward(ctx: GameCtx, p: Pick<Purchase, "id" | "seasonId" | "amount">): Promise<number> {
  if (!ctx.season || p.seasonId !== ctx.season.id || p.amount <= 0) return 0;
  return grantReward(ctx, `${PAYMENT_REWARD_PREFIX}${p.id}`, REWARD_PAYMENT, { payment: true });
}

/**
 * 記録した支出に支払い方法を記入・変更する（PM-13〜15）。ゲームの判定に影響しないので差分の解消は起きない。
 * 未記入には戻せない。取り消した支出（金額 0）には記入できない。初めての記入なら報酬を返す
 */
export async function setPurchasePayment(ctx: GameCtx, p: Purchase, v: unknown): Promise<{ paymentMethodId: string; paymentReward: number }> {
  if (v === null || v === "") fail("invalid", "記入した支払い方法は未記入に戻せません（現金にすれば同じ扱いになります）");
  if (p.amount === 0) fail("invalid", "取り消した支出には支払い方法を記入できません");
  const m = (await resolvePaymentMethod(ctx, v))!;
  if (m.id === p.paymentMethodId) return { paymentMethodId: m.id, paymentReward: 0 };
  const first = p.paymentMethodId === null && p.paymentRecordedAt === null;
  await ctx.tx.purchase.update({ where: { id: p.id }, data: { paymentMethodId: m.id, ...(first ? { paymentRecordedAt: new Date(ctx.now) } : {}) } });
  return { paymentMethodId: m.id, paymentReward: first ? await grantPaymentReward(ctx, p) : 0 };
}

/** 支払い方法が未記入の、今のシーズンの支出（記入すると報酬が出るもの。RW-08） */
export async function unfilledPurchases(ctx: GameCtx) {
  const items = ctx.season
    ? await ctx.tx.purchase.findMany({
        where: { userId: ctx.user.id, seasonId: ctx.season.id, paymentMethodId: null, deletedAt: null, amount: { gt: 0 } },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        select: { id: true, date: true, name: true, amount: true, category: true, isSubscription: true, wishItemId: true },
        take: 200,
      })
    : [];
  return { items, reward: await paymentRewardStatus(ctx) };
}

const termsOf = (m: PaymentMethod): CardTerms | null =>
  m.kind === "CARD" && m.closingDay && m.paymentDay ? { closingDay: m.closingDay, paymentDay: m.paymentDay, paymentMonths: m.paymentMonths ?? 1 } : null;

export interface CardUnpaidRow extends CardUnpaid {
  id: string;
  name: string;
}

/** カードごとの未払い（E7）。シーズンによらず家計履歴全体から数える（CE-01・CE-02） */
export async function cardsUnpaid(ctx: GameCtx): Promise<CardUnpaidRow[]> {
  const cards = await ctx.tx.paymentMethod.findMany({ where: { userId: ctx.user.id, kind: "CARD" }, orderBy: order });
  if (!cards.length) return [];
  const today = dayKey(ctx.now, ctx.user.timezone);
  const purchases = await ctx.tx.purchase.findMany({
    where: { userId: ctx.user.id, paymentMethodId: { in: cards.map((c) => c.id) }, deletedAt: null, amount: { gt: 0 }, date: { gte: unpaidSince(today) } },
    select: { paymentMethodId: true, date: true, amount: true },
  });
  const rows: CardUnpaidRow[] = [];
  for (const c of cards) {
    const t = termsOf(c);
    if (!t) continue;
    const r = cardUnpaid(
      purchases.filter((p) => p.paymentMethodId === c.id),
      t,
      today,
    );
    // 使わないにしたカードも、未払いが残っていれば出す
    if (c.archivedAt && r.amount === 0) continue;
    rows.push({ id: c.id, name: c.name, ...r });
  }
  return rows;
}
