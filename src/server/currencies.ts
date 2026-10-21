// ユーザ定義通貨の定義（SCR-11）。定義はユーザー単位でシーズンをまたいで引き継ぎ、残高はシーズンごと。
// 自由予算の内訳なので、B − S − C が負になる月が出る設定は保存しない（docs/bond-and-custom-currency.md §5.5）。
import { Prisma } from "@prisma/client";
import { budgetOverruns, describeOverruns, nextOccurrences, type CurrencyDefLite, type Rule } from "@/game/currency";
import { fail } from "@/game/errors";
import { dayKey, periodRange } from "@/game/time";
import { budgetPlan, defLite, loadCurrencyDefs, type GameCtx } from "./game";
import { date, int, oneOf, optDate, str } from "./validate";

type Body = Record<string, unknown>;

const AMOUNT_MAX = 10_000_000;
const RULES_MAX = 20;
const DATES_MAX = 100;

function intList(v: unknown, label: string, allowed: (n: number) => boolean): number[] {
  if (!Array.isArray(v) || v.length === 0) fail("invalid", `${label}を1つ以上選んでください`);
  const out = [...new Set((v as unknown[]).map((x) => int(x, label, { min: -1, max: 31 })))];
  if (out.some((n) => !allowed(n))) fail("invalid", `${label}が不正です`);
  return out.sort((a, b) => a - b);
}

const amountOf = (v: unknown) => int(v, "1回の量", { min: 1, max: AMOUNT_MAX });
const weekdays = (v: unknown) => intList(v, "曜日", (n) => n >= 0 && n <= 6);
const monthDays = (v: unknown) => intList(v, "日", (n) => n >= 1 && n <= 31);

/** 発生ルールの配列を検証する（種類ごとの必須項目、毎分ルールは1つまで、ルールは1つ以上、量は1以上） */
export function parseRules(v: unknown): Rule[] {
  if (!Array.isArray(v) || v.length === 0) fail("invalid", "発生ルールを1つ以上追加してください");
  if ((v as unknown[]).length > RULES_MAX) fail("invalid", `発生ルールは${RULES_MAX}個までです`);
  const rules = (v as Record<string, unknown>[]).map((r): Rule => {
    if (!r || typeof r !== "object") fail("invalid", "発生ルールが不正です");
    const kind = oneOf(r.kind, ["minute", "weekly", "monthDays", "monthNth", "everyMonths", "dates"] as const, "発生ルールの種類");
    switch (kind) {
      case "minute":
        return { kind, monthlyAmount: int(r.monthlyAmount, "月あたりの量", { min: 1, max: AMOUNT_MAX }) };
      case "weekly":
        return { kind, every: int(r.every ?? 1, "何週ごと", { min: 1, max: 12 }), weekdays: weekdays(r.weekdays), amount: amountOf(r.amount) };
      case "monthDays":
        return { kind, days: monthDays(r.days), amount: amountOf(r.amount) };
      case "monthNth":
        return {
          kind,
          nth: intList(r.nth, "第何週", (n) => n === -1 || (n >= 1 && n <= 4)),
          weekdays: weekdays(r.weekdays),
          amount: amountOf(r.amount),
        };
      case "everyMonths":
        return { kind, every: int(r.every ?? 1, "何か月ごと", { min: 1, max: 12 }), days: monthDays(r.days), amount: amountOf(r.amount) };
      case "dates": {
        if (!Array.isArray(r.dates) || r.dates.length === 0) fail("invalid", "日付を1つ以上選んでください");
        if ((r.dates as unknown[]).length > DATES_MAX) fail("invalid", `日付は${DATES_MAX}個までです`);
        const dates = [...new Set((r.dates as unknown[]).map((d) => date(d, "日付")))].sort();
        if (dates.some((d) => d < "2000-01-01" || d > "2099-12-31")) fail("invalid", "日付は2000〜2099年の範囲で選んでください");
        return { kind, dates, amount: amountOf(r.amount) };
      }
    }
  });
  if (rules.filter((r) => r.kind === "minute").length > 1) fail("invalid", "毎分の発生ルールは1つまでです");
  return rules;
}

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

/** 絵文字1文字（結合文字を含む1書記素） */
export function parseIcon(v: unknown): string {
  const s = str(v, "アイコン", { max: 32 });
  const graphemes = [...segmenter.segment(s)];
  if (graphemes.length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s)) {
    fail("invalid", "アイコンは絵文字1文字で入力してください");
  }
  return s;
}

async function currencyInput(ctx: GameCtx, body: Body) {
  const remainder = oneOf(body.remainder ?? "KEEP", ["KEEP", "TO_BOND"] as const, "余りの扱い");
  const startDate = body.startDate ? date(body.startDate, "開始日") : dayKey(ctx.now, ctx.user.timezone);
  const endDate = optDate(body.endDate, "終了日");
  if (endDate && endDate <= startDate) fail("invalid", "終了日は開始日より後にしてください");
  if (!Array.isArray(body.categoryIds) || body.categoryIds.length === 0) fail("invalid", "使えるジャンルを1つ以上選んでください");
  const categoryIds = [...new Set((body.categoryIds as unknown[]).map((c) => str(c, "ジャンル")))];
  const found = await ctx.tx.category.count({ where: { id: { in: categoryIds }, userId: ctx.user.id } });
  if (found !== categoryIds.length) fail("not_found", "ジャンルが見つかりません", 404);
  return {
    name: str(body.name, "通貨の名前", { max: 20 }),
    icon: parseIcon(body.icon),
    categoryIds,
    rules: parseRules(body.rules),
    remainder,
    remainderDays: remainder === "TO_BOND" ? int(body.remainderDays, "債券へ移すまでの日数", { min: 1, max: 365 }) : null,
    startDate,
    endDate,
  };
}

type CurrencyInput = Awaited<ReturnType<typeof currencyInput>>;

function asLite(id: string, input: CurrencyInput, sortOrder: number, createdAt: number): CurrencyDefLite {
  return { id, ...input, sortOrder, createdAt };
}

/** 保存後の定義の並びで、自由予算を超える月がないか確かめる */
function requireWithinBudget(ctx: GameCtx, defs: CurrencyDefLite[]) {
  const overruns = budgetOverruns(budgetPlan(ctx, { defs }), ctx.now);
  if (overruns.length) {
    fail("over_budget", `${describeOverruns(overruns)}。発生の量を減らすか、自由予算を見直してください`, 400, { overruns });
  }
}

async function reloadDefs(ctx: GameCtx) {
  ctx.currencyRows = await loadCurrencyDefs(ctx.tx, ctx.user.id);
  ctx.defs = ctx.currencyRows.map(defLite);
}

export async function createCurrency(ctx: GameCtx, body: Body) {
  const input = await currencyInput(ctx, body);
  const sortOrder = ctx.defs.length ? Math.max(...ctx.defs.map((d) => d.sortOrder)) + 1 : 0;
  requireWithinBudget(ctx, [...ctx.defs, asLite("new", input, sortOrder, ctx.now)]);
  const def = await ctx.tx.currencyDef.create({
    data: { ...input, rules: input.rules as unknown as Prisma.InputJsonValue, sortOrder, userId: ctx.user.id, createdAt: new Date(ctx.now) },
  });
  await reloadDefs(ctx);
  return { id: def.id };
}

async function ownCurrency(ctx: GameCtx, id: string) {
  const d = await ctx.tx.currencyDef.findFirst({ where: { id, userId: ctx.user.id, deletedAt: null } });
  return d ?? fail("not_found", "通貨が見つかりません", 404);
}

/** 変更時点までは前の内容で採掘・発生済み。ここから新しい内容で発生し、採掘から差し引く */
export async function updateCurrency(ctx: GameCtx, id: string, body: Body) {
  const cur = await ownCurrency(ctx, id);
  const input = await currencyInput(ctx, { ...cur, ...body });
  const sortOrder = body.sortOrder !== undefined ? int(body.sortOrder, "並び順", { max: 10_000 }) : cur.sortOrder;
  requireWithinBudget(ctx, ctx.defs.map((d) => (d.id === id ? asLite(id, input, sortOrder, d.createdAt) : d)));
  await ctx.tx.currencyDef.update({ where: { id }, data: { ...input, rules: input.rules as unknown as Prisma.InputJsonValue, sortOrder } });
  await reloadDefs(ctx);
  return { id };
}

/** 削除：定義を消し、このシーズンの残高は所持金貨へ戻す（自由予算から差し引いた分なので） */
export async function deleteCurrency(ctx: GameCtx, id: string) {
  await ownCurrency(ctx, id);
  let returned = 0;
  for (const lot of ctx.lots) {
    if (lot.currencyId !== id || lot.remaining <= 0) continue;
    ctx.ledger.push({ currency: "CUSTOM", currencyId: id, delta: -lot.remaining, reason: "currency_delete" });
    returned += lot.remaining;
    lot.remaining = 0;
    lot.dirty = true;
  }
  if (returned > 0) {
    ctx.balances.gold += returned;
    ctx.ledger.push({ currency: "GOLD", delta: returned, reason: "currency_delete", refId: id });
  }
  await ctx.tx.currencyDef.update({ where: { id }, data: { deletedAt: new Date(ctx.now) } });
  await reloadDefs(ctx);
  return { id, returned };
}

/** 保存前の確認：次の発生日と、今月・来月の C と差し引き後の採掘額 */
export async function previewCurrency(ctx: GameCtx, body: Body) {
  const id = typeof body.id === "string" ? body.id : null;
  const cur = id ? await ownCurrency(ctx, id) : null;
  const input = await currencyInput(ctx, cur ? { ...cur, ...body } : body);
  const def = asLite(id ?? "new", input, cur?.sortOrder ?? Number.MAX_SAFE_INTEGER, cur?.createdAt.getTime() ?? ctx.now);
  const defs = cur ? ctx.defs.map((d) => (d.id === id ? def : d)) : [...ctx.defs, def];
  const plan = budgetPlan(ctx, { defs });
  const alone = budgetPlan(ctx, { defs: [def], budget: Number.MAX_SAFE_INTEGER, subs: [] });
  const tz = ctx.user.timezone;
  const thisMonth = periodRange(ctx.now, ctx.cal);
  const months = [thisMonth.start, thisMonth.end].map((t) => {
    const m = plan.monthSummary(t);
    return { monthKey: dayKey(t, tz).slice(0, 7), budget: plan.budget, subs: m.subs, custom: m.custom, thisCurrency: alone.monthSummary(t).custom, mining: m.net };
  });
  return { next: nextOccurrences(def, ctx.now, tz, 5), months, overruns: budgetOverruns(plan, ctx.now) };
}

/** 一覧（SCR-11）：定義と、このシーズンの残高・次の発生・次の期限 */
export function currencySummaries(ctx: GameCtx) {
  const tz = ctx.user.timezone;
  return ctx.currencyRows.map((row) => {
    const def = ctx.defs.find((d) => d.id === row.id)!;
    const lots = ctx.lots.filter((l) => l.currencyId === row.id && l.remaining > 0);
    const expiring = lots.filter((l) => l.expiresAt !== null).sort((a, b) => a.expiresAt! - b.expiresAt!)[0];
    const next = nextOccurrences(def, ctx.now, tz, 1)[0] ?? null;
    return {
      id: row.id,
      name: row.name,
      icon: row.icon,
      categoryIds: row.categoryIds,
      rules: def.rules,
      remainder: row.remainder,
      remainderDays: row.remainderDays,
      startDate: row.startDate,
      endDate: row.endDate,
      sortOrder: row.sortOrder,
      balance: lots.reduce((a, l) => a + l.remaining, 0),
      nextIssue: next ? { date: next.date, amount: next.amount } : null,
      nextExpiry: expiring ? { at: expiring.expiresAt!, amount: expiring.remaining } : null,
    };
  });
}
