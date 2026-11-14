import type { NextRequest } from "next/server";
import { deletePaymentMethod, updatePaymentMethod } from "@/server/payments";
import { gameRoute, type IdParams } from "@/server/routes";

export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => updatePaymentMethod(ctx, id, body));
}

/** 使っていない支払い方法だけ削除できる（PM-04） */
export async function DELETE(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx) => deletePaymentMethod(ctx, id));
}
