// シーズン開始時の街。
import { INITIAL_PLOTS, INITIAL_POPULATION, INITIAL_STOCK, INITIAL_TREASURY, PLOT_SIZE } from "../config";
import { DEFAULT_PRIORITIES, type Building, type CityPolicy, type CityState, type NeedKey } from "../types";
import { initialZones, isPlannedRoad } from "./layout";
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

/** 初期の道路：中心の 10×10 の推奨道路（docs/map-layout-redesign.md §7.1） */
function initialRoads(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = -PLOT_SIZE; y < PLOT_SIZE; y++)
    for (let x = -PLOT_SIZE; x < PLOT_SIZE; x++) if (isPlannedRoad(x, y)) out.push({ x, y });
  return out;
}

/** シーズン開始時の街。銀行（3×3）の中心が原点で、2×2 の建物を区画の四隅（docs/map-layout-redesign.md §7.1）に置く */
export function createCity(startAt: number, preset: CityPolicy["preset"] = "balanced"): CityState {
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
  const buildings: Building[] = [
    b("bank", -1, -1, { special: "bank", locked: true }),
    b("b1", -5, -2, { line: "housing" }),
    b("b2", -2, -5, { line: "housing" }),
    b("b3", -5, 0, { line: "farm" }),
    b("b4", 3, 0, { line: "lumber" }),
    // 区画の真ん中を通る推奨道路（x・y が −3 と 2 の列）。銀行を囲む輪になり、どの建物もこれに接する
    ...initialRoads().map(({ x, y }, i) => b(`b${5 + i}`, x, y, { line: "road" })),
  ];
  const priorities = preset === "custom" ? DEFAULT_PRIORITIES : POLICY_PRESETS[preset].priorities;
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
    // 初期建物は実績に数える（建て直しで稼げないように）
    peaks: { "n:housing": 2, "n:farm": 1, "n:lumber": 1, "n:road": buildings.filter((o) => o.line === "road").length },
    zones: initialZones(),
    noAuto: [],
    plots: [...INITIAL_PLOTS],
    policy: { preset, priorities: [...priorities], autoEnabled: true },
    techLevel: 1,
    bankLevel: 1,
    // b1, b2, … の次（銀行は名前の ID）
    nextId: buildings.length - 1 + 1,
    flags: { foodShort: false, powerShort: false },
  };
}
