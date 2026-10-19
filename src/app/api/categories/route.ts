import type { NextRequest } from "next/server";
import { createCategory } from "@/server/categories";
import { prisma } from "@/server/db";
import { route } from "@/server/http";
import { gameRoute } from "@/server/routes";

export async function GET(req: NextRequest) {
  return route(req, async ({ userId }) => ({
    items: await prisma.category.findMany({ where: { userId, archivedAt: null }, orderBy: { createdAt: "asc" } }),
  }));
}

export async function POST(req: NextRequest) {
  return gameRoute(req, createCategory);
}
