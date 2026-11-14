import type { NextRequest } from "next/server";
import { buyTimelapseFx } from "@/server/ops";
import { gameRoute, type IdParams } from "@/server/routes";

/** 完了したシーズンのタイムラプスに、銀貨で演出（花火）を足す（docs/savings-driven-growth.md REC-06） */
export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => buyTimelapseFx(ctx, id, body));
}
