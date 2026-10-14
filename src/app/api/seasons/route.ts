import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.season.findMany({
      where: { userId, status: "COMPLETED" },
      orderBy: { number: "desc" },
      select: { id: true, number: true, goalAmount: true, startedAt: true, reachedAt: true, completedAt: true },
    }),
  }));
}
