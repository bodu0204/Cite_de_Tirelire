import type { NextRequest } from "next/server";
import { completeSeason } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx) => completeSeason(ctx));
}
