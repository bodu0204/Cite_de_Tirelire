import type { NextRequest } from "next/server";
import { nameBuilding } from "@/server/ops";
import { gameRoute } from "@/server/routes";

/** 建物に銀貨で名前をつける（docs/savings-driven-growth.md REC-06） */
export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx, body) => nameBuilding(ctx, body));
}
