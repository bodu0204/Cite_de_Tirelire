"use client";

// 街の描画（ホーム・目標達成・タイムラプス）。ゲームの盤面をアイソメトリック描画の形に変えて IsoCity に渡す。
import { useMemo } from "react";
import { IsoCity } from "@/components/iso/IsoCity";
import { type CityInput, cityToIso } from "./toIso";

type Props = CityInput & {
  label: string;
  selected?: { x: number; y: number } | null;
  onSelect?: (tile: { x: number; y: number }) => void;
  /** 経過時間の基準（サーバー時刻 − 端末時刻）。工事のバーに使う */
  serverOffset?: number;
  /** カメラを固定して街全体を見せる（目標達成・タイムラプス。CAM-09） */
  fixed?: boolean;
  className?: string;
};

export function CityView({ label, selected, onSelect, serverOffset = 0, fixed = false, className, ...input }: Props) {
  const { buildings, jobs, zones, noAuto, devLevel, bankLevel, highlights, showZones } = input;
  const { map, overlay } = useMemo(
    () => cityToIso({ buildings, jobs, zones, noAuto, devLevel, bankLevel, highlights, showZones }),
    [buildings, jobs, zones, noAuto, devLevel, bankLevel, highlights, showZones],
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
