// 貯金日とこまめボーナス（docs/saving-habit-balance.md HAB-01〜04）。
// こまめに貯金する（記録して貯金を確定する）ほど、区画の上限が増えて街が広くなる。
// 記録した日は1日1つ、記録のない日の自動の確定は AUTO_DAYS_PER_SAVING_DAY 日分で1つ数える。
// 債券がマイナス（使い過ぎ）の間は数えない。累計なので、途切れても減らない。
import { habitPlots, savingDaysOf } from "./city/layout";
import type { CityEvent, CityState } from "./types";

/** f で貯金日を足し、こまめボーナスの区画が増えたら知らせる */
function add(city: CityState, at: number, events: CityEvent[], f: () => void) {
  const before = habitPlots(savingDaysOf(city));
  f();
  const days = savingDaysOf(city);
  const after = habitPlots(days);
  if (after > before) events.push({ at, type: "HABIT_PLOT", auto: false, important: true, payload: { plots: after, added: after - before, savingDays: days } });
}

/**
 * 記録で貯金を確定したとき（HAB-01）：その暦日（ユーザーのタイムゾーンの YYYY-MM-DD）をまだ数えていなければ、貯金日を1つ足す。
 * bond は確定したあとの債券。マイナスなら数えない。数えたら true
 */
export function countRecordDay(city: CityState, day: string, bond: number, at: number, events: CityEvent[]): boolean {
  if (bond < 0 || city.lastSavingDay === day) return false;
  city.lastSavingDay = day;
  add(city, at, events, () => (city.savingDays = (city.savingDays ?? 0) + 1));
  return true;
}

/** 記録のない日が自動で確定したとき（HAB-01）：確定した日の数を足す（AUTO_DAYS_PER_SAVING_DAY 日分で貯金日1日） */
export function countAutoDays(city: CityState, days: number, bond: number, at: number, events: CityEvent[]) {
  if (days <= 0 || bond < 0) return;
  add(city, at, events, () => (city.autoSavedDays = (city.autoSavedDays ?? 0) + days));
}
