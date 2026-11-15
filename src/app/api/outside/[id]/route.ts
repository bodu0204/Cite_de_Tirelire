import type { NextRequest } from "next/server";
import { editOutside } from "@/server/accounts";
import { gameRoute, type IdParams } from "@/server/routes";

/** 金額だけの編集（0 で取り消し） */
export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => editOutside(ctx, id, body));
}
