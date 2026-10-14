import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordSavings } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.savingsTransaction.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 500,
    }),
  }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, recordSavings);
}
