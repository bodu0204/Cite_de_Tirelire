// 悪い出来事（docs/savings-driven-growth.md §10）。建物を壊さず、人口も減らさず、工事を遅らせ・建物を一時休業させるだけ。
// 起きる日時と種類はシーズン（開始時刻）と日付から決定的に決める（同じ経過時間なら同じ結果。EVT-02）。
// 備えLv（債券残高。RSV-03）と幸福度（EVT-07）で被害が変わる。
import { tierDef } from "../catalog";
import {
  BLACKOUT,
  CROP_FAILURE,
  DAY,
  DISASTER_FROM_DAY,
  DISASTER_PER_DAY,
  FIRE_REOPEN_HOURS,
  HOUR,
  PRICE_SURGE,
  REPAIR_FUND_RATIO,
  TICK_MS,
  TYPHOON_HOURS,
} from "../config";
import { devLevel } from "../levels";
import { snapBuilding, type Building, type CityEvent, type CityState } from "../types";

export type DisasterKind = "typhoon" | "crop" | "fire" | "surge" | "blackout";

export const DISASTER_LABELS: Record<DisasterKind, string> = {
  typhoon: "台風",
  crop: "不作",
  fire: "火事",
  surge: "資材の値上がり",
  blackout: "停電",
};

/** シーズンと日付から決まる乱数 [0, 1) */
export function seasonRand(seed: number, ...keys: number[]): number {
  let h = (2166136261 ^ (seed % 4294967296) ^ Math.floor(seed / 4294967296)) >>> 0;
  for (const k of keys) h = Math.imul(h ^ Math.floor(k * 1000), 16777619) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const TICKS_PER_DAY = DAY / TICK_MS;

/** その日に起きる出来事（起きなければ null）。day はシーズンの日（1〜）、slot はその日の何ティック目（0〜143）に起きるか */
export function disasterOn(s: Pick<CityState, "startedAt" | "devPoints" | "techLevel">, day: number): { kind: DisasterKind; slot: number } | null {
  if (day < DISASTER_FROM_DAY) return null;
  const seed = s.startedAt;
  if (seasonRand(seed, day, 2) >= DISASTER_PER_DAY) return null;
  const dev = devLevel(s.devPoints);
  if (dev < 2) return null;
  const kinds: DisasterKind[] = ["typhoon", "crop"];
  if (dev >= 3) kinds.push("fire", "surge");
  if (s.techLevel >= 3) kinds.push("blackout");
  return { kind: kinds[Math.floor(seasonRand(seed, day, 3) * kinds.length)], slot: Math.floor(seasonRand(seed, day, 1) * TICKS_PER_DAY) };
}

/** 幸福度による被害の倍率（EVT-07）：70以上 ×0.75、40未満 ×1.25 */
export const moodFactor = (happiness: number) => (happiness >= 70 ? 0.75 : happiness < 40 ? 1.25 : 1);

/** 効果が今も続いているか */
export const active = (e: { until: number } | undefined, at: number) => !!e && e.until > at;

/** 休業させる建物の候補：道路以外の通常の建物で、休業していないもの */
const fireCandidates = (s: CityState) => s.buildings.filter((b) => b.line && b.line !== "road" && !b.closed && b.placed !== false);

/**
 * end で終わるティックに出来事が起きるなら起こす（tick から呼ぶ）。priceOf は建設資金での修繕費の計算に使う
 */
export function maybeDisaster(s: CityState, end: number, events: CityEvent[], priceOf: (s: CityState, b: Building) => number) {
  const day = Math.floor((end - 1 - s.startedAt) / DAY) + 1;
  const d = disasterOn(s, day);
  if (!d) return;
  const slot = Math.floor((end - TICK_MS - (s.startedAt + (day - 1) * DAY)) / TICK_MS);
  if (slot !== d.slot) return;

  const lv = s.reserveLevel ?? 0;
  const f = moodFactor(s.happiness) * (lv >= 1 ? 0.5 : 1);
  const prevented = lv >= 4 || (lv >= 2 && (d.kind === "typhoon" || d.kind === "surge"));
  const payload: Record<string, unknown> = { kind: d.kind, reserveLevel: lv, prevented };
  if (!prevented) {
    const fx = (s.effects ??= {});
    if (d.kind === "typhoon") {
      const ms = Math.max(TICK_MS, Math.round((TYPHOON_HOURS * HOUR * f) / TICK_MS) * TICK_MS);
      for (const j of s.jobs) j.finishAt += ms;
      fx.pauseUntil = Math.max(fx.pauseUntil ?? 0, end + ms);
      payload.hours = ms / HOUR;
    } else if (d.kind === "crop" || d.kind === "surge" || d.kind === "blackout") {
      const base = d.kind === "crop" ? CROP_FAILURE : d.kind === "surge" ? PRICE_SURGE : BLACKOUT;
      const effect = { until: end + base.hours * HOUR * f, rate: base.rate * f };
      fx[d.kind] = effect;
      payload.hours = base.hours * f;
      payload.percent = Math.round(effect.rate * 100);
    } else {
      // 火事：人口1,000人ごとに1棟増える（最大3棟）。備えLv3 からは建設資金から修繕費を払ってすぐ再開する
      const pool = fireCandidates(s);
      const n = Math.min(3, 1 + Math.floor(s.population / 1000), pool.length);
      const hit: Building[] = [];
      for (let i = 0; i < n; i++) hit.push(pool.splice(Math.floor(seasonRand(s.startedAt, day, 10 + i) * pool.length), 1)[0]);
      if (lv >= 3) {
        const cost = hit.reduce((a, b) => a + Math.ceil(priceOf(s, b) * REPAIR_FUND_RATIO), 0);
        s.treasury -= Math.min(Math.max(0, s.treasury), cost);
        payload.repaired = true;
        payload.cost = cost;
      } else {
        const closed = (s.closedUntil ??= {});
        for (const b of hit) {
          b.closed = true;
          closed[b.id] = end + FIRE_REOPEN_HOURS * HOUR;
        }
      }
      payload.buildings = hit.map(snapBuilding);
      payload.names = hit.map((b) => tierDef(b.line!, b.tier).name);
    }
  }
  events.push({ at: end, type: "DISASTER", auto: true, important: true, payload });
}

/** 火事で休業した建物を再開する（自動で再開する時刻が来たもの、または修繕したもの） */
export function reopen(s: CityState, b: Building, at: number, events: CityEvent[], by: "auto" | "silver") {
  b.closed = false;
  if (s.closedUntil) delete s.closedUntil[b.id];
  events.push({ at, type: "REPAIRED", auto: by === "auto", important: by === "silver", payload: { building: snapBuilding(b), name: tierDef(b.line!, b.tier).name, by } });
}

/** 自動で再開する時刻が来た建物を再開する（EVT-05：修繕しなくても72時間で再開） */
export function reopenDue(s: CityState, end: number, events: CityEvent[]) {
  if (!s.closedUntil) return;
  for (const [id, until] of Object.entries(s.closedUntil)) {
    if (until > end) continue;
    const b = s.buildings.find((o) => o.id === id);
    if (b) reopen(s, b, until, events, "auto");
    else delete s.closedUntil[id];
  }
}

/** 終わった効果を片付ける（保存する状態を小さく保つ） */
export function clearEffects(s: CityState, at: number) {
  const fx = s.effects;
  if (!fx) return;
  if ((fx.pauseUntil ?? 0) <= at) delete fx.pauseUntil;
  for (const k of ["crop", "surge", "blackout"] as const) if (fx[k] && !active(fx[k], at)) delete fx[k];
  if (!Object.keys(fx).length) delete s.effects;
}
