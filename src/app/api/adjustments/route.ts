import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordReconcile } from "@/server/accounts";
import { gameRoute } from "@/server/routes";

/** これまでの照合（誤差調整）。置き場所ごとの内訳つき */
export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.cashAdjustment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 100 }),
  }));
}

/** 照合：置き場所ごとの実際の残高に合わせ、誤差の合計を差分の解消ルールで解消する（docs/money-accounts.md §9） */
export async function POST(req: NextRequest) {
  return gameRoute(req, recordReconcile);
}
