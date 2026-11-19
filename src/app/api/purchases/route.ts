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
    // 固定費の支払いか（履歴の札。サブスクの支払いと同じ形の記録なので、登録の種類で見分ける。登録を消したあとは null）
    const kinds = new Map((await prisma.subscription.findMany({ where: { userId }, select: { id: true, kind: true } })).map((s) => [s.id, s.kind]));
    const fixedOf = (id: string | null) => (id && kinds.has(id) ? kinds.get(id) === "FIXED" : null);
    return { items: items.map((p) => ({ ...p, isFixedCost: fixedOf(p.subscriptionId), resolutions: resolutions.filter((r) => r.refId === p.id) })) };
  });
}

/** 支出の記録。items で一括保存できる（固定費・サブスク・ほしい物のベースの行） */
export async function POST(req: NextRequest) {
  return gameRoute(req, recordPurchases);
}
