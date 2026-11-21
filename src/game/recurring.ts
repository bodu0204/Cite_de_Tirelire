// 固定費・サブスクの支払いの行（docs/take-home-and-fixed-costs.md FC-11・FC-12・FC-15、docs/record-input-redesign.md EX-01）。
// 登録から「未記録の支払い」を収入期間ごとに1件ずつ求める。DB に依存しない。
import { dayKey, parseDateInTz, zonedParts, zonedTimeToUtc } from "./time";

export interface Recurring {
  cycle: "MONTHLY" | "YEARLY";
  /** 開始日・終了日（"YYYY-MM-DD"。終了日はその日を含まない） */
  startDate: string;
  endDate: string | null;
  /** 支払日（1〜31。その月にない日は末日）。null は期間の初めから並べる。月額だけに使う */
  payDay: number | null;
  /** 「この回は記録しない」にした期間 */
  skippedPeriods: string[];
}

export interface DuePeriod {
  key: string;
  start: number;
  end: number;
}

/** 月額換算（年額は ÷12） */
export function monthlyEquivalent(s: { amount: number; cycle: "MONTHLY" | "YEARLY" }): number {
  return s.cycle === "YEARLY" ? Math.round(s.amount / 12) : s.amount;
}

/**
 * 直近2回の支払いがどちらも登録額と違うとき、登録額の変更の案内に出す額（直近の支払いの額）を返す。それ以外は null
 * （docs/record-input-redesign.md EX-05、docs/take-home-and-fixed-costs.md FC-17）。recent は新しい順（取り消しは除く）
 */
export function suggestedAmount(registered: number, recent: number[]): number | null {
  if (recent.length < 2) return null;
  const [last, prev] = recent;
  return last !== registered && prev !== registered ? last : null;
}

/** 期間 [start, end) の中で最初の「毎月 day 日」の 0:00（その月にない日は末日）。なければ null */
export function payDayIn(p: { start: number; end: number }, day: number, tz: string): number | null {
  const first = zonedParts(p.start, tz);
  for (let i = 0; i < 3; i++) {
    const y = first.year + Math.floor((first.month - 1 + i) / 12);
    const m = ((first.month - 1 + i) % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const at = zonedTimeToUtc(y, m, Math.min(day, last), tz);
    if (at >= p.end) return null;
    if (at >= p.start) return at;
  }
  return null;
}

/**
 * 未記録の支払い（期間ごとに1件まで）。
 * - 月額：毎期間。支払日があれば、その日が来てから並べ、日付はその日。シーズンの開始日・登録の開始日より前の支払日の分は並べない。
 *   支払日がなければ期間の初めから並べ、日付は期間の初め（登録の開始日・シーズンの開始日が後ならその日）
 * - 年額：開始日と同じ月日がある期間（期間の初めから並べる）
 * - 記録済み（paid）・「この回は記録しない」にした期間は並べない
 */
export function duePayments(
  r: Recurring,
  periods: DuePeriod[],
  opts: { tz: string; now: number; seasonStart: number; paid: (periodKey: string) => boolean },
): { periodKey: string; date: string }[] {
  const { tz, now } = opts;
  const startAt = parseDateInTz(r.startDate, tz) ?? 0;
  const endAt = r.endDate ? parseDateInTz(r.endDate, tz) : null;
  const seasonDay = parseDateInTz(dayKey(opts.seasonStart, tz), tz) ?? opts.seasonStart;
  const anniversary = r.startDate.slice(5);
  const out: { periodKey: string; date: string }[] = [];
  for (const p of periods) {
    if (startAt >= p.end || (endAt !== null && endAt <= p.start)) continue;
    if (r.skippedPeriods.includes(p.key) || opts.paid(p.key)) continue;
    if (r.cycle === "YEARLY") {
      // 年額は開始日の記念日がある期間だけ
      const y = zonedParts(p.start, tz).year;
      const hit = [y, y + 1].map((yy) => parseDateInTz(`${yy}-${anniversary}`, tz)).some((t) => t !== null && t >= p.start && t < p.end && t >= startAt);
      if (!hit) continue;
    } else if (r.payDay !== null) {
      const at = payDayIn(p, r.payDay, tz);
      if (at === null || at > now || at < startAt || at < seasonDay || (endAt !== null && at >= endAt)) continue;
      out.push({ periodKey: p.key, date: dayKey(at, tz) });
      continue;
    }
    // 日付は期間の初め（登録の開始日・シーズンの開始日が後ならその日）。シーズンの開始より前の日付にはしない
    const due = Math.max(p.start, startAt, seasonDay);
    out.push({ periodKey: p.key, date: dayKey(Math.min(due, now), tz) });
  }
  return out;
}
