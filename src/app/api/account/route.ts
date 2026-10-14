import type { NextRequest } from "next/server";
import { fail } from "@/game/errors";
import { destroySession, verifyPassword } from "@/server/auth";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { str } from "@/server/validate";

// アカウント削除：家計データ・シーズン・タイムラプスをすべて削除する
export async function POST(req: NextRequest) {
  return route(req, async ({ userId, body }) => {
    const password = str(body.password, "パスワード", { max: 200 });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(password, user.passwordHash))) fail("bad_credentials", "パスワードが違います", 401);
    await destroySession();
    await prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  });
}
