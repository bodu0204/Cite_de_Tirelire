import type { NextRequest } from "next/server";
import { fail } from "@/game/errors";
import { seasonSavingsMoves } from "@/server/accounts";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import type { IdParams } from "@/server/routes";

// タイムラプスは完了済みシーズンのみ閲覧できる
export async function GET(req: NextRequest, { params }: IdParams) {
  const { id } = await params;
  return route(req, async ({ userId }) => {
    const season = await prisma.season.findFirst({ where: { id, userId } });
    if (!season) fail("not_found", "シーズンが見つかりません", 404);
    if (season!.status !== "COMPLETED") fail("locked", "タイムラプスは目標を完了すると見られます", 403);
    const [start, final, events, savings] = await Promise.all([
      prisma.citySnapshot.findUnique({ where: { seasonId_kind: { seasonId: id, kind: "START" } } }),
      prisma.citySnapshot.findUnique({ where: { seasonId_kind: { seasonId: id, kind: "FINAL" } } }),
      prisma.cityEvent.findMany({ where: { seasonId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] }),
      // 貯金管理の増減（貯金用の置き場所への振替と、以前の貯金管理の記録）
      seasonSavingsMoves(prisma, userId, id),
    ]);
    return {
      season: {
        id: season!.id,
        number: season!.number,
        name: season!.goalName,
        goal: season!.goalAmount,
        startedAt: season!.startedAt.getTime(),
        reachedAt: season!.reachedAt?.getTime() ?? null,
        completedAt: season!.completedAt?.getTime() ?? null,
        fx: season!.timelapseFx,
      },
      start: start?.state ?? null,
      final: final?.state ?? null,
      events: events.map((e) => ({ at: e.at.getTime(), type: e.type, auto: e.auto, important: e.important, payload: e.payload })),
      savings: savings.map((s) => ({ at: s.createdAt.getTime(), delta: s.kind === "DEPOSIT" ? s.amount : -s.amount })),
    };
  });
}
