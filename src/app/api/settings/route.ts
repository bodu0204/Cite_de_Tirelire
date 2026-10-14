import type { NextRequest } from "next/server";
import { updateSettings } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function PATCH(req: NextRequest) {
  return gameRoute(req, updateSettings);
}
