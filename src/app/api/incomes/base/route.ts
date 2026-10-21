import type { NextRequest } from "next/server";
import { incomeBase } from "@/server/incomes";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => incomeBase(ctx));
}
