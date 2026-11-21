import type { NextRequest } from "next/server";
import { skipSubscriptionPayment } from "@/server/ops";
import { gameRoute, type IdParams } from "@/server/routes";

/** 支払いの行を「この回は記録しない」にする（periodKey）。undo で戻す（docs/take-home-and-fixed-costs.md FC-15） */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => skipSubscriptionPayment(ctx, id, body));
}
