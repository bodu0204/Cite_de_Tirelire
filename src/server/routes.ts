// ルート定義の補助：認証付きでゲームの同期トランザクションを実行する。
import type { NextRequest } from "next/server";
import { withGame, type GameCtx } from "./game";
import { idempotencyKey, route } from "./http";

type Body = Record<string, unknown>;

/** readOnly：状態を変えない POST（プレビュー）。結果を冪等キーとして保存しない */
export function gameRoute(req: NextRequest, fn: (ctx: GameCtx, body: Body) => Promise<unknown> | unknown, opts: { readOnly?: boolean } = {}) {
  return route(req, ({ userId, body }) =>
    withGame(userId, async (ctx) => fn(ctx, body), { idempotencyKey: req.method === "GET" || opts.readOnly ? undefined : idempotencyKey(req) }),
  );
}

export type IdParams = { params: Promise<{ id: string }> };
