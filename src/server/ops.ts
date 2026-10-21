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
import { INITIAL_GOLD, INITIAL_SILVER, REWARD_DAILY_CAP, REWARD_PURCHASE, REWARD_SAVINGS, SAVINGS_DAILY_LIMIT } from "@/game/config";
import { fail } from "@/game/errors";
import { canExchange, quoteNeedsExchange, quoteResourceExchange, totalGains, ZERO_GAINS, type Currency } from "@/game/exchange";
import { budgetOverruns, describeOverruns, startOfDay, type Overrun } from "@/game/currency";
import { goldMineLevel, silverMineLevel } from "@/game/levels";
import { collect, newMine } from "@/game/mine";
import { lotOrder, pay, summarize, type Lot, type Payment } from "@/game/settle";
import { changePayday, dayKey, isValidTimeZone, parseDateInTz, periodKey } from "@/game/time";
import { DEFAULT_PRIORITIES, type CityPolicy, type Gains, type NeedKey, type StockKey } from "@/game/types";
import {
  addCurrency,
  budgetPlan,
  calOf,
  erasJson,
  emitFacilityLevels,
  facilityLevels,
  requireSeason,
  syncSpecials,
  tagLedger,
  withPurse,
  type GameCtx,
} from "./game";
import { resolveCategory } from "./categories";
import { resolveDiff } from "./resolve";
import { bool, date, int, oneOf, optDate, optStr, str } from "./validate";

export { facilityLevels };

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
  const mine = newMine(ctx.now, ctx.cal);
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
  ctx.citySpent = 0;
  ctx.grants = [];
  ctx.cuts = [];
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

export async function grantReward(ctx: GameCtx, recordKey: string, base: number): Promise<number> {
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

/** 金鉱で精算する対象か：進行中シーズン・サブスク以外・当期（収入期間）の購入 */
function settleable(ctx: GameCtx, p: { date: string; isSubscription: boolean }) {
  if (!ctx.mine || p.isSubscription) return false;
  const at = parseDateInTz(p.date, ctx.user.timezone);
  return at !== null && periodKey(at, ctx.cal) === ctx.mine.monthKey;
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

async function savePayments(ctx: GameCtx, purchaseId: string, payments: Payment[]) {
  await ctx.tx.purchasePayment.deleteMany({ where: { purchaseId } });
  const rows = payments.filter((x) => x.amount !== 0);
  if (!rows.length) return;
  // id の並びが支払いの順
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

/** サブスクの支払い（どのサブスクの何期間分か）。同じサブスク・同じ期間は1件だけ */
async function subscriptionFor(ctx: GameCtx, body: Body) {
  if (!body.subscriptionId) return null;
  const sub = await ctx.tx.subscription.findFirst({ where: { id: str(body.subscriptionId, "サブスク"), userId: ctx.user.id } });
  if (!sub) fail("not_found", "サブスクが見つかりません", 404);
  const key = str(body.periodKey, "対象の期間", { max: 7 });
  if (!/^\d{4}-\d{2}$/.test(key)) fail("invalid", "対象の期間が不正です");
  const dup = await ctx.tx.purchase.findFirst({ where: { subscriptionId: sub!.id, periodKey: key, deletedAt: null } });
  if (dup) fail("already", "この期間の支払いは記録済みです", 409);
  return { sub: sub!, periodKey: key };
}

/**
 * 支出の記録（docs/record-input-redesign.md §6）。
 * - 普通の支出：精算順（ユーザ通貨 → 未回収 → 所持金貨 → 債券＋手数料）で払う
 * - サブスクの支払い：登録額（ベース）は採掘から差し引き済みなので精算しない。登録額との差を差分として解消する
 * - ほしい物：価格（ベース）を 像の積立金貨 → 精算順 で払い、価格との差を差分として解消する（余った積立も債券 → おまかせ交換へ）
 */
export async function recordPurchase(ctx: GameCtx, body: Body) {
  const subPay = await subscriptionFor(ctx, body);
  const wish = await wishFor(ctx, body);
  const input = purchaseInput(subPay ? { ...body, name: body.name ?? subPay.sub.name, isSubscription: true } : wish ? { ...body, name: body.name ?? wish.name } : body);
  const cat = await resolveCategory(ctx, body);
  const baseAmount = subPay ? subPay.sub.amount : wish ? wish.price : null;

  const purchase = await ctx.tx.purchase.create({
    data: {
      ...input,
      ...cat,
      userId: ctx.user.id,
      seasonId: ctx.season?.id ?? null,
      wishItemId: wish?.id ?? null,
      subscriptionId: subPay?.sub.id ?? null,
      periodKey: subPay?.periodKey ?? null,
      baseAmount,
    },
  });
  let reservedApplied = 0;
  let settledAmount = 0;
  const payments: Payment[] = [];
  // 精算するのはベース（ほしい物は価格、普通の支出は金額）
  const settleBase = wish ? wish.price : input.amount;
  if (ctx.season && settleable(ctx, input)) {
    // 像の積立金貨を先に充当する（二重計上しない）
    if (wish) {
      reservedApplied = Math.min(await reservedFor(ctx, wish.id), settleBase);
      if (reservedApplied > 0) {
        await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: wish.id, amount: -reservedApplied } });
        addCurrency(ctx, "RESERVED", -reservedApplied, "wish_purchase", purchase.id);
        payments.push({ currency: "RESERVED", kind: "pay", amount: reservedApplied });
      }
    }
    settledAmount = settleBase - reservedApplied;
    settle(ctx, settledAmount, cat.categoryId, payments, purchase.id);
    await savePayments(ctx, purchase.id, payments);
    await ctx.tx.purchase.update({
      where: { id: purchase.id },
      data: { settledAmount, settledMonth: ctx.mine!.monthKey, reservedApplied },
    });
  }
  // ベースとの差：安ければ＋差分、高ければ−差分
  const resolution = baseAmount !== null ? await resolveDiff(ctx, baseAmount - input.amount, { type: "purchase", id: purchase.id }) : null;
  if (wish) {
    await ctx.tx.wishItem.update({ where: { id: wish.id }, data: { purchasedAt: new Date(ctx.now), purchaseId: purchase.id } });
    await syncSpecials(ctx);
  }
  const reward = await grantReward(ctx, `purchase:${purchase.id}`, REWARD_PURCHASE);
  return { id: purchase.id, reward, settled: settledAmount, reservedApplied, payment: summarize(payments), resolution };
}

/** 支出の記録（items で一括保存） */
export async function recordPurchases(ctx: GameCtx, body: Body) {
  if (!Array.isArray(body.items)) return recordPurchase(ctx, body);
  if (body.items.length > 50) fail("invalid", "一括保存は50件までです");
  const items = [];
  for (const item of body.items as Body[]) items.push(await recordPurchase(ctx, item));
  return { items };
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
 * 支出の金額だけを変える（docs/record-input-redesign.md §9.3）。最初の精算はそのまま残し、変化分を差分として解消する：
 * 減額は＋差分（債券 → おまかせ交換）、増額は−差分（債券＋手数料）。金額 0 は取り消し（記録は残る）。
 * 日付・名称・ジャンルなどは変えられない。
 */
export async function editPurchase(ctx: GameCtx, id: string, body: Body) {
  const p = await ownPurchase(ctx, id);
  const extra = Object.keys(body).filter((k) => k !== "amount");
  if (extra.length) fail("invalid", "登録した支出は金額だけ変更できます");
  const amount = int(body.amount, "金額", { min: 0, max: 100_000_000 });
  if (amount === p.amount) return { id, resolution: null };
  // 別のシーズンの記録は家計履歴だけ直す
  const resolution = p.seasonId && p.seasonId === ctx.season?.id ? await resolveDiff(ctx, p.amount - amount, { type: "purchase", id }, { before: p.amount, after: amount }) : null;
  await ctx.tx.purchase.update({ where: { id }, data: { amount } });
  // 編集では報酬を再付与しない
  return { id, resolution };
}

function savingsInput(body: Body) {
  return {
    kind: oneOf(body.kind, ["DEPOSIT", "WITHDRAW"] as const, "記録種別"),
    amount: int(body.amount, "貯金額", { min: 1, max: 100_000_000 }),
    date: date(body.date, "記録日"),
    memo: optStr(body.memo, "メモ"),
  };
}

/** 貯金管理の1日の登録回数（ユーザーのタイムゾーンの暦日。削除しても戻らない） */
export async function savingsCountToday(ctx: GameCtx) {
  const start = startOfDay(ctx.now, ctx.user.timezone);
  return ctx.tx.savingsTransaction.count({ where: { userId: ctx.user.id, createdAt: { gte: new Date(start) } } });
}

/**
 * 貯金管理：手元の財布と別口座の間の出し入れ（docs/record-input-redesign.md §7.2）。
 * 判定（技術Lv・銀行Lv・目標）には使わず、通貨も動かさない。手元のお金の推測（E5）と履歴に使う。1日3回まで。
 */
export async function recordSavings(ctx: GameCtx, body: Body) {
  const input = savingsInput(body);
  if ((await savingsCountToday(ctx)) >= SAVINGS_DAILY_LIMIT) fail("daily_limit", `貯金管理の登録は1日${SAVINGS_DAILY_LIMIT}回までです`, 429);
  const tx = await ctx.tx.savingsTransaction.create({ data: { ...input, userId: ctx.user.id, seasonId: ctx.season?.id ?? null } });
  const reward = await grantReward(ctx, `savings:${tx.id}`, REWARD_SAVINGS);
  return { id: tx.id, reward };
}

async function ownSavings(ctx: GameCtx, id: string) {
  const s = await ctx.tx.savingsTransaction.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
  return s ?? fail("not_found", "貯金記録が見つかりません", 404);
}

export async function editSavings(ctx: GameCtx, id: string, body: Body) {
  const s = await ownSavings(ctx, id);
  const input = savingsInput({ ...s, ...body });
  await ctx.tx.savingsTransaction.update({ where: { id }, data: input });
  return { id };
}

export async function deleteSavings(ctx: GameCtx, id: string) {
  await ownSavings(ctx, id);
  await ctx.tx.savingsTransaction.update({ where: { id }, data: { deletedAt: new Date(ctx.now) } });
  return { id };
}

// ---- 資源交換 ----

const RESOURCES: StockKey[] = ["wood", "stone", "food"];

/** 交換で街に入れる資源と都市資金（ゲーム内のおまかせ交換と同じ量。docs/needs-based-exchange.md §5・§6・§13） */
function addStock(ctx: GameCtx, gains: Gains) {
  for (const k of RESOURCES) ctx.city!.stock[k] += gains[k];
  ctx.city!.treasury += gains.treasury;
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
  const resource = oneOf(body.resource, [...RESOURCES, "treasury", "auto"] as const, "資源");
  if (resource !== "auto" && !canExchange(currency, resource)) fail("invalid", "都市資金は金貨でだけ交換できます");
  const lv = facilityLevels(ctx);
  // おまかせ：都市の必要資源の割合で振り分ける（手数料は1回分）
  const q =
    resource === "auto"
      ? quoteNeedsExchange(currency, amount, cityNeeds(ctx.city!).needs, lv)
      : (() => {
          const one = quoteResourceExchange(currency, resource, amount, lv);
          const gains: Gains = { ...ZERO_GAINS };
          gains[resource] = one.gain;
          return { ...one, gains };
        })();
  const gain = totalGains(q.gains);
  if (gain <= 0) fail("too_small", "交換量が少なすぎます");
  addCurrency(ctx, "SILVER", -q.silverCost, "exchange_resource");
  addCurrency(ctx, "GOLD", -q.goldCost, "exchange_resource");
  addStock(ctx, q.gains);
  // 金貨（1G＝1円相当）をゲーム内で使った分は、現実で使わずに済んだお金＝見込み貯金
  if (q.goldCost > 0) ctx.citySpent += q.goldCost;
  return { ...q, gain, citySpentAdded: q.goldCost };
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
  const data: { monthlyBudget?: number; timezone?: string; bondMiningRate?: number; incomeDay?: number; incomeEras?: Prisma.InputJsonValue } = {};
  if (body.incomeDay !== undefined) {
    // 収入日は次の収入日から効く。今の期間はそこまで延ばす・縮める（docs/record-input-redesign.md §5.1 IN-06）
    data.incomeDay = int(body.incomeDay, "収入日", { min: 1, max: 31 });
    ctx.cal = changePayday(ctx.cal, data.incomeDay, ctx.now);
    data.incomeEras = erasJson(ctx.cal) as unknown as Prisma.InputJsonValue;
  }
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
  ctx.cal = calOf(ctx.user);
  return { ok: true };
}

const CHECK_KEYS = ["E1", "E2", "E3a", "E3b", "E4a", "E4b", "E5"] as const;

/** 手元のお金の推測のチェックの状態を保存する（前回の設定を引き継ぐ） */
export async function saveEstimateChecks(ctx: GameCtx, body: Body) {
  const raw = (body.checks ?? {}) as Record<string, unknown>;
  const checks = Object.fromEntries(CHECK_KEYS.map((k) => [k, raw[k] === true]));
  ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data: { estimateChecks: checks } });
  return { checks };
}

