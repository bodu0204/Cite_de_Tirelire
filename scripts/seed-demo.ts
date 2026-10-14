// デモ用データ：12日前に始まったシーズンを作り、途中の貯金記録を反映しながら街を現在まで育てる。
// 実行: npx tsx scripts/seed-demo.ts   （ログイン: demo@example.com / password123）
import { PrismaClient, type Prisma } from "@prisma/client";
import { syncParks, syncStatues } from "../src/game/city/actions";
import { createCity } from "../src/game/city/init";
import { applyTechLevel, simulate } from "../src/game/city/sim";
import { DAY, HOUR } from "../src/game/config";
import { achievementRate, bankLevel, savingsProgress, techLevel } from "../src/game/levels";
import { newMine } from "../src/game/mine";
import { dayKey } from "../src/game/time";
import type { CityEvent } from "../src/game/types";
import { hashPassword } from "../src/server/auth";

const prisma = new PrismaClient();
const EMAIL = "demo@example.com";
const TZ = "Asia/Tokyo";

async function main() {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  const now = Date.now();
  const start = now - 12 * DAY;
  const user = await prisma.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword("password123"), monthlyBudget: 60000, timezone: TZ },
  });
  const sub = await prisma.subscription.create({
    data: { userId: user.id, name: "動画配信", amount: 1490, cycle: "MONTHLY", startDate: dayKey(start - 30 * DAY, TZ) },
  });
  const wish = await prisma.wishItem.create({ data: { userId: user.id, name: "ロードバイク", price: 45000, priority: 1 } });

  const city = createCity(start);
  const events: CityEvent[] = [{ at: start, type: "SEASON_STARTED", auto: false, important: true, payload: { goal: 100000, number: 1 } }];
  syncParks(city, [{ id: sub.id, name: sub.name, monthly: sub.amount, active: true }], start, events);
  syncStatues(city, [{ id: wish.id, name: wish.name, price: wish.price, progress: 0, purchased: false }], start, events);
  const snapshot = structuredClone(city);

  // 1日目 5,000円、4日目 +10,000円、8日目 +20,000円、11日目 -3,000円
  const plan: [number, "DEPOSIT" | "WITHDRAW", number][] = [
    [1, "DEPOSIT", 5000],
    [4, "DEPOSIT", 10000],
    [8, "DEPOSIT", 20000],
    [11, "WITHDRAW", 3000],
  ];
  const records: { kind: "DEPOSIT" | "WITHDRAW"; amount: number; at: number }[] = [];
  for (const [day, kind, amount] of plan) {
    const at = start + day * DAY + 3 * HOUR;
    simulate(city, at, events);
    records.push({ kind, amount, at });
    const { net, max } = savingsProgress(records);
    applyTechLevel(city, techLevel(max), at, events);
    const lv = bankLevel(achievementRate(net, 100000));
    if (lv !== city.bankLevel) {
      events.push({ at, type: "BANK_LEVEL", auto: false, important: lv > city.bankLevel, payload: { level: lv } });
      city.bankLevel = lv;
    }
  }
  simulate(city, now - 2 * HOUR, events);

  const mine = newMine(start, TZ);
  const season = await prisma.season.create({
    data: {
      userId: user.id,
      number: 1,
      goalAmount: 100000,
      startedAt: new Date(start),
      silver: 260,
      gold: 1200,
      rewardedRecords: 4,
      milestones: [25],
      mineLastAccrualAt: new Date(mine.lastAccrualAt),
      mineMonthKey: mine.monthKey,
      lastSeenAt: new Date(now - 14 * HOUR),
      lastSeenStats: { population: city.population * 0.8, devPoints: city.devPoints - 20, treasury: city.treasury * 0.7 },
    },
  });
  await prisma.cityState.create({ data: { seasonId: season.id, state: city as unknown as Prisma.InputJsonValue } });
  await prisma.citySnapshot.create({ data: { seasonId: season.id, kind: "START", at: new Date(start), state: snapshot as unknown as Prisma.InputJsonValue } });
  await prisma.cityEvent.createMany({
    data: events.map((e) => ({ seasonId: season.id, at: new Date(e.at), type: e.type, auto: e.auto, important: e.important, payload: e.payload as Prisma.InputJsonValue })),
  });
  for (const r of records) {
    await prisma.savingsTransaction.create({
      data: { userId: user.id, seasonId: season.id, kind: r.kind, amount: r.amount, date: dayKey(r.at, TZ), createdAt: new Date(r.at) },
    });
  }
  await prisma.purchase.create({ data: { userId: user.id, seasonId: season.id, amount: 980, date: dayKey(now - DAY, TZ), name: "ランチ", category: "食費" } });
  console.log(`seeded ${EMAIL} / password123 — ${city.buildings.length} buildings, ${events.length} events, tech ${city.techLevel}`);
}

main().finally(() => prisma.$disconnect());
