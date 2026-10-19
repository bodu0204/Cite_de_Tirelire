// ユーザ定義通貨：発生ルールの暦計算と、採掘から差し引く月の発生額 C（docs/bond-and-custom-currency.md §5）。
// 日付はユーザーのタイムゾーンの暦日。日の発生は「その日の 0:00」に起きる。
import { BUDGET_CHECK_MONTHS, DAY, MINUTE } from "./config";
import type { SubWindow } from "./mine";
import { monthKey, monthRange, parseDateInTz, zonedParts, zonedTimeToUtc } from "./time";

/** 曜日：0＝日〜6＝土 */
export type Weekday = number;

export type Rule =
  | { kind: "minute"; monthlyAmount: number }
  | { kind: "weekly"; every: number; weekdays: Weekday[]; amount: number }
  | { kind: "monthDays"; days: number[]; amount: number }
  /** nth：1〜4、-1＝最終 */
  | { kind: "monthNth"; nth: number[]; weekdays: Weekday[]; amount: number }
  | { kind: "everyMonths"; every: number; days: number[]; amount: number }
  | { kind: "dates"; dates: string[]; amount: number };

export type RuleKind = Rule["kind"];

export interface CurrencyDefLite {
  id: string;
  name: string;
  icon: string;
  categoryIds: string[];
  rules: Rule[];
  remainder: "KEEP" | "TO_BOND";
  remainderDays: number | null;
  startDate: string;
  endDate: string | null;
  sortOrder: number;
  createdAt: number;
}

// ---- 暦日（UTC の日番号で扱う） ----

const dayNumOf = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY;

function civilOf(dn: number) {
  const dt = new Date(dn * DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const weekdayOf = (dn: number) => (((dn + 4) % 7) + 7) % 7; // 1970-01-01 は木曜
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const keyOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function parseDayNum(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return dayNumOf(y, m, d);
}

/** 時刻 t を含む暦日の日番号 */
function dayNumAt(t: number, tz: string): number {
  const p = zonedParts(t, tz);
  return dayNumOf(p.year, p.month, p.day);
}

/** 日番号の 0:00（tz） */
function startOfDayNum(dn: number, tz: string): number {
  const c = civilOf(dn);
  return zonedTimeToUtc(c.y, c.m, c.d, tz);
}

/** 時刻 t を含む日の 0:00 */
export function startOfDay(t: number, tz: string): number {
  return startOfDayNum(dayNumAt(t, tz), tz);
}

/** t を含む日の n 日後の 0:00 */
export function shiftDays(t: number, n: number, tz: string): number {
  return startOfDayNum(dayNumAt(t, tz) + n, tz);
}

/** from を含む日から to を含む日の翌日までの各日の 0:00 と、その月の [開始, 終了) */
export function dayGrid(from: number, to: number, tz: string): { at: number; monthStart: number; monthEnd: number }[] {
  const out: { at: number; monthStart: number; monthEnd: number }[] = [];
  let month = monthRange(from, tz);
  const last = dayNumAt(to, tz) + 1;
  for (let dn = dayNumAt(from, tz); dn <= last; dn++) {
    const at = startOfDayNum(dn, tz);
    if (at >= month.end) month = monthRange(at, tz);
    out.push({ at, monthStart: month.start, monthEnd: month.end });
  }
  return out;
}

/** 月曜始まりの週の先頭 */
const mondayOf = (dn: number) => dn - ((weekdayOf(dn) + 6) % 7);

/** ルールがその暦日に当たるか（毎分ルールは日の発生を持たない） */
function ruleHits(rule: Rule, dn: number, startDn: number): boolean {
  const { y, m, d } = civilOf(dn);
  const last = daysInMonth(y, m);
  const hitsDay = (days: number[]) => days.some((x) => Math.min(x, last) === d);
  switch (rule.kind) {
    case "minute":
      return false;
    case "weekly": {
      const weeks = (mondayOf(dn) - mondayOf(startDn)) / 7;
      return weeks >= 0 && weeks % rule.every === 0 && rule.weekdays.includes(weekdayOf(dn));
    }
    case "monthDays":
      return hitsDay(rule.days);
    case "monthNth":
      return rule.weekdays.includes(weekdayOf(dn)) && rule.nth.some((n) => (n === -1 ? d + 7 > last : Math.ceil(d / 7) === n));
    case "everyMonths": {
      const s = civilOf(startDn);
      const idx = y * 12 + m - (s.y * 12 + s.m);
      return idx >= 0 && idx % rule.every === 0 && hitsDay(rule.days);
    }
    case "dates":
      return rule.dates.includes(keyOf(y, m, d));
  }
}

function validOnDay(def: Pick<CurrencyDefLite, "startDate" | "endDate">, dn: number): boolean {
  return dn >= parseDayNum(def.startDate) && (def.endDate === null || dn < parseDayNum(def.endDate));
}

/** その暦日に発生する額（毎分ルールを除く。同じ日に当たったルールは合算する） */
export function dayAmount(def: Pick<CurrencyDefLite, "rules" | "startDate" | "endDate">, dn: number): number {
  if (!validOnDay(def, dn)) return 0;
  const startDn = parseDayNum(def.startDate);
  let sum = 0;
  for (const r of def.rules) if (r.kind !== "minute" && ruleHits(r, dn, startDn)) sum += r.amount;
  return sum;
}

/** (from, to] に 0:00 を迎える日の発生（時刻順） */
export function dayEvents(def: CurrencyDefLite, from: number, to: number, tz: string): { at: number; amount: number }[] {
  const out: { at: number; amount: number }[] = [];
  if (to <= from || !def.rules.some((r) => r.kind !== "minute")) return out;
  const last = dayNumAt(to, tz);
  for (let dn = dayNumAt(from, tz); dn <= last; dn++) {
    const at = startOfDayNum(dn, tz);
    if (at <= from || at > to) continue;
    const amount = dayAmount(def, dn);
    if (amount > 0) out.push({ at, amount });
  }
  return out;
}

export function minuteRule(def: Pick<CurrencyDefLite, "rules">): number {
  const r = def.rules.find((x) => x.kind === "minute");
  return r && r.kind === "minute" ? r.monthlyAmount : 0;
}

/** 有効期間の [開始, 終了) の時刻 */
export function validWindow(def: Pick<CurrencyDefLite, "startDate" | "endDate">, tz: string): { startAt: number; endAt: number | null } {
  return { startAt: parseDateInTz(def.startDate, tz) ?? 0, endAt: def.endDate ? parseDateInTz(def.endDate, tz) : null };
}

const activeAt = (w: { startAt: number; endAt: number | null }, t: number) => w.startAt <= t && (w.endAt === null || t < w.endAt);

/** 月 [start, end) に日の発生として出る額の合計 */
function monthDayTotal(def: CurrencyDefLite, start: number, end: number, tz: string): number {
  let sum = 0;
  const last = dayNumAt(end - 1, tz);
  for (let dn = dayNumAt(start, tz); dn <= last; dn++) sum += dayAmount(def, dn);
  return sum;
}

/**
 * 採掘から差し引く額を時刻ごとに返す（サブスク S とユーザ通貨 C）。
 * C ＝ その月の日の発生の合計（月の間は一定）＋ その時点で有効な毎分ルールの月あたりの量。
 * 月ごとの合計はキャッシュする。
 */
export class BudgetPlan {
  private dayTotals = new Map<string, number>();
  private windows: { def: CurrencyDefLite; w: { startAt: number; endAt: number | null } }[];

  constructor(
    readonly budget: number,
    readonly subs: SubWindow[],
    readonly defs: CurrencyDefLite[],
    readonly tz: string,
  ) {
    this.windows = defs.map((def) => ({ def, w: validWindow(def, tz) }));
  }

  subsAt(t: number): number {
    let s = 0;
    for (const w of this.subs) if (activeAt(w, t)) s += w.monthly;
    return s;
  }

  /** その月の日の発生の合計（全通貨） */
  monthDays(t: number): number {
    const key = monthKey(t, this.tz);
    let v = this.dayTotals.get(key);
    if (v === undefined) {
      const { start, end } = monthRange(t, this.tz);
      v = this.defs.reduce((a, def) => a + monthDayTotal(def, start, end, this.tz), 0);
      this.dayTotals.set(key, v);
    }
    return v;
  }

  minutesAt(t: number): number {
    let s = 0;
    for (const { def, w } of this.windows) if (activeAt(w, t)) s += minuteRule(def);
    return s;
  }

  customAt(t: number): number {
    return this.monthDays(t) + this.minutesAt(t);
  }

  /** 月あたりの採掘額 max(0, B − S − C) */
  netAt(t: number): number {
    return Math.max(0, this.budget - this.subsAt(t) - this.customAt(t));
  }

  /** 採掘速度が変わる時刻（サブスクと毎分ルールの開始・終了） */
  changePoints(): number[] {
    const pts: number[] = [];
    for (const w of this.subs) pts.push(w.startAt, w.endAt ?? Infinity);
    for (const { def, w } of this.windows) if (minuteRule(def) > 0) pts.push(w.startAt, w.endAt ?? Infinity);
    return pts.filter(Number.isFinite).map((t) => Math.floor(t / MINUTE) * MINUTE).sort((a, b) => a - b);
  }

  /** 月の中で差し引き（S ＋ C）が最大になる時点の内訳と、そのときの月あたりの採掘額 */
  monthSummary(t: number): { subs: number; custom: number; net: number } {
    const { start, end } = monthRange(t, this.tz);
    const points = [start, ...this.changePoints().filter((p) => p > start && p < end)];
    let best = { subs: 0, minutes: 0 };
    for (const p of points) {
      const cur = { subs: this.subsAt(p), minutes: this.minutesAt(p) };
      if (cur.subs + cur.minutes > best.subs + best.minutes) best = cur;
    }
    const custom = this.monthDays(t) + best.minutes;
    return { subs: best.subs, custom, net: Math.max(0, this.budget - best.subs - custom) };
  }

  /** 月の中で差し引き（S ＋ C）が最大になる額 */
  maxDeduction(t: number): number {
    const m = this.monthSummary(t);
    return m.subs + m.custom;
  }
}

export interface Overrun {
  monthKey: string;
  /** S ＋ C */
  deduction: number;
  /** 自由予算を超える額 */
  over: number;
}

/**
 * B − S − C が負になる月。今月から12か月先までの各月と、それより先のカレンダー指定日がある月を確かめる
 * （周期ルールは1年分あれば各曜日が5回ある月を含む）。
 */
export function budgetOverruns(plan: BudgetPlan, now: number): Overrun[] {
  const tz = plan.tz;
  const months: number[] = [];
  let t = monthRange(now, tz).start;
  for (let i = 0; i <= BUDGET_CHECK_MONTHS; i++) {
    months.push(t);
    t = monthRange(t, tz).end;
  }
  const horizon = t;
  const later = new Set<string>();
  for (const def of plan.defs) {
    for (const r of def.rules) {
      if (r.kind !== "dates") continue;
      for (const d of r.dates) {
        const at = parseDateInTz(d, tz);
        if (at !== null && at >= horizon && !later.has(d.slice(0, 7))) {
          later.add(d.slice(0, 7));
          months.push(monthRange(at, tz).start);
        }
      }
    }
  }
  const out: Overrun[] = [];
  for (const m of months.sort((a, b) => a - b)) {
    const deduction = plan.maxDeduction(m);
    if (deduction > plan.budget) out.push({ monthKey: monthKey(m, tz), deduction, over: deduction - plan.budget });
  }
  return out;
}

export function describeOverruns(list: Overrun[]): string {
  const head = list.slice(0, 3).map((o) => `${o.monthKey} は ${o.over.toLocaleString("ja-JP")}円`).join("、");
  return `${head}${list.length > 3 ? ` ほか${list.length - 3}か月` : ""}自由予算を超えます`;
}

/** from より後の発生（毎分ルールを除く）を最大 count 件。5年先まで探す */
export function nextOccurrences(def: CurrencyDefLite, from: number, tz: string, count = 5): { date: string; at: number; amount: number }[] {
  const out: { date: string; at: number; amount: number }[] = [];
  if (!def.rules.some((r) => r.kind !== "minute")) return out;
  const first = dayNumAt(from, tz);
  const endDn = def.endDate ? parseDayNum(def.endDate) : Infinity;
  for (let dn = Math.max(first, parseDayNum(def.startDate)); dn < Math.min(first + 5 * 366, endDn) && out.length < count; dn++) {
    const amount = dayAmount(def, dn);
    if (amount <= 0) continue;
    const at = startOfDayNum(dn, tz);
    if (at <= from) continue;
    const c = civilOf(dn);
    out.push({ date: keyOf(c.y, c.m, c.d), at, amount });
  }
  return out;
}
