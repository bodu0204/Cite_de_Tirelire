import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordOutside } from "@/server/accounts";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.outsideRecord.findMany({ where: { userId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 }),
  }));
}

/** 予算外の入出金（置き場所の残高だけを動かす） */
export async function POST(req: NextRequest) {
  return gameRoute(req, recordOutside);
}
