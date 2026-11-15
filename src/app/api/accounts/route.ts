import type { NextRequest } from "next/server";
import { createAccount, listAccounts } from "@/server/accounts";
import { gameRoute } from "@/server/routes";

/** お金の置き場所の一覧（残高・最後の照合）、いつもの置き場所、よく使う振替、引き落とし予定（docs/money-accounts.md §12.3） */
export async function GET(req: NextRequest) {
  return gameRoute(req, (ctx) => listAccounts(ctx));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createAccount);
}
