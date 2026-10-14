import type { NextRequest } from "next/server";
import { gameRoute } from "@/server/routes";
import { buildView } from "@/server/view";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => buildView(ctx, { markSeen: true }));
}
