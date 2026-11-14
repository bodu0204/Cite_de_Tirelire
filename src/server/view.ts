// クライアントへ返す状態（ホーム画面・各施設画面で共通）。
import { bondCap, bondMiningStatus, bondShare } from "@/game/bond";
import { highestUnlockedTier, LINE_IDS, LINES, unlocksAtTech } from "@/game/catalog";
import { computeMetrics } from "@/game/city/economy";
import { basePlotLimit, habitPlots, nextHabitPlotIn, plotLimit, plotsUsed, savingDaysOf, unlockedTileCount } from "@/game/city/layout";
import { cityNeeds, discountRate, levelCap, renewal, renewing } from "@/game/city/sim";
import {
  AWAY_SUMMARY_MIN_MS,
  BANK_EXCHANGE_BONUS,
  CONCURRENT_JOBS,
  DEV_NAMES,
  DEV_POINTS_PER_BASE,
  DEV_THRESHOLDS,
  GOLD_MINE_LEVEL_THRESHOLDS,
  REWARD_DAILY_CAP,
  SILVER_MINE_LEVEL_THRESHOLDS,
  TECH_ERAS,
} from "@/game/config";
import { exchangeRate, GAIN_KEYS, needShares, ZERO_GAINS } from "@/game/exchange";
import { unconfirmedGold } from "@/game/confirm";
import { describeEvent } from "@/game/describe";
import { bondInterestPerDay, earlyBonusRate, earlyBonusRoom, fundPace, nextReserveAt, reserveLevel } from "@/game/fund";
import { devLevel, goldMineLevel, nextThreshold, savingsProgress, silverMineLevel, techThresholdYen } from "@/game/levels";
import { microToGold, ratePerMinute } from "@/game/mine";
import { dayKey, periodRange } from "@/game/time";
import type { CityState, Gains } from "@/game/types";
import { currencySummaries } from "./currencies";
import { budgetPlan, monthlyEquivalent, savingsOf, type GameCtx } from "./game";
import { facilityLevels } from "./ops";

export interface AwayStats {
  population: number;
  devPoints: number;
  treasury: number;
  /** 貯金額（債券 ＋ ゲーム内で使った金貨）と、債券の利息の累計（追加前の記録には無い） */
  savings?: number;
  interest?: number;
  /** 債券化で得た資源の累計（追加前の記録には無い） */
  bondResources?: Gains;
}


function statsOf(city: CityState, savings: number): AwayStats {
  return {
    population: city.population,
    devPoints: city.devPoints,
    treasury: city.treasury,
    savings,
    interest: city.interestTotal ?? 0,
    bondResources: { ...ZERO_GAINS, ...city.bondResourceTotal },
  };
}

/** 前回から1時間以上空いていれば、その間の変化をまとめる */
async function awaySummary(ctx: GameCtx) {
  const { season, city } = ctx;
  if (!season || !city) return null;
  const last = season.lastSeenAt?.getTime();
  const lastStats = season.lastSeenStats as AwayStats | null;
  const savings = savingsOf(ctx).amount;
  ctx.seasonPatch.lastSeenAt = new Date(ctx.now);
  ctx.seasonPatch.lastSeenStats = statsOf(city, savings) as never;
  if (!last || !lastStats || ctx.now - last < AWAY_SUMMARY_MIN_MS) return null;

  const stored = await ctx.tx.cityEvent.findMany({
    where: { seasonId: season.id, at: { gt: new Date(last) }, auto: true },
    select: { type: true, payload: true, at: true },
  });
  const events = [...stored, ...ctx.events.filter((e) => e.auto)];
  const count = (t: string) => events.filter((e) => e.type === t).length;
  const tiles = new Set<string>();
  for (const e of events) {
    const b = (e.payload as { building?: { x: number; y: number; placed?: false } }).building;
    if (b && b.placed !== false) tiles.add(`${b.x},${b.y}`);
  }
  return {
    hours: Math.floor((ctx.now - last) / 3_600_000),
    population: Math.floor(city.population) - Math.floor(lastStats.population),
    built: count("BUILD"),
    upgraded: count("UPGRADE"),
    evolved: count("EVOLVE"),
    expanded: count("PLOT_EXPANDED"),
    devPoints: Math.floor(city.devPoints - lastStats.devPoints),
    treasury: Math.floor(city.treasury - lastStats.treasury),
    /** 債券化で得た資源 */
    bondResources: lastStats.bondResources ? diffGains({ ...ZERO_GAINS, ...city.bondResourceTotal }, { ...ZERO_GAINS, ...lastStats.bondResources }) : { ...ZERO_GAINS },
    /** 留守中に増えた貯金額（記録のない日の自動の確定など）と債券の利息（FX-04） */
    saved: lastStats.savings === undefined ? 0 : Math.floor(savings - lastStats.savings),
    interest: lastStats.interest === undefined ? 0 : Math.floor((city.interestTotal ?? 0) - lastStats.interest),
    /** 留守中に起きた悪い出来事（EVT-06） */
    disasters: events.filter((e) => e.type === "DISASTER").map((e) => describeEvent({ type: e.type, payload: e.payload as Record<string, unknown> })),
    tiles: [...tiles].map((t) => t.split(",").map(Number) as [number, number]),
  };
}

function diffGains(a: Gains, b: Gains): Gains {
  return Object.fromEntries(GAIN_KEYS.map((k) => [k, Math.floor(a[k] - b[k])])) as unknown as Gains;
}

export async function buildView(ctx: GameCtx, opts: { markSeen?: boolean } = {}) {
  const { user, season, city, mine, tx } = ctx;
  const base = {
    serverNow: ctx.now,
    user: { email: user.email, monthlyBudget: user.monthlyBudget, timezone: user.timezone, bondMiningRate: user.bondMiningRate, incomeDay: user.incomeDay },
    hasArchive: (await tx.season.count({ where: { userId: user.id, status: "COMPLETED" } })) > 0,
  };
  if (!season || !city || !mine) return { ...base, season: null };

  const savings = await tx.savingsTransaction.findMany({
    where: { seasonId: season.id, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { kind: true, amount: true, date: true, createdAt: true },
  });
  // 貯金管理（別口座への出し入れ）の純増額。判定には使わない
  const managed = savingsProgress(savings).net;
  const saved = savingsOf(ctx);
  const period = periodRange(ctx.now, ctx.cal);
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

  // 技術Lvの閾値は基準額の倍数（docs/savings-driven-growth.md PRC-03）なので、円に直して返す
  const nextTech = techThresholdYen(city.techLevel + 1, city.base);
  const nextDev = nextThreshold(DEV_THRESHOLDS, dev);
  const overspends = await tx.monthlyOverspend.findMany({ where: { seasonId: season.id }, orderBy: { monthKey: "desc" } });
  const bond = ctx.balances.bond;
  const cap = bondCap(user.monthlyBudget);
  const reserve = reserveLevel(bond, user.monthlyBudget);
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
      /** 貯金額 ＝ 債券 ＋ ゲーム内で使った金貨（技術Lv・銀行Lv・達成率の根拠） */
      savings: saved.amount,
      citySpent: saved.citySpent,
      bond,
      /** 貯金額の最高到達額（技術Lv） */
      max: saved.max,
      rate: saved.rate,
      /** 貯金管理の純増額（追加 − 引出） */
      managed,
      bankLevel: city.bankLevel,
      bankBonus: BANK_EXCHANGE_BONUS[city.bankLevel - 1],
      savingsTimeline: savings.map((s) => ({ at: s.createdAt.getTime(), date: s.date, delta: s.kind === "DEPOSIT" ? s.amount : -s.amount })),
    },
    /** 当期の収入期間 */
    income: { day: user.incomeDay, periodKey: mine.monthKey, start: period.start, end: period.end },
    // 金貨・銀貨・ユーザ通貨は0以上。マイナスになり得るのは債券だけ
    currencies: {
      ...ctx.balances,
      custom: custom.map((c) => ({ id: c.id, name: c.name, icon: c.icon, categoryIds: c.categoryIds, balance: c.balance, pending: c.pending, nextIssue: c.nextIssue, nextExpiry: c.nextExpiry })),
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
      ratePerMinute: ratePerMinute(plan, ctx.now, ctx.cal),
      /** 採掘速度の内訳（月あたり）：max(0, B − S − C) */
      breakdown: { budget: user.monthlyBudget, subs: plan.subsAt(ctx.now), custom: plan.customAt(ctx.now), net: plan.netAt(ctx.now) },
      bond: {
        rate: user.bondMiningRate,
        cap,
        status: bondMiningStatus(bond, user.bondMiningRate, cap),
        /** 今の採掘のうち債券へ回る割合（%） */
        share: bondShare(bond, user.bondMiningRate, cap),
      },
      /** 記録による確定（docs/savings-driven-growth.md REC-01）：最後に確定した時刻、まだ確定していない配当、手数料なしで取り崩せる債券 */
      confirmedAt: mine.confirmedAt ?? null,
      unconfirmed: unconfirmedGold(mine),
      freeBond: mine.freeBond ?? 0,
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
        gold: Object.fromEntries(GAIN_KEYS.map((k) => [k, exchangeRate("gold", k, levels)])) as unknown as Gains,
        silver: Object.fromEntries(GAIN_KEYS.map((k) => [k, exchangeRate("silver", k, levels)])) as unknown as Gains,
      },
      /** 都市の必要資源・必要割合と、在庫が最初に足りなくなる計画（おまかせ交換・債券化の資源の割合） */
      needs: needs.needs,
      needShares: needShares(needs.needs),
      nextPlan: needs.next,
      /** 計画列（交換後の在庫で実施できる計画のプレビューに使う） */
      planQueue: needs.queue,
      bondCap: cap,
    },
    tech: {
      level: city.techLevel,
      max: saved.max,
      /** 今の技術Lvになった額と、次の技術Lvになる額（円） */
      prev: techThresholdYen(city.techLevel, city.base) ?? 0,
      next: nextTech,
      remaining: nextTech !== null ? Math.max(0, nextTech - saved.max) : 0,
      nextUnlocks: nextTech !== null ? unlocksAtTech(city.techLevel + 1) : [],
      nextBuildable: nextTechBuildable,
      /** 時代の名前（docs/saving-habit-balance.md TEC-03） */
      era: TECH_ERAS[city.techLevel - 1],
      nextEra: TECH_ERAS[city.techLevel] ?? null,
      /** 技術の更新の間なら、終わる時刻・無料か・建て替えた数（TEC-02・TEC-04） */
      renewal: city.renewal && renewing(city, ctx.now) ? { until: city.renewal.until, free: renewal.evolveRate === 0, evolved: city.renewal.evolved } : null,
    },
    dev: {
      level: dev,
      name: DEV_NAMES[dev - 1],
      points: city.devPoints,
      next: nextDev,
      /** 基準額（円）と、完成した計画の累計額・次の発展Lvになる累計額（円。GRW-04） */
      base: city.base,
      completed: city.completed,
      nextAt: nextDev === null ? null : Math.round((nextDev / DEV_POINTS_PER_BASE) * city.base),
      /** 建設資金（円）と、債券の利息（円/日）・備えLv・開拓期ボーナス（RSV-02・RSV-03・ERL-01） */
      fund: city.treasury,
      interestPerDay: bondInterestPerDay(bond, cap),
      reserveLevel: reserve,
      nextReserveAt: nextReserveAt(reserve, user.monthlyBudget),
      earlyBonusRate: earlyBonusRate(city, ctx.now),
      /** 開拓期ボーナスでまだ増やせる額（円） */
      earlyBonusRoom: earlyBonusRoom(city),
      discount: discountRate(city),
      /** 見通し（REC-04）：直近14日に入った建設資金のペース（円/日）と、このペースで次の発展Lvに届くまでの日数 */
      pace: fundPace(city, ctx.now),
      forecastDays: forecastDays(city, nextDev, fundPace(city, ctx.now)),
      concurrentJobs: CONCURRENT_JOBS[dev - 1],
      tiles: unlockedTileCount(city),
      /**
       * 開いた・開拓中の区画の数と、その上限（docs/map-layout-redesign.md §7.3）。上限は発展Lvの分とこまめボーナスの分、
       * 貯金日の数と、次のこまめボーナスの区画まであと何日の貯金日か（docs/saving-habit-balance.md HAB-02・HAB-04）
       */
      plots: {
        used: plotsUsed(city),
        limit: plotLimit(city.devPoints, savingDaysOf(city)),
        base: basePlotLimit(city.devPoints),
        habit: habitPlots(savingDaysOf(city)),
        savingDays: savingDaysOf(city),
        nextHabitIn: nextHabitPlotIn(savingDaysOf(city)),
      },
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

/** このペースで次の発展Lvに届くまでの日数（工事中の分と建設資金を差し引いた残り ÷ ペース）。届かなければ null */
function forecastDays(city: CityState, nextDev: number | null, pace: number): number | null {
  if (nextDev === null || pace <= 0) return null;
  const nextAt = (nextDev / DEV_POINTS_PER_BASE) * city.base;
  const inProgress = city.jobs.reduce((a, j) => a + (j.price ?? 0), 0);
  const rest = nextAt - city.completed - inProgress - Math.max(0, city.treasury);
  return Math.max(0, Math.ceil(rest / pace));
}

export type GameView = Awaited<ReturnType<typeof buildView>>;
/** 進行中のシーズンがあるときの状態 */
export type ActiveView = Extract<GameView, { city: unknown }>;
