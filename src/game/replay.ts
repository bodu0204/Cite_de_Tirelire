// タイムラプス：開始時スナップショット＋イベント履歴から、任意の時刻の街を再構築する。
import type { Zone } from "./catalog";
import type { BuildingSnap, CityEventType } from "./types";

export interface ReplayEvent {
  at: number;
  type: CityEventType | string;
  payload: Record<string, unknown>;
}

export interface ReplayFrame {
  buildings: Map<string, BuildingSnap>;
  zones: Zone[];
  devLevel: number;
  techLevel: number;
  bankLevel: number;
}

export interface ReplayStart {
  buildings: BuildingSnap[];
  zones: Zone[];
  techLevel: number;
}

export function applyEvent(frame: ReplayFrame, e: ReplayEvent) {
  const b = e.payload.building as BuildingSnap | undefined;
  switch (e.type) {
    case "BUILD":
    case "UPGRADE":
    case "EVOLVE":
    case "MOVE":
    case "PARK_OPENED":
    case "PARK_CLOSED":
    case "STATUE_PROGRESS":
    case "STATUE_COMPLETED":
      if (b) frame.buildings.set(b.id, { ...b });
      break;
    case "DEMOLISH":
      frame.buildings.delete(e.payload.buildingId as string);
      break;
    case "DEV_LEVEL":
      frame.devLevel = Math.max(frame.devLevel, e.payload.level as number);
      break;
    case "TECH_UNLOCKED":
      frame.techLevel = Math.max(frame.techLevel, e.payload.level as number);
      break;
    case "BANK_LEVEL": {
      const bank = frame.buildings.get("bank");
      frame.bankLevel = e.payload.level as number;
      if (bank) frame.buildings.set("bank", { ...bank, level: frame.bankLevel });
      break;
    }
  }
}

/** 時刻を進める・戻すたびに先頭から適用し直さずに済むよう、カーソルを保持する */
export function createReplay(start: ReplayStart, events: ReplayEvent[]) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let frame: ReplayFrame;
  let cursor = 0;
  const reset = () => {
    frame = {
      buildings: new Map(start.buildings.map((b) => [b.id, { ...b }])),
      zones: start.zones,
      devLevel: 1,
      techLevel: start.techLevel,
      bankLevel: 1,
    };
    cursor = 0;
  };
  reset();
  let lastT = -Infinity;
  return {
    events: sorted,
    at(t: number): ReplayFrame {
      if (t < lastT) reset();
      lastT = t;
      while (cursor < sorted.length && sorted[cursor].at <= t) applyEvent(frame, sorted[cursor++]);
      return frame;
    },
  };
}

/** その時刻の達成率（%） */
export function rateAt(savings: { at: number; delta: number }[], goal: number, t: number): number {
  let net = 0;
  for (const s of savings) if (s.at <= t) net += s.delta;
  return goal > 0 ? (Math.max(0, net) / goal) * 100 : 0;
}
