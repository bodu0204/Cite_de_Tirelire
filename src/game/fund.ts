// 建設資金（docs/savings-driven-growth.md §5・§7・§8）。街は自分では稼がず、貯金（金貨の交換・債券化）と債券の利息からだけ建設資金が入る。
import { BOND_INTEREST_PER_DAY, DAY, EARLY_BONUS, EARLY_BONUS_CAP, FORECAST_DAYS, RESERVE_LEVEL_MONTHS } from "./config";
import type { CityState, Gains } from "./types";

/** シーズン開始から何日目か（1 から） */
export function seasonDay(city: Pick<CityState, "startedAt">, at: number): number {
  return Math.floor((at - city.startedAt) / DAY) + 1;
}

/** 開拓期ボーナスの倍率（ERL-01）：1〜7日目 ×2、8〜14日目 ×1.5、以降 ×1 */
export function earlyBonusRate(city: Pick<CityState, "startedAt">, at: number): number {
  const day = seasonDay(city, at);
  for (const b of EARLY_BONUS) if (day <= b.days) return b.rate;
  return 1;
}

/**
 * 貯金から建設資金を入れる。開拓期ボーナスを足す（増える分はシーズンで基準額 × EARLY_BONUS_CAP まで。ERL-02）。
 * at は貯金が入った時刻（採掘・交換・振り分け）。足したボーナスを返す
 */
export function creditFund(city: CityState, amount: number, at: number): number {
  if (amount <= 0) return 0;
  const room = Math.max(0, EARLY_BONUS_CAP * city.base - city.earlyBonus);
  const bonus = Math.min(amount * (earlyBonusRate(city, at) - 1), room);
  city.earlyBonus += bonus;
  city.treasury += amount + bonus;
  logFund(city, at, amount + bonus);
  return bonus;
}

/** 建設資金が入った額をシーズンの日ごとに覚える（見通し REC-04 のペース。直近 FORECAST_DAYS 日だけ残す） */
export function logFund(city: CityState, at: number, amount: number) {
  if (amount <= 0) return;
  const day = seasonDay(city, at);
  const log = (city.fundLog ??= {});
  log[day] = (log[day] ?? 0) + amount;
  for (const k of Object.keys(log)) if (Number(k) <= day - FORECAST_DAYS) delete log[k];
}

/** 直近 FORECAST_DAYS 日に入った建設資金の1日あたりのペース（円/日） */
export function fundPace(city: CityState, now: number): number {
  const day = seasonDay(city, now);
  const days = Math.max(1, Math.min(FORECAST_DAYS, day));
  const sum = Object.entries(city.fundLog ?? {}).reduce((a, [k, v]) => (Number(k) > day - FORECAST_DAYS ? a + v : a), 0);
  return sum / days;
}

/** 交換の結果（Gains）を街に入れる。建設資金は creditFund を通す。足した開拓期ボーナスを返す */
export function creditGains(city: CityState, gains: Gains, at: number): number {
  city.stock.wood += gains.wood;
  city.stock.stone += gains.stone;
  city.stock.food += gains.food;
  return creditFund(city, gains.treasury, at);
}

/** 債券の利息（1日あたり、円）：債券残高（0〜上限）の BOND_INTEREST_PER_DAY（RSV-02）。マイナスの間はつかない */
export function bondInterestPerDay(bond: number, cap: number): number {
  return Math.max(0, Math.min(bond, cap)) * BOND_INTEREST_PER_DAY;
}

/** 備えLv（0〜4）：債券残高が月間自由予算の 0.5 / 1 / 2 / 3 か月分（RSV-03） */
export function reserveLevel(bond: number, monthlyBudget: number): number {
  if (monthlyBudget <= 0 || bond <= 0) return 0;
  return RESERVE_LEVEL_MONTHS.filter((m) => bond >= m * monthlyBudget).length;
}

/** 次の備えLvになる債券残高（最大なら null） */
export function nextReserveAt(level: number, monthlyBudget: number): number | null {
  const m = RESERVE_LEVEL_MONTHS[level];
  return m === undefined ? null : Math.round(m * monthlyBudget);
}
