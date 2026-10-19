import type { NextRequest } from "next/server";
import { createCurrency, currencySummaries } from "@/server/currencies";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => ({ items: currencySummaries(ctx) }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createCurrency);
}
