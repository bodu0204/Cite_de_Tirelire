import {
  BANK_EXCHANGE_BONUS,
  BANK_LEVEL_THRESHOLDS,
  DEV_THRESHOLDS,
  GOLD_MINE_EXCHANGE_BONUS,
  GOLD_MINE_LEVEL_THRESHOLDS,
  SILVER_MINE_EXCHANGE_BONUS,
  SILVER_MINE_LEVEL_THRESHOLDS,
  STATUE_GOLD_FROM,
  STATUE_SILVER_FROM,
  TECH_THRESHOLDS,
} from "./config";

/** 閾値の配列からレベル（1始まり）を求める */
export function levelFrom(thresholds: readonly number[], value: number): number {
  let lv = 1;
  for (let i = 0; i < thresholds.length; i++) if (value >= thresholds[i]) lv = i + 1;
  return lv;
}

/** 目標達成率(%)。純増額が負なら 0 */
export function achievementRate(netSavings: number, goal: number): number {
  if (goal <= 0) return 0;
  return (Math.max(0, netSavings) / goal) * 100;
}

export interface SavingsParts {
  /** 債券（マイナス可） */
  bond: number;
  /** 都市に使った金貨の累計（金貨 → 資源・都市資金。＋差分のおまかせ交換を含む） */
  citySpent: number;
}

/**
 * 貯金額 ＝ 債券 ＋ 都市に使った金貨（docs/record-input-redesign.md §7.1）。
 * 金貨はゲーム内で使っても現実のお金は出ていかないので、都市に使った金貨はそのまま貯金になる。債券は現実の支払いに使うと減る。
 * 技術Lv（最高到達額）・銀行Lv・目標達成の判定と表示はこの額で行う。債券がマイナスなら減らす。
 */
export function savingsTotal(p: SavingsParts): number {
  return p.bond + Math.max(0, p.citySpent);
}

/** 達成率(%)：max(0, 貯金額) ÷ 目標 */
export function savingsRate(p: SavingsParts, goal: number): number {
  return achievementRate(savingsTotal(p), goal);
}

/** 銀行Lv：1〜5、6 は「完成」 */
export function bankLevel(ratePercent: number): number {
  return levelFrom(BANK_LEVEL_THRESHOLDS, ratePercent);
}

/**
 * 銀行Lvの区間を金額で返す（現在Lvの到達額 → 次のLvに必要な額）。完成（Lv6）なら next は null。
 * 例：目標100,000円・Lv2 → { from: 20,000, next: 40,000 }
 */
export function bankLevelBand(goal: number, lv: number): { from: number; next: number | null } {
  const from = Math.round((goal * (BANK_LEVEL_THRESHOLDS[lv - 1] ?? 0)) / 100);
  const nextPct = BANK_LEVEL_THRESHOLDS[lv];
  return { from, next: nextPct === undefined ? null : Math.round((goal * nextPct) / 100) };
}

/** 技術Lv：貯金額の最高到達額で決まる（D-7。債券を使って貯金額が下がっても下がらない） */
export function techLevel(maxSavings: number): number {
  return levelFrom(TECH_THRESHOLDS, maxSavings);
}

export function devLevel(points: number): number {
  return levelFrom(DEV_THRESHOLDS, points);
}

export function goldMineLevel(totalCollected: number): number {
  return levelFrom(GOLD_MINE_LEVEL_THRESHOLDS, totalCollected);
}

export function silverMineLevel(rewardedRecords: number): number {
  return levelFrom(SILVER_MINE_LEVEL_THRESHOLDS, rewardedRecords);
}

export const bankBonus = (lv: number) => BANK_EXCHANGE_BONUS[lv - 1] ?? 0;
export const goldMineBonus = (lv: number) => GOLD_MINE_EXCHANGE_BONUS[lv - 1] ?? 0;
export const silverMineBonus = (lv: number) => SILVER_MINE_EXCHANGE_BONUS[lv - 1] ?? 0;

/** 次のレベルの閾値。最大なら null */
export function nextThreshold(thresholds: readonly number[], lv: number): number | null {
  return lv < thresholds.length ? thresholds[lv] : null;
}

export type StatueRank = "bronze" | "silver" | "gold";

export function statueRank(price: number): StatueRank {
  if (price >= STATUE_GOLD_FROM) return "gold";
  if (price >= STATUE_SILVER_FROM) return "silver";
  return "bronze";
}

export const STATUE_RANK_LABELS: Record<StatueRank, string> = { bronze: "銅像", silver: "銀像", gold: "金像" };

/** 貯金管理の記録（別口座への出し入れ）の並びから純増額と最高到達額を求める。判定には使わない（手元のお金の推測 E5） */
export function savingsProgress(records: { kind: "DEPOSIT" | "WITHDRAW"; amount: number }[]): {
  net: number;
  max: number;
} {
  let net = 0;
  let max = 0;
  for (const r of records) {
    net += r.kind === "DEPOSIT" ? r.amount : -r.amount;
    if (net > max) max = net;
  }
  return { net, max };
}
