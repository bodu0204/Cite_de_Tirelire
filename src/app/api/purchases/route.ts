import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordPurchases } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => {
    const items = await prisma.purchase.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: { payments: { orderBy: { id: "asc" } } },
      take: 500,
    });
    const resolutions = await prisma.resolution.findMany({ where: { refType: "purchase", refId: { in: items.map((p) => p.id) } }, orderBy: { createdAt: "asc" } });
    return { items: items.map((p) => ({ ...p, resolutions: resolutions.filter((r) => r.refId === p.id) })) };
  });
}

/** 支出の記録。items で一括保存できる（サブスク・ほしい物のベースの行） */
export async function POST(req: NextRequest) {
  return gameRoute(req, recordPurchases);
}
