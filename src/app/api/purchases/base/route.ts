import type { NextRequest } from "next/server";
import { purchaseBase } from "@/server/adjustments";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => purchaseBase(ctx));
}
