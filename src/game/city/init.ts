// シーズン開始時の街。
import { INITIAL_PLOTS, INITIAL_POPULATION, INITIAL_STOCK, INITIAL_TREASURY } from "../config";
import { DEFAULT_PRIORITIES, type Building, type CityLayout, type CityPolicy, type CityState, type NeedKey } from "../types";
import { initialZones, legacyZones } from "./layout";
import { alignTick } from "./sim";

export const POLICY_PRESETS: Record<Exclude<CityPolicy["preset"], "custom">, { label: string; priorities: NeedKey[] }> = {
  balanced: { label: "バランス", priorities: DEFAULT_PRIORITIES },
  housing: {
    label: "住宅優先",
    priorities: ["shortage", "housing", "jobs", "logistics", "efficiency", "industry", "beautify"],
  },
  industry: {
    label: "産業優先",
    priorities: ["shortage", "jobs", "industry", "efficiency", "housing", "logistics", "beautify"],
  },
  commerce: {
    label: "商業優先",
    priorities: ["shortage", "jobs", "housing", "industry", "logistics", "efficiency", "beautify"],
  },
};

export const NEED_LABELS: Record<NeedKey, string> = {
  shortage: "食料・電力・資材の不足解消",
  jobs: "雇用不足の解消",
  housing: "住宅不足の解消",
  logistics: "物流能力の改善",
  efficiency: "生産効率の改善（進化・Lvアップ）",
  industry: "新産業への投資",
  beautify: "余剰資金による景観改善",
};

/**
 * シーズン開始時の街。layout 1 は 10×10 固定の古い盤面（テストと、古いシーズンの確認用。docs/map-layout-redesign.md §6.5）
 */
export function createCity(startAt: number, preset: CityPolicy["preset"] = "balanced", layout: CityLayout = 2): CityState {
  const t = alignTick(startAt);
  const b = (id: string, x: number, y: number, extra: Partial<Building>): Building => ({
    id,
    tier: 0,
    level: 1,
    x,
    y,
    locked: false,
    manual: false,
    builtAt: t,
    ...extra,
  });
  // v1 は 10×10 の (4, 4) に銀行、まわりに1マスずつ。
  // v2 は銀行（3×3）の中心が原点で、2×2 の建物を区画の四隅（docs/map-layout-redesign.md §7.1）に置く
  const buildings: Building[] =
    layout === 1
      ? [
          b("bank", 4, 4, { special: "bank", locked: true }),
          b("gold_mine", 5, 4, { special: "gold_mine", locked: true }),
          b("silver_mine", 4, 5, { special: "silver_mine", locked: true }),
          b("b1", 3, 3, { line: "housing" }),
          b("b2", 3, 4, { line: "housing" }),
          b("b3", 3, 5, { line: "farm" }),
          b("b4", 6, 5, { line: "lumber" }),
          b("b5", 4, 6, { line: "road" }),
        ]
      : [
          b("bank", -1, -1, { special: "bank", locked: true }),
          b("gold_mine", 3, -2, { special: "gold_mine", locked: true }),
          b("silver_mine", -2, 3, { special: "silver_mine", locked: true }),
          b("b1", -5, -2, { line: "housing" }),
          b("b2", -2, -5, { line: "housing" }),
          b("b3", -5, 0, { line: "farm" }),
          b("b4", 3, 0, { line: "lumber" }),
          b("b5", 2, 1, { line: "road" }),
        ];
  const priorities = preset === "custom" ? DEFAULT_PRIORITIES : POLICY_PRESETS[preset].priorities;
  return {
    v: layout,
    simTime: t,
    buildings,
    jobs: [],
    stock: { ...INITIAL_STOCK },
    treasury: INITIAL_TREASURY,
    population: INITIAL_POPULATION,
    peakPopulation: INITIAL_POPULATION,
    happiness: 60,
    devPoints: 0,
    // 初期建物は実績に数える（建て直しで稼げないように）
    peaks: { "n:housing": 2, "n:farm": 1, "n:lumber": 1, "n:road": 1 },
    zones: layout === 1 ? legacyZones() : initialZones(),
    noAuto: [],
    ...(layout === 1 ? {} : { plots: [...INITIAL_PLOTS] }),
    policy: { preset, priorities: [...priorities], autoEnabled: true },
    techLevel: 1,
    bankLevel: 1,
    nextId: 6,
    flags: { foodShort: false, powerShort: false },
  };
}
