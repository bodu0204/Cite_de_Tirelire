import type { NextRequest } from "next/server";
import { editIncome } from "@/server/incomes";
import { gameRoute, type IdParams } from "@/server/routes";

/** 金額だけの編集（0 で取り消し）。削除はできない（docs/record-input-redesign.md §9.3） */
export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => editIncome(ctx, id, body));
}
