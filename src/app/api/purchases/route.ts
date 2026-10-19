import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordPurchase } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.purchase.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      include: { payments: { orderBy: { id: "asc" } } },
      take: 500,
    }),
  }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, recordPurchase);
}
