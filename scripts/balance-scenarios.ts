// バランス確認（シナリオ別）：貯金のペース・金貨の使い方・開発方針を変えて街を放置したときの推移と、停滞の兆候を表示する。
// docs/game-balance-review.md の数値はこのスクリプトで出している。scripts/balance.ts は PACE=fast・GOLD=none に当たる。
//
// 実行例:
//   npx tsx scripts/balance-scenarios.ts                     # 現実的なペース（B=60,000・採掘の2割を貯金）、金貨は使わない、120日
//   GOLD=city npx tsx scripts/balance-scenarios.ts           # 貯めた金貨を毎日おまかせ交換する
//   GOLD=bond npx tsx scripts/balance-scenarios.ts           # 貯めた金貨を債券に入れる（資源つき・債券倍率）
//   PACE=fast DAYS=50 npx tsx scripts/balance-scenarios.ts   # balance.ts と同じ貯金スケジュール（40日で20万円）
//   PRESET=industry npx tsx scripts/balance-scenarios.ts     # 開発方針（balanced / housing / industry / commerce）
//
// 単純化：採掘は B ÷ 30 を毎日、貯金はその SAVE 倍とする（収入期間・サブスク・ユーザ通貨・購入の精算は扱わない）。
// GOLD=city / bond では、その日の貯金分を日の始めに手数料なしのおまかせ交換と同じ資源にして街に入れる。
import { bondCap, bondMultiplier } from "../src/game/bond";
import type { LineId } from "../src/game/catalog";
import { computeMetrics } from "../src/game/city/economy";
import { createCity, POLICY_PRESETS } from "../src/game/city/init";
import { alignTick, applyTechLevel, cityNeeds, tick } from "../src/game/city/sim";
import { DAY, TICK_MS } from "../src/game/config";
import { quoteNeedsExchange } from "../src/game/exchange";
import { bankLevel, devLevel, goldMineLevel, silverMineLevel, techLevel } from "../src/game/levels";
import type { CityEvent, CityPolicy } from "../src/game/types";

const T0 = Date.UTC(2026, 9, 1);
const DAYS = Number(process.env.DAYS ?? 120);
const PACE = process.env.PACE === "fast" ? "fast" : "real";
const GOLD = (["none", "city", "bond"] as const).find((g) => g === process.env.GOLD) ?? "none";
const PRESET = (Object.keys(POLICY_PRESETS).find((p) => p === process.env.PRESET) ?? "balanced") as CityPolicy["preset"];
/** 月間自由予算 B（サブスク・ユーザ通貨を引いた採掘額として扱う） */
const BUDGET = Number(process.env.B ?? 60_000);
/** 採掘のうち使わずに貯金になる割合 */
const SAVE = Number(process.env.SAVE ?? 0.2);
const GOAL = Number(process.env.GOAL ?? 100_000);
/** 1日あたりの有効な記録件数（記録Lv用） */
const RECORDS_PER_DAY = 3;
const EVERY = Number(process.env.EVERY ?? 10);

// balance.ts と同じ貯金スケジュール（日, 追加額）
const FAST: [number, number][] = [[1, 5000], [7, 10000], [14, 15000], [21, 30000], [28, 40000], [40, 100000]];
const WORK = new Set<CityEvent["type"]>(["BUILD", "UPGRADE", "EVOLVE", "PLOT_EXPANDED"]);
const SHOW: LineId[] = ["housing", "farm", "commerce", "factory", "quarry", "power", "school", "clinic", "culture", "office", "rail", "logistics", "future"];

const s = createCity(T0, PRESET);
const events: CityEvent[] = [];
let savings = 0;
let bond = 0;
let mined = 0;
let idleDays = 0;
const devDay: Record<number, number> = {};
const techDay: Record<number, number> = {};

console.log(`PACE=${PACE} GOLD=${GOLD} PRESET=${PRESET} B=${BUDGET} SAVE=${SAVE} GOAL=${GOAL} DAYS=${DAYS}`);
for (let d = 1; d <= DAYS; d++) {
  const minedToday = BUDGET / 30;
  mined += minedToday;
  const add = PACE === "fast" ? FAST.filter(([day]) => day === d).reduce((a, [, amt]) => a + amt, 0) : minedToday * SAVE;
  savings += add;
  applyTechLevel(s, techLevel(savings), s.simTime, events);
  if (GOLD !== "none" && add > 0) {
    // 債券は上限（3M）までしか資源がつかない
    const amount = GOLD === "bond" ? Math.max(0, Math.min(add, bondCap(BUDGET) - bond)) : add;
    const lv = { bank: bankLevel((savings / GOAL) * 100), goldMine: goldMineLevel(mined), silverMine: silverMineLevel(d * RECORDS_PER_DAY) };
    const q = quoteNeedsExchange("gold", amount, cityNeeds(s).needs, lv, { fee: false, floor: false });
    s.stock.wood += q.gains.wood;
    s.stock.stone += q.gains.stone;
    s.stock.food += q.gains.food;
    s.treasury += q.gains.treasury;
    if (GOLD === "bond") bond += add;
  }
  const k = GOLD === "bond" ? bondMultiplier(bond, BUDGET) : 1;
  const before = events.length;
  while (s.simTime < alignTick(T0 + d * DAY)) tick(s, s.simTime + TICK_MS, events, k);
  if (!events.slice(before).some((e) => WORK.has(e.type))) idleDays++;

  const dev = devLevel(s.devPoints);
  for (let lv = 1; lv <= dev; lv++) devDay[lv] ??= d;
  for (let lv = 1; lv <= s.techLevel; lv++) techDay[lv] ??= d;
  if (d === 1 || d % EVERY === 0 || d === DAYS) {
    const m = computeMetrics(s);
    const count = (l: LineId) => s.buildings.filter((b) => b.line === l).length;
    console.log(
      `d${String(d).padStart(3)} 貯金${Math.round(savings)} tech${s.techLevel} dev${dev}(${s.devPoints.toFixed(0)}) k${k.toFixed(2)}`,
      `人口${s.population.toFixed(0)}/${m.housingCap.toFixed(0)} 幸福${s.happiness.toFixed(0)} 活用率${m.techUtilization.toFixed(2)}`,
      `食料${m.foodRatio.toFixed(2)} 電力${m.powerRatio.toFixed(2)} 雇用${m.employment.toFixed(2)} 物流${m.logistics.toFixed(2)}`,
      `木${s.stock.wood.toFixed(0)} 石${s.stock.stone.toFixed(0)} 資金${s.treasury.toFixed(0)}(+${m.production.treasury.toFixed(0)}/h うち税${m.tax.toFixed(0)})`,
      `区画${s.plots.length}`,
      SHOW.map((l) => `${l}${count(l)}`).join(" "),
    );
  }
}
console.log("発展Lvに届いた日", devDay);
console.log("技術Lvに届いた日", techDay);
console.log(`建設・Lvアップ・進化・開拓が1件もなかった日: ${idleDays} / ${DAYS}`);
