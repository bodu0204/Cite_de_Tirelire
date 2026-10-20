// ゲーム操作。すべて withGame の中（同期済み・ロック済み）で呼ばれる。
import { Prisma } from "@prisma/client";
import { bondCap, bondResourceEligible } from "@/game/bond";
import { LINE_IDS, type LineId, type Zone } from "@/game/catalog";
import {
  demolish,
  manualBuild,
  manualEvolve,
  manualUpgrade,
  moveBuilding,
  rushJob,
  setLocked,
  setNoAuto,
  setPolicy,
  setZone,
} from "@/game/city/actions";
import { createCity, POLICY_PRESETS } from "@/game/city/init";
import { cityNeeds } from "@/game/city/sim";
import { INITIAL_GOLD, INITIAL_SILVER, REWARD_DAILY_CAP, REWARD_PURCHASE, REWARD_SAVINGS } from "@/game/config";
import { fail } from "@/game/errors";
import { quoteNeedsExchange, quoteResourceExchange, type Currency } from "@/game/exchange";
import { budgetOverruns, describeOverruns, type Overrun } from "@/game/currency";
import { goldMineLevel, silverMineLevel } from "@/game/levels";
import { collect, newMine } from "@/game/mine";
import { lotOrder, pay, refund, summarize, type Lot, type LotRef, type Payment } from "@/game/settle";
import { dayKey, isValidTimeZone, monthKey, parseDateInTz } from "@/game/time";
import { DEFAULT_PRIORITIES, type CityPolicy, type NeedKey, type Stock, type StockKey } from "@/game/types";
import {
  addCurrency,
  budgetPlan,
  emitFacilityLevels,
  lotFromRow,
  refreshSavings,
  requireSeason,
  syncSpecials,
  tagLedger,
  withPurse,
  type GameCtx,
} from "./game";
import { resolveCategory } from "./categories";
import { bool, date, int, oneOf, optDate, optStr, str } from "./validate";

type Body = Record<string, unknown>;

const PRESETS = ["balanced", "housing", "industry", "commerce", "custom"] as const;

function requireOpen(ctx: GameCtx) {
  requireSeason(ctx);
  return ctx;
}

// ---- シーズン ----

export async function startSeason(ctx: GameCtx, body: Body) {
  if (ctx.season) fail("season_exists", "進行中のシーズンがあります", 409);
  const goal = int(body.goalAmount, "貯金目標額", { min: 1000, max: 100_000_000 });
  const preset = body.preset ? oneOf(body.preset, PRESETS, "開発方針") : "balanced";
  if (body.monthlyBudget !== undefined) {
    ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data: { monthlyBudget: int(body.monthlyBudget, "月間自由予算", { max: 10_000_000 }) } });
  }
  const tz = ctx.user.timezone;
  const number = (await ctx.tx.season.count({ where: { userId: ctx.user.id } })) + 1;
  const mine = newMine(ctx.now, tz);
  const city = createCity(ctx.now, preset);
  const season = await ctx.tx.season.create({
    data: {
      userId: ctx.user.id,
      number,
      goalAmount: goal,
      startedAt: new Date(ctx.now),
      gold: 0,
      silver: 0,
      mineLastAccrualAt: new Date(mine.lastAccrualAt),
      mineMonthKey: mine.monthKey,
    },
  });
  await ctx.tx.cityState.create({ data: { seasonId: season.id, state: city as unknown as Prisma.InputJsonValue } });
  ctx.season = season;
  ctx.mine = mine;
  ctx.city = city;
  ctx.cityVersion = 0;
  // 債券・ユーザ通貨の残高はシーズンごと（新シーズンで0から。マイナスも持ち越さない）
  ctx.balances = { gold: 0, silver: 0, reserved: 0, bond: 0 };
  ctx.lots = [];
  ctx.accruals = new Map();
  ctx.customStart = new Map();
  addCurrency(ctx, "GOLD", INITIAL_GOLD, "season_start");
  addCurrency(ctx, "SILVER", INITIAL_SILVER, "season_start");
  ctx.events.push({ at: ctx.now, type: "SEASON_STARTED", auto: false, important: true, payload: { goal, number } });
  await syncSpecials(ctx);
  await ctx.tx.citySnapshot.create({
    data: { seasonId: season.id, kind: "START", at: new Date(ctx.now), state: city as unknown as Prisma.InputJsonValue },
  });
  return { seasonId: season.id };
}

export async function completeSeason(ctx: GameCtx) {
  requireOpen(ctx);
  const { season } = ctx;
  if (!season || season.status !== "GOAL_REACHED") fail("not_reached", "まだ貯金目標に到達していません", 409);
  ctx.events.push({ at: ctx.now, type: "SEASON_COMPLETED", auto: false, important: true, payload: { goal: season!.goalAmount } });
  ctx.seasonPatch.status = "COMPLETED";
  ctx.seasonPatch.completedAt = new Date(ctx.now);
  await ctx.tx.citySnapshot.create({
    data: { seasonId: season!.id, kind: "FINAL", at: new Date(ctx.now), state: ctx.city as unknown as Prisma.InputJsonValue },
  });
  return { seasonId: season!.id };
}

// ---- 金鉱 ----

export function collectGold(ctx: GameCtx) {
  requireOpen(ctx);
  const before = goldMineLevel(ctx.mine!.totalCollected);
  const r = collect(ctx.mine!);
  ctx.mine = r.mine;
  addCurrency(ctx, "GOLD", r.gold, "mine_collect");
  emitFacilityLevels(ctx, { gold: before });
  return { collected: r.gold };
}

// ---- 銀鉱：記録と報酬 ----

async function grantReward(ctx: GameCtx, recordKey: string, base: number): Promise<number> {
  if (!ctx.season) return 0;
  const day = dayKey(ctx.now, ctx.user.timezone);
  const exists = await ctx.tx.rewardClaim.findUnique({ where: { recordKey } });
  if (exists) return 0;
  const today = await ctx.tx.rewardClaim.aggregate({ where: { userId: ctx.user.id, dayKey: day }, _sum: { amount: true } });
  const amount = Math.max(0, Math.min(base, REWARD_DAILY_CAP - (today._sum.amount ?? 0)));
  await ctx.tx.rewardClaim.create({ data: { userId: ctx.user.id, seasonId: ctx.season.id, recordKey, dayKey: day, amount } });
  if (amount === 0) return 0;
  const before = silverMineLevel(ctx.season.rewardedRecords);
  const rewarded = ctx.season.rewardedRecords + 1;
  ctx.seasonPatch.rewardedRecords = rewarded;
  addCurrency(ctx, "SILVER", amount, "record_reward", recordKey);
  emitFacilityLevels(ctx, { silver: before });
  return amount;
}

function purchaseInput(body: Body) {
  return {
    amount: int(body.amount, "購入金額", { min: 1, max: 100_000_000 }),
    date: date(body.date, "購入日"),
    name: str(body.name, "購入内容", { max: 100 }),
    memo: optStr(body.memo, "メモ"),
    isSubscription: bool(body.isSubscription),
  };
}

/** 金鉱で精算する対象か：進行中シーズン・サブスク以外・当月の購入 */
function settleable(ctx: GameCtx, p: { date: string; isSubscription: boolean }) {
  if (!ctx.mine || p.isSubscription) return false;
  const at = parseDateInTz(p.date, ctx.user.timezone);
  return at !== null && monthKey(at, ctx.user.timezone) === ctx.mine.monthKey;
}

/** そのジャンルの購入に使えるロットを支払い順に（期限の近い順、同じなら通貨の並び順） */
function eligibleLots(ctx: GameCtx, lots: Lot[], categoryId: string | null): Lot[] {
  if (!categoryId) return [];
  const usable = new Set(ctx.defs.filter((d) => d.categoryIds.includes(categoryId)).map((d) => d.id));
  const order = new Map(ctx.defs.map((d, i) => [d.id, i]));
  return lots
    .filter((l) => usable.has(l.currencyId) && l.remaining > 0 && (l.expiresAt === null || l.expiresAt > ctx.now))
    .sort(lotOrder((id) => order.get(id) ?? 0));
}

/** 購入額を精算する（ユーザ通貨 → 未回収 → 所持金貨 → 債券＋手数料） */
function settle(ctx: GameCtx, amount: number, categoryId: string | null, payments: Payment[], refId: string) {
  if (amount <= 0) return;
  const from = ctx.ledger.length;
  withPurse(ctx, (p) => pay(p, amount, eligibleLots(ctx, ctx.lots, categoryId), payments));
  ctx.mine!.settledThisMonth += amount;
  tagLedger(ctx, from, refId);
}

/** 支払いに使ったロットを読み込んでおく（払い戻しで元のロットへ戻すため） */
async function loadPaidLots(ctx: GameCtx, payments: Payment[]) {
  const ids = payments.filter((x) => x.lotId && !ctx.lots.some((l) => l.id === x.lotId)).map((x) => x.lotId!);
  if (!ids.length) return;
  const rows = await ctx.tx.currencyLot.findMany({ where: { id: { in: ids } } });
  ctx.lots.push(...rows.map(lotFromRow));
}

function refundAmount(ctx: GameCtx, amount: number, payments: Payment[], refId: string) {
  if (amount <= 0) return;
  const from = ctx.ledger.length;
  const live = new Set(ctx.defs.map((d) => d.id));
  const resolve = (lotId: string): LotRef => {
    const lot = ctx.lots.find((l) => l.id === lotId);
    if (!lot || !live.has(lot.currencyId)) return {};
    // 期限切れなら、戻した分にその場で余りの扱い（債券へ）を適用する
    return { lot, expiredToBond: lot.expiresAt !== null && lot.expiresAt <= ctx.now };
  };
  withPurse(ctx, (p) => refund(p, amount, payments, resolve));
  ctx.mine!.settledThisMonth = Math.max(0, ctx.mine!.settledThisMonth - amount);
  tagLedger(ctx, from, refId);
}

/** 購入の支払い内訳。内訳のない精算済みの購入（移行前）は全額を所持金貨で払ったとみなす */
async function paymentsOf(ctx: GameCtx, p: { id: string; settledAmount: number; reservedApplied: number }): Promise<Payment[]> {
  const rows = await ctx.tx.purchasePayment.findMany({ where: { purchaseId: p.id }, orderBy: { id: "asc" } });
  if (rows.length) return rows.map((r) => ({ currency: r.currency, kind: r.kind as Payment["kind"], currencyId: r.currencyId, lotId: r.lotId, amount: r.amount }));
  const list: Payment[] = [];
  if (p.reservedApplied > 0) list.push({ currency: "RESERVED", kind: "pay", amount: p.reservedApplied });
  if (p.settledAmount > 0) list.push({ currency: "GOLD", kind: "pay", amount: p.settledAmount });
  return list;
}

async function savePayments(ctx: GameCtx, purchaseId: string, payments: Payment[]) {
  await ctx.tx.purchasePayment.deleteMany({ where: { purchaseId } });
  const rows = payments.filter((x) => x.amount !== 0);
  if (!rows.length) return;
  // id の並びが支払いの順（払い戻しは逆順）
  await ctx.tx.purchasePayment.createMany({
    data: rows.map((x, i) => ({
      id: `${purchaseId}_${String(i).padStart(3, "0")}`,
      purchaseId,
      currency: x.currency,
      kind: x.kind,
      currencyId: x.currencyId ?? null,
      lotId: x.lotId ?? null,
      amount: x.amount,
    })),
  });
}

async function reservedFor(ctx: GameCtx, wishItemId: string): Promise<number> {
  if (!ctx.season) return 0;
  const agg = await ctx.tx.wishContribution.aggregate({ where: { seasonId: ctx.season.id, wishItemId }, _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}

async function wishFor(ctx: GameCtx, body: Body) {
  const wishItemId = body.wishItemId ? str(body.wishItemId, "ほしい物") : null;
  const wish = wishItemId ? await ctx.tx.wishItem.findFirst({ where: { id: wishItemId, userId: ctx.user.id } }) : null;
  if (wishItemId && !wish) fail("not_found", "ほしい物が見つかりません", 404);
  if (wish?.purchasedAt) fail("already", "このほしい物は購入済みです");
  return wish;
}

export async function recordPurchase(ctx: GameCtx, body: Body) {
  const input = purchaseInput(body);
  const cat = await resolveCategory(ctx, body);
  const wish = await wishFor(ctx, body);

  const purchase = await ctx.tx.purchase.create({
    data: { ...input, ...cat, userId: ctx.user.id, seasonId: ctx.season?.id ?? null, wishItemId: wish?.id ?? null },
  });
  let reservedApplied = 0;
  let settledAmount = 0;
  const payments: Payment[] = [];
  if (ctx.season && settleable(ctx, input)) {
    // 像の積立金貨を先に購入額へ充当する（二重計上しない）
    if (wish) {
      reservedApplied = Math.min(await reservedFor(ctx, wish.id), input.amount);
      if (reservedApplied > 0) {
        await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: wish.id, amount: -reservedApplied } });
        addCurrency(ctx, "RESERVED", -reservedApplied, "wish_purchase", purchase.id);
        payments.push({ currency: "RESERVED", kind: "pay", amount: reservedApplied });
      }
    }
    settledAmount = input.amount - reservedApplied;
    settle(ctx, settledAmount, cat.categoryId, payments, purchase.id);
    await savePayments(ctx, purchase.id, payments);
    await ctx.tx.purchase.update({
      where: { id: purchase.id },
      data: { settledAmount, settledMonth: ctx.mine!.monthKey, reservedApplied },
    });
  }
  if (wish) {
    await ctx.tx.wishItem.update({ where: { id: wish.id }, data: { purchasedAt: new Date(ctx.now), purchaseId: purchase.id } });
    await syncSpecials(ctx);
  }
  const reward = await grantReward(ctx, `purchase:${purchase.id}`, REWARD_PURCHASE);
  return { id: purchase.id, reward, settled: settledAmount, reservedApplied, payment: summarize(payments) };
}

/** 記録前の支払い内訳のプレビュー。状態は変えない */
export async function quotePurchase(ctx: GameCtx, body: Body) {
  const amount = int(body.amount, "購入金額", { min: 1, max: 100_000_000 });
  const input = { date: date(body.date, "購入日"), isSubscription: bool(body.isSubscription) };
  const categoryId = body.categoryId ? str(body.categoryId, "ジャンル") : null;
  if (!ctx.season || !settleable(ctx, input)) {
    return { settleable: false, payment: summarize([]), after: null };
  }
  const wish = body.wishItemId ? await wishFor(ctx, body) : null;
  const reserved = wish ? Math.min(await reservedFor(ctx, wish.id), amount) : 0;
  const payments: Payment[] = reserved > 0 ? [{ currency: "RESERVED", kind: "pay", amount: reserved }] : [];
  const lots = ctx.lots.map((l) => ({ ...l }));
  const purse = { mine: ctx.mine!, gold: ctx.balances.gold, silver: ctx.balances.silver, bond: ctx.balances.bond, bondCap: 0, moves: [], overspend: 0 };
  pay(purse, amount - reserved, eligibleLots(ctx, lots, categoryId), payments);
  return {
    settleable: true,
    payment: summarize(payments),
    after: { gold: purse.gold, uncollected: Number(purse.mine.uncollected / 1_000_000n), silver: purse.silver, bond: purse.bond },
  };
}

async function ownPurchase(ctx: GameCtx, id: string) {
  const p = await ctx.tx.purchase.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
  return p ?? fail("not_found", "購入記録が見つかりません", 404);
}

/**
 * 精算済みの額を新しい目標額に合わせる。増額は追加で精算し、減額は逆順に払い戻す。
 * ジャンルが変わったら、使えるユーザ通貨が変わるので全額を戻してから精算し直す。
 * 締めた月・別シーズンの記録は精算し直さない。
 */
async function resettle(ctx: GameCtx, p: Awaited<ReturnType<typeof ownPurchase>>, target: number, categoryId: string | null) {
  if (!ctx.season || p.seasonId !== ctx.season.id || !ctx.mine) return null;
  if (p.settledMonth && p.settledMonth !== ctx.mine.monthKey) return null;
  const payments = await paymentsOf(ctx, p);
  await loadPaidLots(ctx, payments);
  if (categoryId !== p.categoryId && p.settledAmount > 0 && target > 0) {
    refundAmount(ctx, p.settledAmount, payments, p.id);
    settle(ctx, target, categoryId, payments, p.id);
  } else {
    const delta = target - p.settledAmount;
    if (delta > 0) settle(ctx, delta, categoryId, payments, p.id);
    if (delta < 0) refundAmount(ctx, -delta, payments, p.id);
  }
  return { payments, patch: { settledAmount: target, settledMonth: target > 0 ? ctx.mine.monthKey : null } };
}

export async function editPurchase(ctx: GameCtx, id: string, body: Body) {
  const p = await ownPurchase(ctx, id);
  const input = purchaseInput({ ...p, ...body });
  const cat = body.categoryId !== undefined || body.category !== undefined ? await resolveCategory(ctx, body) : { categoryId: p.categoryId, category: p.category };
  const target = settleable(ctx, input) ? Math.max(0, input.amount - p.reservedApplied) : 0;
  const s = await resettle(ctx, p, target, cat.categoryId);
  if (s) await savePayments(ctx, id, s.payments);
  await ctx.tx.purchase.update({ where: { id }, data: { ...input, ...cat, ...(s?.patch ?? {}) } });
  // 編集では報酬を再付与しない
  return { id, payment: s ? summarize(s.payments) : null };
}

export async function deletePurchase(ctx: GameCtx, id: string) {
  const p = await ownPurchase(ctx, id);
  const s = await resettle(ctx, p, 0, p.categoryId);
  if (s && p.reservedApplied > 0 && p.wishItemId && ctx.season) {
    await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: p.wishItemId, amount: p.reservedApplied } });
    addCurrency(ctx, "RESERVED", p.reservedApplied, "wish_purchase_undo", p.id);
  }
  if (s) await savePayments(ctx, id, s.payments.filter((x) => x.currency !== "RESERVED"));
  await ctx.tx.purchase.update({ where: { id }, data: { deletedAt: new Date(ctx.now), ...(s?.patch ?? {}), reservedApplied: s ? 0 : p.reservedApplied } });
  if (p.wishItemId) {
    await ctx.tx.wishItem.updateMany({ where: { id: p.wishItemId, purchaseId: p.id }, data: { purchasedAt: null, purchaseId: null } });
    await syncSpecials(ctx);
  }
  return { id };
}

function savingsInput(body: Body) {
  return {
    kind: oneOf(body.kind, ["DEPOSIT", "WITHDRAW"] as const, "記録種別"),
    amount: int(body.amount, "貯金額", { min: 1, max: 100_000_000 }),
    date: date(body.date, "記録日"),
    memo: optStr(body.memo, "メモ"),
  };
}

export async function recordSavings(ctx: GameCtx, body: Body) {
  const input = savingsInput(body);
  const tx = await ctx.tx.savingsTransaction.create({ data: { ...input, userId: ctx.user.id, seasonId: ctx.season?.id ?? null } });
  const progress = ctx.season ? await refreshSavings(ctx) : null;
  // 記録した実額が正。それまでの見込み貯金は置き換える（誤差修正）
  const replacedEstimate = ctx.season?.estimatedSavings ?? 0;
  if (ctx.season) ctx.seasonPatch.estimatedSavings = 0;
  const reward = await grantReward(ctx, `savings:${tx.id}`, REWARD_SAVINGS);
  return { id: tx.id, reward, progress, replacedEstimate };
}

async function ownSavings(ctx: GameCtx, id: string) {
  const s = await ctx.tx.savingsTransaction.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
  return s ?? fail("not_found", "貯金記録が見つかりません", 404);
}

export async function editSavings(ctx: GameCtx, id: string, body: Body) {
  const s = await ownSavings(ctx, id);
  const input = savingsInput({ ...s, ...body });
  await ctx.tx.savingsTransaction.update({ where: { id }, data: input });
  if (ctx.season && s.seasonId === ctx.season.id) await refreshSavings(ctx);
  return { id };
}

export async function deleteSavings(ctx: GameCtx, id: string) {
  const s = await ownSavings(ctx, id);
  await ctx.tx.savingsTransaction.update({ where: { id }, data: { deletedAt: new Date(ctx.now) } });
  if (ctx.season && s.seasonId === ctx.season.id) await refreshSavings(ctx);
  return { id };
}

// ---- 資源交換 ----

export function facilityLevels(ctx: GameCtx) {
  requireSeason(ctx);
  return {
    bank: ctx.city.bankLevel,
    goldMine: goldMineLevel(ctx.mine.totalCollected),
    silverMine: silverMineLevel((ctx.seasonPatch.rewardedRecords as number | undefined) ?? ctx.season.rewardedRecords),
  };
}

const RESOURCES: StockKey[] = ["wood", "stone", "food"];

/** 交換で街に入れる資源（ゲーム内のおまかせ交換と同じ量。docs/needs-based-exchange.md §5・§6） */
function addStock(ctx: GameCtx, gains: Stock) {
  for (const k of RESOURCES) ctx.city!.stock[k] += gains[k];
}

/**
 * 金貨・ユーザ通貨を債券へ 1:1 で無料で替える（上限 3M を超えてもよい）。債券からは戻せない（急な出費用に取っておく）。
 * 債券は表示の達成率に直接含まれるので、見込み貯金には加えない（二重に数えない）。
 * 同じ理由で、記録の報酬（現実のお金ではない）である銀貨は替えられない。
 * ユーザ通貨は期限の近いロットから使う。
 * 債券が 0〜3M の範囲に入る分は、同じ量の金貨でおまかせ交換したのと同じ資源もつける（手数料なし。元の通貨はそれ以上減らない）。
 */
function exchangeToBond(ctx: GameCtx, from: "gold" | "custom", amount: number, body: Body) {
  const before = ctx.balances.bond;
  const grant = () => {
    const eligible = bondResourceEligible(before, amount, bondCap(ctx.user.monthlyBudget));
    const q = quoteNeedsExchange("gold", eligible, cityNeeds(ctx.city!).needs, facilityLevels(ctx), { fee: false });
    addStock(ctx, q.gains);
    return { resourceEligible: eligible, gains: q.gains, split: q.split };
  };
  if (from === "gold") {
    addCurrency(ctx, "GOLD", -amount, "exchange_g2b");
    addCurrency(ctx, "BOND", amount, "exchange_g2b");
    return { gold: -amount, bond: amount, ...grant() };
  }
  const currencyId = str(body.currencyId, "ユーザ通貨");
  const def = ctx.defs.find((d) => d.id === currencyId);
  if (!def) fail("not_found", "ユーザ通貨が見つかりません", 404);
  const lots = ctx.lots.filter((l) => l.currencyId === currencyId && l.remaining > 0).sort(lotOrder(() => 0));
  const balance = lots.reduce((a, l) => a + l.remaining, 0);
  if (balance < amount) fail("insufficient", `${def!.name}が足りません`);
  let rest = amount;
  for (const lot of lots) {
    const use = Math.min(rest, lot.remaining);
    lot.remaining -= use;
    lot.dirty = true;
    rest -= use;
    if (rest === 0) break;
  }
  ctx.ledger.push({ currency: "CUSTOM", currencyId, delta: -amount, reason: "exchange_c2b" });
  addCurrency(ctx, "BOND", amount, "exchange_c2b", currencyId);
  return { custom: -amount, currencyId, bond: amount, ...grant() };
}

export function exchange(ctx: GameCtx, body: Body) {
  requireOpen(ctx);
  const kind = oneOf(body.kind, ["gold_to_silver", "gold_to_bond", "to_bond", "to_resource"] as const, "交換の種類");
  const amount = int(body.amount, "交換量", { min: 1, max: 10_000_000 });
  if (kind === "gold_to_silver") {
    // 金貨→銀貨は無料（銀貨不足で操作不能にならないように）
    addCurrency(ctx, "GOLD", -amount, "exchange_g2s");
    addCurrency(ctx, "SILVER", amount, "exchange_g2s");
    return { gold: -amount, silver: amount };
  }
  if (kind === "gold_to_bond" || kind === "to_bond") {
    return exchangeToBond(ctx, kind === "gold_to_bond" ? "gold" : oneOf(body.currency, ["gold", "custom"] as const, "通貨"), amount, body);
  }
  const currency = oneOf(body.currency, ["gold", "silver"] as const, "通貨") as Currency;
  const resource = oneOf(body.resource, [...RESOURCES, "auto"] as const, "資源");
  const lv = facilityLevels(ctx);
  // おまかせ：都市の必要資源の割合で振り分ける（手数料は1回分）
  const q =
    resource === "auto"
      ? quoteNeedsExchange(currency, amount, cityNeeds(ctx.city!).needs, lv)
      : (() => {
          const one = quoteResourceExchange(currency, resource, amount, lv);
          const gains: Stock = { wood: 0, stone: 0, food: 0 };
          gains[resource] = one.gain;
          return { ...one, gains };
        })();
  const gain = q.gains.wood + q.gains.stone + q.gains.food;
  if (gain <= 0) fail("too_small", "交換量が少なすぎます");
  addCurrency(ctx, "SILVER", -q.silverCost, "exchange_resource");
  addCurrency(ctx, "GOLD", -q.goldCost, "exchange_resource");
  addStock(ctx, q.gains);
  // 金貨（1G＝1円相当）をゲーム内で使った分は、現実で使わずに済んだお金＝見込み貯金
  if (q.goldCost > 0) ctx.seasonPatch.estimatedSavings = { increment: q.goldCost };
  return { ...q, gain, estimatedAdded: q.goldCost };
}

// ---- 街の操作 ----

const ZONES: Zone[] = ["residential", "commercial", "industrial", "agricultural", "public", "special", "none"];
const NEEDS: NeedKey[] = DEFAULT_PRIORITIES;

export function cityAction(ctx: GameCtx, body: Body) {
  requireOpen(ctx);
  const city = ctx.city!;
  const silver = ctx.balances.silver;
  const type = oneOf(
    body.type,
    ["build", "upgrade", "evolve", "move", "demolish", "rush", "lock", "zone", "noAuto", "policy"] as const,
    "操作",
  );
  const xy = () => ({ x: int(body.x, "X", { max: 9 }), y: int(body.y, "Y", { max: 9 }) });
  const id = () => str(body.buildingId ?? body.jobId, "対象");
  let fee = 0;
  switch (type) {
    case "build": {
      const line = oneOf(body.line, LINE_IDS, "建物") as LineId;
      const tier = body.tier === undefined ? undefined : int(body.tier, "段階", { max: 10 });
      fee = manualBuild(city, { line, tier, ...xy() }, ctx.now, silver).silverFee;
      break;
    }
    case "upgrade":
      fee = manualUpgrade(city, id(), ctx.now, silver).silverFee;
      break;
    case "evolve":
      fee = manualEvolve(city, id(), ctx.now, silver).silverFee;
      break;
    case "move": {
      const { x, y } = xy();
      fee = moveBuilding(city, id(), x, y, ctx.now, silver, ctx.events).silverFee;
      break;
    }
    case "demolish":
      demolish(city, id(), ctx.now, ctx.events);
      break;
    case "rush":
      fee = rushJob(city, id(), ctx.now, silver, ctx.events).silverFee;
      break;
    case "lock":
      setLocked(city, id(), bool(body.locked));
      break;
    case "zone": {
      const { x, y } = xy();
      setZone(city, x, y, oneOf(body.zone, ZONES, "土地用途"));
      break;
    }
    case "noAuto": {
      const { x, y } = xy();
      setNoAuto(city, x, y, bool(body.noAuto));
      break;
    }
    case "policy": {
      const patch: Partial<CityPolicy> = {};
      if (body.preset !== undefined) {
        patch.preset = oneOf(body.preset, PRESETS, "開発方針");
        if (patch.preset !== "custom") patch.priorities = [...POLICY_PRESETS[patch.preset].priorities];
      }
      if (Array.isArray(body.priorities)) {
        patch.priorities = body.priorities.map((p) => oneOf(p, NEEDS, "優先順位"));
        patch.preset = "custom";
      }
      if (body.autoEnabled !== undefined) patch.autoEnabled = bool(body.autoEnabled);
      setPolicy(city, patch);
      break;
    }
  }
  addCurrency(ctx, "SILVER", -fee, `city_${type}`);
  return { silverFee: fee };
}

// ---- サブスク ----

function subscriptionInput(body: Body) {
  const startDate = date(body.startDate, "契約開始日");
  const endDate = optDate(body.endDate, "解約日");
  if (endDate && endDate < startDate) fail("invalid", "解約日は契約開始日より後にしてください");
  return {
    name: str(body.name, "サービス名", { max: 100 }),
    amount: int(body.amount, "金額", { min: 1, max: 10_000_000 }),
    cycle: oneOf(body.cycle ?? "MONTHLY", ["MONTHLY", "YEARLY"] as const, "支払い周期"),
    startDate,
    endDate,
    memo: optStr(body.memo, "メモ"),
  };
}

/**
 * サブスクは現実の契約の記録なので、自由予算を超えても保存は拒否しない（設計原則5）。
 * 超える月があれば警告を返す（その月の採掘は0になる）
 */
async function subscriptionWarnings(ctx: GameCtx): Promise<{ warning: string | null; overruns: Overrun[] }> {
  ctx.subs = await ctx.tx.subscription.findMany({ where: { userId: ctx.user.id }, orderBy: { createdAt: "asc" } });
  const overruns = budgetOverruns(budgetPlan(ctx), ctx.now);
  return { warning: overruns.length ? `${describeOverruns(overruns)}。その月の金貨の採掘は0になります` : null, overruns };
}

export async function createSubscription(ctx: GameCtx, body: Body) {
  const sub = await ctx.tx.subscription.create({ data: { ...subscriptionInput(body), userId: ctx.user.id } });
  await syncSpecials(ctx);
  return { id: sub.id, ...(await subscriptionWarnings(ctx)) };
}

export async function updateSubscription(ctx: GameCtx, id: string, body: Body) {
  const sub = await ctx.tx.subscription.findFirst({ where: { id, userId: ctx.user.id } });
  if (!sub) fail("not_found", "サブスクが見つかりません", 404);
  await ctx.tx.subscription.update({ where: { id }, data: subscriptionInput({ ...sub, ...body }) });
  await syncSpecials(ctx);
  return { id, ...(await subscriptionWarnings(ctx)) };
}

export async function deleteSubscription(ctx: GameCtx, id: string) {
  const r = await ctx.tx.subscription.deleteMany({ where: { id, userId: ctx.user.id } });
  if (!r.count) fail("not_found", "サブスクが見つかりません", 404);
  await syncSpecials(ctx);
  return { id };
}

// ---- ほしい物 ----

function wishInput(body: Body) {
  return {
    name: str(body.name, "商品名", { max: 100 }),
    price: int(body.price, "価格", { min: 1, max: 100_000_000 }),
    priority: int(body.priority ?? 2, "優先度", { min: 1, max: 3 }),
    memo: optStr(body.memo, "メモ"),
  };
}

export async function createWish(ctx: GameCtx, body: Body) {
  const w = await ctx.tx.wishItem.create({ data: { ...wishInput(body), userId: ctx.user.id } });
  await syncSpecials(ctx);
  return { id: w.id };
}

async function ownWish(ctx: GameCtx, id: string) {
  const w = await ctx.tx.wishItem.findFirst({ where: { id, userId: ctx.user.id } });
  return w ?? fail("not_found", "ほしい物が見つかりません", 404);
}

export async function updateWish(ctx: GameCtx, id: string, body: Body) {
  const w = await ownWish(ctx, id);
  const input = wishInput({ ...w, ...body });
  await ctx.tx.wishItem.update({ where: { id }, data: input });
  // 価格を積立額より下げたら、超えた分の金貨を返す（価格を超える積立を残さない）
  let returned = 0;
  if (ctx.season && !w.purchasedAt) {
    const reserved = await reservedFor(ctx, id);
    returned = Math.max(0, reserved - input.price);
    if (returned > 0) {
      await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: id, amount: -returned } });
      addCurrency(ctx, "RESERVED", -returned, "wish_price_down", id);
      addCurrency(ctx, "GOLD", returned, "wish_price_down", id);
    }
  }
  await syncSpecials(ctx);
  return { id, returned };
}

export async function deleteWish(ctx: GameCtx, id: string) {
  await ownWish(ctx, id);
  const reserved = await reservedFor(ctx, id);
  if (reserved > 0) {
    addCurrency(ctx, "RESERVED", -reserved, "wish_delete", id);
    addCurrency(ctx, "GOLD", reserved, "wish_delete", id);
  }
  await ctx.tx.wishItem.delete({ where: { id } });
  await syncSpecials(ctx);
  return { id, returned: reserved };
}

/** 金貨の積立（正）・取消（負） */
export async function contributeWish(ctx: GameCtx, id: string, body: Body) {
  requireOpen(ctx);
  const w = await ownWish(ctx, id);
  if (w.purchasedAt) fail("already", "購入済みのほしい物です");
  const amount = int(body.amount, "金貨", { min: -100_000_000, max: 100_000_000 });
  if (amount === 0) fail("invalid", "金貨を入力してください");
  const reserved = await reservedFor(ctx, id);
  if (amount < 0 && -amount > reserved) fail("invalid", `取り消せるのは積立済みの ${reserved}G までです`);
  // 価格を超えて積み立てることはできない
  if (amount > 0 && reserved + amount > w.price) {
    const rest = Math.max(0, w.price - reserved);
    fail("over_price", rest > 0 ? `積み立てられるのはあと ${rest.toLocaleString("ja-JP")}G までです` : "積立はすでに価格に達しています");
  }
  addCurrency(ctx, "GOLD", -amount, amount > 0 ? "wish_contribute" : "wish_withdraw", id);
  addCurrency(ctx, "RESERVED", amount, amount > 0 ? "wish_contribute" : "wish_withdraw", id);
  await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season!.id, wishItemId: id, amount } });
  await syncSpecials(ctx);
  return { reserved: reserved + amount, progress: Math.min(1, (reserved + amount) / w.price) };
}

// ---- 設定 ----

export async function updateSettings(ctx: GameCtx, body: Body) {
  const data: { monthlyBudget?: number; timezone?: string; bondMiningRate?: number } = {};
  if (body.monthlyBudget !== undefined) {
    data.monthlyBudget = int(body.monthlyBudget, "月間自由予算", { max: 10_000_000 });
    // 予算を下げてユーザ通貨（自由予算の内訳）が予算を超える月が出るなら保存しない
    if (data.monthlyBudget < ctx.user.monthlyBudget) {
      const overruns = budgetOverruns(budgetPlan(ctx, { budget: data.monthlyBudget }), ctx.now);
      if (overruns.length) fail("over_budget", `${describeOverruns(overruns)}。ユーザ通貨の発生額を減らすか、予算を見直してください`, 400, { overruns });
    }
  }
  if (body.bondMiningRate !== undefined) {
    const rate = int(body.bondMiningRate, "債券化率", { max: 100 });
    if (rate % 10 !== 0) fail("invalid", "債券化率は10%刻みで選んでください");
    data.bondMiningRate = rate;
  }
  if (body.timezone !== undefined) {
    const tz = str(body.timezone, "タイムゾーン", { max: 64 });
    if (!isValidTimeZone(tz)) fail("invalid", "タイムゾーンが不正です");
    data.timezone = tz;
  }
  // 採掘は変更前の予算・債券化率で現在まで計算済み。ここから新しい設定で採掘する
  ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data });
  return { ok: true };
}

