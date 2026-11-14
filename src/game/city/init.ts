// シーズン開始時の街。
import { DEV_POINTS_PER_BASE, DEV_THRESHOLDS, LEGACY_FUND_PRICE_KAPPA, GOLD_RESOURCE_VALUE, INITIAL_PLOTS, INITIAL_POPULATION, INITIAL_STOCK, INITIAL_TREASURY, PLOT_SIZE } from "../config";
import type { Building, CityState } from "../types";
import { initialZones, isPlannedRoad } from "./layout";
import { alignTick } from "./sim";

/** 初期の道路：中心の 10×10 の推奨道路（docs/map-layout-redesign.md §7.1） */
function initialRoads(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = -PLOT_SIZE; y < PLOT_SIZE; y++)
    for (let x = -PLOT_SIZE; x < PLOT_SIZE; x++) if (isPlannedRoad(x, y)) out.push({ x, y });
  return out;
}

/** 基準額：月間自由予算と目標額の小さいほう（docs/savings-driven-growth.md PRC-06）。0 以下なら 1 */
export function seasonBase(monthlyBudget: number, goal: number): number {
  return Math.max(1, Math.min(monthlyBudget, goal));
}

/**
 * シーズン開始時の街。銀行（3×3）の中心が原点で、2×2 の建物を区画の四隅（docs/map-layout-redesign.md §7.1）に置く。
 * base は基準額（seasonBase）
 */
export function createCity(startAt: number, base: number): CityState {
  const t = alignTick(startAt);
  const b = (id: string, x: number, y: number, extra: Partial<Building>): Building => ({
    id,
    tier: 0,
    level: 1,
    x,
    y,
    builtAt: t,
    ...extra,
  });
  const buildings: Building[] = [
    b("bank", -1, -1, { special: "bank" }),
    b("b1", -5, -2, { line: "housing" }),
    b("b2", -2, -5, { line: "housing" }),
    b("b3", -5, 0, { line: "farm" }),
    b("b4", 3, 0, { line: "lumber" }),
    // 区画の真ん中を通る推奨道路（x・y が −3 と 2 の列）。銀行を囲む輪になり、どの建物もこれに接する
    ...initialRoads().map(({ x, y }, i) => b(`b${5 + i}`, x, y, { line: "road" })),
  ];
  return {
    v: 1,
    simTime: t,
    buildings,
    jobs: [],
    stock: { ...INITIAL_STOCK },
    treasury: INITIAL_TREASURY,
    population: INITIAL_POPULATION,
    peakPopulation: INITIAL_POPULATION,
    happiness: 60,
    devPoints: 0,
    base,
    completed: 0,
    startedAt: t,
    earlyBonus: 0,
    // 初期建物は実績に数える（建て直しで稼げないように）
    peaks: { "n:housing": 2, "n:farm": 1, "n:lumber": 1, "n:road": buildings.filter((o) => o.line === "road").length },
    zones: initialZones(),
    plots: [...INITIAL_PLOTS],
    techLevel: 1,
    bankLevel: 1,
    // b1, b2, … の次（銀行は名前の ID）
    nextId: buildings.length - 1 + 1,
    flags: { foodShort: false, powerShort: false },
    // 貯金日（docs/saving-habit-balance.md HAB-01）
    savingDays: 0,
    autoSavedDays: 0,
  };
}

/** 以前の（街が自分で稼ぐ）発展ptの閾値。移行で発展Lvを保つのに使う */
const LEGACY_DEV_THRESHOLDS = [0, 50, 150, 350, 700, 1200];

/**
 * 貯金で育つ街（docs/savings-driven-growth.md）より前の街を読み込んだときに直す。基準額を持たない街だけが対象。
 * - 発展Lvはそのまま保つ（完成した計画の累計額を、そのLvの閾値の額にする）
 * - 木材・石材・都市資金は、計画の値段と同じ換算で建設資金（円）にする
 * 直したら true
 */
export function migrateCity(s: CityState, opts: { base: number; startedAt: number }): boolean {
  if (typeof s.base === "number" && s.base > 0) return false;
  const base = Math.max(1, opts.base);
  let lv = 1;
  LEGACY_DEV_THRESHOLDS.forEach((v, i) => {
    if (s.devPoints >= v) lv = i + 1;
  });
  s.base = base;
  s.devPoints = DEV_THRESHOLDS[lv - 1];
  s.completed = (s.devPoints / DEV_POINTS_PER_BASE) * base;
  const rel = s.stock.wood / GOLD_RESOURCE_VALUE.wood + s.stock.stone / GOLD_RESOURCE_VALUE.stone + s.treasury / GOLD_RESOURCE_VALUE.treasury;
  s.treasury = Math.max(0, Math.floor(rel * LEGACY_FUND_PRICE_KAPPA * base));
  s.stock.wood = 0;
  s.stock.stone = 0;
  s.startedAt = opts.startedAt;
  s.earlyBonus = 0;
  return true;
}
