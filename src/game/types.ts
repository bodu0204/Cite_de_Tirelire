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
  /** 公園の閉園など */
  closed?: boolean;
  builtAt: number;
}

/** expand は区画の開拓（docs/map-layout-redesign.md §7.2） */
export type JobKind = "build" | "upgrade" | "evolve" | "expand";

export interface Job {
  id: string;
  kind: JobKind;
  line: LineId;
  tier: number;
  level: number;
  /** upgrade / evolve の対象。build ならジョブ完了時に作られる建物ID。expand は "plot:px,py" */
  buildingId: string;
  /** 対象のマス。expand は区画の左上のマス */
  x: number;
  y: number;
  /** expand：開く区画（"px,py"）と、その土地用途（土地を求めた建物の用途） */
  plot?: string;
  zone?: Zone;
  startedAt: number;
  finishAt: number;
  /** 着工時に払った値段（円）。完成すると発展ptに数える（GRW-04） */
  price?: number;
}

export type NeedKey = "shortage" | "jobs" | "housing" | "logistics" | "efficiency" | "industry" | "beautify";

/**
 * 街の発展が必要事項を検討する順（すべての街で同じ）。新産業は系統ごとに1棟目だけなので、雇用・住宅より先にしても
 * ほかを長く待たせない（docs/savings-driven-growth.md GRW-07）
 */
export const NEED_ORDER: NeedKey[] = [
  "shortage",
  "industry",
  "jobs",
  "housing",
  "logistics",
  "efficiency",
  "beautify",
];

export interface CityState {
  v: 1;
  /** シミュレーション済みの時刻（TICK_MS に揃う） */
  simTime: number;
  buildings: Building[];
  jobs: Job[];
  /** 食料だけを使う。木材・石材は建物の見た目にだけ残し、在庫には持たない（docs/savings-driven-growth.md GRW-02） */
  stock: Stock;
  /** 建設資金（円）。貯金からだけ入り、計画の値段を払う（GRW-01） */
  treasury: number;
  population: number;
  peakPopulation: number;
  happiness: number;
  /** 発展pt ＝ 完成した計画の累計額 ÷ 基準額 × 1000（GRW-04） */
  devPoints: number;
  /** 基準額（円）：シーズン開始時の月間自由予算と目標額の小さいほう。値段と発展Lv・技術Lvの閾値の単位（PRC-05・PRC-06） */
  base: number;
  /** 完成した計画の累計額（円） */
  completed: number;
  /** シーズン開始時刻（開拓期ボーナスの判定。ERL-01） */
  startedAt: number;
  /** 開拓期ボーナスで増えた建設資金の累計（円。上限 ERL-02） */
  earlyBonus: number;
  /** 建築実績の最高記録。重複計上を防ぐ（"line:tier" → 棟数, "lv:line" → Lv合計） */
  peaks: Record<string, number>;
  /** マスの土地用途（キーは "x,y"）。書いていないマスは未指定 */
  zones: Record<string, Zone>;
  /** 開拓した区画（"px,py"。区画 (px, py) はマス x = 5px〜5px+4、y = 5py〜5py+4） */
  plots: string[];
  techLevel: number;
  /** 銀行Lv（達成率から決まる。タイムラプスの外観用に街の状態にも持つ） */
  bankLevel: number;
  nextId: number;
  flags: { foodShort: boolean; powerShort: boolean };
  /** 債券化（採掘・ユーザ通貨の余り）で建設資金をつける額のうち、まだ街に入れていない分（金貨換算）。次のティックの前に入れる */
  bondResourcePending?: number;
  /** 債券化で得た建設資金の累計（放置中の変化の表示用。treasury だけを使う） */
  bondResourceTotal?: Gains;
  /** 債券の利息で得た建設資金の累計（円。RSV-02） */
  interestTotal?: number;
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
  /** 街が自ら起こしたできごと（建設・人口・不足など）。家計から起きたもの（公園・像・技術Lv・銀行など）は false */
  auto: boolean;
  /** 街のできごとに出す重要イベントか */
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
