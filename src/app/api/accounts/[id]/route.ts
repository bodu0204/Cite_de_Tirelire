import type { NextRequest } from "next/server";
import { deleteAccount, updateAccount } from "@/server/accounts";
import { gameRoute, type IdParams } from "@/server/routes";

export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => updateAccount(ctx, id, body));
}

/** 記録に使っていない置き場所だけ削除できる（AC-07） */
export async function DELETE(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx) => deleteAccount(ctx, id));
}
