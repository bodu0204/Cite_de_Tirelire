// 購入の精算と払い戻し（docs/bond-and-custom-currency.md §6）。
// 支払い順：（像の積立金貨は呼び出し側）→ ジャンルが一致するユーザ通貨 → 未回収の金貨 → 所持金貨 → 債券（マイナス可）＋ 銀貨の手数料。
// 払い戻しは逆順：債券 → 所持金貨 → ユーザ通貨（元のロットへ）。手数料は債券の支払い合計から計算し直す。
import { bondFee } from "./bond";
import { payWithGold, type MineState } from "./mine";

export type PayCurrency = "GOLD" | "SILVER" | "BOND" | "CUSTOM" | "RESERVED";

export interface Lot {
  id: string;
  currencyId: string;
  issuedAt: number;
  expiresAt: number | null;
  amount: number;
  remaining: number;
  /** 保存が必要か（新規・変更） */
  isNew?: boolean;
  dirty?: boolean;
}

export interface Payment {
  currency: PayCurrency;
  kind: "pay" | "fee";
  currencyId?: string | null;
  lotId?: string | null;
  amount: number;
}

/** 台帳に書く増減 */
export interface Move {
  currency: "GOLD" | "SILVER" | "BOND" | "CUSTOM";
  delta: number;
  reason: string;
  currencyId?: string;
}

export interface Purse {
  mine: MineState;
  gold: number;
  silver: number;
  bond: number;
  /** 債券化（採掘・ユーザ通貨の余り）が止まる額 */
  bondCap: number;
  moves: Move[];
  /** 当月に不足分として債券から払った額の増減 */
  overspend: number;
}

function move(p: Purse, m: Move) {
  if (m.delta !== 0) p.moves.push(m);
}

function addPayment(list: Payment[], x: Payment) {
  if (x.amount === 0) return;
  const same = list.find((p) => p.currency === x.currency && p.kind === x.kind && (p.lotId ?? null) === (x.lotId ?? null));
  if (same) same.amount += x.amount;
  else list.push({ ...x });
  for (let i = list.length - 1; i >= 0; i--) if (list[i].amount === 0) list.splice(i, 1);
}

const total = (list: Payment[], currency: PayCurrency, kind: Payment["kind"]) =>
  list.filter((p) => p.currency === currency && p.kind === kind).reduce((a, p) => a + p.amount, 0);

/** 支払いに使うロットの順：期限の近い順（期限なしは最後）、同じなら通貨の並び順、発生の早い順 */
export function lotOrder(sortOf: (currencyId: string) => number) {
  return (a: Lot, b: Lot) =>
    (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || sortOf(a.currencyId) - sortOf(b.currencyId) || a.issuedAt - b.issuedAt || a.id.localeCompare(b.id);
}

/** 債券へ入れる。上限を超える分は所持金貨へ（ユーザ通貨の余り） */
export function depositToBond(p: Purse, amount: number, reason: string, currencyId?: string) {
  if (amount <= 0) return;
  const toBond = Math.max(0, Math.min(amount, p.bondCap - p.bond));
  p.bond += toBond;
  p.gold += amount - toBond;
  move(p, { currency: "BOND", delta: toBond, reason, currencyId });
  move(p, { currency: "GOLD", delta: amount - toBond, reason, currencyId });
}

/**
 * amount を支払う。lots は使えるロット（ジャンルが一致するもの）を支払い順に並べたもの。
 * payments（この購入の支払い内訳）に追記する。
 */
export function pay(p: Purse, amount: number, lots: Lot[], payments: Payment[]) {
  let rest = amount;
  for (const lot of lots) {
    if (rest <= 0) break;
    const use = Math.min(rest, lot.remaining);
    if (use <= 0) continue;
    lot.remaining -= use;
    lot.dirty = true;
    rest -= use;
    addPayment(payments, { currency: "CUSTOM", kind: "pay", currencyId: lot.currencyId, lotId: lot.id, amount: use });
    move(p, { currency: "CUSTOM", delta: -use, reason: "purchase_custom", currencyId: lot.currencyId });
  }
  const g = payWithGold(p.mine, p.gold, rest);
  p.mine = g.mine;
  p.gold -= g.fromHeld;
  move(p, { currency: "GOLD", delta: -g.fromHeld, reason: "purchase_settle" });
  addPayment(payments, { currency: "GOLD", kind: "pay", amount: g.fromUncollected + g.fromHeld });
  if (g.rest > 0) {
    p.bond -= g.rest;
    p.overspend += g.rest;
    move(p, { currency: "BOND", delta: -g.rest, reason: "purchase_bond" });
    addPayment(payments, { currency: "BOND", kind: "pay", amount: g.rest });
  }
  settleFee(p, payments);
}

export interface LotRef {
  lot?: Lot;
  /** 期限切れ（余りを債券へ移す通貨）なので、戻した分をその場で債券へ */
  expiredToBond?: boolean;
}

/** amount を払い戻す（逆順）。resolve は支払いに使ったロットの今の状態を返す */
export function refund(p: Purse, amount: number, payments: Payment[], resolve: (lotId: string) => LotRef) {
  let rest = amount;
  const bondPaid = total(payments, "BOND", "pay");
  const fromBond = Math.min(rest, bondPaid);
  if (fromBond > 0) {
    p.bond += fromBond;
    p.overspend -= fromBond;
    move(p, { currency: "BOND", delta: fromBond, reason: "purchase_refund" });
    addPayment(payments, { currency: "BOND", kind: "pay", amount: -fromBond });
    rest -= fromBond;
  }
  const fromGold = Math.min(rest, total(payments, "GOLD", "pay"));
  if (fromGold > 0) {
    p.gold += fromGold;
    move(p, { currency: "GOLD", delta: fromGold, reason: "purchase_refund" });
    addPayment(payments, { currency: "GOLD", kind: "pay", amount: -fromGold });
    rest -= fromGold;
  }
  const custom = payments.filter((x) => x.currency === "CUSTOM" && x.kind === "pay").reverse();
  for (const x of custom) {
    if (rest <= 0) break;
    const back = Math.min(rest, x.amount);
    const ref = resolve(x.lotId!);
    if (ref.lot && !ref.expiredToBond) {
      ref.lot.remaining += back;
      ref.lot.dirty = true;
      move(p, { currency: "CUSTOM", delta: back, reason: "purchase_refund", currencyId: x.currencyId! });
    } else if (ref.lot) {
      depositToBond(p, back, "currency_expire_bond", x.currencyId!);
    } else {
      // 通貨を削除済み：残高と同じく所持金貨へ戻す
      p.gold += back;
      move(p, { currency: "GOLD", delta: back, reason: "purchase_refund", currencyId: x.currencyId! });
    }
    addPayment(payments, { ...x, amount: -back });
    rest -= back;
  }
  settleFee(p, payments);
  return rest;
}

/** 手数料を「その購入で債券から払った額の合計」に合わせる。不足分の銀貨は債券から、返すときは債券の分から先に */
export function settleFee(p: Purse, payments: Payment[]) {
  const target = bondFee(total(payments, "BOND", "pay"));
  const silverFee = total(payments, "SILVER", "fee");
  const bondFeePaid = total(payments, "BOND", "fee");
  const diff = target - silverFee - bondFeePaid;
  if (diff > 0) {
    const s = Math.min(diff, Math.max(0, p.silver));
    p.silver -= s;
    p.bond -= diff - s;
    move(p, { currency: "SILVER", delta: -s, reason: "bond_fee" });
    move(p, { currency: "BOND", delta: -(diff - s), reason: "bond_fee" });
    addPayment(payments, { currency: "SILVER", kind: "fee", amount: s });
    addPayment(payments, { currency: "BOND", kind: "fee", amount: diff - s });
  } else if (diff < 0) {
    const b = Math.min(-diff, bondFeePaid);
    const s = -diff - b;
    p.bond += b;
    p.silver += s;
    move(p, { currency: "BOND", delta: b, reason: "bond_fee_refund" });
    move(p, { currency: "SILVER", delta: s, reason: "bond_fee_refund" });
    addPayment(payments, { currency: "BOND", kind: "fee", amount: -b });
    addPayment(payments, { currency: "SILVER", kind: "fee", amount: -s });
  }
}

/** 支払い内訳の要約（応答・プレビュー用） */
export function summarize(payments: Payment[]) {
  return {
    reserved: total(payments, "RESERVED", "pay"),
    custom: payments.filter((x) => x.currency === "CUSTOM" && x.kind === "pay").map((x) => ({ currencyId: x.currencyId!, lotId: x.lotId!, amount: x.amount })),
    gold: total(payments, "GOLD", "pay"),
    bond: total(payments, "BOND", "pay"),
    feeSilver: total(payments, "SILVER", "fee"),
    feeBond: total(payments, "BOND", "fee"),
  };
}
