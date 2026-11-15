// 貯金日とこまめボーナス（docs/saving-habit-balance.md HAB-01〜04）。
// こまめに貯金する（使い過ぎずに貯金が出る日が多い）ほど、区画の上限が増えて街が広くなる。
// プレイヤーに何かを確定させない：放置計算が1日の終わりごとに、その日に持ち分が増えたかを自動で見る。
// 持ち分 ＝ 未回収の金貨 ＋ 所持金貨 ＋ 債券 ＋ 欲しいもの貯金 ＋ ゲーム内で使った金貨（savingsHoldings）。
// 配当で増え、支出（購入・誤差調整の−）で減る。受け取り・確定・交換・積立は持ち分の中の移動なので変わらない。
// 債券がマイナス（使い過ぎ）の間は数えない。累計なので、途切れても減らない。
import { habitPlots } from "./city/layout";
import { startOfDay } from "./currency";
import { DAY, MICRO_PER_GOLD } from "./config";
import type { Purse } from "./settle";
import type { CityEvent, CityState } from "./types";

/** 貯金日を1つ足し、こまめボーナスの区画が増えたら知らせる */
export function countSavingDay(city: CityState, at: number, events: CityEvent[]) {
  const before = habitPlots(city.savingDays);
  city.savingDays = (city.savingDays ?? 0) + 1;
  const after = habitPlots(city.savingDays);
  if (after > before) events.push({ at, type: "HABIT_PLOT", auto: true, important: true, payload: { plots: after, added: after - before, savingDays: city.savingDays } });
}

/**
 * 持ち分（G）：未回収の金貨 ＋ 所持金貨 ＋ 債券 ＋ base。base は欲しいもの貯金とゲーム内で使った金貨の累計（放置計算の外で決まる分）
 */
export function savingsHoldings(p: Pick<Purse, "mine" | "gold" | "bond">, base: number): number {
  return Number(p.mine.uncollected) / Number(MICRO_PER_GOLD) + p.gold + p.bond + base;
}

/**
 * ティックの終わり（at）ごとに呼ぶ。ユーザーのタイムゾーンで日が替わっていれば、前の日に持ち分が増えていたら貯金日に数え、
 * 新しい日の始まりの持ち分を覚える。最初の呼び出しでは覚えるだけ
 */
export function trackSavingDay(city: CityState, at: number, tz: string, holdings: number, bond: number, events: CityEvent[]) {
  const day = startOfDay(at, tz);
  const d = city.habitDay;
  if (!d) {
    city.habitDay = { day, holdings };
    return;
  }
  if (day <= d.day) return;
  // 端数の誤差で数えないよう、1G 未満の増えは数えない
  if (holdings - d.holdings >= 1 && bond >= 0) countSavingDay(city, at, events);
  city.habitDay = { day, holdings };
}

/**
 * 貯金日を持たない街・記録で数えていた街（2026-11-14 の形）を直す。直したら true。
 * - 持たない街：シーズンが始まってから終わった日の数（債券がマイナスなら 0）から始める（日ごとの持ち分の増えは残っていないため）
 * - 記録で数えていた街：記録の日はそのまま、自動の確定の日（7日分で1日）を足し、使わなくなった値を消す
 */
export function migrateSavingDays(city: CityState, o: { now: number; startedAt: number; bond: number }): boolean {
  const old = city as CityState & { autoSavedDays?: number; lastSavingDay?: string };
  if (old.autoSavedDays !== undefined || old.lastSavingDay !== undefined) {
    city.savingDays = (city.savingDays ?? 0) + Math.floor((old.autoSavedDays ?? 0) / 7);
    delete old.autoSavedDays;
    delete old.lastSavingDay;
    return true;
  }
  if (city.savingDays !== undefined) return false;
  city.savingDays = o.bond < 0 ? 0 : Math.max(0, Math.floor((o.now - o.startedAt) / DAY));
  return true;
}
