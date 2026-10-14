import type { NextRequest } from "next/server";
import { fail } from "@/game/errors";
import { isValidTimeZone } from "@/game/time";
import { createSession, hashPassword } from "@/server/auth";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { str } from "@/server/validate";

export async function POST(req: NextRequest) {
  return route(
    req,
    async ({ body }) => {
      const email = str(body.email, "メールアドレス", { max: 200 }).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("invalid", "メールアドレスの形式が正しくありません");
      const password = str(body.password, "パスワード", { max: 200 });
      if (password.length < 8) fail("invalid", "パスワードは8文字以上にしてください");
      const tz = typeof body.timezone === "string" && isValidTimeZone(body.timezone) ? body.timezone : "Asia/Tokyo";
      if (await prisma.user.findUnique({ where: { email } })) fail("exists", "このメールアドレスは登録済みです", 409);
      const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), timezone: tz } });
      await createSession(user.id);
      return { ok: true };
    },
    { auth: false },
  );
}
