import type { LineId, SpecialKind, Zone } from "./catalog";

export interface Stock {
  wood: number;
  stone: number;
  food: number;
}
export type StockKey = keyof Stock;
/** 交換で得られるもの：備蓄資源と都市資金 */
export interface Gains extends Stock {
  treasury: number;
}
export type GainKey = keyof Gains;

export interface Building {
  id: string;
  /** 通常建物は line を持ち、特殊施設は special を持つ */
  line?: LineId;
  special?: SpecialKind;
  /** 公園ならサブスクID、像ならほしい物ID */
  refId?: string;
  tier: number;
  level: number;
  /** -1 はマップ外（土地が足りない特殊施設） */
  x: number;
  y: number;
  /** 固定：自動開発の対象外、移動不可 */
  locked: boolean;
  /** 手動で配置・編集された（自動配置変更の対象外） */
  manual: boolean;
  /** 公園の閉園など */
  closed?: boolean;
  builtAt: number;
}

export type JobKind = "build" | "upgrade" | "evolve";

export interface Job {
  id: string;
  kind: JobKind;
  auto: boolean;
  line: LineId;
  tier: number;
  level: number;
  /** upgrade / evolve の対象。build ならジョブ完了時に作られる建物ID */
  buildingId: string;
  x: number;
  y: number;
  startedAt: number;
  finishAt: number;
}

export type NeedKey = "shortage" | "jobs" | "housing" | "logistics" | "efficiency" | "industry" | "beautify";

export const DEFAULT_PRIORITIES: NeedKey[] = [
  "shortage",
  "jobs",
  "housing",
  "logistics",
  "efficiency",
  "industry",
  "beautify",
];

export interface CityPolicy {
  preset: "balanced" | "housing" | "industry" | "commerce" | "custom";
  priorities: NeedKey[];
  /** false で自動開発を止める */
  autoEnabled: boolean;
}

export interface CityState {
  v: 1;
  /** シミュレーション済みの時刻（TICK_MS に揃う） */
  simTime: number;
  buildings: Building[];
  jobs: Job[];
  stock: Stock;
  treasury: number;
  population: number;
  peakPopulation: number;
  happiness: number;
  devPoints: number;
  /** 建築実績の最高記録。重複計上を防ぐ（"line:tier" → 棟数, "lv:line" → Lv合計） */
  peaks: Record<string, number>;
  zones: Zone[];
  /** 自動建設を禁止したマス */
  noAuto: boolean[];
  policy: CityPolicy;
  techLevel: number;
  /** 銀行Lv（達成率から決まる。タイムラプスの外観用に街の状態にも持つ） */
  bankLevel: number;
  nextId: number;
  flags: { foodShort: boolean; powerShort: boolean };
  /** 債券化（採掘・ユーザ通貨の余り）で資源をつける額のうち、まだ資源にしていない分（金貨換算）。次のティックの前に資源にする */
  bondResourcePending?: number;
  /** 債券化で得た資源の累計（放置中の変化の表示用） */
  bondResourceTotal?: Gains;
}

export type CityEventType =
  | "BUILD"
  | "UPGRADE"
  | "EVOLVE"
  | "DEMOLISH"
  | "MOVE"
  | "TECH_UNLOCKED"
  | "DEV_LEVEL"
  | "DISTRICT_UNLOCKED"
  | "POPULATION"
  | "SHORTAGE_STARTED"
  | "SHORTAGE_RESOLVED"
  | "BANK_LEVEL"
  | "GOLD_MINE_LEVEL"
  | "SILVER_MINE_LEVEL"
  | "PARK_OPENED"
  | "PARK_CLOSED"
  | "STATUE_PROGRESS"
  | "STATUE_COMPLETED"
  | "SAVINGS_MILESTONE"
  | "SEASON_STARTED"
  | "SEASON_COMPLETED";

export interface CityEvent {
  at: number;
  type: CityEventType;
  auto: boolean;
  /** 自動発展ログに出す重要イベントか */
  important: boolean;
  payload: Record<string, unknown>;
}

/** タイムラプス再生用の建物の要約 */
export type BuildingSnap = Pick<Building, "id" | "line" | "special" | "refId" | "tier" | "level" | "x" | "y" | "closed">;

export function snapBuilding(b: Building): BuildingSnap {
  const s: BuildingSnap = { id: b.id, tier: b.tier, level: b.level, x: b.x, y: b.y };
  if (b.line) s.line = b.line;
  if (b.special) s.special = b.special;
  if (b.refId) s.refId = b.refId;
  if (b.closed) s.closed = true;
  return s;
}
