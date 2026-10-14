import type { NextRequest } from "next/server";
import { deleteSavings, editSavings } from "@/server/ops";
import { gameRoute, type IdParams } from "@/server/routes";

export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => editSavings(ctx, id, body));
}

export async function DELETE(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx) => deleteSavings(ctx, id));
}
