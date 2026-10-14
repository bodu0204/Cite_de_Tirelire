import type { NextRequest } from "next/server";
import { fail } from "@/game/errors";
import { createSession, verifyPassword } from "@/server/auth";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { str } from "@/server/validate";

export async function POST(req: NextRequest) {
  return route(
    req,
    async ({ body }) => {
      const email = str(body.email, "メールアドレス", { max: 200 }).toLowerCase();
      const password = str(body.password, "パスワード", { max: 200 });
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        fail("bad_credentials", "メールアドレスまたはパスワードが違います", 401);
      }
      await createSession(user!.id);
      return { ok: true };
    },
    { auth: false },
  );
}
