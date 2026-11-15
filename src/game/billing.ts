// クレジットカードの請求の区切り（docs/money-accounts.md §7）。日付は "YYYY-MM-DD"（ユーザーのタイムゾーンの暦日）。

export interface CardTerms {
  /** 締め日（1〜31。その月にない日は末日） */
  closingDay: number;
  /** 引き落とし日（1〜31。その月にない日は末日） */
  paymentDay: number;
  /** 締めた月の何か月後に引き落とすか（1 = 翌月、2 = 翌々月） */
  paymentMonths: number;
}

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

function addMonth(y: number, m: number, n: number) {
  const i = y * 12 + (m - 1) + n;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

/** 利用日 date の分が引き落とされる日（CB-01・CB-02）。土日祝日のずれは見ない */
export function billingDate(date: string, t: CardTerms): string {
  const [y, m, d] = date.split("-").map(Number);
  // 締め日以前ならその月の請求、後なら翌月の請求
  const bill = d <= Math.min(t.closingDay, daysIn(y, m)) ? { y, m } : addMonth(y, m, 1);
  const pay = addMonth(bill.y, bill.m, t.paymentMonths);
  return `${pay.y}-${pad(pay.m)}-${pad(Math.min(t.paymentDay, daysIn(pay.y, pay.m)))}`;
}

/** 引き落とし日の 0:00 を過ぎたら未払いから外れる（CB-03） */
export const isUnpaid = (date: string, t: CardTerms, today: string) => billingDate(date, t) > today;

/**
 * カードで払った支出（金額 0 の取り消しは除く）を引き落とし日ごとにまとめる（引き落とし予定の請求額。docs/money-accounts.md CB-02）。
 * 返す Map は引き落とし日の昇順
 */
export function billsByDue(purchases: { date: string; amount: number }[], t: CardTerms): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const p of purchases) {
    if (p.amount <= 0) continue;
    const due = billingDate(p.date, t);
    byDate.set(due, (byDate.get(due) ?? 0) + p.amount);
  }
  return new Map([...byDate].sort(([a], [b]) => a.localeCompare(b)));
}

/** 引き落とし日が since 以後になりうる利用日の下限（最長で翌々月末払いなので、3か月前の1日） */
export function unpaidSince(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const from = addMonth(y, m, -3);
  return `${from.y}-${pad(from.m)}-01`;
}
