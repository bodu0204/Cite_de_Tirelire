import type { NextRequest } from "next/server";
import { exchange } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, exchange);
}
