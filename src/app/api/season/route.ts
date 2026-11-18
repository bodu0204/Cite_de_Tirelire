import type { NextRequest } from "next/server";
import { startSeason, updateSeason } from "@/server/ops";
import { gameRoute } from "@/server/routes";

export async function POST(req: NextRequest) {
  return gameRoute(req, startSeason);
}

/** 目標の名前の変更、開始から24時間以内のすでにある貯金の訂正（docs/season-start-settings.md GN-04・RC-11） */
export async function PATCH(req: NextRequest) {
  return gameRoute(req, updateSeason);
}
