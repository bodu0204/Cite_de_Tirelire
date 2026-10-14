// ゲーム操作。すべて withGame の中（同期済み・ロック済み）で呼ばれる。
import { Prisma } from "@prisma/client";
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
import { INITIAL_GOLD, INITIAL_SILVER, REWARD_DAILY_CAP, REWARD_PURCHASE, REWARD_SAVINGS } from "@/game/config";
import { fail } from "@/game/errors";
import { quoteResourceExchange, type Currency } from "@/game/exchange";
import { goldMineLevel, silverMineLevel } from "@/game/levels";
import { collect, newMine, refundPurchase, settlePurchase } from "@/game/mine";
import { dayKey, isValidTimeZone, monthKey, parseDateInTz } from "@/game/time";
import { DEFAULT_PRIORITIES, type CityPolicy, type NeedKey, type StockKey } from "@/game/types";
import {
  addCurrency,
  emitFacilityLevels,
  refreshSavings,
  requireSeason,
  syncSpecials,
  type GameCtx,
} from "./game";
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
  ctx.balances = { gold: 0, silver: 0, reserved: 0 };
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
    category: optStr(body.category, "カテゴリ", 50),
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

function settle(ctx: GameCtx, amount: number, refId: string) {
  if (amount <= 0) return;
  const r = settlePurchase(ctx.mine!, ctx.balances.gold, amount);
  ctx.mine = r.mine;
  addCurrency(ctx, "GOLD", -r.fromHeld, "purchase_settle", refId);
}

function refund(ctx: GameCtx, amount: number, refId: string) {
  if (amount <= 0) return;
  const r = refundPurchase(ctx.mine!, amount);
  ctx.mine = r.mine;
  addCurrency(ctx, "GOLD", r.toHeld, "purchase_refund", refId);
}

async function reservedFor(ctx: GameCtx, wishItemId: string): Promise<number> {
  if (!ctx.season) return 0;
  const agg = await ctx.tx.wishContribution.aggregate({ where: { seasonId: ctx.season.id, wishItemId }, _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}

export async function recordPurchase(ctx: GameCtx, body: Body) {
  const input = purchaseInput(body);
  const wishItemId = body.wishItemId ? str(body.wishItemId, "ほしい物") : null;
  const wish = wishItemId ? await ctx.tx.wishItem.findFirst({ where: { id: wishItemId, userId: ctx.user.id } }) : null;
  if (wishItemId && !wish) fail("not_found", "ほしい物が見つかりません", 404);
  if (wish?.purchasedAt) fail("already", "このほしい物は購入済みです");

  const purchase = await ctx.tx.purchase.create({
    data: { ...input, userId: ctx.user.id, seasonId: ctx.season?.id ?? null, wishItemId },
  });
  let reservedApplied = 0;
  let settledAmount = 0;
  if (ctx.season && settleable(ctx, input)) {
    // 像の積立金貨を先に購入額へ充当する（二重計上しない）
    if (wish) {
      reservedApplied = Math.min(await reservedFor(ctx, wish.id), input.amount);
      if (reservedApplied > 0) {
        await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: wish.id, amount: -reservedApplied } });
        addCurrency(ctx, "RESERVED", -reservedApplied, "wish_purchase", purchase.id);
      }
    }
    settledAmount = input.amount - reservedApplied;
    settle(ctx, settledAmount, purchase.id);
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
  return { id: purchase.id, reward, settled: settledAmount, reservedApplied };
}

async function ownPurchase(ctx: GameCtx, id: string) {
  const p = await ctx.tx.purchase.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
  return p ?? fail("not_found", "購入記録が見つかりません", 404);
}

/** 精算済みの額を新しい目標額に合わせる。締めた月・別シーズンの記録は精算し直さない */
async function resettle(ctx: GameCtx, p: Awaited<ReturnType<typeof ownPurchase>>, target: number) {
  if (!ctx.season || p.seasonId !== ctx.season.id || !ctx.mine) return null;
  if (p.settledMonth && p.settledMonth !== ctx.mine.monthKey) return null;
  const delta = target - p.settledAmount;
  if (delta > 0) settle(ctx, delta, p.id);
  if (delta < 0) refund(ctx, -delta, p.id);
  return { settledAmount: target, settledMonth: target > 0 ? ctx.mine.monthKey : null };
}

export async function editPurchase(ctx: GameCtx, id: string, body: Body) {
  const p = await ownPurchase(ctx, id);
  const input = purchaseInput({ ...p, ...body });
  const target = settleable(ctx, input) ? Math.max(0, input.amount - p.reservedApplied) : 0;
  const s = await resettle(ctx, p, target);
  await ctx.tx.purchase.update({ where: { id }, data: { ...input, ...(s ?? {}) } });
  // 編集では報酬を再付与しない
  return { id };
}

export async function deletePurchase(ctx: GameCtx, id: string) {
  const p = await ownPurchase(ctx, id);
  const s = await resettle(ctx, p, 0);
  if (s && p.reservedApplied > 0 && p.wishItemId && ctx.season) {
    await ctx.tx.wishContribution.create({ data: { seasonId: ctx.season.id, wishItemId: p.wishItemId, amount: p.reservedApplied } });
    addCurrency(ctx, "RESERVED", p.reservedApplied, "wish_purchase_undo", p.id);
  }
  await ctx.tx.purchase.update({ where: { id }, data: { deletedAt: new Date(ctx.now), ...(s ?? {}), reservedApplied: s ? 0 : p.reservedApplied } });
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

export function exchange(ctx: GameCtx, body: Body) {
  requireOpen(ctx);
  const kind = oneOf(body.kind, ["gold_to_silver", "to_resource"] as const, "交換の種類");
  const amount = int(body.amount, "交換量", { min: 1, max: 10_000_000 });
  if (kind === "gold_to_silver") {
    // 金貨→銀貨は無料（銀貨不足で操作不能にならないように）
    addCurrency(ctx, "GOLD", -amount, "exchange_g2s");
    addCurrency(ctx, "SILVER", amount, "exchange_g2s");
    return { gold: -amount, silver: amount };
  }
  const currency = oneOf(body.currency, ["gold", "silver"] as const, "通貨") as Currency;
  const resource = oneOf(body.resource, ["wood", "stone", "food"] as const, "資源") as StockKey;
  const q = quoteResourceExchange(currency, resource, amount, facilityLevels(ctx));
  if (q.gain <= 0) fail("too_small", "交換量が少なすぎます");
  addCurrency(ctx, "SILVER", -q.silverCost, "exchange_resource");
  addCurrency(ctx, "GOLD", -q.goldCost, "exchange_resource");
  ctx.city!.stock[resource] += q.gain;
  // 金貨（1G＝1円相当）をゲーム内で使った分は、現実で使わずに済んだお金＝見込み貯金
  if (q.goldCost > 0) ctx.seasonPatch.estimatedSavings = { increment: q.goldCost };
  return { ...q, estimatedAdded: q.goldCost };
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

export async function createSubscription(ctx: GameCtx, body: Body) {
  const sub = await ctx.tx.subscription.create({ data: { ...subscriptionInput(body), userId: ctx.user.id } });
  await syncSpecials(ctx);
  return { id: sub.id };
}

export async function updateSubscription(ctx: GameCtx, id: string, body: Body) {
  const sub = await ctx.tx.subscription.findFirst({ where: { id, userId: ctx.user.id } });
  if (!sub) fail("not_found", "サブスクが見つかりません", 404);
  await ctx.tx.subscription.update({ where: { id }, data: subscriptionInput({ ...sub, ...body }) });
  await syncSpecials(ctx);
  return { id };
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
  const data: { monthlyBudget?: number; timezone?: string } = {};
  if (body.monthlyBudget !== undefined) data.monthlyBudget = int(body.monthlyBudget, "月間自由予算", { max: 10_000_000 });
  if (body.timezone !== undefined) {
    const tz = str(body.timezone, "タイムゾーン", { max: 64 });
    if (!isValidTimeZone(tz)) fail("invalid", "タイムゾーンが不正です");
    data.timezone = tz;
  }
  // 採掘は変更前の予算で現在まで計算済み。ここから新しい予算で採掘する
  ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data });
  return { ok: true };
}

