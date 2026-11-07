import type { NextRequest } from "next/server";
import { repairBuilding } from "@/server/ops";
import { gameRoute } from "@/server/routes";

/** 火事で休業した建物を銀貨で修繕する（docs/savings-driven-growth.md EVT-05） */
export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx, body) => repairBuilding(ctx, body));
}
