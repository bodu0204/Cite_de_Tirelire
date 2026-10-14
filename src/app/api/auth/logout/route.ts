import type { NextRequest } from "next/server";
import { destroySession } from "@/server/auth";
import { route } from "@/server/http";

export async function POST(req: NextRequest) {
  return route(
    req,
    async () => {
      await destroySession();
      return { ok: true };
    },
    { auth: false },
  );
}
