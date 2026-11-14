import type { NextRequest } from "next/server";
import { decorateBuilding } from "@/server/ops";
import { gameRoute } from "@/server/routes";

/** 建物に銀貨で装飾を添える・外す（docs/savings-driven-growth.md REC-06） */
export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx, body) => decorateBuilding(ctx, body));
}
