import type { NextRequest } from "next/server";
import { quoteEdit } from "@/server/incomes";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, quoteEdit, { readOnly: true });
}
