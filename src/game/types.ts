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
  /** 占有範囲の左上のマス（docs/map-layout-redesign.md §4.2）。銀行の中心が原点で、負もある */
  x: number;
  y: number;
  /** false はマップ外（土地が足りない特殊施設）。x, y は意味を持たない */
  placed?: false;
  /** 固定：自動開発の対象外、移動不可 */
  locked: boolean;
  /** 手動で配置・編集された（自動配置変更の対象外） */
  manual: boolean;
  /** 公園の閉園など */
  closed?: boolean;
  builtAt: number;
}

/** expand は区画の開拓（docs/map-layout-redesign.md §7.2） */
export type JobKind = "build" | "upgrade" | "evolve" | "expand";

export interface Job {
  id: string;
  kind: JobKind;
  auto: boolean;
  line: LineId;
  tier: number;
  level: number;
  /** upgrade / evolve の対象。build ならジョブ完了時に作られる建物ID。expand は "plot:px,py" */
  buildingId: string;
  /** 対象のマス。expand は区画の左上のマス */
  x: number;
  y: number;
  /** expand：開く区画（"px,py"）と、その土地用途（自動開発が土地を求めた建物の用途。手動は未指定） */
  plot?: string;
  zone?: Zone;
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
  /** false で自動開発の開拓を止める（省略すると開拓する。Q9） */
  autoExpand?: boolean;
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
  /** マスの土地用途（キーは "x,y"）。書いていないマスは未指定 */
  zones: Record<string, Zone>;
  /** 自動建設を禁止したマス（"x,y"） */
  noAuto: string[];
  /** 開拓した区画（"px,py"。区画 (px, py) はマス x = 5px〜5px+4、y = 5py〜5py+4） */
  plots: string[];
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
  | "PLOT_EXPANDED"
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
export type BuildingSnap = Pick<Building, "id" | "line" | "special" | "refId" | "tier" | "level" | "x" | "y" | "closed" | "placed">;

export function snapBuilding(b: Building): BuildingSnap {
  const s: BuildingSnap = { id: b.id, tier: b.tier, level: b.level, x: b.x, y: b.y };
  if (b.line) s.line = b.line;
  if (b.special) s.special = b.special;
  if (b.refId) s.refId = b.refId;
  if (b.closed) s.closed = true;
  if (b.placed === false) s.placed = false;
  return s;
}
