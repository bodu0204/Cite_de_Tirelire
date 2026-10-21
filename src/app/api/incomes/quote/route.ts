import type { NextRequest } from "next/server";
import { quoteIncome } from "@/server/incomes";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, quoteIncome, { readOnly: true });
}
