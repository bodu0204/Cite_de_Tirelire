import type { NextRequest } from "next/server";
import { currentSeason } from "@/server/game";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { createWish } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => {
    const season = await currentSeason(prisma, userId);
    const items = await prisma.wishItem.findMany({
      where: { userId },
      include: { contributions: { where: { seasonId: season?.id ?? "-" }, select: { amount: true } } },
      orderBy: [{ purchasedAt: { sort: "desc", nulls: "first" } }, { priority: "asc" }, { createdAt: "asc" }],
    });
    return {
      items: items.map(({ contributions, ...w }) => ({ ...w, reserved: contributions.reduce((a, c) => a + c.amount, 0) })),
    };
  });
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createWish);
}
