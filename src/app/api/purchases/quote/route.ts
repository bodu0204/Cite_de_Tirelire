import type { NextRequest } from "next/server";
import { quotePurchase } from "@/server/ops";
import { gameRoute } from "@/server/routes";

// 記録前の支払い内訳のプレビュー（債券・手数料が確定前に見える）
export async function POST(req: NextRequest) {
  return gameRoute(req, quotePurchase, { readOnly: true });
}
