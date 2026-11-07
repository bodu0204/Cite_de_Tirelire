// ゲームバランスの正本。意図は docs/requirements.md と docs/savings-driven-growth.md（貯金で育つ街）を参照。

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 都市シミュレーションのティック幅（絶対時刻に揃える） */
export const TICK_MS = 10 * MINUTE;

/** 金鉱の固定小数点：1G = 10^6 単位 */
export const MICRO_PER_GOLD = 1_000_000n;

// ---- マップ（docs/map-layout-redesign.md） ----
/** 開拓区画の一辺（マス） */
export const PLOT_SIZE = 5;
/** シーズン開始時に開いている区画（中心の 10×10 ＝ マス -5〜4） */
export const INITIAL_PLOTS = ["-1,-1", "0,-1", "-1,0", "0,0"];
/**
 * 開拓できる区画数の上限（初期の4区画を含む。発展Lv別。docs/map-layout-redesign.md §7.2、Q8）。
 * 発展Lv6 からは発展pt が PLOT_STEP_POINTS 増えるごとに PLOT_STEP ずつ増え、MAX_PLOTS で止まる（Q5）
 */
export const PLOT_LIMIT = [4, 8, 14, 22, 30, 40];
export const PLOT_STEP_POINTS = 150;
export const PLOT_STEP = 4;
export const MAX_PLOTS = 400;
/**
 * n 区画目（初期の4区画のあとに開く順、0 から）の開拓の相対コストと工事時間（分）。開くたびに増える。
 * 値段（円）は建物と同じく相対コストから決める（sim.ts priceOf。docs/savings-driven-growth.md PRC-04）
 */
export const PLOT_COST_GROWTH = 1.1;
export const expandCost = (n: number, stone = n >= 2) => {
  const k = PLOT_COST_GROWTH ** n;
  // stone が false なら木材と都市資金だけ（最初の2区画と、石材加工所が解放されるまで。sim.ts plotCost）
  return { wood: Math.round(60 * k), stone: stone ? Math.round(20 * k) : 0, treasury: Math.round(150 * k) };
};
export const expandMinutes = (n: number) => Math.min(360, 60 + 15 * n);

// ---- 銀鉱の記録報酬 ----
export const REWARD_PURCHASE = 50;
export const REWARD_SAVINGS = 100;
export const REWARD_DAILY_CAP = 300;
/** 貯金管理の登録は1日3回まで（docs/record-input-redesign.md SV-13） */
export const SAVINGS_DAILY_LIMIT = 3;

// ---- シーズン初期値 ----
export const INITIAL_GOLD = 0;
export const INITIAL_SILVER = 100;
/** 木材・石材は建物の見た目にだけ残し、在庫には持たない（GRW-02）。建設資金（treasury、円）は貯金からだけ入る（GRW-01） */
export const INITIAL_STOCK = { wood: 0, stone: 0, food: 40 };
export const INITIAL_TREASURY = 0;
export const INITIAL_POPULATION = 4;

// ---- 債券（docs/bond-and-custom-currency.md §4） ----
/** 債券化が止まる額 ＝ 月間自由予算 × この値 */
export const BOND_CAP_MONTHS = 3;
/** 債券の利息：毎日、債券残高（0〜上限）のこの割合が建設資金として街に入る（RSV-02） */
export const BOND_INTEREST_PER_DAY = 0.003;
/** 備えLv1〜4 になる債券残高（月間自由予算の何か月分。RSV-03） */
export const RESERVE_LEVEL_MONTHS = [0.5, 1, 2, 3];
/** 債券がマイナスの間に採掘から強制的に債券へ回す割合（%） */
export const BOND_FORCED_RATE = 20;
/** 債券を使ったときの銀貨の手数料：使った債券の10%、上限 50S */
export const BOND_FEE_RATE = 0.1;
export const BOND_FEE_CAP = 50;

// ---- ユーザ定義通貨 ----
/** 自由予算を超えないか確かめる範囲（今月から何か月先まで） */
export const BUDGET_CHECK_MONTHS = 12;

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

// ---- 建設資金（docs/savings-driven-growth.md §5・§6） ----
/** 1G（1円）あたりの建設資金（円）。銀貨はその 1/10 */
export const FUND_PER_GOLD = 1;
export const SILVER_VALUE_RATIO = 0.1;
/**
 * カタログの相対コストの重み：木材 ÷10 ＋ 石材 ÷5 ＋ 都市資金 ÷10（以前の金貨1枚あたりの交換量）。
 * 計画の値段（円）＝ 相対コスト × 基準額 × FUND_PRICE_KAPPA ×（1 − 割引）（PRC-01）
 */
export const GOLD_RESOURCE_VALUE = { wood: 10, stone: 5, food: 10, treasury: 10 } as const;
export const FUND_PRICE_KAPPA = 0.0002;
/** 木材加工所・石材加工所・工場1棟あたりの建設費の割引と、その上限（GRW-05） */
export const DISCOUNT_PER_BUILDING = 0.02;
export const DISCOUNT_MAX = 0.4;
/** 同時に進める工事の数（発展Lv別。GRW-03） */
export const CONCURRENT_JOBS = [3, 4, 6, 8, 12, 16];
/** 開拓期ボーナス：シーズン開始から days 日目までの貯金は rate 倍の建設資金になる。増える分は基準額 × EARLY_BONUS_CAP まで（ERL-01・02） */
export const EARLY_BONUS = [
  { days: 7, rate: 2 },
  { days: 14, rate: 1.5 },
] as const;
export const EARLY_BONUS_CAP = 0.3;

// ---- 銀貨の手数料 ----
export const FEE_EXCHANGE = 5;
/** 公園・像のために林を押しのけて敷く道路1マス */
export const FEE_INSTANT_ROAD = 15;

// ---- 技術Lv（貯金最高到達額 ÷ 基準額。基準額＝月間自由予算と目標額の小さいほう。PRC-03・PRC-06） ----
export const TECH_THRESHOLDS = [0, 0.05, 0.15, 0.3, 0.6, 1.0, 1.5];
export const TECH_MULTIPLIER = [1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0];
export const MAX_TECH = TECH_THRESHOLDS.length;

// ---- 発展Lv（完成した計画の累計額で決まる。GRW-04・PRC-02） ----
/** 発展pt ＝ 完成した計画の累計額 ÷ 基準額 × DEV_POINTS_PER_BASE */
export const DEV_POINTS_PER_BASE = 1000;
/** 発展Lvの閾値（発展pt）：基準額の 0.03 / 0.12 / 0.3 / 0.7 / 1.5 倍 */
export const DEV_THRESHOLDS = [0, 30, 120, 300, 700, 1500];
export const DEV_NAMES = ["集落", "村", "町", "地方都市", "大都市", "巨大都市"];
export const MAX_DEV = DEV_THRESHOLDS.length;
/** 建物Lv上限（発展Lv別）＝高密度化 */
export const BUILDING_LEVEL_CAP = [3, 3, 3, 4, 5, 6];

// ---- 内部経済 ----
export const FOOD_PER_RESIDENT_HOUR = 0.25;
export const LABOR_PARTICIPATION = 0.7;
/** 住宅の空きのうち1時間に移り住む割合（人口は時間ではなく住宅で決まる。GRW-09） */
export const MOVE_IN_PER_HOUR = 0.25;
/** カタログの都市資金コスト・建設時間に掛ける係数 */
export const TREASURY_COST_SCALE = 2;
export const BUILD_TIME_SCALE = 3;
/** 幸福度が目標値へ近づく速さ（1時間あたりの割合） */
export const HAPPINESS_EASE_HOUR = 0.2;
export const LOGISTICS_FLOOR = 0.6;
export const OPERATION_FLOOR = 0.3;
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
