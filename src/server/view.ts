// クライアントへ返す状態（ホーム画面・各施設画面で共通）。
import { bondCap, bondMiningStatus, bondMultiplier, bondShare } from "@/game/bond";
import { highestUnlockedTier, LINE_IDS, LINES, unlocksAtTech } from "@/game/catalog";
import { computeMetrics } from "@/game/city/economy";
import { DISTRICT_NAMES, unlockedTileCount } from "@/game/city/layout";
import { cityNeeds, levelCap } from "@/game/city/sim";
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
import { exchangeRate, needShares } from "@/game/exchange";
import { achievementRate, devLevel, goldMineLevel, nextThreshold, projectedRate, savingsProgress, silverMineLevel } from "@/game/levels";
import { microToGold, ratePerMinute } from "@/game/mine";
import { dayKey } from "@/game/time";
import type { CityState, Stock } from "@/game/types";
import { currencySummaries } from "./currencies";
import { budgetPlan, monthlyEquivalent, type GameCtx } from "./game";
import { facilityLevels } from "./ops";

export interface AwayStats {
  population: number;
  devPoints: number;
  treasury: number;
  /** 債券化で得た資源の累計（追加前の記録には無い） */
  bondResources?: Stock;
}

const ZERO: Stock = { wood: 0, stone: 0, food: 0 };

function statsOf(city: CityState): AwayStats {
  return { population: city.population, devPoints: city.devPoints, treasury: city.treasury, bondResources: { ...(city.bondResourceTotal ?? ZERO) } };
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
    /** 債券化で得た資源 */
    bondResources: lastStats.bondResources ? diffStock(city.bondResourceTotal ?? ZERO, lastStats.bondResources) : { ...ZERO },
    tiles: [...tiles].map((t) => t.split(",").map(Number) as [number, number]),
  };
}

function diffStock(a: Stock, b: Stock): Stock {
  return { wood: Math.floor(a.wood - b.wood), stone: Math.floor(a.stone - b.stone), food: Math.floor(a.food - b.food) };
}

export async function buildView(ctx: GameCtx, opts: { markSeen?: boolean } = {}) {
  const { user, season, city, mine, tx } = ctx;
  const base = {
    serverNow: ctx.now,
    user: { email: user.email, monthlyBudget: user.monthlyBudget, timezone: user.timezone, bondMiningRate: user.bondMiningRate },
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
  const bond = ctx.balances.bond;
  const k = bondMultiplier(bond, user.monthlyBudget);
  const cap = bondCap(user.monthlyBudget);
  const plan = budgetPlan(ctx);
  const custom = currencySummaries(ctx);
  const needs = cityNeeds(city, metrics);

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
      /** 債券（表示の達成率にだけ含める。マイナスなら減らす） */
      bond,
      projectedRate: projectedRate(net, estimated, season.goalAmount, bond),
      bankLevel: city.bankLevel,
      bankBonus: BANK_EXCHANGE_BONUS[city.bankLevel - 1],
      savingsTimeline: savings.map((s) => ({ at: s.createdAt.getTime(), date: s.date, delta: s.kind === "DEPOSIT" ? s.amount : -s.amount })),
    },
    // 金貨・銀貨・ユーザ通貨は0以上。マイナスになり得るのは債券だけ
    currencies: {
      ...ctx.balances,
      custom: custom.map((c) => ({ id: c.id, name: c.name, icon: c.icon, categoryIds: c.categoryIds, balance: c.balance, nextIssue: c.nextIssue, nextExpiry: c.nextExpiry })),
    },
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
      ratePerMinute: ratePerMinute(plan, ctx.now, tz),
      /** 採掘速度の内訳（月あたり）：max(0, B − S − C) */
      breakdown: { budget: user.monthlyBudget, subs: plan.subsAt(ctx.now), custom: plan.customAt(ctx.now), net: plan.netAt(ctx.now) },
      bond: {
        rate: user.bondMiningRate,
        cap,
        status: bondMiningStatus(bond, user.bondMiningRate, cap),
        /** 今の採掘のうち債券へ回る割合（%） */
        share: bondShare(bond, user.bondMiningRate, cap),
      },
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
      /** 都市の必要資源・必要割合と、在庫が最初に足りなくなる計画（おまかせ交換・債券化の資源の割合） */
      needs: needs.needs,
      needShares: needShares(needs.needs),
      nextPlan: needs.next,
      bondCap: cap,
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
      ratePerHour: DEV_PER_HOUR * metrics.operation * k,
      operation: metrics.operation,
      bondMultiplier: k,
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
