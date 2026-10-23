"use client";

// 街の描画（ホーム・目標達成・タイムラプス）。ゲームの盤面をアイソメトリック描画の形に変えて IsoCity に渡す。
import { useEffect, useMemo, useState } from "react";
import { IsoCity } from "@/components/iso/IsoCity";
import { type CityInput, cityToIso, hourIn } from "./toIso";

type Props = CityInput & {
  label: string;
  selected?: { x: number; y: number } | null;
  onSelect?: (tile: { x: number; y: number }) => void;
  /** 経過時間の基準（サーバー時刻 − 端末時刻）。工事のバーに使う */
  serverOffset?: number;
  /** カメラを固定して街全体を見せる（目標達成・タイムラプス。CAM-09） */
  fixed?: boolean;
  /** 昼夜をこのタイムゾーンの時刻に合わせる（OBJ-14）。省略すると昼のまま */
  timezone?: string;
  className?: string;
};

export function CityView({ label, selected, onSelect, serverOffset = 0, fixed = false, timezone, className, ...input }: Props) {
  const { buildings, jobs, zones, noAuto, devLevel, bankLevel, highlights, showZones, occupancy, population, logistics } = input;
  // 毎回作り直される入れ物は、中の値で見比べる
  const [power, workers, food] = [input.supply?.power, input.supply?.workers, input.supply?.food];
  const [uncollected, ratePerMinute] = [input.gold?.uncollected, input.gold?.ratePerMinute];
  // 時刻は1分ごとに見直す（暗さは2時間かけて変わるので、それで十分なめらか）
  const [hour, setHour] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!timezone) {
      setHour(undefined);
      return;
    }
    const tick = () => setHour(hourIn(timezone));
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [timezone]);
  const { map, overlay } = useMemo(
    () =>
      cityToIso({
        buildings,
        jobs,
        zones,
        noAuto,
        devLevel,
        bankLevel,
        highlights,
        showZones,
        hour,
        occupancy,
        population,
        logistics,
        supply: power === undefined ? undefined : { power, workers: workers ?? 1, food: food ?? 1 },
        gold: uncollected === undefined ? undefined : { uncollected, ratePerMinute: ratePerMinute ?? 0 },
      }),
    [buildings, jobs, zones, noAuto, devLevel, bankLevel, highlights, showZones, hour, occupancy, population, logistics, power, workers, food, uncollected, ratePerMinute],
  );
  return (
    <div className="rounded-xl border-4 border-[var(--map-frame)] bg-[var(--map-frame)] shadow-inner">
      <IsoCity
        className={className ?? "aspect-[4/3] max-h-[70vh] w-full rounded-md"}
        map={map}
        overlay={overlay}
        serverOffset={serverOffset}
        art="atlas"
        interactive={!fixed}
        storageKey={fixed ? undefined : "city-camera"}
        selected={selected}
        onSelect={onSelect}
        label={label}
      />
    </div>
  );
}
