import type { NextRequest } from "next/server";
import { startSeason } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, startSeason);
}
