import type { NextRequest } from "next/server";
import { recordAdjustment } from "@/server/adjustments";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, recordAdjustment);
}
