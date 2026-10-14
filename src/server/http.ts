// ルートハンドラの共通処理：認証、同一オリジン確認、エラー整形。
import { NextResponse, type NextRequest } from "next/server";
import { GameError } from "@/game/errors";
import { currentUserId } from "./auth";

type Handler<T> = (ctx: { req: NextRequest; userId: string; body: Record<string, unknown> }) => Promise<T>;

function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // 同一オリジンの fetch でも付かない場合がある
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function errorResponse(e: unknown) {
  if (e instanceof GameError) return json({ error: { code: e.code, message: e.message } }, e.status);
  console.error(e);
  return json({ error: { code: "internal", message: "サーバーでエラーが発生しました" } }, 500);
}

export async function route<T>(req: NextRequest, handler: Handler<T>, opts: { auth?: boolean } = {}) {
  try {
    if (req.method !== "GET" && !sameOrigin(req)) throw new GameError("forbidden", "不正なリクエストです", 403);
    let userId = "";
    if (opts.auth !== false) {
      userId = (await currentUserId()) ?? "";
      if (!userId) throw new GameError("unauthorized", "ログインしてください", 401);
    }
    let body: Record<string, unknown> = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new GameError("bad_json", "リクエストの形式が不正です");
        }
      }
    }
    const result = await handler({ req, userId, body });
    return result instanceof NextResponse ? result : json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export const idempotencyKey = (req: NextRequest) => req.headers.get("idempotency-key") ?? undefined;
