// クレジットカードの請求の区切り（docs/payment-method-sync.md §5.1）。日付は "YYYY-MM-DD"（ユーザーのタイムゾーンの暦日）。

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

export interface CardUnpaid {
  /** 未払いの合計 */
  amount: number;
  /** 次回の引き落とし（未払いがなければ null） */
  next: { date: string; amount: number } | null;
}

/** カードで払った支出（金額 0 の取り消しは除く）から、今日の時点の未払いを求める（CE-01） */
export function cardUnpaid(purchases: { date: string; amount: number }[], t: CardTerms, today: string): CardUnpaid {
  const byDate = new Map<string, number>();
  for (const p of purchases) {
    if (p.amount <= 0) continue;
    const due = billingDate(p.date, t);
    if (due > today) byDate.set(due, (byDate.get(due) ?? 0) + p.amount);
  }
  const dates = [...byDate.keys()].sort();
  return {
    amount: [...byDate.values()].reduce((a, v) => a + v, 0),
    next: dates.length ? { date: dates[0], amount: byDate.get(dates[0])! } : null,
  };
}

/** 未払いの支出を探すときの利用日の下限：これより前の利用は、どのカードでも引き落とし済み（最長で翌々月末） */
export function unpaidSince(today: string): string {
  const [y, m] = today.split("-").map(Number);
  const from = addMonth(y, m, -3);
  return `${from.y}-${pad(from.m)}-01`;
}
