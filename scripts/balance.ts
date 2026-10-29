// バランス確認：貯金スケジュールに沿って街を放置したときの推移を表示する。
// 実行: npx tsx scripts/balance.ts
// 債券倍率 k（時間発展にだけ掛かる）を変えて確かめる: K=1.5 npx tsx scripts/balance.ts
// 古い 10×10 の盤面（v1）で確かめる: LAYOUT=1 npx tsx scripts/balance.ts
import { alignTick, applyTechLevel, tick } from "../src/game/city/sim";
import { createCity } from "../src/game/city/init";
import { computeMetrics } from "../src/game/city/economy";
import { devLevel, techLevel } from "../src/game/levels";
import { DAY, TICK_MS } from "../src/game/config";
import type { CityEvent } from "../src/game/types";

const T0 = Date.UTC(2026, 9, 1);
const K = Number(process.env.K ?? 1);
const LAYOUT = Number(process.env.LAYOUT ?? 2) === 1 ? 1 : 2;
const s = createCity(T0, "balanced", LAYOUT);
// 1日目 5,000円、7日目 +10,000円、14日目 +15,000円、21日目 +30,000円、28日目 +40,000円
const savings: [number, number][] = [[1, 5000], [7, 10000], [14, 15000], [21, 30000], [28, 40000], [40, 100000]];
let total = 0;
const events: CityEvent[] = [];
for (let d = 1; d <= 50; d++) {
  for (const [day, amt] of savings) if (day === d) { total += amt; applyTechLevel(s, techLevel(total), s.simTime, events); }
  while (s.simTime < alignTick(T0 + d * DAY)) tick(s, s.simTime + TICK_MS, events, K);
  const m = computeMetrics(s);
  const count = (l: string) => s.buildings.filter((b) => b.line === l).length;
  console.log(
    `d${String(d).padStart(2)} tech${s.techLevel} dev${devLevel(s.devPoints)}(${s.devPoints.toFixed(0)}) pop ${s.population.toFixed(0)}/${m.housingCap.toFixed(0)}`,
    `wood ${s.stock.wood.toFixed(0)} stone ${s.stock.stone.toFixed(0)} food ${s.stock.food.toFixed(0)} tr ${s.treasury.toFixed(0)} (+${m.production.treasury.toFixed(1)}/h)`,
    `h${s.happiness.toFixed(0)} op${m.operation} emp${m.employment.toFixed(2)} pw${m.powerRatio.toFixed(2)} lg${m.logistics.toFixed(2)}`,
    `B${s.buildings.length} jobs${s.jobs.length} H${count("housing")} F${count("farm")} C${count("commerce")} I${count("factory")} P${count("power")} R${count("road")}`,
    s.plots ? `plots${s.plots.length}` : "",
  );
}
const byType: Record<string, number> = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
console.log(byType);
console.log(s.buildings.filter((b) => b.line).map((b) => `${b.line}:${b.tier}:L${b.level}`).join(" "));
