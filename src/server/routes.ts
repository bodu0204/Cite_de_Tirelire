// ルート定義の補助：認証付きでゲームの同期トランザクションを実行する。
import type { NextRequest } from "next/server";
import { withGame, type GameCtx } from "./game";
import { idempotencyKey, route } from "./http";

type Body = Record<string, unknown>;

export function gameRoute(req: NextRequest, fn: (ctx: GameCtx, body: Body) => Promise<unknown> | unknown) {
  return route(req, ({ userId, body }) =>
    withGame(userId, async (ctx) => fn(ctx, body), { idempotencyKey: req.method === "GET" ? undefined : idempotencyKey(req) }),
  );
}

export type IdParams = { params: Promise<{ id: string }> };
