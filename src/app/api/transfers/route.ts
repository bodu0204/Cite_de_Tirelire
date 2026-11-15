import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { recordTransfer } from "@/server/accounts";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.transfer.findMany({ where: { userId }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 }),
  }));
}

/** 振替の記録（docs/money-accounts.md §6） */
export async function POST(req: NextRequest) {
  return gameRoute(req, recordTransfer);
}
