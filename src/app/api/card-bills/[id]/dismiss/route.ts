import type { NextRequest } from "next/server";
import { dismissCardBill } from "@/server/accounts";
import { gameRoute, type IdParams } from "@/server/routes";

/** 引き落とし予定を消す（CB-08） */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx) => dismissCardBill(ctx, id));
}
