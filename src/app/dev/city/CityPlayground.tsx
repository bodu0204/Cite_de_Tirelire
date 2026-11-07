"use client";

import { useMemo, useState } from "react";
import { CityView } from "@/components/city/CityView";
import { DECOR_KINDS } from "@/game/catalog";
import { syncParks, syncStatues } from "@/game/city/actions";
import { syncReserve } from "@/game/city/reserve";
import { computeMetrics } from "@/game/city/economy";
import { expandablePlots } from "@/game/city/layout";
import { createCity } from "@/game/city/init";
import { creditFund } from "@/game/fund";
import { applyTechLevel, simulate } from "@/game/city/sim";
import { DAY, TICK_MS } from "@/game/config";
import { devLevel } from "@/game/levels";
import type { CityState } from "@/game/types";

const T0 = Date.UTC(2026, 9, 1);
/** 放置する日数と、その日までの技術Lv（scripts/balance.ts の貯金の進み方に近い） */
const DAYS = [0, 1, 3, 7, 14, 21, 30];
const techAt = (d: number) => (d >= 21 ? 5 : d >= 14 ? 4 : d >= 7 ? 3 : d >= 1 ? 2 : 1);
/** 基準額（月間自由予算 10万円）と、毎日の貯金（初日 5,000円、以降 月2万円のペース） */
const BASE = 100_000;
const savedOn = (d: number) => (d === 0 ? 5_000 : 667);

/** 確認用の追加：備えの施設（Lv4 まで建てて Lv3 に下げ、金庫を閉める）・装飾、入金の回数（工事が始まり金貨が飛ぶ。FX-02） */
interface Extras {
  reserve: boolean;
  deposits: number;
}

function cityAfter(days: number, specials: boolean, extras: Extras = { reserve: false, deposits: 0 }): CityState {
  const s = createCity(T0, BASE);
  for (let d = 0; d < days; d++) {
    applyTechLevel(s, techAt(d + 1), s.simTime, []);
    creditFund(s, savedOn(d), s.simTime);
    simulate(s, T0 + (d + 1) * DAY, []);
  }
  // 公園（高額・ふつう）と像。土地が足りなければ林を押しのけて置く
  if (specials) {
    const at = s.simTime;
    syncParks(s, [{ id: "p1", name: "高額", monthly: 5000, active: true }, { id: "p2", name: "ふつう", monthly: 1000, active: true }], at, []);
    syncStatues(s, Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, name: `像${i}`, price: 10_000 * (i + 1), progress: 0.6, purchased: false })), at, []);
  }
  if (extras.reserve) {
    syncReserve(s, 4, s.simTime, []);
    syncReserve(s, 3, s.simTime, []);
    // 住宅に順に装飾を添える
    s.buildings.filter((b) => b.line === "housing").forEach((b, i) => (b.decor = DECOR_KINDS[i % DECOR_KINDS.length]));
  }
  for (let i = 0; i < extras.deposits; i++) {
    creditFund(s, 3_000, s.simTime);
    simulate(s, s.simTime + TICK_MS, []);
  }
  return s;
}

export function CityPlayground() {
  const [days, setDays] = useState(7);
  const [showZones, setShowZones] = useState(false);
  const [night, setNight] = useState(false);
  const [specials, setSpecials] = useState(false);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [reserve, setReserve] = useState(false);
  const [deposits, setDeposits] = useState(0);
  const [fireworks, setFireworks] = useState(0);
  const city = useMemo(() => cityAfter(days, specials, { reserve, deposits }), [days, specials, reserve, deposits]);
  const m = computeMetrics(city);
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          放置
          <select className="w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}日
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" className="w-auto" checked={showZones} onChange={(e) => setShowZones(e.target.checked)} />
          土地用途
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" className="w-auto" checked={specials} onChange={(e) => setSpecials(e.target.checked)} />
          公園・像
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" className="w-auto" checked={night} onChange={(e) => setNight(e.target.checked)} />
          夜
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" className="w-auto" checked={reserve} onChange={(e) => setReserve(e.target.checked)} />
          備え・装飾
        </label>
        <button type="button" className="w-auto rounded border px-2" onClick={() => setDeposits((n) => n + 1)}>
          入金（{deposits}）
        </button>
        <button type="button" className="w-auto rounded border px-2" onClick={() => setFireworks((n) => n + 3)}>
          花火
        </button>
        <span data-testid="stats">
          発展Lv{devLevel(city.devPoints)} ・ 人口{Math.floor(city.population)} ・ 建物{city.buildings.length}棟 ・ 区画{city.plots.length} ・ 工事{city.jobs.length}
        </span>
        {selected && <span>選択 ({selected.x}, {selected.y})</span>}
      </div>
      <CityView
        label="確認用の街"
        plots={city.plots}
        expandable={expandablePlots(city)}
        buildings={city.buildings}
        jobs={city.jobs}
        zones={city.zones}
        bankLevel={city.bankLevel}
        showZones={showZones}
        fixedHour={night ? 22 : undefined}
        occupancy={0.8}
        selected={selected}
        onSelect={setSelected}
        population={m.population}
        logistics={m.logistics}
        fireworks={fireworks}
        className="h-[80vh] w-full rounded-md"
      />
    </div>
  );
}
