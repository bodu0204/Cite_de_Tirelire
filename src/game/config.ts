// ゲームバランスの正本。意図は docs/requirements.md を参照。

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 都市シミュレーションのティック幅（絶対時刻に揃える） */
export const TICK_MS = 10 * MINUTE;

/** 金鉱の固定小数点：1G = 10^6 単位 */
export const MICRO_PER_GOLD = 1_000_000n;

export const MAP_SIZE = 10;

// ---- 銀鉱の記録報酬 ----
export const REWARD_PURCHASE = 50;
export const REWARD_SAVINGS = 100;
export const REWARD_DAILY_CAP = 300;

// ---- シーズン初期値 ----
export const INITIAL_GOLD = 0;
export const INITIAL_SILVER = 100;
export const INITIAL_STOCK = { wood: 60, stone: 0, food: 40 };
export const INITIAL_TREASURY = 150;
export const INITIAL_POPULATION = 4;

// ---- 施設レベル ----
/** 銀行：達成率(%) の閾値。index+1 がレベル、6 が「完成」 */
export const BANK_LEVEL_THRESHOLDS = [0, 20, 40, 60, 80, 100];
export const BANK_EXCHANGE_BONUS = [0, 0.05, 0.1, 0.15, 0.2, 0.3];

/** 金鉱：累計回収金貨 */
export const GOLD_MINE_LEVEL_THRESHOLDS = [0, 5_000, 15_000, 40_000, 80_000, 150_000];
export const GOLD_MINE_EXCHANGE_BONUS = [0, 0.04, 0.08, 0.12, 0.16, 0.2];

/** 銀鉱：有効な記録件数 */
export const SILVER_MINE_LEVEL_THRESHOLDS = [0, 5, 15, 30, 50, 80];
export const SILVER_MINE_EXCHANGE_BONUS = [0, 0.04, 0.08, 0.12, 0.16, 0.2];

// ---- 資源交換 ----
/** 1G あたりの基準獲得量。銀貨はその 1/10 */
export const GOLD_RESOURCE_VALUE = { wood: 10, stone: 5, food: 10 } as const;
export const SILVER_VALUE_RATIO = 0.1;

// ---- 手動操作の銀貨手数料 ----
export const FEE_EXCHANGE = 5;
export const FEE_MOVE = 5;
export const feeBuild = (tier: number) => 10 + 5 * (tier + 1);
export const feeUpgrade = (level: number) => 10 + 5 * level;
/** 即時完了：残り10分ごと */
export const FEE_RUSH_PER_10MIN = 2;

// ---- 技術Lv（貯金最高到達額、円） ----
export const TECH_THRESHOLDS = [0, 5_000, 15_000, 30_000, 60_000, 100_000, 200_000];
export const TECH_MULTIPLIER = [1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];
export const MAX_TECH = TECH_THRESHOLDS.length;

// ---- 発展Lv ----
export const DEV_THRESHOLDS = [0, 50, 150, 350, 700, 1200];
export const DEV_NAMES = ["集落", "村", "町", "地方都市", "大都市", "巨大都市"];
export const MAX_DEV = DEV_THRESHOLDS.length;
export const DEV_PER_HOUR = 2;
export const DEV_BUILD = 3;
export const DEV_LEVEL_UP = 1;
export const DEV_EVOLVE = 4;
/** 人口の最高記録がこの人数増えるごとに +1pt */
export const DEV_POP_STEP = 25;
/** 建物Lv上限（発展Lv別）＝高密度化 */
export const BUILDING_LEVEL_CAP = [3, 3, 3, 4, 5, 6];

// ---- 内部経済 ----
export const FOOD_PER_RESIDENT_HOUR = 0.25;
export const LABOR_PARTICIPATION = 0.7;
export const TAX_PER_RESIDENT_HOUR = 0.8;
/** 人口増加の基礎速度：一定値＋人口比例分（指数的な急成長を避ける） */
export const POP_GROWTH_BASE_HOUR = 0.4;
export const POP_GROWTH_PER_RESIDENT_HOUR = 0.004;
/** カタログの都市資金コスト・建設時間・商工業収益に掛ける係数 */
export const TREASURY_COST_SCALE = 2;
export const BUILD_TIME_SCALE = 3;
export const REVENUE_SCALE = 0.6;
/** 自動開発の同時ジョブ数 = 1 + floor(発展Lv / この値) */
export const AUTO_JOBS_PER_DEV = 3;
/** 幸福度が目標値へ近づく速さ（1時間あたりの割合） */
export const HAPPINESS_EASE_HOUR = 0.2;
export const LOGISTICS_FLOOR = 0.6;
export const OPERATION_FLOOR = 0.3;
/** 自動開発：これ以上待たないと払えない目標は後回しにする */
export const AUTO_MAX_WAIT_HOURS = 12;
/** 住宅の空きがこの割合を下回ったら住宅を増やす */
export const HOUSING_VACANCY_TARGET = 0.15;

// ---- 公園の幸福度（逓減） ----
export const PARK_HAPPINESS_FIRST = 6;
export const PARK_HAPPINESS_DECAY = 0.6;
export const PARK_HAPPINESS_CAP = 15;

// ---- 像の分類（円） ----
export const STATUE_SILVER_FROM = 5_000;
export const STATUE_GOLD_FROM = 30_000;

// ---- 放置中の変化表示 ----
export const AWAY_SUMMARY_MIN_MS = HOUR;
