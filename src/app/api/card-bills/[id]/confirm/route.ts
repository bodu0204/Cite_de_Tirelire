import type { NextRequest } from "next/server";
import { confirmCardBill } from "@/server/accounts";
import { gameRoute, type IdParams } from "@/server/routes";

/** 引き落とし予定の確定（金額を直せる。docs/money-accounts.md CB-03） */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => confirmCardBill(ctx, id, body));
}
