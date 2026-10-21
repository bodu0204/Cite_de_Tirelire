import type { NextRequest } from "next/server";
import { listIncomes, recordIncome } from "@/server/incomes";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => listIncomes(ctx));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, recordIncome);
}
