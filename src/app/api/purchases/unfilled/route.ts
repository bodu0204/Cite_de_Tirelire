import type { NextRequest } from "next/server";
import { unfilledPurchases } from "@/server/payments";
import { gameRoute } from "@/server/routes";

/** 支払い方法が未記入の今のシーズンの支出と、記入の報酬の今日の残り（docs/payment-method-sync.md RW-08） */
export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => unfilledPurchases(ctx));
}
