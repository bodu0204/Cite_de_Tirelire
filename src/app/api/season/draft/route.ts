import type { NextRequest } from "next/server";
import { seasonDraft } from "@/server/ops";
import { gameRoute } from "@/server/routes";

/** 開始画面の初期値（docs/season-start-settings.md §11.3、docs/take-home-and-fixed-costs.md §9）。?income=&incomeDay= は入力中の値 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return gameRoute(req, (ctx) => seasonDraft(ctx, { income: q.get("income"), incomeDay: q.get("incomeDay") }));
}
