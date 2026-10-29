// ゲームの正本はサーバー。1ユーザーの操作はユーザー単位のロックを取ったトランザクションで直列化し、
// 「最終計算時刻から現在まで」の放置計算をしてから操作を適用する。
import { randomUUID } from "node:crypto";
import { Prisma, type CurrencyDef, type Season, type Subscription, type User, type WishItem } from "@prisma/client";
import { bondCap } from "@/game/bond";
import { placeOffMapSpecials, syncParks, syncStatues, type ParkSource, type StatueSource } from "@/game/city/actions";
import { normalizeCity } from "@/game/city/layout";
import { applyTechLevel } from "@/game/city/sim";
import { BudgetPlan, type CurrencyDefLite, type Rule } from "@/game/currency";
import { fail } from "@/game/errors";
import { advance, type Accrual, type CustomCut, type Grant } from "@/game/idle";
import { achievementRate, bankLevel, goldMineLevel, savingsTotal, silverMineLevel, techLevel } from "@/game/levels";
import { floorMinute, type GoldWindow, type MineState, type SubWindow } from "@/game/mine";
import type { Lot, Purse } from "@/game/settle";
import { monthCal, parseDateInTz, type PeriodCal } from "@/game/time";
import type { CityEvent, CityState } from "@/game/types";
import { prisma } from "./db";

export type Tx = Prisma.TransactionClient;

export interface LedgerRow {
  currency: "GOLD" | "SILVER" | "RESERVED" | "BOND" | "CUSTOM";
  delta: number;
  reason: string;
  refId?: string;
  /** CUSTOM のときの通貨 */
  currencyId?: string;
}

export interface GameCtx {
  tx: Tx;
  now: number;
  user: User;
  /** 収入期間の区切り（収入日） */
  cal: PeriodCal;
  /** 進行中（ACTIVE / GOAL_REACHED）のシーズン */
  season: Season | null;
  mine: MineState | null;
  city: CityState | null;
  cityVersion: number;
  subs: Subscription[];
  events: CityEvent[];
  ledger: LedgerRow[];
  /** bond はマイナスになり得る */
  balances: { gold: number; silver: number; reserved: number; bond: number };
  /** その月に不足分として債券から払った額の増減 */
  overspends: { monthKey: string; amount: number }[];
  /** ユーザ定義通貨の定義（削除済みを除く、並び順） */
  currencyRows: CurrencyDef[];
  defs: CurrencyDefLite[];
  /** このシーズンのロット（残りがあるもの＋この操作で触ったもの） */
  lots: Lot[];
  accruals: Map<string, Accrual>;
  /** 読み込み時の通貨ごとの残高（台帳の balanceAfter 用） */
  customStart: Map<string, number>;
  /** 予約した振り分けのうち、この操作の放置計算で期日が来たもの（入れた時刻を保存する） */
  grants: Grant[];
  /** 当期のユーザ通貨の未発生分から減らす額（月の収入の−差分） */
  cuts: CustomCut[];
  /** 都市に使った金貨の累計（貯金額の債券以外） */
  citySpent: number;
  /** シーズン行の追加更新 */
  seasonPatch: Prisma.SeasonUpdateInput;
}

type EraJson = { day: number; from: number | null; prevEnd: number | null };

/** 収入日の区切り。履歴がなければ毎月1日 */
export function calOf(user: Pick<User, "timezone" | "incomeEras">): PeriodCal {
  const raw = (user.incomeEras as EraJson[] | null) ?? [];
  if (!raw.length) return monthCal(user.timezone);
  return { tz: user.timezone, eras: raw.map((e) => ({ day: e.day, from: e.from ?? -Infinity, prevEnd: e.prevEnd ?? -Infinity })) };
}

export function erasJson(cal: PeriodCal): EraJson[] {
  const n = (v: number) => (Number.isFinite(v) ? v : null);
  return cal.eras.map((e) => ({ day: e.day, from: n(e.from), prevEnd: n(e.prevEnd) }));
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

type WindowJson = Omit<GoldWindow, "total"> & { total: string };

export function mineFromSeason(s: Season): MineState {
  return {
    windows: ((s.mineWindows as WindowJson[] | null) ?? []).map((w) => ({ ...w, total: BigInt(w.total) })),
    cut: s.mineCut,
    dividend: s.mineDividend,
    uncollected: s.mineUncollected,
    bondFraction: s.mineBondFraction,
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
    mineBondFraction: m.bondFraction,
    mineLastAccrualAt: new Date(m.lastAccrualAt),
    mineMonthKey: m.monthKey,
    mineMinedMonth: m.minedThisMonth,
    mineSettledMonth: m.settledThisMonth,
    mineTotalCollected: m.totalCollected,
    mineWindows: (m.windows ?? []).map((w) => ({ ...w, total: w.total.toString() })) as unknown as Prisma.InputJsonValue,
    mineCut: m.cut ?? 0n,
    mineDividend: m.dividend ?? 0n,
  };
}

export async function currentSeason(tx: Tx, userId: string): Promise<Season | null> {
  return tx.season.findFirst({ where: { userId, status: { in: ["ACTIVE", "GOAL_REACHED"] } }, orderBy: { number: "desc" } });
}

export function defLite(d: CurrencyDef): CurrencyDefLite {
  return {
    id: d.id,
    name: d.name,
    icon: d.icon,
    categoryIds: d.categoryIds,
    rules: d.rules as unknown as Rule[],
    remainder: d.remainder,
    remainderDays: d.remainderDays,
    startDate: d.startDate,
    endDate: d.endDate,
    sortOrder: d.sortOrder,
    createdAt: d.createdAt.getTime(),
  };
}

/** 採掘から差し引く額（サブスク・ユーザ通貨）の計画。予算・サブスク・通貨を変えたら作り直す */
export function budgetPlan(ctx: Pick<GameCtx, "user" | "subs" | "defs" | "cal">, override: { budget?: number; subs?: Subscription[]; defs?: CurrencyDefLite[] } = {}) {
  const tz = ctx.user.timezone;
  return new BudgetPlan(override.budget ?? ctx.user.monthlyBudget, subWindows(override.subs ?? ctx.subs, tz), override.defs ?? ctx.defs, ctx.cal);
}

export async function loadCurrencyDefs(tx: Tx, userId: string): Promise<CurrencyDef[]> {
  return tx.currencyDef.findMany({ where: { userId, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

/**
 * 金貨・銀貨・債券・金鉱を Purse として操作し、結果（残高・台帳・予算超過）を ctx に戻す。
 * Purse の操作は残高がマイナスにならないことを自分で保証する（債券を除く）。
 */
export function withPurse<T>(ctx: GameCtx, fn: (p: Purse) => T): T {
  requireSeason(ctx);
  const p: Purse = {
    mine: ctx.mine,
    gold: ctx.balances.gold,
    silver: ctx.balances.silver,
    bond: ctx.balances.bond,
    bondCap: bondCap(ctx.user.monthlyBudget),
    moves: [],
    overspend: 0,
  };
  const result = fn(p);
  ctx.mine = p.mine;
  ctx.balances.gold = p.gold;
  ctx.balances.silver = p.silver;
  ctx.balances.bond = p.bond;
  // 払い戻しで余りが債券に戻った分などは、次のティックの前に資源にする
  if (p.bondResource) ctx.city!.bondResourcePending = (ctx.city!.bondResourcePending ?? 0) + p.bondResource;
  for (const m of p.moves) ctx.ledger.push({ currency: m.currency, delta: m.delta, reason: m.reason, currencyId: m.currencyId });
  if (p.overspend !== 0) ctx.overspends.push({ monthKey: ctx.mine.monthKey, amount: p.overspend });
  return result;
}

/** 台帳の refId を Purse の操作で付いた行に付ける */
export function tagLedger(ctx: GameCtx, from: number, refId: string) {
  for (let i = from; i < ctx.ledger.length; i++) ctx.ledger[i].refId ??= refId;
}

export function addCurrency(ctx: GameCtx, currency: "GOLD" | "SILVER" | "RESERVED" | "BOND", delta: number, reason: string, refId?: string) {
  if (delta === 0) return;
  const key = currency === "GOLD" ? "gold" : currency === "SILVER" ? "silver" : currency === "BOND" ? "bond" : "reserved";
  const after = ctx.balances[key] + delta;
  // 債券だけはマイナスになってよい（購入の精算で足りない分を肩代わりする）
  if (after < 0 && currency !== "BOND") {
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
  const currencyRows = await loadCurrencyDefs(tx, userId);
  const ctx: GameCtx = {
    tx,
    now,
    user,
    cal: calOf(user),
    season,
    mine: null,
    city: null,
    cityVersion: 0,
    subs,
    events: [],
    ledger: [],
    balances: { gold: season?.gold ?? 0, silver: season?.silver ?? 0, reserved: season?.reservedGold ?? 0, bond: season?.bond ?? 0 },
    overspends: [],
    currencyRows,
    defs: currencyRows.map(defLite),
    lots: [],
    accruals: new Map(),
    customStart: new Map(),
    grants: [],
    cuts: [],
    citySpent: season?.citySpentGold ?? 0,
    seasonPatch: {},
  };
  if (!season) return ctx;

  const row = await tx.cityState.findUniqueOrThrow({ where: { seasonId: season.id } });
  ctx.city = normalizeCity(row.state as unknown as CityState);
  ctx.cityVersion = row.version;
  ctx.mine = mineFromSeason(season);

  const lots = await tx.currencyLot.findMany({ where: { seasonId: season.id, remaining: { gt: 0 } } });
  ctx.lots = lots.map(lotFromRow);
  for (const l of ctx.lots) ctx.customStart.set(l.currencyId, (ctx.customStart.get(l.currencyId) ?? 0) + l.remaining);
  const accruals = await tx.currencyAccrual.findMany({ where: { seasonId: season.id } });
  for (const a of accruals) ctx.accruals.set(a.currencyId, { currencyId: a.currencyId, lastAccrualAt: a.lastAccrualAt.getTime(), fraction: a.fraction });
  for (const d of ctx.defs) {
    if (!ctx.accruals.has(d.id)) {
      // 発生は通貨を作った時点（またはシーズン開始）から。過ぎた日の分はさかのぼって発生させない
      const startAt = floorMinute(Math.max(season.startedAt.getTime(), d.createdAt));
      ctx.accruals.set(d.id, { currencyId: d.id, lastAccrualAt: startAt, fraction: 0n, isNew: true });
    }
  }

  // 予約した振り分けのうち期日が来たもの・当期のユーザ通貨から減らす額
  const due = await tx.scheduledGrant.findMany({ where: { seasonId: season.id, grantedAt: null, canceled: false, at: { lte: new Date(now) } } });
  ctx.grants = due.map((g) => ({ id: g.id, at: g.at.getTime(), currency: g.currency as Grant["currency"], currencyId: g.currencyId, amount: g.amount, dividend: g.dividend, grantedAt: null }));
  ctx.cuts = ((season.customCuts as CustomCut[] | null) ?? []).filter((c) => c.remaining > 0);

  // 放置計算：10分ティックごとに 金鉱 → ユーザ通貨 → 街
  const goldLevel = goldMineLevel(ctx.mine.totalCollected);
  withPurse(ctx, (purse) => {
    advance(
      { purse, city: ctx.city!, lots: ctx.lots, accruals: ctx.accruals, grants: ctx.grants, cuts: ctx.cuts },
      { plan: budgetPlan(ctx), bondRate: user.bondMiningRate, until: now, newId: newLotId },
      ctx.events,
    );
  });
  // 債券化した採掘も金鉱Lvの経験値に含める
  emitFacilityLevels(ctx, { gold: goldLevel });
  await syncSpecials(ctx);
  // 放置中の債券化で貯金額が変わるので、技術Lv・銀行Lv・達成率を確かめ直す
  refreshSavings(ctx);
  return ctx;
}

export const newLotId = () => `l${randomUUID().replace(/-/g, "")}`;

export function lotFromRow(l: { id: string; currencyId: string; issuedAt: Date; expiresAt: Date | null; amount: number; remaining: number }): Lot {
  return { id: l.id, currencyId: l.currencyId, issuedAt: l.issuedAt.getTime(), expiresAt: l.expiresAt?.getTime() ?? null, amount: l.amount, remaining: l.remaining };
}

async function save(ctx: GameCtx) {
  const { tx, season } = ctx;
  if (!season || !ctx.city || !ctx.mine) return;
  await tx.season.update({
    where: { id: season.id },
    data: {
      ...mineToSeason(ctx.mine),
      gold: ctx.balances.gold,
      silver: ctx.balances.silver,
      reservedGold: ctx.balances.reserved,
      bond: ctx.balances.bond,
      citySpentGold: ctx.citySpent,
      customCuts: ctx.cuts.filter((c) => c.remaining > 0 && c.periodKey === ctx.mine!.monthKey) as unknown as Prisma.InputJsonValue,
      ...ctx.seasonPatch,
    },
  });
  const granted = ctx.grants.filter((g) => g.grantedAt !== null);
  for (const g of granted) await tx.scheduledGrant.update({ where: { id: g.id }, data: { grantedAt: new Date(g.grantedAt!) } });
  ctx.grants = ctx.grants.filter((g) => g.grantedAt === null);
  await saveCurrencies(ctx, season.id);
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
    const running = new Map<string, number>([
      ["GOLD", season.gold],
      ["SILVER", season.silver],
      ["RESERVED", season.reservedGold],
      ["BOND", season.bond],
      ...[...ctx.customStart].map(([id, v]) => [`CUSTOM:${id}`, v] as [string, number]),
    ]);
    await tx.currencyLedger.createMany({
      data: ctx.ledger.map((l) => {
        const key = l.currency === "CUSTOM" ? `CUSTOM:${l.currencyId}` : l.currency;
        const after = (running.get(key) ?? 0) + l.delta;
        running.set(key, after);
        return { seasonId: season.id, currency: l.currency, currencyId: l.currencyId, delta: l.delta, balanceAfter: after, reason: l.reason, refId: l.refId };
      }),
    });
  }
  const overspend = new Map<string, number>();
  for (const o of ctx.overspends) overspend.set(o.monthKey, (overspend.get(o.monthKey) ?? 0) + o.amount);
  for (const [monthKey, amount] of overspend) {
    if (amount === 0) continue;
    await tx.monthlyOverspend.upsert({
      where: { seasonId_monthKey: { seasonId: season.id, monthKey } },
      create: { seasonId: season.id, monthKey, amount: Math.max(0, amount) },
      update: { amount: { increment: amount } },
    });
  }
}

/** ロットと発生の進み具合を保存する */
async function saveCurrencies(ctx: GameCtx, seasonId: string) {
  const { tx } = ctx;
  const created = ctx.lots.filter((l) => l.isNew && l.amount > 0);
  if (created.length) {
    await tx.currencyLot.createMany({
      data: created.map((l) => ({
        id: l.id,
        seasonId,
        currencyId: l.currencyId,
        issuedAt: new Date(l.issuedAt),
        expiresAt: l.expiresAt === null ? null : new Date(l.expiresAt),
        amount: l.amount,
        remaining: l.remaining,
      })),
    });
  }
  for (const l of ctx.lots) {
    if (l.isNew || !l.dirty) continue;
    await tx.currencyLot.update({ where: { id: l.id }, data: { amount: l.amount, remaining: l.remaining } });
  }
  for (const l of created) l.isNew = false;
  for (const l of ctx.lots) l.dirty = false;

  const fresh = [...ctx.accruals.values()].filter((a) => a.isNew);
  if (fresh.length) {
    await tx.currencyAccrual.createMany({
      data: fresh.map((a) => ({ seasonId, currencyId: a.currencyId, lastAccrualAt: new Date(a.lastAccrualAt), fraction: a.fraction })),
    });
    for (const a of fresh) a.isNew = false;
  }
  const rest = [...ctx.accruals.values()].filter((a) => !fresh.includes(a));
  if (rest.length) {
    const rows = rest.map((a) => Prisma.sql`(${a.currencyId}, ${new Date(a.lastAccrualAt)}::timestamp(3), ${a.fraction}::bigint)`);
    await tx.$executeRaw`
      UPDATE "CurrencyAccrual" AS a SET "lastAccrualAt" = v.t, "fraction" = v.f
      FROM (VALUES ${Prisma.join(rows)}) AS v(id, t, f)
      WHERE a."seasonId" = ${seasonId} AND a."currencyId" = v.id`;
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
      refreshSavings(ctx);
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

// ---- 貯金額の再評価（技術Lv・銀行Lv・達成率・シーズン状態。docs/record-input-redesign.md §7.1） ----

/** 貯金額（債券 ＋ 都市に使った金貨）と、その最高到達額・達成率 */
export function savingsOf(ctx: GameCtx) {
  requireSeason(ctx);
  const amount = savingsTotal({ bond: ctx.balances.bond, citySpent: ctx.citySpent });
  const stored = (ctx.seasonPatch.maxSavingsAmount as number | undefined) ?? ctx.season.maxSavingsAmount;
  const max = Math.max(stored, amount);
  return { amount, bond: ctx.balances.bond, citySpent: ctx.citySpent, max, rate: achievementRate(amount, ctx.season.goalAmount) };
}

/** 貯金額が変わる操作のあとに呼ぶ（読み込み時と操作のあと、withGame が呼ぶ）。完了したシーズンは触らない */
export function refreshSavings(ctx: GameCtx) {
  if (!ctx.season || !ctx.city || !ctx.mine) return null;
  const status = (ctx.seasonPatch.status as string | undefined) ?? ctx.season.status;
  if (status === "COMPLETED") return null;
  const { season, city } = ctx;
  const s = savingsOf(ctx);
  if (s.max !== season.maxSavingsAmount) ctx.seasonPatch.maxSavingsAmount = s.max;

  // 技術Lvは最高到達額で決まり、下がらない
  applyTechLevel(city, Math.max(city.techLevel, techLevel(s.max)), ctx.now, ctx.events);

  const lv = bankLevel(s.rate);
  if (lv !== city.bankLevel) {
    ctx.events.push({ at: ctx.now, type: "BANK_LEVEL", auto: false, important: lv > city.bankLevel, payload: { level: lv, rate: s.rate } });
    city.bankLevel = lv;
  }

  const hit = new Set((ctx.seasonPatch.milestones as number[] | undefined) ?? season.milestones);
  let added = false;
  for (const m of [25, 50, 75, 100]) {
    if (s.rate >= m && !hit.has(m)) {
      hit.add(m);
      added = true;
      ctx.events.push({ at: ctx.now, type: "SAVINGS_MILESTONE", auto: false, important: true, payload: { percent: m } });
    }
  }
  if (added) ctx.seasonPatch.milestones = [...hit].sort((a, b) => a - b);

  if (s.rate >= 100 && status === "ACTIVE") {
    ctx.seasonPatch.status = "GOAL_REACHED";
    ctx.seasonPatch.reachedAt = new Date(ctx.now);
  } else if (s.rate < 100 && status === "GOAL_REACHED") {
    // 債券を使って100%を下回ったら進行中に戻す
    ctx.seasonPatch.status = "ACTIVE";
    ctx.seasonPatch.reachedAt = null;
  }
  return s;
}

export function facilityLevels(ctx: GameCtx) {
  requireSeason(ctx);
  return {
    bank: ctx.city.bankLevel,
    goldMine: goldMineLevel(ctx.mine.totalCollected),
    silverMine: silverMineLevel((ctx.seasonPatch.rewardedRecords as number | undefined) ?? ctx.season.rewardedRecords),
  };
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
