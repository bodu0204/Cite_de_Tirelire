import type { NextRequest } from "next/server";
import { collectGold } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx) => collectGold(ctx));
}
