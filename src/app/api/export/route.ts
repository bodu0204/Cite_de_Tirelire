import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { route } from "@/server/http";

// 家計・ゲーム履歴のエクスポート（FR-026）
export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        monthlyBudget: true,
        timezone: true,
        createdAt: true,
        purchases: true,
        savings: true,
        subscriptions: true,
        wishItems: { include: { contributions: true } },
        seasons: { include: { events: true, ledger: true, overspends: true } },
      },
    });
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), ...user }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="tirelire-export.json"`,
        "cache-control": "no-store",
      },
    });
  });
}
