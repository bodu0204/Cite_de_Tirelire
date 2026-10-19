import type { NextRequest } from "next/server";
import { deleteCurrency, updateCurrency } from "@/server/currencies";
import { gameRoute, type IdParams } from "@/server/routes";

export async function PATCH(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx, body) => updateCurrency(ctx, id, body));
}

export async function DELETE(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return gameRoute(req, (ctx) => deleteCurrency(ctx, id));
}
