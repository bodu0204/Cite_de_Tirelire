"use client";

import { useMemo, useState } from "react";
import { CityView } from "@/components/city/CityView";
import { computeMetrics } from "@/game/city/economy";
import { expandablePlots, isLegacy } from "@/game/city/layout";
import { createCity } from "@/game/city/init";
import { applyTechLevel, simulate } from "@/game/city/sim";
import { DAY } from "@/game/config";
import { devLevel } from "@/game/levels";
import type { CityLayout, CityState } from "@/game/types";

const T0 = Date.UTC(2026, 9, 1);
/** 放置する日数と、その日までの技術Lv（scripts/balance.ts の貯金の進み方に近い） */
const DAYS = [0, 1, 3, 7, 14, 21, 30];
const techAt = (d: number) => (d >= 21 ? 5 : d >= 14 ? 4 : d >= 7 ? 3 : d >= 1 ? 2 : 1);

function cityAfter(days: number, layout: CityLayout): CityState {
  const s = createCity(T0, "balanced", layout);
  for (let d = 0; d < days; d++) {
    applyTechLevel(s, techAt(d + 1), s.simTime, []);
    simulate(s, T0 + (d + 1) * DAY, []);
  }
  return s;
}

export function CityPlayground() {
  const [days, setDays] = useState(7);
  const [layout, setLayout] = useState<CityLayout>(2);
  const [showZones, setShowZones] = useState(false);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const city = useMemo(() => cityAfter(days, layout), [days, layout]);
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
          盤面
          <select className="w-auto" value={layout} onChange={(e) => setLayout(Number(e.target.value) as CityLayout)}>
            <option value={2}>v2</option>
            <option value={1}>v1（10×10）</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" className="w-auto" checked={showZones} onChange={(e) => setShowZones(e.target.checked)} />
          土地用途
        </label>
        <span data-testid="stats">
          発展Lv{devLevel(city.devPoints)} ・ 人口{Math.floor(city.population)} ・ 建物{city.buildings.length}棟 ・ 区画{city.plots?.length ?? "-"} ・ 工事{city.jobs.length}
        </span>
        {selected && <span>選択 ({selected.x}, {selected.y})</span>}
      </div>
      <CityView
        label="確認用の街"
        layout={city.v}
        plots={city.plots}
        expandable={isLegacy(city) ? undefined : expandablePlots(city)}
        buildings={city.buildings}
        jobs={city.jobs}
        zones={city.zones}
        noAuto={city.noAuto}
        devLevel={devLevel(city.devPoints)}
        bankLevel={city.bankLevel}
        showZones={showZones}
        selected={selected}
        onSelect={setSelected}
        population={m.population}
        logistics={m.logistics}
        className="h-[80vh] w-full rounded-md"
      />
    </div>
  );
}
