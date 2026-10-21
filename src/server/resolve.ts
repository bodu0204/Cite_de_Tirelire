// 差分の解消（docs/record-input-redesign.md §4）。収入・支出・誤差調整・金額の編集で共通に使う。
// ＋差分：債券に上限まで入れ（0〜上限の分は資源つき）、入りきらない残りはおまかせ交換（手数料 5S、銀貨が足りなければなし）。
// −差分：全額を債券から減らす（マイナス可）＋ 購入と同じ手数料。
import { Prisma } from "@prisma/client";
import { bondCap, bondFee, bondResourceEligible } from "@/game/bond";
import { cityNeeds } from "@/game/city/sim";
import { FEE_EXCHANGE } from "@/game/config";
import { GAIN_KEYS, quoteNeedsExchange, ZERO_GAINS } from "@/game/exchange";
import { absorbShortfall, absorbSurplus, type Payment } from "@/game/settle";
import type { Gains, StockKey } from "@/game/types";
import { facilityLevels, requireSeason, tagLedger, withPurse, type GameCtx } from "./game";

export type RefType = "income" | "purchase" | "adjustment";

export interface ResolutionView {
  /** 正：＋差分、負：−差分 */
  amount: number;
  bond: number;
  resourced: number;
  exchanged: number;
  gains: Gains;
  feeSilver: number;
  feeBond: number;
}

const RESOURCES: StockKey[] = ["wood", "stone", "food"];

function addGains(ctx: GameCtx, gains: Gains) {
  for (const k of RESOURCES) ctx.city!.stock[k] += gains[k];
  ctx.city!.treasury += gains.treasury;
}

const sumGains = (a: Gains, b: Gains): Gains => Object.fromEntries(GAIN_KEYS.map((k) => [k, a[k] + b[k]])) as unknown as Gains;

/** 金貨 amount をおまかせ交換したときの資源（手数料は銀貨が足りるときだけ） */
function surplusExchange(ctx: GameCtx, amount: number, silver: number) {
  const fee = silver >= FEE_EXCHANGE;
  return quoteNeedsExchange("gold", amount, cityNeeds(ctx.city!).needs, facilityLevels(ctx), { fee });
}

/** ＋差分の解消のプレビュー（状態は変えない） */
export function previewSurplus(ctx: GameCtx, d: number): ResolutionView {
  requireSeason(ctx);
  const cap = bondCap(ctx.user.monthlyBudget);
  const bond = ctx.balances.bond;
  const toBond = Math.min(d, Math.max(0, cap - bond));
  const resourced = bondResourceEligible(bond, toBond, cap);
  const lv = facilityLevels(ctx);
  const needs = cityNeeds(ctx.city).needs;
  const a = quoteNeedsExchange("gold", resourced, needs, lv, { fee: false });
  const rest = d - toBond;
  const b = rest > 0 ? surplusExchange(ctx, rest, ctx.balances.silver) : null;
  return { amount: d, bond: toBond, resourced, exchanged: rest, gains: sumGains(a.gains, b?.gains ?? ZERO_GAINS), feeSilver: b?.silverCost ?? 0, feeBond: 0 };
}

/** −差分の解消のプレビュー */
export function previewShortfall(ctx: GameCtx, d: number): ResolutionView {
  const fee = bondFee(d);
  const feeSilver = Math.min(fee, Math.max(0, ctx.balances.silver));
  return { amount: -d, bond: -d - (fee - feeSilver), resourced: 0, exchanged: 0, gains: { ...ZERO_GAINS }, feeSilver, feeBond: fee - feeSilver };
}

/** 差分（正：＋差分、負：−差分）の解消のプレビュー */
export function previewDiff(ctx: GameCtx, diff: number): ResolutionView | null {
  if (!ctx.season || diff === 0) return null;
  return diff > 0 ? previewSurplus(ctx, diff) : previewShortfall(ctx, -diff);
}

async function saveResolution(ctx: GameCtx, ref: { type: RefType; id: string }, r: ResolutionView, edit?: { before: number; after: number }, detail?: Record<string, unknown>) {
  await ctx.tx.resolution.create({
    data: {
      seasonId: ctx.season!.id,
      refType: ref.type,
      refId: ref.id,
      amount: r.amount,
      bond: r.bond,
      resourced: r.resourced,
      exchanged: r.exchanged,
      gains: { ...r.gains, ...(detail ?? {}) } as Prisma.InputJsonValue,
      feeSilver: r.feeSilver,
      feeBond: r.feeBond,
      before: edit?.before ?? null,
      after: edit?.after ?? null,
    },
  });
}

/** ＋差分 d を解消する：債券 → おまかせ交換 */
export async function resolveSurplus(ctx: GameCtx, d: number, ref: { type: RefType; id: string }, edit?: { before: number; after: number }): Promise<ResolutionView> {
  requireSeason(ctx);
  const from = ctx.ledger.length;
  const r = withPurse(ctx, (p) => absorbSurplus(p, d, `${ref.type}_surplus`));
  const a = quoteNeedsExchange("gold", r.eligible, cityNeeds(ctx.city).needs, facilityLevels(ctx), { fee: false });
  addGains(ctx, a.gains);
  let gains = a.gains;
  let feeSilver = 0;
  if (r.rest > 0) {
    // 入りきらない分はおまかせ交換。金貨としては残らないが、都市に使った金貨（貯金額）に数える
    const b = surplusExchange(ctx, r.rest, ctx.balances.silver);
    feeSilver = b.silverCost;
    if (feeSilver > 0) {
      ctx.balances.silver -= feeSilver;
      ctx.ledger.push({ currency: "SILVER", delta: -feeSilver, reason: "exchange_resource" });
    }
    addGains(ctx, b.gains);
    gains = sumGains(gains, b.gains);
    ctx.citySpent += r.rest;
  }
  tagLedger(ctx, from, ref.id);
  const view: ResolutionView = { amount: d, bond: r.toBond, resourced: r.eligible, exchanged: r.rest, gains, feeSilver, feeBond: 0 };
  await saveResolution(ctx, ref, view, edit);
  return view;
}

/** −差分 d を解消する：債券（マイナス可）＋ 手数料 */
export async function resolveShortfall(
  ctx: GameCtx,
  d: number,
  ref: { type: RefType; id: string },
  edit?: { before: number; after: number },
  detail?: Record<string, unknown>,
): Promise<ResolutionView> {
  requireSeason(ctx);
  const from = ctx.ledger.length;
  const payments: Payment[] = [];
  if (d > 0) withPurse(ctx, (p) => absorbShortfall(p, d, payments, `${ref.type}_shortfall`));
  tagLedger(ctx, from, ref.id);
  const fee = (c: string) => payments.filter((x) => x.kind === "fee" && x.currency === c).reduce((s, x) => s + x.amount, 0);
  const feeBond = fee("BOND");
  const view: ResolutionView = { amount: -d, bond: -d - feeBond, resourced: 0, exchanged: 0, gains: { ...ZERO_GAINS }, feeSilver: fee("SILVER"), feeBond };
  await saveResolution(ctx, ref, view, edit, detail);
  return view;
}

/** 差分（正：＋差分、負：−差分）を解消する。シーズン外は何もしない */
export async function resolveDiff(ctx: GameCtx, diff: number, ref: { type: RefType; id: string }, edit?: { before: number; after: number }) {
  if (!ctx.season || diff === 0) return null;
  return diff > 0 ? resolveSurplus(ctx, diff, ref, edit) : resolveShortfall(ctx, -diff, ref, edit);
}
