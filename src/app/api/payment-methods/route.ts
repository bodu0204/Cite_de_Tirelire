import type { NextRequest } from "next/server";
import { createPaymentMethod, listPaymentMethods } from "@/server/payments";
import { gameRoute } from "@/server/routes";

/** 支払い方法の一覧（使わないにしたものも含む）と記入の報酬の今日の残り（docs/payment-method-sync.md §7.3） */
export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => listPaymentMethods(ctx));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createPaymentMethod);
}
