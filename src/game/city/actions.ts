// プレイヤーの手動操作と、特殊施設（公園・像）の同期。
import { evolveCost, isTierUnlocked, highestUnlockedTier, LINES, tierDef, upgradeCost, upgradeMinutes, type LineId, type Zone } from "../catalog";
import { FEE_MOVE, FEE_RUSH_PER_10MIN, feeBuild, feeUpgrade, MINUTE } from "../config";
import { fail } from "../errors";
import { devLevel, statueRank } from "../levels";
import { snapBuilding, type Building, type CityEvent, type CityPolicy, type CityState, type NeedKey } from "../types";
import { findSpecialSite, idx, inBounds, isTileUnlocked, occupancy } from "./layout";
import { buildingName, canAfford, finishJob, levelCap, newId, startJob } from "./sim";

function requireBuilding(s: CityState, id: string): Building {
  return s.buildings.find((b) => b.id === id) ?? fail("not_found", "建物が見つかりません", 404);
}

function requireSilver(silver: number, fee: number) {
  if (silver < fee) fail("silver_short", `銀貨が足りません（必要 ${fee}S）`);
}

function requireMaterials(s: CityState, cost: { wood: number; stone: number }) {
  if (!canAfford(s, { ...cost, treasury: 0 }, false)) {
    fail("materials_short", `資材が足りません（木材 ${cost.wood}・石材 ${cost.stone}）`);
  }
}

function requireFreeTile(s: CityState, x: number, y: number) {
  if (!inBounds(x, y)) fail("bad_tile", "マップの外です");
  if (!isTileUnlocked(x, y, devLevel(s.devPoints))) fail("locked_tile", "まだ解放されていない区画です");
  if (occupancy(s)[idx(x, y)]) fail("occupied", "そのマスは使用中です");
}

export interface ManualResult {
  silverFee: number;
}

/** 手動建設：資材＋銀貨手数料で支払う（都市資金は使わない） */
export function manualBuild(s: CityState, input: { line: LineId; tier?: number; x: number; y: number }, now: number, silver: number): ManualResult {
  if (!LINES[input.line]) fail("bad_line", "建物の種類が不正です");
  const dev = devLevel(s.devPoints);
  const tier = input.tier ?? highestUnlockedTier(input.line, s.techLevel, dev);
  if (tier < 0 || !isTierUnlocked(input.line, tier, s.techLevel, dev)) fail("not_unlocked", "まだ解放されていない建物です");
  requireFreeTile(s, input.x, input.y);
  const t = tierDef(input.line, tier);
  const fee = feeBuild(tier);
  requireSilver(silver, fee);
  requireMaterials(s, t.cost);
  startJob(s, { kind: "build", line: input.line, tier, level: 1, site: { x: input.x, y: input.y }, cost: t.cost, minutes: t.buildMinutes }, now, false);
  return { silverFee: fee };
}

function requireIdle(s: CityState, b: Building) {
  if (s.jobs.some((j) => j.buildingId === b.id)) fail("busy", "工事中の建物です");
}

export function manualUpgrade(s: CityState, id: string, now: number, silver: number): ManualResult {
  const b = requireBuilding(s, id);
  if (!b.line) fail("special", "この施設はアップグレードできません");
  requireIdle(s, b);
  if (b.level >= levelCap(devLevel(s.devPoints))) fail("level_cap", "建物Lvの上限です。発展Lvを上げると上限が上がります");
  const cost = upgradeCost(b.line!, b.tier, b.level);
  const fee = feeUpgrade(b.level);
  requireSilver(silver, fee);
  requireMaterials(s, cost);
  b.manual = true;
  startJob(s, { kind: "upgrade", line: b.line!, tier: b.tier, level: b.level + 1, building: b, cost, minutes: upgradeMinutes(b.line!, b.tier, b.level) }, now, false);
  return { silverFee: fee };
}

export function manualEvolve(s: CityState, id: string, now: number, silver: number): ManualResult {
  const b = requireBuilding(s, id);
  if (!b.line) fail("special", "この施設は進化しません");
  requireIdle(s, b);
  const to = b.tier + 1;
  if (!isTierUnlocked(b.line!, to, s.techLevel, devLevel(s.devPoints))) fail("not_unlocked", "次の段階はまだ解放されていません");
  const cost = evolveCost(b.line!, to);
  const fee = feeBuild(to);
  requireSilver(silver, fee);
  requireMaterials(s, cost);
  b.manual = true;
  startJob(s, { kind: "evolve", line: b.line!, tier: to, level: b.level, building: b, cost, minutes: tierDef(b.line!, to).buildMinutes }, now, false);
  return { silverFee: fee };
}

export function moveBuilding(s: CityState, id: string, x: number, y: number, now: number, silver: number, events: CityEvent[]): ManualResult {
  const b = requireBuilding(s, id);
  if (b.locked && !b.special) fail("locked", "固定された建物は移動できません。固定を解除してください");
  requireIdle(s, b);
  requireFreeTile(s, x, y);
  requireSilver(silver, FEE_MOVE);
  const from = { x: b.x, y: b.y };
  b.x = x;
  b.y = y;
  b.manual = true;
  events.push({ at: now, type: "MOVE", auto: false, important: false, payload: { building: snapBuilding(b), from } });
  return { silverFee: FEE_MOVE };
}

export function demolish(s: CityState, id: string, now: number, events: CityEvent[]): void {
  const b = requireBuilding(s, id);
  if (b.special === "bank" || b.special === "gold_mine" || b.special === "silver_mine") fail("special", "この施設は撤去できません");
  if (b.special === "statue") fail("special", "像はほしい物リストから管理します");
  if (b.special === "park" && !b.closed) fail("special", "契約中のサブスクの公園は撤去できません");
  requireIdle(s, b);
  s.buildings = s.buildings.filter((o) => o.id !== id);
  events.push({ at: now, type: "DEMOLISH", auto: false, important: true, payload: { buildingId: id, name: b.line ? buildingName(b) : "閉園した公園" } });
}

export function rushFee(s: CityState, jobId: string, now: number): number {
  const job = s.jobs.find((j) => j.id === jobId) ?? fail("not_found", "工事が見つかりません", 404);
  return Math.max(1, Math.ceil(Math.max(0, job.finishAt - now) / (10 * MINUTE))) * FEE_RUSH_PER_10MIN;
}

/** 即時完了（建築時間の短縮） */
export function rushJob(s: CityState, jobId: string, now: number, silver: number, events: CityEvent[]): ManualResult {
  const fee = rushFee(s, jobId, now);
  requireSilver(silver, fee);
  const job = s.jobs.find((j) => j.id === jobId)!;
  finishJob(s, job, now, events);
  return { silverFee: fee };
}

export function setLocked(s: CityState, id: string, locked: boolean) {
  const b = requireBuilding(s, id);
  if (b.special && b.special !== "park" && b.special !== "statue") fail("special", "この施設は常に固定です");
  b.locked = locked;
}

const ZONES: Zone[] = ["residential", "commercial", "industrial", "agricultural", "public", "special", "none"];

export function setZone(s: CityState, x: number, y: number, zone: Zone) {
  if (!inBounds(x, y)) fail("bad_tile", "マップの外です");
  if (!ZONES.includes(zone)) fail("bad_zone", "土地用途が不正です");
  s.zones[idx(x, y)] = zone;
}

export function setNoAuto(s: CityState, x: number, y: number, noAuto: boolean) {
  if (!inBounds(x, y)) fail("bad_tile", "マップの外です");
  s.noAuto[idx(x, y)] = noAuto;
}

const NEEDS: NeedKey[] = ["shortage", "jobs", "housing", "logistics", "efficiency", "industry", "beautify"];

export function setPolicy(s: CityState, policy: Partial<CityPolicy>) {
  if (policy.priorities) {
    const p = policy.priorities;
    if (p.length !== NEEDS.length || NEEDS.some((n) => !p.includes(n))) fail("bad_policy", "優先順位が不正です");
    s.policy.priorities = [...p];
  }
  if (policy.preset) s.policy.preset = policy.preset;
  if (typeof policy.autoEnabled === "boolean") s.policy.autoEnabled = policy.autoEnabled;
}

// ---- 公園（サブスク） ----

export interface ParkSource {
  id: string;
  name: string;
  monthly: number;
  active: boolean;
}

export function parkSize(monthly: number): number {
  if (monthly >= 3000) return 3;
  if (monthly >= 1500) return 2;
  if (monthly >= 500) return 1;
  return 0;
}

export function syncParks(s: CityState, subs: ParkSource[], now: number, events: CityEvent[]) {
  const dev = devLevel(s.devPoints);
  const ids = new Set(subs.map((x) => x.id));
  for (const b of s.buildings.filter((b) => b.special === "park" && b.refId && !ids.has(b.refId))) {
    s.buildings = s.buildings.filter((o) => o.id !== b.id);
    events.push({ at: now, type: "DEMOLISH", auto: false, important: true, payload: { buildingId: b.id, name: "公園" } });
  }
  for (const sub of subs) {
    const park = s.buildings.find((b) => b.special === "park" && b.refId === sub.id);
    const tier = parkSize(sub.monthly);
    if (!park) {
      if (!sub.active) continue;
      const site = findSpecialSite(s, dev) ?? { x: -1, y: -1 };
      const b: Building = { id: newId(s), special: "park", refId: sub.id, tier, level: 1, x: site.x, y: site.y, locked: false, manual: false, builtAt: now };
      s.buildings.push(b);
      events.push({ at: now, type: "PARK_OPENED", auto: false, important: true, payload: { building: snapBuilding(b), name: sub.name } });
      continue;
    }
    park.tier = tier;
    if (park.closed && sub.active) {
      park.closed = false;
      events.push({ at: now, type: "PARK_OPENED", auto: false, important: true, payload: { building: snapBuilding(park), name: sub.name } });
    } else if (!park.closed && !sub.active) {
      park.closed = true;
      events.push({ at: now, type: "PARK_CLOSED", auto: false, important: true, payload: { building: snapBuilding(park), name: sub.name } });
    }
  }
}

// ---- 像（ほしい物） ----

export interface StatueSource {
  id: string;
  name: string;
  price: number;
  /** 0〜1 */
  progress: number;
  purchased: boolean;
}

const RANKS = ["bronze", "silver", "gold"] as const;

/** 像の level は進捗の段階（0〜4）。5 は購入済みで完成 */
export function statueStage(src: StatueSource): number {
  if (src.purchased) return 5;
  return Math.min(4, Math.floor(src.progress * 4 + 1e-9));
}

export function syncStatues(s: CityState, wishes: StatueSource[], now: number, events: CityEvent[]) {
  const dev = devLevel(s.devPoints);
  const ids = new Set(wishes.map((w) => w.id));
  for (const b of s.buildings.filter((b) => b.special === "statue" && b.refId && !ids.has(b.refId))) {
    s.buildings = s.buildings.filter((o) => o.id !== b.id);
    events.push({ at: now, type: "DEMOLISH", auto: false, important: false, payload: { buildingId: b.id, name: "像" } });
  }
  for (const w of wishes) {
    let statue = s.buildings.find((b) => b.special === "statue" && b.refId === w.id);
    const tier = RANKS.indexOf(statueRank(w.price));
    const stage = statueStage(w);
    if (!statue) {
      const site = findSpecialSite(s, dev) ?? { x: -1, y: -1 };
      statue = { id: newId(s), special: "statue", refId: w.id, tier, level: 0, x: site.x, y: site.y, locked: false, manual: false, builtAt: now };
      s.buildings.push(statue);
      events.push({ at: now, type: "STATUE_PROGRESS", auto: false, important: false, payload: { building: snapBuilding(statue), name: w.name, progress: 0 } });
    }
    statue.tier = tier;
    if (stage !== statue.level) {
      const rising = stage > statue.level;
      statue.level = stage;
      if (stage === 5) {
        events.push({ at: now, type: "STATUE_COMPLETED", auto: false, important: true, payload: { building: snapBuilding(statue), name: w.name } });
      } else {
        events.push({
          at: now,
          type: "STATUE_PROGRESS",
          auto: false,
          important: rising && stage === 4,
          payload: { building: snapBuilding(statue), name: w.name, progress: stage * 25 },
        });
      }
    }
  }
}

/** マップ外に置かれた特殊施設を、区画が解放されたら配置する */
export function placeOffMapSpecials(s: CityState) {
  const dev = devLevel(s.devPoints);
  for (const b of s.buildings) {
    if (b.x >= 0 || !b.special) continue;
    const site = findSpecialSite(s, dev);
    if (!site) return;
    b.x = site.x;
    b.y = site.y;
  }
}
