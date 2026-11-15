import type { NextRequest } from "next/server";
import { quoteReconcile } from "@/server/accounts";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, quoteReconcile, { readOnly: true });
}
