import type { NextRequest } from "next/server";
import { quoteAdjustment } from "@/server/adjustments";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, quoteAdjustment, { readOnly: true });
}
