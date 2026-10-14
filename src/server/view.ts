// クライアントへ返す状態（ホーム画面・各施設画面で共通）。
import { highestUnlockedTier, LINE_IDS, LINES, unlocksAtTech } from "@/game/catalog";
import { computeMetrics } from "@/game/city/economy";
import { DISTRICT_NAMES, unlockedTileCount } from "@/game/city/layout";
import { levelCap } from "@/game/city/sim";
import {
  AWAY_SUMMARY_MIN_MS,
  BANK_EXCHANGE_BONUS,
  DEV_NAMES,
  DEV_PER_HOUR,
  DEV_THRESHOLDS,
  GOLD_MINE_LEVEL_THRESHOLDS,
  REWARD_DAILY_CAP,
  SILVER_MINE_LEVEL_THRESHOLDS,
  TECH_THRESHOLDS,
} from "@/game/config";
import { exchangeRate } from "@/game/exchange";
import { achievementRate, devLevel, goldMineLevel, nextThreshold, projectedRate, savingsProgress, silverMineLevel } from "@/game/levels";
import { goldBalance, microToGold, ratePerMinute } from "@/game/mine";
import { dayKey } from "@/game/time";
import type { CityState } from "@/game/types";
import { monthlyEquivalent, subWindows, type GameCtx } from "./game";
import { facilityLevels } from "./ops";

export interface AwayStats {
  population: number;
  devPoints: number;
  treasury: number;
}

function statsOf(city: CityState): AwayStats {
  return { population: city.population, devPoints: city.devPoints, treasury: city.treasury };
}

/** 前回から1時間以上空いていれば、その間の変化をまとめる */
async function awaySummary(ctx: GameCtx) {
  const { season, city } = ctx;
  if (!season || !city) return null;
  const last = season.lastSeenAt?.getTime();
  const lastStats = season.lastSeenStats as AwayStats | null;
  ctx.seasonPatch.lastSeenAt = new Date(ctx.now);
  ctx.seasonPatch.lastSeenStats = statsOf(city) as never;
  if (!last || !lastStats || ctx.now - last < AWAY_SUMMARY_MIN_MS) return null;

  const stored = await ctx.tx.cityEvent.findMany({
    where: { seasonId: season.id, at: { gt: new Date(last) }, auto: true },
    select: { type: true, payload: true },
  });
  const events = [...stored, ...ctx.events.filter((e) => e.auto)];
  const count = (t: string) => events.filter((e) => e.type === t).length;
  const tiles = new Set<string>();
  for (const e of events) {
    const b = (e.payload as { building?: { x: number; y: number } }).building;
    if (b && b.x >= 0) tiles.add(`${b.x},${b.y}`);
  }
  return {
    hours: Math.floor((ctx.now - last) / 3_600_000),
    population: Math.floor(city.population) - Math.floor(lastStats.population),
    built: count("BUILD"),
    upgraded: count("UPGRADE"),
    evolved: count("EVOLVE"),
    devPoints: Math.floor(city.devPoints - lastStats.devPoints),
    treasury: Math.floor(city.treasury - lastStats.treasury),
    tiles: [...tiles].map((t) => t.split(",").map(Number) as [number, number]),
  };
}

export async function buildView(ctx: GameCtx, opts: { markSeen?: boolean } = {}) {
  const { user, season, city, mine, tx } = ctx;
  const base = {
    serverNow: ctx.now,
    user: { email: user.email, monthlyBudget: user.monthlyBudget, timezone: user.timezone },
    hasArchive: (await tx.season.count({ where: { userId: user.id, status: "COMPLETED" } })) > 0,
  };
  if (!season || !city || !mine) return { ...base, season: null };

  const savings = await tx.savingsTransaction.findMany({
    where: { seasonId: season.id, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { kind: true, amount: true, date: true, createdAt: true },
  });
  const { net, max } = savingsProgress(savings);
  const rate = achievementRate(net, season.goalAmount);
  const patchedEstimate = ctx.seasonPatch.estimatedSavings;
  const estimated = typeof patchedEstimate === "number" ? patchedEstimate : season.estimatedSavings;
  // 欲しいもの貯金：未購入のほしい物への積立（像の積立金貨）
  const wishes = await tx.wishItem.findMany({
    where: { userId: user.id },
    include: { contributions: { where: { seasonId: season.id }, select: { amount: true } } },
  });
  const openWishes = wishes.filter((w) => !w.purchasedAt);
  const metrics = computeMetrics(city);
  const dev = devLevel(city.devPoints);
  const levels = facilityLevels(ctx);
  const tz = user.timezone;
  const rewardedRecords = (ctx.seasonPatch.rewardedRecords as number | undefined) ?? season.rewardedRecords;
  const today = await tx.rewardClaim.aggregate({ where: { userId: user.id, dayKey: dayKey(ctx.now, tz) }, _sum: { amount: true } });
  const log = await tx.cityEvent.findMany({
    where: { seasonId: season.id, important: true },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: 40,
  });
  const fresh = ctx.events.filter((e) => e.important).reverse();

  const nextTech = nextThreshold(TECH_THRESHOLDS, city.techLevel);
  const nextDev = nextThreshold(DEV_THRESHOLDS, dev);
  const overspends = await tx.monthlyOverspend.findMany({ where: { seasonId: season.id }, orderBy: { monthKey: "desc" } });

  // 次の技術Lvで建てられるようになる建物（発展Lvも満たすもの）
  const nextTechBuildable = nextTech !== null ? LINE_IDS.filter((l) => highestUnlockedTier(l, city.techLevel + 1, dev) > highestUnlockedTier(l, city.techLevel, dev)).map((l) => LINES[l].tiers[highestUnlockedTier(l, city.techLevel + 1, dev)].name) : [];

  return {
    ...base,
    season: {
      id: season.id,
      number: season.number,
      status: (ctx.seasonPatch.status as string | undefined) ?? season.status,
      goal: season.goalAmount,
      startedAt: season.startedAt.getTime(),
      reachedAt: season.reachedAt?.getTime() ?? null,
      net,
      max,
      rate,
      estimated,
      projectedRate: projectedRate(net, estimated, season.goalAmount),
      bankLevel: city.bankLevel,
      bankBonus: BANK_EXCHANGE_BONUS[city.bankLevel - 1],
      savingsTimeline: savings.map((s) => ({ at: s.createdAt.getTime(), date: s.date, delta: s.kind === "DEPOSIT" ? s.amount : -s.amount })),
    },
    // gold は手持ち − 採掘負債（購入が所持金貨を超えるとマイナス）
    currencies: { ...ctx.balances, gold: goldBalance(ctx.balances.gold, mine) },
    /** マップ上の公園・像の元データ（refId → 名前と詳細） */
    specials: {
      parks: Object.fromEntries(
        ctx.subs.map((s) => [
          s.id,
          { name: s.name, amount: s.amount, cycle: s.cycle, monthly: monthlyEquivalent(s), startDate: s.startDate, endDate: s.endDate },
        ]),
      ),
      statues: Object.fromEntries(
        wishes.map((w) => [
          w.id,
          { name: w.name, price: w.price, priority: w.priority, reserved: w.contributions.reduce((a, c) => a + c.amount, 0), purchased: !!w.purchasedAt },
        ]),
      ),
    },
    wishSavings: {
      reserved: ctx.balances.reserved,
      target: openWishes.reduce((a, w) => a + w.price, 0),
      count: openWishes.length,
    },
    mine: {
      uncollected: microToGold(mine.uncollected),
      debt: microToGold(mine.debt),
      ratePerMinute: ratePerMinute(user.monthlyBudget, subWindows(ctx.subs, tz), ctx.now, tz),
      minedThisMonth: microToGold(mine.minedThisMonth),
      settledThisMonth: mine.settledThisMonth,
      monthKey: mine.monthKey,
      level: goldMineLevel(mine.totalCollected),
      totalCollected: mine.totalCollected,
      nextLevelAt: nextThreshold(GOLD_MINE_LEVEL_THRESHOLDS, goldMineLevel(mine.totalCollected)),
      overspends: overspends.map((o) => ({ monthKey: o.monthKey, amount: o.amount })),
      subscriptionsMonthly: ctx.subs.filter((s) => !s.endDate || s.endDate > dayKey(ctx.now, tz)).reduce((a, s) => a + monthlyEquivalent(s), 0),
    },
    silverMine: {
      level: silverMineLevel(rewardedRecords),
      records: rewardedRecords,
      nextLevelAt: nextThreshold(SILVER_MINE_LEVEL_THRESHOLDS, silverMineLevel(rewardedRecords)),
      todayRewarded: today._sum.amount ?? 0,
      dailyCap: REWARD_DAILY_CAP,
    },
    exchange: {
      levels,
      rates: {
        gold: { wood: exchangeRate("gold", "wood", levels), stone: exchangeRate("gold", "stone", levels), food: exchangeRate("gold", "food", levels) },
        silver: { wood: exchangeRate("silver", "wood", levels), stone: exchangeRate("silver", "stone", levels), food: exchangeRate("silver", "food", levels) },
      },
    },
    tech: {
      level: city.techLevel,
      max,
      next: nextTech,
      remaining: nextTech !== null ? Math.max(0, nextTech - max) : 0,
      nextUnlocks: nextTech !== null ? unlocksAtTech(city.techLevel + 1) : [],
      nextBuildable: nextTechBuildable,
    },
    dev: {
      level: dev,
      name: DEV_NAMES[dev - 1],
      points: city.devPoints,
      next: nextDev,
      ratePerHour: DEV_PER_HOUR * metrics.operation,
      operation: metrics.operation,
      nextDistrict: DISTRICT_NAMES[dev + 1] ?? null,
      tiles: unlockedTileCount(dev),
      levelCap: levelCap(dev),
    },
    city,
    metrics,
    log: [
      ...fresh.map((e) => ({ at: e.at, type: e.type, auto: e.auto, payload: e.payload })),
      ...log.map((e) => ({ at: e.at.getTime(), type: e.type, auto: e.auto, payload: e.payload })),
    ].slice(0, 40),
    away: opts.markSeen ? await awaySummary(ctx) : null,
  };
}

export type GameView = Awaited<ReturnType<typeof buildView>>;
/** 進行中のシーズンがあるときの状態 */
export type ActiveView = Extract<GameView, { city: unknown }>;
