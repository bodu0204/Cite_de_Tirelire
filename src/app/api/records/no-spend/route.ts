import type { NextRequest } from "next/server";
import { recordNoSpend } from "@/server/ops";
import { gameRoute } from "@/server/routes";

/** 「今日は支出なし」（docs/savings-driven-growth.md REC-02） */
export async function POST(req: NextRequest) {
  return gameRoute(req, (ctx) => recordNoSpend(ctx));
}
