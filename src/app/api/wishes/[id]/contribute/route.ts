import type { NextRequest } from "next/server";
import { contributeWish } from "@/server/ops";
import { gameRoute, type IdParams } from "@/server/routes";

export async function POST(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => contributeWish(ctx, id, body));
}
