// 収入の記録（docs/record-input-redesign.md §5）。
// 月の収入：雛形（B と通貨配分設定）の分はこれまでどおり採掘・ユーザ通貨の発生で配当し、雛形との差分だけをここで配当する。
//   ＋差分は振り分け（初期値は通貨配分設定の割合）、−差分は当期の未配当分（残りの採掘 → ユーザ通貨の未発生分）から減らし、足りなければ債券。
// 臨時の収入：全額を振り分ける（初期値は即時貯蓄＝債券 → おまかせ交換）。
import type { Income } from "@prisma/client";
import { cityNeeds } from "@/game/city/sim";
import { FEE_EXCHANGE, MICRO_PER_GOLD, REWARD_PURCHASE } from "@/game/config";
import { dayEvents, minuteRule, monthDayTotal, shiftDays, startOfDay, validWindow, type CurrencyDefLite } from "@/game/currency";
import { fail } from "@/game/errors";
import { quoteNeedsExchange } from "@/game/exchange";
import { applyGrant, type Grant } from "@/game/idle";
import { floorMinute, remainingMining, windowMinedBy } from "@/game/mine";
import { dayKey, parseDateInTz, periodKey, periodRange } from "@/game/time";
import type { Gains } from "@/game/types";
import { addCurrency, budgetPlan, facilityLevels, newLotId, requireSeason, withPurse, type GameCtx } from "./game";
import { grantReward } from "./ops";
import { previewShortfall, previewSurplus, resolveShortfall, resolveSurplus, type ResolutionView } from "./resolve";
import { bool, date, int, oneOf, optStr, str } from "./validate";

type Body = Record<string, unknown>;

export type AllocCurrency = "SAVE" | "GOLD" | "BOND" | "CUSTOM";

/** 振り分けの1行（§5.5）。dates・rangeStart・rangeEnd は "YYYY-MM-DD"（範囲は両端を含む） */
export interface AllocationRow {
  currency: AllocCurrency;
  currencyId?: string | null;
  amount: number;
  when: "now" | "dates" | "range";
  dates?: string[];
  rangeStart?: string;
  rangeEnd?: string;
  how: "lump" | "daily" | "minute";
}

export type Preset = "save" | "gold" | "ratio";

export interface PeriodInfo {
  key: string;
  start: number;
  end: number;
}

const MAX_ROWS = 20;
const MAX_GRANTS = 400;

/** シーズン開始の期間から当期までの収入期間 */
export function seasonPeriods(ctx: GameCtx): PeriodInfo[] {
  requireSeason(ctx);
  const out: PeriodInfo[] = [];
  let t = periodRange(ctx.season.startedAt.getTime(), ctx.cal).start;
  while (t <= ctx.now && out.length < 240) {
    const r = periodRange(t, ctx.cal);
    out.push({ key: periodKey(r.start, ctx.cal), start: r.start, end: r.end });
    t = r.end;
  }
  return out;
}

const currentPeriod = (ctx: GameCtx): PeriodInfo => {
  const r = periodRange(ctx.now, ctx.cal);
  return { key: periodKey(ctx.now, ctx.cal), ...r };
};

/** その期間にユーザ通貨が発生する額（日の発生 ＋ 毎分ルールの月あたりの量） */
function periodIssue(ctx: GameCtx, def: CurrencyDefLite, p: PeriodInfo): number {
  const w = validWindow(def, ctx.user.timezone);
  const minute = w.startAt < p.end && (w.endAt === null || w.endAt > p.start) ? minuteRule(def) : 0;
  return monthDayTotal(def, p.start, p.end, ctx.user.timezone) + minute;
}

/**
 * プリセットの振り分け（§5.5 の表）。
 * ratio：額 × その期間の各ユーザ通貨の発生額 ÷ B をその通貨の残りの発生日に、残りを金貨としてその期間の終わりまで毎分（過去の期間は即時。債券化率の分は債券）。
 */
export function presetRows(ctx: GameCtx, preset: Preset, amount: number, period: PeriodInfo | null): AllocationRow[] {
  if (amount <= 0) return [];
  if (preset === "save") return [{ currency: "SAVE", amount, when: "now", how: "lump" }];
  if (preset === "gold") return [{ currency: "GOLD", amount, when: "now", how: "lump" }];
  const p = period ?? currentPeriod(ctx);
  const tz = ctx.user.timezone;
  const live = p.end > ctx.now;
  const budget = ctx.user.monthlyBudget;
  const rows: AllocationRow[] = [];
  let rest = amount;
  if (budget > 0) {
    for (const def of ctx.defs) {
      const share = Math.floor((amount * periodIssue(ctx, def, p)) / budget);
      if (share <= 0) continue;
      const dates = live ? dayEvents(def, ctx.now, p.end - 1, tz).map((e) => dayKey(e.at, tz)) : [];
      rows.push(dates.length ? { currency: "CUSTOM", currencyId: def.id, amount: share, when: "dates", dates, how: "lump" } : { currency: "CUSTOM", currencyId: def.id, amount: share, when: "now", how: "lump" });
      rest -= share;
    }
  }
  if (rest > 0) {
    if (live) {
      rows.push({ currency: "GOLD", amount: rest, when: "range", rangeStart: dayKey(ctx.now, tz), rangeEnd: dayKey(p.end - 1, tz), how: "minute" });
    } else {
      const bond = Math.floor((rest * ctx.user.bondMiningRate) / 100);
      if (bond > 0) rows.push({ currency: "BOND", amount: bond, when: "now", how: "lump" });
      if (rest - bond > 0) rows.push({ currency: "GOLD", amount: rest - bond, when: "now", how: "lump" });
    }
  }
  return rows;
}

/** 振り分けの行を検証する。合計は total と一致させる */
function parseRows(ctx: GameCtx, v: unknown, total: number): AllocationRow[] {
  if (!Array.isArray(v)) fail("invalid", "振り分けが不正です");
  if ((v as unknown[]).length > MAX_ROWS) fail("invalid", `振り分けは${MAX_ROWS}行までです`);
  const rows = (v as Record<string, unknown>[]).map((r): AllocationRow => {
    const currency = oneOf(r.currency, ["SAVE", "GOLD", "BOND", "CUSTOM"] as const, "振り分けの通貨");
    const amount = int(r.amount, "振り分けの量", { min: 0, max: 100_000_000 });
    const when = currency === "SAVE" ? "now" : oneOf(r.when ?? "now", ["now", "dates", "range"] as const, "振り分けの時期");
    const how = oneOf(r.how ?? "lump", ["lump", "daily", "minute"] as const, "振り分けの方法");
    const row: AllocationRow = { currency, amount, when, how };
    if (currency === "CUSTOM") {
      const id = str(r.currencyId, "ユーザ通貨");
      if (!ctx.defs.some((d) => d.id === id)) fail("not_found", "ユーザ通貨が見つかりません", 404);
      row.currencyId = id;
    }
    if (when === "dates") {
      if (!Array.isArray(r.dates) || r.dates.length === 0) fail("invalid", "振り分けの日付を1つ以上選んでください");
      row.dates = [...new Set((r.dates as unknown[]).map((d) => date(d, "振り分けの日付")))].sort();
    }
    if (when === "range") {
      row.rangeStart = date(r.rangeStart, "振り分けの開始日");
      row.rangeEnd = date(r.rangeEnd, "振り分けの終了日");
      if (row.rangeEnd < row.rangeStart) fail("invalid", "振り分けの終了日は開始日より後にしてください");
    }
    return row;
  });
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  if (sum !== total) fail("invalid", `振り分けの合計（${sum.toLocaleString("ja-JP")}円）を ${total.toLocaleString("ja-JP")}円 にしてください`);
  return rows.filter((r) => r.amount > 0);
}

/** amount を n 回に均等に分ける（端数は最後に寄せる） */
function evenly(amount: number, n: number): number[] {
  const each = Math.floor(amount / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? amount - each * (n - 1) : each));
}

/** 行の入る時刻と額（minute の金貨は区間で入れるので別） */
function rowSchedule(ctx: GameCtx, row: AllocationRow): { at: number; amount: number }[] {
  const tz = ctx.user.timezone;
  if (row.when === "now") return [{ at: ctx.now, amount: row.amount }];
  if (row.when === "dates") {
    const ats = row.dates!.map((d) => parseDateInTz(d, tz)!);
    return evenly(row.amount, ats.length).map((amount, i) => ({ at: ats[i], amount }));
  }
  const s = parseDateInTz(row.rangeStart!, tz)!;
  if (row.how === "lump") return [{ at: s, amount: row.amount }];
  const days: number[] = [];
  for (let t = s; t <= parseDateInTz(row.rangeEnd!, tz)! && days.length < MAX_GRANTS; t = shiftDays(t, 1, tz)) days.push(t);
  return evenly(row.amount, days.length).map((amount, i) => ({ at: days[i], amount }));
}

/** 通貨に今すぐ入れる（金貨・債券・ユーザ通貨） */
function grantNow(ctx: GameCtx, g: Pick<Grant, "currency" | "currencyId" | "amount" | "dividend">) {
  const def = ctx.defs.find((d) => d.id === g.currencyId);
  const tz = ctx.user.timezone;
  withPurse(ctx, (p) =>
    applyGrant(p, { ...g, at: ctx.now }, def, ctx.cal, (d, at, amount) => {
      const issuedAt = startOfDay(at, tz);
      const expiresAt = d.remainder === "TO_BOND" && d.remainderDays ? shiftDays(issuedAt, d.remainderDays, tz) : null;
      ctx.lots.push({ id: newLotId(), currencyId: d.id, issuedAt, expiresAt, amount, remaining: amount, isNew: true });
      p.moves.push({ currency: "CUSTOM", delta: amount, reason: "income_grant", currencyId: d.id });
      if (g.dividend) p.mine.dividend = (p.mine.dividend ?? 0n) + BigInt(amount) * MICRO_PER_GOLD;
    }),
  );
}

/**
 * 振り分けを実行する。即時の分は今入れ、先の日付は予約し、毎分の金貨は採掘に上乗せする。
 * 戻り値は即時に入った金貨（おまかせで資源を買う対象）と、即時貯蓄の解消。
 */
async function executeRows(ctx: GameCtx, income: Income, rows: AllocationRow[], dividend: boolean) {
  requireSeason(ctx);
  let goldNow = 0;
  const saved: ResolutionView[] = [];
  const tz = ctx.user.timezone;
  for (const row of rows) {
    if (row.currency === "SAVE") {
      saved.push(await resolveSurplus(ctx, row.amount, { type: "income", id: income.id }));
      continue;
    }
    const currency = row.currency;
    if (row.when === "range" && row.how === "minute" && currency === "GOLD") {
      const start = Math.max(floorMinute(parseDateInTz(row.rangeStart!, tz)!), ctx.mine.lastAccrualAt);
      const end = shiftDays(parseDateInTz(row.rangeEnd!, tz)!, 1, tz);
      if (end > start) {
        ctx.mine.windows = [...(ctx.mine.windows ?? []), { incomeId: income.id, dividend, start, end, total: BigInt(row.amount) * MICRO_PER_GOLD }];
        continue;
      }
    }
    const later: { at: number; amount: number }[] = [];
    for (const x of rowSchedule(ctx, row)) {
      if (x.amount <= 0) continue;
      if (x.at <= ctx.now) {
        grantNow(ctx, { currency, currencyId: row.currencyId, amount: x.amount, dividend });
        if (currency === "GOLD") goldNow += x.amount;
      } else later.push(x);
    }
    if (later.length) {
      await ctx.tx.scheduledGrant.createMany({
        data: later.map((x) => ({ seasonId: ctx.season!.id, incomeId: income.id, at: new Date(x.at), currency, currencyId: row.currencyId ?? null, amount: x.amount, dividend })),
      });
    }
  }
  return { goldNow, saved };
}

/** 即時に入った金貨をおまかせ交換する（手数料 5S、銀貨が足りなければなし。都市に使った金貨に数える） */
function autoExchange(ctx: GameCtx, gold: number, refId: string): Gains | null {
  if (gold <= 0) return null;
  const fee = ctx.balances.silver >= FEE_EXCHANGE;
  const q = quoteNeedsExchange("gold", gold, cityNeeds(ctx.city!).needs, facilityLevels(ctx), { fee });
  addCurrency(ctx, "GOLD", -gold, "exchange_resource", refId);
  addCurrency(ctx, "SILVER", -q.silverCost, "exchange_resource", refId);
  for (const k of ["wood", "stone", "food"] as const) ctx.city!.stock[k] += q.gains[k];
  ctx.city!.treasury += q.gains.treasury;
  ctx.citySpent += gold;
  return q.gains;
}

/** 当期の未配当分（残りの採掘・ユーザ通貨の未発生分）のうち、まだ減らしていない額 */
function undistributed(ctx: GameCtx, p: PeriodInfo) {
  requireSeason(ctx);
  const plan = budgetPlan(ctx);
  const mining = Number(remainingMining(ctx.mine, plan, ctx.cal, ctx.mine.lastAccrualAt).natural / MICRO_PER_GOLD);
  const len = p.end - p.start;
  const custom = ctx.defs.map((def) => {
    const w = validWindow(def, ctx.user.timezone);
    const minuteEnd = Math.min(p.end, w.endAt ?? Infinity);
    const minuteFrom = Math.max(ctx.now, w.startAt);
    const minute = minuteEnd > minuteFrom ? Math.floor((minuteRule(def) * (minuteEnd - minuteFrom)) / len) : 0;
    const days = dayEvents(def, ctx.now, p.end - 1, ctx.user.timezone).reduce((a, e) => a + e.amount, 0);
    const cut = ctx.cuts.filter((c) => c.currencyId === def.id && c.periodKey === p.key).reduce((a, c) => a + c.remaining, 0);
    return { currencyId: def.id, amount: Math.max(0, minute + days - cut) };
  });
  return { mining, custom };
}

/** −差分の内訳のプレビュー：未配当分から減らす額と、債券から減らす額 */
function planReduction(ctx: GameCtx, d: number, monthKey: string | null) {
  let rest = d;
  let cutMining = 0;
  const cutCustom: { currencyId: string; amount: number }[] = [];
  const p = currentPeriod(ctx);
  if (monthKey !== null && monthKey === p.key) {
    const u = undistributed(ctx, p);
    cutMining = Math.min(rest, u.mining);
    rest -= cutMining;
    for (const c of u.custom) {
      const take = Math.min(rest, c.amount);
      if (take > 0) cutCustom.push({ currencyId: c.currencyId, amount: take });
      rest -= take;
    }
  }
  return { cutMining, cutCustom, bond: rest, periodKey: p.key };
}

/** 月の収入の−差分：当期の未配当分から減らし、足りない分は債券（手数料あり） */
async function reduceUndistributed(ctx: GameCtx, d: number, monthKey: string | null, ref: { type: "income"; id: string }, edit?: { before: number; after: number }, canceled = 0) {
  requireSeason(ctx);
  const plan = planReduction(ctx, d, monthKey);
  if (plan.cutMining > 0) ctx.mine.cut = (ctx.mine.cut ?? 0n) + BigInt(plan.cutMining) * MICRO_PER_GOLD;
  for (const c of plan.cutCustom) {
    const cur = ctx.cuts.find((x) => x.currencyId === c.currencyId && x.periodKey === plan.periodKey);
    if (cur) cur.remaining += c.amount;
    else ctx.cuts.push({ currencyId: c.currencyId, periodKey: plan.periodKey, remaining: c.amount });
  }
  const cutCustom = plan.cutCustom.reduce((a, c) => a + c.amount, 0);
  return resolveShortfall(ctx, plan.bond, ref, edit, { total: d + canceled, cutMining: plan.cutMining, cutCustom, canceled });
}

/** 予約中の振り分け・採掘への上乗せから減らす（その記録の未配当分。新しい予約から） */
async function cancelPending(ctx: GameCtx, incomeId: string, d: number): Promise<number> {
  requireSeason(ctx);
  let rest = d;
  const pending = await ctx.tx.scheduledGrant.findMany({ where: { incomeId, grantedAt: null, canceled: false, at: { gt: new Date(ctx.now) } }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  for (const g of pending) {
    if (rest <= 0) break;
    const take = Math.min(rest, g.amount);
    rest -= take;
    await ctx.tx.scheduledGrant.update({ where: { id: g.id }, data: take === g.amount ? { canceled: true } : { amount: g.amount - take } });
  }
  const t = ctx.mine.lastAccrualAt;
  ctx.mine.windows = (ctx.mine.windows ?? []).map((w) => {
    if (w.incomeId !== incomeId || rest <= 0) return w;
    // これから入る分だけを残した区間に置き換える（入った分は採掘済み）
    const remain = w.total - windowMinedBy(w, t);
    const take = BigInt(Math.min(rest, Number(remain / MICRO_PER_GOLD)));
    rest -= Number(take);
    return { ...w, start: Math.max(w.start, t), total: remain - take * MICRO_PER_GOLD };
  });
  return d - rest;
}

// ---- 一覧・雛形 ----

/** 未記録の期間の一覧（ベースは今の B）と、記録済みの収入 */
export async function incomeBase(ctx: GameCtx) {
  if (!ctx.season) return { periods: [], budget: ctx.user.monthlyBudget, current: null };
  const recorded = new Set(
    (await ctx.tx.income.findMany({ where: { userId: ctx.user.id, kind: "MONTHLY" }, select: { monthKey: true } })).map((i) => i.monthKey),
  );
  const cur = currentPeriod(ctx);
  const tz = ctx.user.timezone;
  return {
    budget: ctx.user.monthlyBudget,
    current: cur.key,
    periods: seasonPeriods(ctx)
      .filter((p) => !recorded.has(p.key))
      .map((p) => ({ key: p.key, startDate: dayKey(p.start, tz), endDate: dayKey(p.end - 1, tz), base: ctx.user.monthlyBudget, current: p.key === cur.key })),
  };
}

/** 記録済みの収入（解消の内訳と予約中の振り分けつき） */
export async function listIncomes(ctx: GameCtx) {
  const items = await ctx.tx.income.findMany({ where: { userId: ctx.user.id }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 500 });
  const ids = items.map((i) => i.id);
  const [resolutions, grants] = await Promise.all([
    ctx.tx.resolution.findMany({ where: { refType: "income", refId: { in: ids } }, orderBy: { createdAt: "asc" } }),
    ctx.tx.scheduledGrant.findMany({ where: { incomeId: { in: ids }, grantedAt: null, canceled: false }, orderBy: { at: "asc" } }),
  ]);
  return {
    items: items.map((i) => ({
      ...i,
      resolutions: resolutions.filter((r) => r.refId === i.id),
      pending: grants.filter((g) => g.incomeId === i.id).map((g) => ({ at: g.at.getTime(), currency: g.currency, currencyId: g.currencyId, amount: g.amount })),
    })),
  };
}

// ---- 記録 ----

function monthlyName(key: string) {
  return `${Number(key.slice(5, 7))}月の月収`;
}

async function recordMonthly(ctx: GameCtx, body: Body) {
  requireSeason(ctx);
  const key = str(body.monthKey, "対象の期間", { max: 7 });
  const period = seasonPeriods(ctx).find((p) => p.key === key);
  if (!period) fail("invalid", "この期間の月の収入は記録できません");
  if (await ctx.tx.income.findFirst({ where: { userId: ctx.user.id, kind: "MONTHLY", monthKey: key } })) fail("already", `${monthlyName(key)}は記録済みです`, 409);
  const amount = int(body.amount, "月の収入", { min: 0, max: 100_000_000 });
  const base = ctx.user.monthlyBudget;
  const diff = amount - base;
  const rows = diff > 0 ? (body.allocation !== undefined ? parseRows(ctx, body.allocation, diff) : presetRows(ctx, "ratio", diff, period!)) : [];
  const income = await ctx.tx.income.create({
    data: {
      userId: ctx.user.id,
      seasonId: ctx.season.id,
      kind: "MONTHLY",
      monthKey: key,
      date: dayKey(period!.start, ctx.user.timezone),
      name: monthlyName(key),
      amount,
      baseAmount: base,
      memo: optStr(body.memo, "メモ"),
      autoExchange: bool(body.autoExchange),
      allocation: rows as never,
    },
  });
  const dividend = key === ctx.mine.monthKey;
  const done = diff > 0 ? await executeRows(ctx, income, rows, dividend) : { goldNow: 0, saved: [] };
  const reduced = diff < 0 ? await reduceUndistributed(ctx, -diff, key, { type: "income", id: income.id }) : null;
  const exchanged = income.autoExchange ? autoExchange(ctx, done.goldNow, income.id) : null;
  const reward = await grantReward(ctx, `income:${key}`, REWARD_PURCHASE);
  return { id: income.id, monthKey: key, diff, reward, saved: done.saved, reduced, exchanged };
}

async function recordExtra(ctx: GameCtx, body: Body) {
  const amount = int(body.amount, "臨時の収入", { min: 1, max: 100_000_000 });
  const rows = ctx.season ? (body.allocation !== undefined ? parseRows(ctx, body.allocation, amount) : presetRows(ctx, "save", amount, null)) : [];
  const income = await ctx.tx.income.create({
    data: {
      userId: ctx.user.id,
      seasonId: ctx.season?.id ?? null,
      kind: "EXTRA",
      date: date(body.date, "日付"),
      name: str(body.name, "名称", { max: 100 }),
      amount,
      memo: optStr(body.memo, "メモ"),
      autoExchange: bool(body.autoExchange),
      allocation: rows as never,
    },
  });
  // 過去の日付でも、記録した時点から配当する
  const done = ctx.season ? await executeRows(ctx, income, rows, false) : { goldNow: 0, saved: [] };
  const exchanged = ctx.season && income.autoExchange ? autoExchange(ctx, done.goldNow, income.id) : null;
  const reward = await grantReward(ctx, `income:${income.id}`, REWARD_PURCHASE);
  return { id: income.id, reward, saved: done.saved, exchanged };
}

/** 収入の記録。月の収入は items で一括保存できる（期間ごとに1件・報酬も期間ごと） */
export async function recordIncome(ctx: GameCtx, body: Body) {
  if (Array.isArray(body.items)) {
    if (body.items.length > 24) fail("invalid", "一括保存は24件までです");
    const results = [];
    for (const item of body.items as Body[]) results.push(await recordMonthly(ctx, item));
    return { items: results };
  }
  const kind = oneOf(body.kind, ["MONTHLY", "EXTRA"] as const, "収入の種類");
  return kind === "MONTHLY" ? recordMonthly(ctx, body) : recordExtra(ctx, body);
}

/** 記録前のプレビュー：差分・振り分けの行（プリセットを選んだらその雛形）・解消の内訳 */
export async function quoteIncome(ctx: GameCtx, body: Body) {
  requireSeason(ctx);
  const kind = oneOf(body.kind, ["MONTHLY", "EXTRA"] as const, "収入の種類");
  const amount = int(body.amount, "金額", { min: 0, max: 100_000_000 });
  const period = kind === "MONTHLY" ? (seasonPeriods(ctx).find((p) => p.key === body.monthKey) ?? fail("invalid", "この期間の月の収入は記録できません")) : null;
  const base = kind === "MONTHLY" ? ctx.user.monthlyBudget : 0;
  const diff = amount - base;
  const total = Math.max(0, diff);
  const preset = body.preset ? oneOf(body.preset, ["save", "gold", "ratio"] as const, "プリセット") : kind === "MONTHLY" ? "ratio" : "save";
  const rows = body.allocation !== undefined && !body.preset ? parseRows(ctx, body.allocation, total) : presetRows(ctx, preset, total, period);
  const save = rows.filter((r) => r.currency === "SAVE").reduce((a, r) => a + r.amount, 0);
  const reduction = diff < 0 ? planReduction(ctx, -diff, period?.key ?? null) : null;
  return {
    base,
    diff,
    preset,
    rows,
    saving: save > 0 ? previewSurplus(ctx, save) : null,
    reduction: reduction ? { cutMining: reduction.cutMining, cutCustom: reduction.cutCustom, bond: reduction.bond, shortfall: reduction.bond > 0 ? previewShortfall(ctx, reduction.bond) : null } : null,
    currencies: ctx.defs.map((d) => ({ id: d.id, name: d.name, icon: d.icon })),
  };
}

// ---- 金額だけの編集（§9.3） ----

async function ownIncome(ctx: GameCtx, id: string) {
  const i = await ctx.tx.income.findFirst({ where: { id, userId: ctx.user.id } });
  return i ?? fail("not_found", "収入の記録が見つかりません", 404);
}

/**
 * 収入の金額だけを変える。増額は＋差分（債券 → おまかせ交換）。
 * 減額はその記録の予約中の振り分け → （月の収入なら）当期の未配当分 → 債券（手数料あり）の順に減らす。金額 0 は取り消し。
 */
export async function editIncome(ctx: GameCtx, id: string, body: Body) {
  const income = await ownIncome(ctx, id);
  if (Object.keys(body).some((k) => k !== "amount")) fail("invalid", "登録した収入は金額だけ変更できます");
  const amount = int(body.amount, "金額", { min: 0, max: 100_000_000 });
  if (amount === income.amount) return { id, resolution: null };
  const edit = { before: income.amount, after: amount };
  const ref = { type: "income" as const, id };
  let resolution: ResolutionView | null = null;
  if (ctx.season && income.seasonId === ctx.season.id) {
    if (amount > income.amount) {
      resolution = await resolveSurplus(ctx, amount - income.amount, ref, edit);
    } else {
      const d = income.amount - amount;
      const canceled = await cancelPending(ctx, id, d);
      resolution =
        income.kind === "MONTHLY"
          ? await reduceUndistributed(ctx, d - canceled, income.monthKey, ref, edit, canceled)
          : await resolveShortfall(ctx, d - canceled, ref, edit, { total: d, canceled });
    }
  }
  await ctx.tx.income.update({ where: { id }, data: { amount } });
  return { id, resolution };
}

/** 金額を変えたときの解消のプレビュー（収入・支出） */
export async function quoteEdit(ctx: GameCtx, body: Body) {
  requireSeason(ctx);
  const refType = oneOf(body.refType, ["income", "purchase"] as const, "記録の種類");
  const id = str(body.id, "記録");
  const amount = int(body.amount, "金額", { min: 0, max: 100_000_000 });
  if (refType === "purchase") {
    const p = await ctx.tx.purchase.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
    if (!p) fail("not_found", "購入記録が見つかりません", 404);
    const diff = p!.amount - amount;
    return { diff, surplus: diff > 0 ? previewSurplus(ctx, diff) : null, shortfall: diff < 0 ? previewShortfall(ctx, -diff) : null };
  }
  const income = await ownIncome(ctx, id);
  const diff = amount - income.amount;
  if (diff >= 0) return { diff, surplus: diff > 0 ? previewSurplus(ctx, diff) : null, shortfall: null };
  const pending = await ctx.tx.scheduledGrant.aggregate({ where: { incomeId: id, grantedAt: null, canceled: false, at: { gt: new Date(ctx.now) } }, _sum: { amount: true } });
  const windows = (ctx.mine.windows ?? []).filter((w) => w.incomeId === id).reduce((a, w) => a + Number((w.total - windowMinedBy(w, ctx.mine.lastAccrualAt)) / MICRO_PER_GOLD), 0);
  const canceled = Math.min(-diff, (pending._sum.amount ?? 0) + windows);
  const r = income.kind === "MONTHLY" ? planReduction(ctx, -diff - canceled, income.monthKey) : { cutMining: 0, cutCustom: [], bond: -diff - canceled };
  return { diff, canceled, cutMining: r.cutMining, cutCustom: r.cutCustom, surplus: null, shortfall: r.bond > 0 ? previewShortfall(ctx, r.bond) : null };
}

