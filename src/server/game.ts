// ゲームの正本はサーバー。1ユーザーの操作はユーザー単位のロックを取ったトランザクションで直列化し、
// 「最終計算時刻から現在まで」の放置計算をしてから操作を適用する。
import { Prisma, type Season, type Subscription, type User, type WishItem } from "@prisma/client";
import { placeOffMapSpecials, syncParks, syncStatues, type ParkSource, type StatueSource } from "@/game/city/actions";
import { applyTechLevel, simulate } from "@/game/city/sim";
import { fail } from "@/game/errors";
import { achievementRate, bankLevel, goldMineLevel, savingsProgress, silverMineLevel, techLevel } from "@/game/levels";
import { accrue, repayDebtFromHeld, type MineState, type SubWindow } from "@/game/mine";
import { parseDateInTz } from "@/game/time";
import type { CityEvent, CityState } from "@/game/types";
import { prisma } from "./db";

export type Tx = Prisma.TransactionClient;

export interface LedgerRow {
  currency: "GOLD" | "SILVER" | "RESERVED";
  delta: number;
  reason: string;
  refId?: string;
}

export interface GameCtx {
  tx: Tx;
  now: number;
  user: User;
  /** 進行中（ACTIVE / GOAL_REACHED）のシーズン */
  season: Season | null;
  mine: MineState | null;
  city: CityState | null;
  cityVersion: number;
  subs: Subscription[];
  events: CityEvent[];
  ledger: LedgerRow[];
  balances: { gold: number; silver: number; reserved: number };
  overspends: { monthKey: string; amount: number }[];
  /** シーズン行の追加更新 */
  seasonPatch: Prisma.SeasonUpdateInput;
}

export function monthlyEquivalent(s: Pick<Subscription, "amount" | "cycle">): number {
  return s.cycle === "YEARLY" ? Math.round(s.amount / 12) : s.amount;
}

export function subWindows(subs: Subscription[], tz: string): SubWindow[] {
  return subs.map((s) => ({
    monthly: monthlyEquivalent(s),
    startAt: parseDateInTz(s.startDate, tz) ?? 0,
    endAt: s.endDate ? parseDateInTz(s.endDate, tz) : null,
  }));
}

export function isSubActive(s: Subscription, tz: string, at: number): boolean {
  const start = parseDateInTz(s.startDate, tz) ?? 0;
  const end = s.endDate ? parseDateInTz(s.endDate, tz) : null;
  return start <= at && (end === null || end > at);
}

export function mineFromSeason(s: Season): MineState {
  return {
    uncollected: s.mineUncollected,
    debt: s.mineDebt,
    lastAccrualAt: s.mineLastAccrualAt.getTime(),
    monthKey: s.mineMonthKey,
    minedThisMonth: s.mineMinedMonth,
    settledThisMonth: s.mineSettledMonth,
    totalCollected: s.mineTotalCollected,
  };
}

function mineToSeason(m: MineState): Prisma.SeasonUpdateInput {
  return {
    mineUncollected: m.uncollected,
    mineDebt: m.debt,
    mineLastAccrualAt: new Date(m.lastAccrualAt),
    mineMonthKey: m.monthKey,
    mineMinedMonth: m.minedThisMonth,
    mineSettledMonth: m.settledThisMonth,
    mineTotalCollected: m.totalCollected,
  };
}

export async function currentSeason(tx: Tx, userId: string): Promise<Season | null> {
  return tx.season.findFirst({ where: { userId, status: { in: ["ACTIVE", "GOAL_REACHED"] } }, orderBy: { number: "desc" } });
}

export function addCurrency(ctx: GameCtx, currency: LedgerRow["currency"], delta: number, reason: string, refId?: string) {
  if (delta === 0) return;
  const key = currency === "GOLD" ? "gold" : currency === "SILVER" ? "silver" : "reserved";
  const after = ctx.balances[key] + delta;
  if (after < 0) {
    const label = currency === "GOLD" ? "金貨" : currency === "SILVER" ? "銀貨" : "積立金貨";
    fail("insufficient", `${label}が足りません`);
  }
  ctx.balances[key] = after;
  ctx.ledger.push({ currency, delta, reason, refId });
}

export function requireSeason(ctx: GameCtx): asserts ctx is GameCtx & { season: Season; mine: MineState; city: CityState } {
  if (!ctx.season || !ctx.mine || !ctx.city) fail("no_season", "進行中のシーズンがありません。貯金目標を設定してください", 409);
}

/** シーズン内でほしい物の像として扱う一覧（未購入＋このシーズン中に購入したもの） */
export async function statueSources(tx: Tx, userId: string, season: Season): Promise<StatueSource[]> {
  const wishes: (WishItem & { contributions: { amount: number }[] })[] = await tx.wishItem.findMany({
    where: { userId, OR: [{ purchasedAt: null }, { purchasedAt: { gte: season.startedAt } }] },
    include: { contributions: { where: { seasonId: season.id }, select: { amount: true } } },
    orderBy: { createdAt: "asc" },
  });
  return wishes.map((w) => {
    const reserved = w.contributions.reduce((a, c) => a + c.amount, 0);
    return { id: w.id, name: w.name, price: w.price, progress: w.price > 0 ? Math.min(1, reserved / w.price) : 0, purchased: !!w.purchasedAt };
  });
}

export function parkSources(subs: Subscription[], tz: string, at: number): ParkSource[] {
  return subs.map((s) => ({ id: s.id, name: s.name, monthly: monthlyEquivalent(s), active: isSubActive(s, tz, at) }));
}

/** 公園・像を最新の家計データに合わせる */
export async function syncSpecials(ctx: GameCtx) {
  if (!ctx.season || !ctx.city) return;
  ctx.subs = await ctx.tx.subscription.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  placeOffMapSpecials(ctx.city);
  syncParks(ctx.city, parkSources(ctx.subs, ctx.user.timezone, ctx.now), ctx.now, ctx.events);
  syncStatues(ctx.city, await statueSources(ctx.tx, ctx.user.id, ctx.season), ctx.now, ctx.events);
}

async function load(tx: Tx, userId: string, now: number): Promise<GameCtx> {
  // 同じユーザーの操作を直列化する（複数端末の同時操作対策）
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  const season = await currentSeason(tx, userId);
  const subs = await tx.subscription.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const ctx: GameCtx = {
    tx,
    now,
    user,
    season,
    mine: null,
    city: null,
    cityVersion: 0,
    subs,
    events: [],
    ledger: [],
    balances: { gold: season?.gold ?? 0, silver: season?.silver ?? 0, reserved: season?.reservedGold ?? 0 },
    overspends: [],
    seasonPatch: {},
  };
  if (!season) return ctx;

  const row = await tx.cityState.findUniqueOrThrow({ where: { seasonId: season.id } });
  ctx.city = row.state as unknown as CityState;
  ctx.cityVersion = row.version;

  // 金鉱の採掘
  const r = accrue(mineFromSeason(season), { budget: user.monthlyBudget, subs: subWindows(subs, user.timezone), tz: user.timezone, until: now });
  ctx.mine = r.mine;
  ctx.overspends.push(...r.overspends);

  // 街の放置計算
  simulate(ctx.city, now, ctx.events);
  await syncSpecials(ctx);
  return ctx;
}

async function save(ctx: GameCtx) {
  const { tx, season } = ctx;
  if (!season || !ctx.city || !ctx.mine) return;
  // 所持金貨がマイナス（採掘負債あり）の間に手持ちへ入った金貨は、まず負債の返済に充てる
  const repay = repayDebtFromHeld(ctx.mine, ctx.balances.gold);
  if (repay.used > 0) {
    ctx.mine = repay.mine;
    addCurrency(ctx, "GOLD", -repay.used, "debt_repay");
  }
  await tx.season.update({
    where: { id: season.id },
    data: {
      ...mineToSeason(ctx.mine),
      gold: ctx.balances.gold,
      silver: ctx.balances.silver,
      reservedGold: ctx.balances.reserved,
      ...ctx.seasonPatch,
    },
  });
  const updated = await tx.cityState.updateMany({
    where: { seasonId: season.id, version: ctx.cityVersion },
    data: { state: ctx.city as unknown as Prisma.InputJsonValue, version: ctx.cityVersion + 1 },
  });
  if (updated.count !== 1) fail("conflict", "他の端末で更新されました。もう一度お試しください", 409);

  if (ctx.events.length) {
    await tx.cityEvent.createMany({
      data: ctx.events.map((e) => ({
        seasonId: season.id,
        at: new Date(e.at),
        type: e.type,
        auto: e.auto,
        important: e.important,
        payload: e.payload as Prisma.InputJsonValue,
      })),
    });
  }
  if (ctx.ledger.length) {
    const running = { GOLD: season.gold, SILVER: season.silver, RESERVED: season.reservedGold };
    await tx.currencyLedger.createMany({
      data: ctx.ledger.map((l) => {
        running[l.currency] += l.delta;
        return { seasonId: season.id, currency: l.currency, delta: l.delta, balanceAfter: running[l.currency], reason: l.reason, refId: l.refId };
      }),
    });
  }
  for (const o of ctx.overspends) {
    await tx.monthlyOverspend.upsert({
      where: { seasonId_monthKey: { seasonId: season.id, monthKey: o.monthKey } },
      create: { seasonId: season.id, monthKey: o.monthKey, amount: o.amount },
      update: { amount: { increment: o.amount } },
    });
  }
}

/**
 * ゲーム操作の入口。idempotencyKey が同じ操作は1回だけ実行し、2回目以降は最初の結果を返す。
 */
export async function withGame<T>(
  userId: string,
  fn: (ctx: GameCtx) => Promise<T>,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const ctx = await load(tx, userId, Date.now());
      if (opts.idempotencyKey) {
        const prev = await tx.idempotencyKey.findUnique({ where: { userId_key: { userId, key: opts.idempotencyKey } } });
        if (prev) {
          await save(ctx);
          return prev.response as T;
        }
      }
      const result = await fn(ctx);
      await save(ctx);
      if (opts.idempotencyKey) {
        await tx.idempotencyKey.create({
          data: { userId, key: opts.idempotencyKey, status: 200, response: JSON.parse(JSON.stringify(result ?? null, bigintReplacer)) },
        });
      }
      return result;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}

export const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

// ---- 貯金の再評価（技術Lv・銀行Lv・達成率・シーズン状態） ----

export async function refreshSavings(ctx: GameCtx) {
  requireSeason(ctx);
  const { tx, season, city } = ctx;
  const records = await tx.savingsTransaction.findMany({
    where: { seasonId: season.id, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { kind: true, amount: true },
  });
  const { net, max } = savingsProgress(records);

  applyTechLevel(city, techLevel(max), ctx.now, ctx.events);

  const rate = achievementRate(net, season.goalAmount);
  const lv = bankLevel(rate);
  if (lv !== city.bankLevel) {
    ctx.events.push({ at: ctx.now, type: "BANK_LEVEL", auto: false, important: lv > city.bankLevel, payload: { level: lv, rate } });
    city.bankLevel = lv;
  }

  const hit = new Set(season.milestones);
  for (const m of [25, 50, 75, 100]) {
    if (rate >= m && !hit.has(m)) {
      hit.add(m);
      ctx.events.push({ at: ctx.now, type: "SAVINGS_MILESTONE", auto: false, important: true, payload: { percent: m } });
    }
  }
  ctx.seasonPatch.milestones = [...hit].sort((a, b) => a - b);

  if (rate >= 100 && season.status === "ACTIVE") {
    ctx.seasonPatch.status = "GOAL_REACHED";
    ctx.seasonPatch.reachedAt = new Date(ctx.now);
  } else if (rate < 100 && season.status === "GOAL_REACHED") {
    // 誤入力の修正などで100%を下回ったら進行中に戻す
    ctx.seasonPatch.status = "ACTIVE";
    ctx.seasonPatch.reachedAt = null;
  }
  return { net, max, rate };
}

/** 金鉱・銀鉱のレベルが before から上がっていればイベントを出す */
export function emitFacilityLevels(ctx: GameCtx, before: { gold?: number; silver?: number }) {
  requireSeason(ctx);
  if (before.gold !== undefined) {
    const g = goldMineLevel(ctx.mine.totalCollected);
    if (g > before.gold) ctx.events.push({ at: ctx.now, type: "GOLD_MINE_LEVEL", auto: false, important: true, payload: { level: g } });
  }
  if (before.silver !== undefined) {
    const rewarded = (ctx.seasonPatch.rewardedRecords as number | undefined) ?? ctx.season.rewardedRecords;
    const s = silverMineLevel(rewarded);
    if (s > before.silver) ctx.events.push({ at: ctx.now, type: "SILVER_MINE_LEVEL", auto: false, important: true, payload: { level: s } });
  }
}
