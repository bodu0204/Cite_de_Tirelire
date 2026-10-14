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
