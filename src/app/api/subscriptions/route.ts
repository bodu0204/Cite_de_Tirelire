import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { createSubscription } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.subscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createSubscription);
}
