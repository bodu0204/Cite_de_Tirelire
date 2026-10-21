// タイムゾーンを考慮した暦の計算（月の境界・日付キー）。

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(t: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(t))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** tz での壁時計時刻を UTC の瞬間に変換する */
export function zonedTimeToUtc(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  // オフセットは2回補正すれば夏時間の境界でも安定する
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(t, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    t = guess - (asUtc - t);
  }
  return t;
}

export function monthKey(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function dayKey(t: number, tz: string): string {
  const p = zonedParts(t, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** t を含む月の [開始, 終了) */
export function monthRange(t: number, tz: string): { start: number; end: number } {
  const p = zonedParts(t, tz);
  const start = zonedTimeToUtc(p.year, p.month, 1, tz);
  const end = p.month === 12 ? zonedTimeToUtc(p.year + 1, 1, 1, tz) : zonedTimeToUtc(p.year, p.month + 1, 1, tz);
  return { start, end };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" を tz の0時として解釈する */
export function parseDateInTz(date: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), tz);
}

// ---- 収入期間（docs/record-input-redesign.md §5.1） ----
// 月の収入が入る日（収入日）から翌月の収入日の前日までを1期間とする。採掘・C・精算の「月」はこの期間。
// 収入日を変えたら次の収入日から新しい区切りにし、変えた時点の期間はそこまで延ばす・縮める（era で表す）。

export interface IncomeEra {
  /** 収入日（1〜31。その月にない日は末日） */
  day: number;
  /** この区切りが始まる時刻（最初の era は -Infinity） */
  from: number;
  /** 前の区切りの最後の期間の開始（この時刻から from までが移り変わりの1期間） */
  prevEnd: number;
}

export interface PeriodCal {
  tz: string;
  /** 時刻順。先頭は from ＝ -Infinity */
  eras: IncomeEra[];
}

/** 暦の月（収入日1日・変更なし） */
export const monthCal = (tz: string, day = 1): PeriodCal => ({ tz, eras: [{ day, from: -Infinity, prevEnd: -Infinity }] });

export const toCal = (v: string | PeriodCal): PeriodCal => (typeof v === "string" ? monthCal(v) : v);

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** y年m月の収入日 0:00 */
function paydayOf(y: number, m: number, day: number, tz: string): number {
  return zonedTimeToUtc(y, m, Math.min(day, daysIn(y, m)), tz);
}

const addMonth = (y: number, m: number, n: number) => {
  const i = y * 12 + (m - 1) + n;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
};

/** 収入日 day の区切りで t を含む [start, end) */
function dayPeriod(t: number, day: number, tz: string): { start: number; end: number } {
  const p = zonedParts(t, tz);
  let cur = { y: p.year, m: p.month };
  if (t < paydayOf(cur.y, cur.m, day, tz)) cur = addMonth(cur.y, cur.m, -1);
  const next = addMonth(cur.y, cur.m, 1);
  return { start: paydayOf(cur.y, cur.m, day, tz), end: paydayOf(next.y, next.m, day, tz) };
}

/** t を含む収入期間の [開始, 終了) */
export function periodRange(t: number, calOrTz: PeriodCal | string): { start: number; end: number } {
  const cal = toCal(calOrTz);
  const eras = cal.eras;
  for (let i = eras.length - 1; i >= 0; i--) {
    const e = eras[i];
    if (t >= e.from) {
      const r = dayPeriod(t, e.day, cal.tz);
      const next = eras[i + 1];
      return { start: Math.max(r.start, e.from), end: next ? Math.min(r.end, next.prevEnd) : r.end };
    }
    if (t >= e.prevEnd) return { start: e.prevEnd, end: e.from };
  }
  return dayPeriod(t, eras[0].day, cal.tz);
}

/** 収入期間の名前（開始の月。例："2026-10"） */
export function periodKey(t: number, calOrTz: PeriodCal | string): string {
  const cal = toCal(calOrTz);
  return monthKey(periodRange(t, cal).start, cal.tz);
}

/**
 * 収入日を day に変えた区切り。次の区切りは、今の期間より後の月にある最初の収入日から始まる（期間の名前が重ならないように）。
 * まだ前の変更が効く前なら、その変更を置き換える。
 */
export function changePayday(cal: PeriodCal, day: number, now: number): PeriodCal {
  const eras = cal.eras.slice();
  const last = eras[eras.length - 1];
  if (last.from > now) eras.pop();
  const base: PeriodCal = { tz: cal.tz, eras };
  const cur = periodRange(now, base);
  if (eras[eras.length - 1].day === day) return base;
  const s = zonedParts(cur.start, cal.tz);
  const next = addMonth(s.year, s.month, 1);
  const from = paydayOf(next.y, next.m, day, cal.tz);
  eras.push({ day, from, prevEnd: cur.start });
  return { tz: cal.tz, eras };
}
