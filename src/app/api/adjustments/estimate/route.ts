import type { NextRequest } from "next/server";
import { estimate } from "@/server/adjustments";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => estimate(ctx));
}
