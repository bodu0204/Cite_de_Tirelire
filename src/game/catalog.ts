// 建物カタログ：系統（ライン）× 段階（ティア）。生産・消費・建設費はここから算出する。
import { BUILD_TIME_SCALE, REVENUE_SCALE, TREASURY_COST_SCALE } from "./config";

export type LineId =
  | "housing"
  | "farm"
  | "lumber"
  | "quarry"
  | "factory"
  | "commerce"
  | "office"
  | "road"
  | "power"
  | "rail"
  | "logistics"
  | "school"
  | "clinic"
  | "culture"
  | "future";

export type Zone =
  | "residential"
  | "commercial"
  | "industrial"
  | "agricultural"
  | "public"
  | "special"
  | "none";

export type Category = "housing" | "agriculture" | "industry" | "commerce" | "infra" | "public" | "future";

export interface Cost {
  wood: number;
  stone: number;
  treasury: number;
}

/** 1時間あたりの値。建物Lv倍率などを掛ける前の基本値 */
export interface TierDef {
  name: string;
  tech: number;
  dev: number;
  cost: Cost;
  buildMinutes: number;
  housing?: number;
  workers?: number;
  power?: number; // 需要
  powerSupply?: number;
  food?: number;
  wood?: number;
  stone?: number;
  revenue?: number; // 都市資金
  customers?: number; // 商業の受け入れ人数
  logistics?: number; // 物流容量（建物何棟分）
  serve?: number; // 公共施設がカバーする人口
  happiness?: number;
}

export interface LineDef {
  id: LineId;
  label: string;
  category: Category;
  zone: Zone | "any";
  tiers: TierDef[];
}

const c = (wood: number, stone: number, treasury: number): Cost => ({ wood, stone, treasury });

export const LINES: Record<LineId, LineDef> = {
  housing: {
    id: "housing",
    label: "住宅",
    category: "housing",
    zone: "residential",
    tiers: [
      { name: "小屋", tech: 1, dev: 1, cost: c(15, 0, 30), buildMinutes: 20, housing: 4 },
      { name: "木造住宅", tech: 2, dev: 1, cost: c(40, 0, 80), buildMinutes: 40, housing: 7 },
      { name: "レンガ住宅", tech: 3, dev: 2, cost: c(40, 40, 180), buildMinutes: 60, housing: 12, power: 1 },
      { name: "集合住宅", tech: 4, dev: 3, cost: c(60, 90, 400), buildMinutes: 90, housing: 22, power: 2 },
      { name: "マンション", tech: 4, dev: 4, cost: c(80, 150, 700), buildMinutes: 120, housing: 36, power: 3 },
      { name: "高層住宅", tech: 5, dev: 5, cost: c(120, 260, 1200), buildMinutes: 180, housing: 60, power: 5 },
    ],
  },
  farm: {
    id: "farm",
    label: "農業",
    category: "agriculture",
    zone: "agricultural",
    tiers: [
      { name: "畑", tech: 1, dev: 1, cost: c(10, 0, 20), buildMinutes: 20, food: 5, workers: 2 },
      { name: "農場", tech: 2, dev: 1, cost: c(30, 0, 60), buildMinutes: 40, food: 9, workers: 3 },
      { name: "機械化農場", tech: 3, dev: 2, cost: c(40, 30, 200), buildMinutes: 60, food: 15, workers: 3, power: 2 },
      { name: "大規模農場", tech: 4, dev: 3, cost: c(60, 70, 450), buildMinutes: 90, food: 24, workers: 4, power: 3 },
      { name: "自動農場", tech: 6, dev: 5, cost: c(80, 140, 1000), buildMinutes: 150, food: 38, workers: 2, power: 5 },
    ],
  },
  lumber: {
    id: "lumber",
    label: "木材",
    category: "industry",
    zone: "industrial",
    tiers: [{ name: "木材加工所", tech: 1, dev: 1, cost: c(5, 0, 40), buildMinutes: 20, wood: 6, workers: 2 }],
  },
  quarry: {
    id: "quarry",
    label: "石材",
    category: "industry",
    zone: "industrial",
    tiers: [{ name: "石材加工所", tech: 2, dev: 2, cost: c(40, 0, 120), buildMinutes: 40, stone: 4, workers: 3 }],
  },
  factory: {
    id: "factory",
    label: "工業",
    category: "industry",
    zone: "industrial",
    tiers: [
      { name: "工房", tech: 2, dev: 2, cost: c(40, 20, 150), buildMinutes: 50, wood: 3, stone: 2, revenue: 8, workers: 4 },
      { name: "工場", tech: 3, dev: 2, cost: c(60, 60, 350), buildMinutes: 80, wood: 6, stone: 5, revenue: 18, workers: 6, power: 4 },
      { name: "大規模工場", tech: 4, dev: 4, cost: c(100, 140, 800), buildMinutes: 120, wood: 10, stone: 8, revenue: 32, workers: 10, power: 8 },
      { name: "自動化工場", tech: 6, dev: 5, cost: c(140, 220, 1500), buildMinutes: 180, wood: 16, stone: 12, revenue: 55, workers: 6, power: 12 },
    ],
  },
  commerce: {
    id: "commerce",
    label: "商業",
    category: "commerce",
    zone: "commercial",
    tiers: [
      { name: "屋台", tech: 1, dev: 2, cost: c(20, 0, 60), buildMinutes: 20, customers: 15, revenue: 6, workers: 2 },
      { name: "小売店", tech: 2, dev: 2, cost: c(40, 10, 150), buildMinutes: 40, customers: 30, revenue: 12, workers: 3 },
      { name: "市場", tech: 3, dev: 3, cost: c(50, 50, 320), buildMinutes: 60, customers: 50, revenue: 20, workers: 5, power: 1 },
      { name: "商業施設", tech: 4, dev: 4, cost: c(80, 120, 700), buildMinutes: 100, customers: 90, revenue: 36, workers: 8, power: 3 },
      { name: "百貨店", tech: 5, dev: 5, cost: c(120, 200, 1300), buildMinutes: 150, customers: 150, revenue: 60, workers: 12, power: 5 },
    ],
  },
  office: {
    id: "office",
    label: "オフィス",
    category: "commerce",
    zone: "commercial",
    tiers: [
      { name: "オフィスビル", tech: 5, dev: 4, cost: c(80, 160, 1000), buildMinutes: 120, revenue: 45, workers: 15, power: 4 },
      { name: "商業タワー", tech: 7, dev: 6, cost: c(160, 360, 2500), buildMinutes: 200, revenue: 110, workers: 25, power: 8 },
    ],
  },
  road: {
    id: "road",
    label: "道路",
    category: "infra",
    zone: "any",
    tiers: [
      { name: "未舗装道路", tech: 1, dev: 1, cost: c(5, 0, 10), buildMinutes: 10, logistics: 6 },
      { name: "舗装道路", tech: 3, dev: 2, cost: c(0, 15, 40), buildMinutes: 20, logistics: 9 },
      { name: "幹線道路", tech: 4, dev: 3, cost: c(0, 40, 120), buildMinutes: 40, logistics: 14 },
      { name: "高度交通網", tech: 6, dev: 5, cost: c(0, 80, 400), buildMinutes: 80, logistics: 22 },
    ],
  },
  power: {
    id: "power",
    label: "電力",
    category: "infra",
    zone: "industrial",
    tiers: [
      { name: "発電所", tech: 3, dev: 2, cost: c(30, 60, 300), buildMinutes: 60, powerSupply: 20, workers: 3 },
      { name: "高効率発電所", tech: 5, dev: 4, cost: c(40, 140, 800), buildMinutes: 100, powerSupply: 45, workers: 4 },
      { name: "先進エネルギー施設", tech: 6, dev: 5, cost: c(60, 260, 1600), buildMinutes: 150, powerSupply: 90, workers: 4 },
    ],
  },
  rail: {
    id: "rail",
    label: "鉄道",
    category: "infra",
    zone: "any",
    tiers: [{ name: "鉄道駅", tech: 4, dev: 4, cost: c(60, 160, 900), buildMinutes: 120, logistics: 25, workers: 4, power: 3 }],
  },
  logistics: {
    id: "logistics",
    label: "物流",
    category: "infra",
    zone: "industrial",
    tiers: [{ name: "物流センター", tech: 5, dev: 4, cost: c(80, 200, 1100), buildMinutes: 120, logistics: 35, workers: 8, power: 3 }],
  },
  school: {
    id: "school",
    label: "教育",
    category: "public",
    zone: "public",
    tiers: [
      { name: "学校", tech: 4, dev: 3, cost: c(60, 60, 400), buildMinutes: 80, serve: 40, happiness: 3, workers: 3, power: 1 },
      { name: "大学", tech: 5, dev: 4, cost: c(80, 160, 900), buildMinutes: 120, serve: 90, happiness: 4, workers: 6, power: 3 },
      { name: "研究所", tech: 6, dev: 5, cost: c(120, 240, 1600), buildMinutes: 160, serve: 160, happiness: 5, workers: 8, power: 5 },
    ],
  },
  clinic: {
    id: "clinic",
    label: "医療",
    category: "public",
    zone: "public",
    tiers: [{ name: "病院", tech: 4, dev: 3, cost: c(60, 80, 500), buildMinutes: 80, serve: 50, happiness: 6, workers: 5, power: 2 }],
  },
  culture: {
    id: "culture",
    label: "文化",
    category: "public",
    zone: "public",
    tiers: [
      { name: "図書館", tech: 4, dev: 3, cost: c(50, 50, 300), buildMinutes: 60, serve: 30, happiness: 4, workers: 2, power: 1 },
      { name: "文化施設", tech: 5, dev: 4, cost: c(100, 140, 800), buildMinutes: 100, serve: 70, happiness: 8, workers: 4, power: 2 },
    ],
  },
  future: {
    id: "future",
    label: "未来",
    category: "future",
    zone: "public",
    tiers: [
      {
        name: "未来都市センター",
        tech: 7,
        dev: 6,
        cost: c(300, 500, 5000),
        buildMinutes: 300,
        serve: 300,
        happiness: 12,
        revenue: 120,
        workers: 20,
        power: 15,
      },
    ],
  },
};

export const LINE_IDS = Object.keys(LINES) as LineId[];

// 表の値は相対値として書き、全体の速さは config の係数で調整する
for (const line of LINE_IDS) {
  for (const t of LINES[line].tiers) {
    t.cost.treasury *= TREASURY_COST_SCALE;
    t.buildMinutes *= BUILD_TIME_SCALE;
    if (t.revenue) t.revenue *= REVENUE_SCALE;
  }
}

export function tierDef(line: LineId, tier: number): TierDef {
  return LINES[line].tiers[tier];
}

export function isTierUnlocked(line: LineId, tier: number, tech: number, dev: number): boolean {
  const t = LINES[line].tiers[tier];
  return !!t && tech >= t.tech && dev >= t.dev;
}

/** 解放済みの最上位ティア。未解放なら -1 */
export function highestUnlockedTier(line: LineId, tech: number, dev: number): number {
  const tiers = LINES[line].tiers;
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (isTierUnlocked(line, i, tech, dev)) return i;
  }
  return -1;
}

/** 技術Lvで解放される建物名（技術ゲージ・技術解放演出用） */
export function unlocksAtTech(tech: number): string[] {
  const out: string[] = [];
  for (const line of LINE_IDS) {
    for (const t of LINES[line].tiers) if (t.tech === tech) out.push(t.name);
  }
  return out;
}

export function levelMultiplier(level: number): number {
  return 1 + 0.25 * (level - 1);
}

export function upgradeCost(line: LineId, tier: number, level: number): Cost {
  const base = tierDef(line, tier).cost;
  const k = 0.6 * level ** 1.5;
  return { wood: Math.ceil(base.wood * k), stone: Math.ceil(base.stone * k), treasury: Math.ceil(base.treasury * k) };
}

export function upgradeMinutes(line: LineId, tier: number, level: number): number {
  return Math.ceil(tierDef(line, tier).buildMinutes * 0.5 * level);
}

export function evolveCost(line: LineId, toTier: number): Cost {
  const base = tierDef(line, toTier).cost;
  return { wood: Math.ceil(base.wood * 0.8), stone: Math.ceil(base.stone * 0.8), treasury: Math.ceil(base.treasury * 0.8) };
}

// ---- 特殊施設 ----

export type SpecialKind = "bank" | "gold_mine" | "silver_mine" | "park" | "statue";

export const SPECIAL_LABELS: Record<SpecialKind, string> = {
  bank: "銀行",
  gold_mine: "金鉱",
  silver_mine: "銀鉱",
  park: "公園",
  statue: "像",
};

export const ZONE_LABELS: Record<Zone, string> = {
  residential: "住宅地区",
  commercial: "商業地区",
  industrial: "工業地区",
  agricultural: "農業地区",
  public: "公共地区",
  special: "特殊地区",
  none: "未指定",
};
