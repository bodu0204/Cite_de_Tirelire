// ジャンル（購入のカテゴリ）のマスタ。ユーザ通貨が使える範囲を決める。
import { fail } from "@/game/errors";
import type { GameCtx } from "./game";
import { optStr, str } from "./validate";

type Body = Record<string, unknown>;

/** 同じ名前があればそれを使う（アーカイブ済みなら戻す） */
async function upsertCategory(ctx: GameCtx, name: string) {
  return ctx.tx.category.upsert({
    where: { userId_name: { userId: ctx.user.id, name } },
    create: { userId: ctx.user.id, name },
    update: { archivedAt: null },
  });
}

/** 購入の入力からジャンルを決める。categoryId を優先し、名前（category）だけならその場で追加する */
export async function resolveCategory(ctx: GameCtx, body: Body): Promise<{ categoryId: string | null; category: string | null }> {
  if (typeof body.categoryId === "string" && body.categoryId) {
    const c = await ctx.tx.category.findFirst({ where: { id: body.categoryId, userId: ctx.user.id } });
    if (!c) fail("not_found", "ジャンルが見つかりません", 404);
    return { categoryId: c!.id, category: c!.name };
  }
  const name = optStr(body.category, "ジャンル", 50);
  if (!name) return { categoryId: null, category: null };
  const c = await upsertCategory(ctx, name);
  return { categoryId: c.id, category: c.name };
}

export async function createCategory(ctx: GameCtx, body: Body) {
  const c = await upsertCategory(ctx, str(body.name, "ジャンル名", { max: 50 }));
  return { id: c.id, name: c.name };
}

async function ownCategory(ctx: GameCtx, id: string) {
  const c = await ctx.tx.category.findFirst({ where: { id, userId: ctx.user.id } });
  return c ?? fail("not_found", "ジャンルが見つかりません", 404);
}

/** 名前の変更。購入記録の表示名も合わせる */
export async function renameCategory(ctx: GameCtx, id: string, body: Body) {
  await ownCategory(ctx, id);
  const name = str(body.name, "ジャンル名", { max: 50 });
  const dup = await ctx.tx.category.findFirst({ where: { userId: ctx.user.id, name, NOT: { id } } });
  if (dup) fail("duplicate", "同じ名前のジャンルがあります", 409);
  await ctx.tx.category.update({ where: { id }, data: { name } });
  await ctx.tx.purchase.updateMany({ where: { userId: ctx.user.id, categoryId: id }, data: { category: name } });
  return { id, name };
}

/** 一覧から外す（過去の購入記録のジャンルはそのまま残る） */
export async function archiveCategory(ctx: GameCtx, id: string) {
  await ownCategory(ctx, id);
  await ctx.tx.category.update({ where: { id }, data: { archivedAt: new Date(ctx.now) } });
  return { id };
}
