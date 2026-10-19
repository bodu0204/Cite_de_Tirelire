import type { NextRequest } from "next/server";
import { previewCurrency } from "@/server/currencies";
import { gameRoute } from "@/server/routes";

// 保存前の確認：次の発生日と、今月・来月の発生額 C
export async function POST(req: NextRequest) {
  return gameRoute(req, previewCurrency, { readOnly: true });
}
