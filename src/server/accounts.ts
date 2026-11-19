// お金の置き場所と振替（docs/money-accounts.md）。
// 置き場所ごとに残高を持ち、収入・支出・振替・照合で動かす。ゲームの通貨を動かすのは、照合の誤差の合計の解消だけ。
// 予算外の入出金はなくした（給料は月の収入、固定費は固定費の支払いで記録する。docs/take-home-and-fixed-costs.md §8）。
import type { MoneyAccount, Purchase } from "@prisma/client";
import { billsByDue, unpaidSince, type CardTerms } from "@/game/billing";
import { REWARD_EXTRA, REWARD_EXTRA_DAILY_CAP } from "@/game/config";
import { fail } from "@/game/errors";
import { balances, ledgerMoves, savingsMoves } from "@/game/ledger";
import { dayKey } from "@/game/time";
import { recurringRows } from "./adjustments";
import { confirmRecords, type GameCtx } from "./game";
import { EXTRA_REWARD_PREFIXES, grantReward } from "./ops";
import { previewDiff, resolveDiff } from "./resolve";
import { bool, date, int, oneOf, optStr, str } from "./validate";

type Body = Record<string, unknown>;
type Tx = GameCtx["tx"];

const KINDS = ["BANK", "CASH", "CARD", "EMONEY"] as const;
const order = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];
const today = (ctx: GameCtx) => dayKey(ctx.now, ctx.user.timezone);

// ---- 置き場所 ----

/** 置き場所がなければ「財布A」（現金・いつもの置き場所）を作る（AC-02） */
export async function ensureAccounts(ctx: GameCtx): Promise<MoneyAccount[]> {
  let list = await ctx.tx.moneyAccount.findMany({ where: { userId: ctx.user.id }, orderBy: order });
  if (!list.some((a) => a.kind === "CASH")) {
    const wallet = await ctx.tx.moneyAccount.create({ data: { userId: ctx.user.id, name: "財布A", kind: "CASH", openingDate: today(ctx), sortOrder: -1 } });
    list = [wallet, ...list];
  }
  if (!ctx.user.defaultSpendAccountId || !list.some((a) => a.id === ctx.user.defaultSpendAccountId)) {
    const cash = list.find((a) => a.kind === "CASH")!;
    ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data: { defaultSpendAccountId: cash.id } });
  }
  return list;
}

/** いつもの置き場所・いつもの入金先（入金先を決めていなければ最初の口座、なければいつもの置き場所） */
export function defaultsOf(ctx: GameCtx, list: MoneyAccount[]) {
  const live = list.filter((a) => !a.archivedAt);
  const spend = list.find((a) => a.id === ctx.user.defaultSpendAccountId)?.id ?? live.find((a) => a.kind === "CASH")?.id ?? null;
  const income = list.find((a) => a.id === ctx.user.defaultIncomeAccountId)?.id ?? live.find((a) => a.kind === "BANK")?.id ?? spend;
  return { spend, income };
}

/** 入力の置き場所。使わないにしたものは新しく選べない */
export async function resolveAccount(ctx: GameCtx, v: unknown, label = "置き場所"): Promise<MoneyAccount> {
  const a = await ctx.tx.moneyAccount.findFirst({ where: { id: str(v, label), userId: ctx.user.id } });
  if (!a) fail("not_found", `${label}が見つかりません`, 404);
  if (a!.archivedAt) fail("invalid", `${a!.name}は使わないにしています`);
  return a!;
}

/** 支出の出どころ（指定がなければ fallback → いつもの置き場所） */
export async function spendAccountFor(ctx: GameCtx, v: unknown, fallback?: string | null): Promise<string> {
  if (v !== undefined && v !== null && v !== "") return (await resolveAccount(ctx, v, "出どころ")).id;
  const list = await ensureAccounts(ctx);
  if (fallback && list.some((a) => a.id === fallback && !a.archivedAt)) return fallback;
  return defaultsOf(ctx, list).spend!;
}

/** 収入の入金先（指定がなければいつもの入金先） */
export async function incomeAccountFor(ctx: GameCtx, v: unknown): Promise<string> {
  if (v !== undefined && v !== null && v !== "") return (await resolveAccount(ctx, v, "入金先")).id;
  return defaultsOf(ctx, await ensureAccounts(ctx)).income!;
}

/** 置き場所ごとの計算した残高（家計履歴全体から） */
export async function accountBalances(ctx: GameCtx, list?: MoneyAccount[], until?: string) {
  const accounts = list ?? (await ensureAccounts(ctx));
  const userId = ctx.user.id;
  const from = accounts.reduce((m, a) => (a.openingDate < m ? a.openingDate : m), "9999-12-31");
  const where = { userId, date: { gte: from } };
  const [incomes, purchases, transfers, adjustments] = await Promise.all([
    ctx.tx.income.findMany({ where, select: { accountId: true, date: true, amount: true } }),
    ctx.tx.purchase.findMany({ where: { ...where, deletedAt: null }, select: { accountId: true, date: true, amount: true } }),
    ctx.tx.transfer.findMany({ where, select: { fromAccountId: true, toAccountId: true, date: true, amount: true } }),
    ctx.tx.accountAdjustment.findMany({ where, select: { accountId: true, date: true, diff: true } }),
  ]);
  return balances(accounts, ledgerMoves({ incomes, purchases, transfers, adjustments }, defaultsOf(ctx, accounts)), until);
}

/** よく使う振替の組（直近に使った出元・入れ先、3つまで。TR-04） */
async function recentPairs(ctx: GameCtx, live: Set<string>) {
  const recent = await ctx.tx.transfer.findMany({
    where: { userId: ctx.user.id, kind: "MANUAL", amount: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { fromAccountId: true, toAccountId: true },
  });
  const seen = new Set<string>();
  const pairs: { fromAccountId: string; toAccountId: string }[] = [];
  for (const t of recent) {
    const k = `${t.fromAccountId}>${t.toAccountId}`;
    if (seen.has(k) || !live.has(t.fromAccountId) || !live.has(t.toAccountId)) continue;
    seen.add(k);
    pairs.push(t);
    if (pairs.length === 3) break;
  }
  return pairs;
}

/** 置き場所の一覧（計算した残高・最後の照合つき）、いつもの置き場所、よく使う振替、引き落とし予定、別枠の報酬の今日の残り */
export async function listAccounts(ctx: GameCtx) {
  const list = await ensureAccounts(ctx);
  await ensureCardBills(ctx, list);
  const bal = await accountBalances(ctx, list);
  const last = await ctx.tx.accountAdjustment.groupBy({ by: ["accountId"], where: { userId: ctx.user.id }, _max: { date: true } });
  const lastOf = new Map(last.map((l) => [l.accountId, l._max.date]));
  const items = list.map((a) => ({ ...a, balance: bal.get(a.id) ?? 0, lastReconciled: lastOf.get(a.id) ?? null }));
  const live = items.filter((a) => !a.archivedAt);
  return {
    items,
    defaults: defaultsOf(ctx, list),
    /** 純額：使っている置き場所の残高の合計（クレカのマイナスを含む） */
    total: live.reduce((s, a) => s + a.balance, 0),
    pairs: await recentPairs(ctx, new Set(live.map((a) => a.id))),
    bills: await pendingBills(ctx, list),
    /** 当期までの未記録の固定費・サブスクの支払いの行の数（照合の前に保存を促す。docs/take-home-and-fixed-costs.md FC-18） */
    unrecorded: (await recurringRows(ctx)).length,
    reward: await extraRewardStatus(ctx),
  };
}

function cardTerms(body: Body, prev?: MoneyAccount) {
  const v = (k: "closingDay" | "paymentDay" | "paymentMonths") => (body[k] !== undefined ? body[k] : prev?.[k]);
  return {
    closingDay: int(v("closingDay"), "締め日", { min: 1, max: 31 }),
    paymentDay: int(v("paymentDay"), "引き落とし日", { min: 1, max: 31 }),
    paymentMonths: int(v("paymentMonths") ?? 1, "引き落としの月", { min: 1, max: 2 }),
  };
}

async function debitFor(ctx: GameCtx, v: unknown, self?: string) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const a = await resolveAccount(ctx, v, "引き落とし口座");
  if (a.id === self || a.kind === "CARD") fail("invalid", "引き落とし口座には口座・現金・電子マネーを選んでください");
  return a.id;
}

/** 開始残高。クレカは未払いを正の数で受け取ってマイナスで持つ（AC-05） */
function openingOf(kind: MoneyAccount["kind"], v: unknown) {
  const n = int(v ?? 0, kind === "CARD" ? "今の未払い" : "開始残高", { min: kind === "CARD" ? 0 : -100_000_000, max: 1_000_000_000 });
  return kind === "CARD" ? -n : n;
}

async function setDefaults(ctx: GameCtx, id: string, body: Body) {
  const data: Record<string, string> = {};
  if (body.defaultSpend === true) data.defaultSpendAccountId = id;
  if (body.defaultIncome === true) data.defaultIncomeAccountId = id;
  if (Object.keys(data).length) ctx.user = await ctx.tx.user.update({ where: { id: ctx.user.id }, data });
}

export async function createAccount(ctx: GameCtx, body: Body) {
  await ensureAccounts(ctx);
  const kind = oneOf(body.kind, KINDS, "種類");
  const last = await ctx.tx.moneyAccount.aggregate({ where: { userId: ctx.user.id }, _max: { sortOrder: true } });
  const a = await ctx.tx.moneyAccount.create({
    data: {
      userId: ctx.user.id,
      name: str(body.name, "名前", { max: 50 }),
      kind,
      openingBalance: openingOf(kind, body.openingBalance),
      openingDate: body.openingDate ? date(body.openingDate, "開始日") : today(ctx),
      isSavings: bool(body.isSavings),
      ...(kind === "CARD" ? { ...cardTerms(body), debitAccountId: (await debitFor(ctx, body.debitAccountId)) ?? null } : {}),
      sortOrder: (last._max.sortOrder ?? 0) + 1,
    },
  });
  if (body.defaultSpend === true && kind === "CARD") fail("invalid", "いつもの置き場所にクレカは選べません");
  await setDefaults(ctx, a.id, body);
  return { id: a.id };
}

async function ownAccount(ctx: GameCtx, id: string) {
  const a = await ctx.tx.moneyAccount.findFirst({ where: { id, userId: ctx.user.id } });
  return a ?? fail("not_found", "置き場所が見つかりません", 404);
}

/** 名前・開始残高と開始日・貯金用・カードの設定・並び順・使わないにする・いつもの置き場所/入金先。種類は変えない（AC-06・07） */
export async function updateAccount(ctx: GameCtx, id: string, body: Body) {
  const a = await ownAccount(ctx, id);
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = str(body.name, "名前", { max: 50 });
  if (body.openingBalance !== undefined) data.openingBalance = openingOf(a.kind, body.openingBalance);
  if (body.openingDate !== undefined) data.openingDate = date(body.openingDate, "開始日");
  if (body.isSavings !== undefined) data.isSavings = bool(body.isSavings);
  if (body.sortOrder !== undefined) data.sortOrder = int(body.sortOrder, "並び順", { min: -1, max: 10_000 });
  if (a.kind === "CARD") {
    if (body.closingDay !== undefined || body.paymentDay !== undefined || body.paymentMonths !== undefined) Object.assign(data, cardTerms(body, a));
    const debit = await debitFor(ctx, body.debitAccountId, a.id);
    if (debit !== undefined) data.debitAccountId = debit;
  }
  if (body.archived !== undefined) {
    if (body.archived && (ctx.user.defaultSpendAccountId === id || ctx.user.defaultIncomeAccountId === id))
      fail("invalid", "いつもの置き場所・入金先は使わないにできません。先に別の置き場所をいつものにしてください");
    if (body.archived && a.kind === "CASH" && (await ctx.tx.moneyAccount.count({ where: { userId: ctx.user.id, kind: "CASH", archivedAt: null } })) <= 1)
      fail("invalid", "現金の置き場所は1つ残してください");
    data.archivedAt = body.archived ? new Date(ctx.now) : null;
  }
  if (body.defaultSpend === true && a.kind === "CARD") fail("invalid", "いつもの置き場所にクレカは選べません");
  await ctx.tx.moneyAccount.update({ where: { id }, data });
  await setDefaults(ctx, id, body);
  return { id };
}

/** 記録に使っていない置き場所だけ削除できる。使っていれば「使わない」にする（AC-07） */
export async function deleteAccount(ctx: GameCtx, id: string) {
  const a = await ownAccount(ctx, id);
  if (ctx.user.defaultSpendAccountId === id || ctx.user.defaultIncomeAccountId === id) fail("invalid", "いつもの置き場所・入金先は削除できません");
  if (a.kind === "CASH" && (await ctx.tx.moneyAccount.count({ where: { userId: ctx.user.id, kind: "CASH" } })) <= 1) fail("invalid", "現金の置き場所は1つ残してください");
  const userId = ctx.user.id;
  const used =
    (await ctx.tx.purchase.count({ where: { accountId: id } })) +
    (await ctx.tx.income.count({ where: { accountId: id } })) +
    (await ctx.tx.subscription.count({ where: { accountId: id } })) +
    (await ctx.tx.transfer.count({ where: { userId, OR: [{ fromAccountId: id }, { toAccountId: id }] } })) +
    (await ctx.tx.accountAdjustment.count({ where: { accountId: id } })) +
    (await ctx.tx.moneyAccount.count({ where: { debitAccountId: id } }));
  if (used > 0) fail("in_use", "この置き場所を使った記録があるため削除できません。「使わない」にしてください", 409);
  await ctx.tx.cardBill.deleteMany({ where: { cardId: id } });
  await ctx.tx.moneyAccount.delete({ where: { id } });
  return { id };
}

// ---- 別枠の報酬（振替・出どころの記入。§8） ----

export async function extraRewardStatus(ctx: GameCtx) {
  const t = await ctx.tx.rewardClaim.aggregate({
    where: { userId: ctx.user.id, dayKey: today(ctx), OR: EXTRA_REWARD_PREFIXES.map((p) => ({ recordKey: { startsWith: p } })) },
    _sum: { amount: true },
  });
  const used = t._sum.amount ?? 0;
  return { amount: REWARD_EXTRA, dailyCap: REWARD_EXTRA_DAILY_CAP, todayRewarded: used, remaining: Math.max(0, REWARD_EXTRA_DAILY_CAP - used) };
}

/** 支出の出どころを初めて自分で選んだときの報酬（RW-02・05）：今のシーズンの、金額が 0 でない支出で、いつもの置き場所以外 */
export async function grantPaymentReward(ctx: GameCtx, p: Pick<Purchase, "id" | "seasonId" | "amount">): Promise<number> {
  if (!ctx.season || p.seasonId !== ctx.season.id || p.amount <= 0) return 0;
  return grantReward(ctx, `payment:${p.id}`, REWARD_EXTRA, { extra: true });
}

/**
 * 記録した支出の出どころを変える（RS-04）。ゲームの判定に影響しないので差分の解消は起きない。
 * 取り消した支出（金額 0）は変えられない。初めていつもの置き場所以外を選んだら報酬
 */
export async function setPurchaseAccount(ctx: GameCtx, p: Purchase, v: unknown): Promise<{ accountId: string; paymentReward: number }> {
  if (p.amount === 0) fail("invalid", "取り消した支出の出どころは変えられません");
  const a = await resolveAccount(ctx, v, "出どころ");
  const current = p.accountId ?? defaultsOf(ctx, await ensureAccounts(ctx)).spend;
  if (a.id === current) return { accountId: a.id, paymentReward: 0 };
  const chosen = a.id !== ctx.user.defaultSpendAccountId;
  const first = chosen && p.paymentRecordedAt === null;
  await ctx.tx.purchase.update({ where: { id: p.id }, data: { accountId: a.id, ...(first ? { paymentRecordedAt: new Date(ctx.now) } : {}) } });
  return { accountId: a.id, paymentReward: first ? await grantPaymentReward(ctx, p) : 0 };
}

// ---- 振替（§6） ----

async function transferInput(ctx: GameCtx, body: Body) {
  const from = await resolveAccount(ctx, body.fromAccountId, "出元");
  const to = await resolveAccount(ctx, body.toAccountId, "入れ先");
  if (from.id === to.id) fail("invalid", "出元と入れ先には別の置き場所を選んでください");
  return {
    fromAccountId: from.id,
    toAccountId: to.id,
    date: date(body.date ?? today(ctx), "日付"),
    amount: int(body.amount, "金額", { min: 1, max: 100_000_000 }),
    memo: optStr(body.memo, "メモ"),
  };
}

async function createTransfer(ctx: GameCtx, data: Awaited<ReturnType<typeof transferInput>>, kind: "MANUAL" | "CARD_PAYMENT") {
  const t = await ctx.tx.transfer.create({ data: { ...data, kind, userId: ctx.user.id, seasonId: ctx.season?.id ?? null } });
  // 振替の報酬（RW-01）。別枠で1日の上限あり
  const reward = ctx.season ? await grantReward(ctx, `transfer:${t.id}`, REWARD_EXTRA, { extra: true }) : 0;
  return { t, reward };
}

/** 振替の記録（TR-01〜03・07）。ゲームの通貨は動かさない。記録したので、それまでの使わなかった配当は確定する */
export async function recordTransfer(ctx: GameCtx, body: Body) {
  const { t, reward } = await createTransfer(ctx, await transferInput(ctx, body), "MANUAL");
  const confirmed = ctx.season ? confirmRecords(ctx) : null;
  return { id: t.id, reward, confirmed };
}

/** 振替は金額だけ変えられる（0 で取り消し。TR-05）。取り消した引き落としは予定に戻す */
export async function editTransfer(ctx: GameCtx, id: string, body: Body) {
  const t = await ctx.tx.transfer.findFirst({ where: { id, userId: ctx.user.id } });
  if (!t) fail("not_found", "振替が見つかりません", 404);
  if (Object.keys(body).some((k) => k !== "amount")) fail("invalid", "登録した振替は金額だけ変更できます");
  const amount = int(body.amount, "金額", { min: 0, max: 100_000_000 });
  await ctx.tx.transfer.update({ where: { id }, data: { amount } });
  if (amount === 0 && t!.kind === "CARD_PAYMENT") await ctx.tx.cardBill.updateMany({ where: { transferId: id }, data: { status: "PENDING", transferId: null } });
  return { id };
}

// ---- クレカの引き落とし予定（§7） ----

const termsOf = (a: MoneyAccount): CardTerms | null =>
  a.kind === "CARD" && a.closingDay && a.paymentDay ? { closingDay: a.closingDay, paymentDay: a.paymentDay, paymentMonths: a.paymentMonths ?? 1 } : null;

/**
 * 引き落とし日が来たカードの予定を作る・確定前の額を計算し直す（CB-02・07・08）。
 * 請求額は、出どころがそのカードの支出をその引き落とし日でまとめた額（開始日より前の利用も含む：開始残高の未払いに入っているため）
 */
export async function ensureCardBills(ctx: GameCtx, list?: MoneyAccount[]) {
  const cards = (list ?? (await ensureAccounts(ctx))).filter((a) => a.kind === "CARD" && a.debitAccountId && termsOf(a));
  if (!cards.length) return;
  const now = today(ctx);
  for (const card of cards) {
    const purchases = await ctx.tx.purchase.findMany({
      where: { accountId: card.id, deletedAt: null, date: { gte: unpaidSince(card.openingDate) } },
      select: { date: true, amount: true },
    });
    const dues = billsByDue(purchases, termsOf(card)!);
    const bills = await ctx.tx.cardBill.findMany({ where: { cardId: card.id, dueDate: { gte: card.openingDate } } });
    const byDue = new Map(bills.map((b) => [b.dueDate, b]));
    for (const [due, amount] of dues) {
      if (due < card.openingDate || due > now) continue;
      const bill = byDue.get(due);
      if (!bill) {
        if (amount > 0) await ctx.tx.cardBill.create({ data: { userId: ctx.user.id, cardId: card.id, dueDate: due, amount } });
      } else if (bill.status === "PENDING" && bill.amount !== amount) {
        await ctx.tx.cardBill.update({ where: { id: bill.id }, data: { amount } });
      }
    }
    // 支出を取り消して請求がなくなった確定前の予定は消す
    for (const b of bills) if (b.status === "PENDING" && !dues.has(b.dueDate)) await ctx.tx.cardBill.delete({ where: { id: b.id } });
  }
}

async function pendingBills(ctx: GameCtx, list: MoneyAccount[]) {
  const bills = await ctx.tx.cardBill.findMany({ where: { userId: ctx.user.id, status: "PENDING" }, orderBy: { dueDate: "asc" } });
  const name = new Map(list.map((a) => [a.id, a]));
  // 開始残高に未払いがあり、まだ引き落としを確定していないカード：最初の予定に開始前の利用が含まれるか確かめてもらう（docs/season-start-settings.md OA-06）
  const paid = new Set((await ctx.tx.cardBill.findMany({ where: { userId: ctx.user.id, status: "CONFIRMED" }, select: { cardId: true } })).map((b) => b.cardId));
  const first = new Set<string>();
  return bills.map((b) => {
    const card = name.get(b.cardId);
    const openingUnpaid = card && card.openingBalance < 0 && !paid.has(b.cardId) && !first.has(b.cardId) ? -card.openingBalance : 0;
    first.add(b.cardId);
    return { ...b, cardName: card?.name ?? "クレカ", debitAccountId: card?.debitAccountId ?? null, openingUnpaid };
  });
}

async function ownBill(ctx: GameCtx, id: string) {
  const b = await ctx.tx.cardBill.findFirst({ where: { id, userId: ctx.user.id } });
  if (!b) fail("not_found", "引き落とし予定が見つかりません", 404);
  if (b!.status !== "PENDING") fail("already", "この引き落とし予定は確定または削除済みです", 409);
  return b!;
}

/** 引き落とし予定の確定：金額を直せる。引き落とし口座 → クレカ の振替になる（CB-03・04） */
export async function confirmCardBill(ctx: GameCtx, id: string, body: Body) {
  const b = await ownBill(ctx, id);
  const card = await ownAccount(ctx, b.cardId);
  if (!card.debitAccountId) fail("invalid", "このカードには引き落とし口座がありません");
  const amount = body.amount === undefined ? b.amount : int(body.amount, "金額", { min: 1, max: 100_000_000 });
  const { t, reward } = await createTransfer(
    ctx,
    { fromAccountId: card.debitAccountId!, toAccountId: card.id, date: b.dueDate, amount, memo: `${card.name}の引き落とし` },
    "CARD_PAYMENT",
  );
  await ctx.tx.cardBill.update({ where: { id }, data: { status: "CONFIRMED", transferId: t.id } });
  return { id, transferId: t.id, reward };
}

/** 予定を消す（同じ引き落とし日にはもう作らない。CB-08） */
export async function dismissCardBill(ctx: GameCtx, id: string) {
  await ownBill(ctx, id);
  await ctx.tx.cardBill.update({ where: { id }, data: { status: "DISMISSED" } });
  return { id };
}

// ---- 照合（残高を合わせる。§9） ----

async function reconcileInput(ctx: GameCtx, body: Body) {
  if (!Array.isArray(body.accounts) || body.accounts.length === 0) fail("invalid", "実際の残高を入れた置き場所がありません");
  const list = await ensureAccounts(ctx);
  const bal = await accountBalances(ctx, list);
  const seen = new Set<string>();
  const rows = (body.accounts as Body[]).map((r) => {
    const a = list.find((x) => x.id === r.accountId);
    if (!a) fail("not_found", "置き場所が見つかりません", 404);
    if (seen.has(a!.id)) fail("invalid", "同じ置き場所が2回入っています");
    seen.add(a!.id);
    // クレカは未払いを正の数で受け取る（RC-01）
    const entered = int(r.actual, `${a!.name}の実際の残高`, { min: a!.kind === "CARD" ? 0 : -1_000_000_000, max: 1_000_000_000 });
    const actual = a!.kind === "CARD" ? -entered : entered;
    const computed = bal.get(a!.id) ?? 0;
    return { accountId: a!.id, name: a!.name, kind: a!.kind, computed, actual, diff: actual - computed };
  });
  const total = rows.reduce((s, r) => s + r.diff, 0);
  const pending = await ctx.tx.cardBill.count({ where: { userId: ctx.user.id, status: "PENDING" } });
  return { rows, total, partial: rows.length < list.filter((a) => !a.archivedAt).length, pendingBills: pending, unrecorded: (await recurringRows(ctx)).length };
}

/** 照合のプレビュー：置き場所ごとの誤差と、誤差の合計の解消の内訳（RC-02・03・05・09） */
export async function quoteReconcile(ctx: GameCtx, body: Body) {
  const r = await reconcileInput(ctx, body);
  return { ...r, resolution: ctx.season && r.total !== 0 ? previewDiff(ctx, r.total) : null };
}

/**
 * 照合の記録：照合した置き場所の残高を実際に合わせ、誤差の合計を差分の解消ルールで解消する（RC-03・04・07）。
 * 報酬なし。保存後は編集しない
 */
export async function recordReconcile(ctx: GameCtx, body: Body) {
  const r = await reconcileInput(ctx, body);
  if (r.rows.every((x) => x.diff === 0)) fail("invalid", "誤差がありません");
  const day = today(ctx);
  const row = await ctx.tx.cashAdjustment.create({
    data: {
      userId: ctx.user.id,
      seasonId: ctx.season?.id ?? null,
      date: day,
      checks: {},
      items: r.rows as never,
      estimated: r.rows.reduce((s, x) => s + x.computed, 0),
      actual: r.rows.reduce((s, x) => s + x.actual, 0),
      diff: r.total,
    },
  });
  await ctx.tx.accountAdjustment.createMany({
    data: r.rows
      .filter((x) => x.diff !== 0)
      .map((x) => ({ userId: ctx.user.id, adjustmentId: row.id, accountId: x.accountId, date: day, computed: x.computed, actual: x.actual, diff: x.diff })),
  });
  const resolution = ctx.season && r.total !== 0 ? await resolveDiff(ctx, r.total, { type: "adjustment", id: row.id }) : null;
  const confirmed = ctx.season ? confirmRecords(ctx) : null;
  return { id: row.id, rows: r.rows, total: r.total, resolution, confirmed };
}

// ---- 貯金管理の増減（貯金用の置き場所への振替 ＋ 以前の貯金管理の記録。H7） ----

/** シーズンの貯金の追加・引出の並び（記録した順）。以前の貯金管理の記録も含める */
export async function seasonSavingsMoves(tx: Tx, userId: string, seasonId: string) {
  const [legacy, transfers, savingAccounts] = await Promise.all([
    tx.savingsTransaction.findMany({ where: { seasonId, deletedAt: null }, select: { kind: true, amount: true, date: true, createdAt: true } }),
    tx.transfer.findMany({ where: { userId, seasonId }, select: { fromAccountId: true, toAccountId: true, amount: true, date: true, createdAt: true } }),
    tx.moneyAccount.findMany({ where: { userId, isSavings: true }, select: { id: true } }),
  ]);
  const moves = savingsMoves(transfers, new Set(savingAccounts.map((a) => a.id))).map((m) => ({ kind: m.kind, amount: m.amount, date: m.date, createdAt: m.createdAt }));
  return [...legacy, ...moves].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}
