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
  // v1 は 10×10 の (4, 4) に銀行。v2 は銀行の中心が原点
  const o = layout === 1 ? 4 : 0;
  const buildings: Building[] = [
    b("bank", o, o, { special: "bank", locked: true }),
    b("gold_mine", o + 1, o, { special: "gold_mine", locked: true }),
    b("silver_mine", o, o + 1, { special: "silver_mine", locked: true }),
    b("b1", o - 1, o - 1, { line: "housing" }),
    b("b2", o - 1, o, { line: "housing" }),
    b("b3", o - 1, o + 1, { line: "farm" }),
    b("b4", o + 2, o + 1, { line: "lumber" }),
    b("b5", o, o + 2, { line: "road" }),
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
