import type { NextRequest } from "next/server";
import { saveEstimateChecks } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function PUT(req: NextRequest) {
  return gameRoute(req, saveEstimateChecks);
}
