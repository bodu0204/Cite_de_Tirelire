import type { NextRequest } from "next/server";
import { SAVINGS_DAILY_LIMIT } from "@/game/config";
import { recordSavings, savingsCountToday } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, async (ctx) => ({
    items: await ctx.tx.savingsTransaction.findMany({
      where: { userId: ctx.user.id, deletedAt: null },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 500,
    }),
    /** 貯金管理の今日の登録回数と上限 */
    today: await savingsCountToday(ctx),
    limit: SAVINGS_DAILY_LIMIT,
  }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, recordSavings);
}
