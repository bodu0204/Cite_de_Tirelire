import type { NextRequest } from "next/server";
import { cityAction } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, cityAction);
}
