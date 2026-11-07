// タイムラプス：開始時スナップショット＋イベント履歴から、任意の時刻の街を再構築する。
import type { Zone } from "./catalog";
import type { BuildingSnap, CityEventType } from "./types";

export interface ReplayEvent {
  at: number;
  type: CityEventType | string;
  payload: Record<string, unknown>;
}

export interface ReplayFrame {
  plots: string[];
  buildings: Map<string, BuildingSnap>;
  zones: Record<string, Zone>;
  devLevel: number;
  techLevel: number;
  bankLevel: number;
}

export interface ReplayStart {
  plots: string[];
  buildings: BuildingSnap[];
  zones: Record<string, Zone>;
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
    case "RESERVE_BUILT":
    case "RESERVE_CLOSED":
    case "RESERVE_OPENED":
    case "DECORATED":
      if (b) frame.buildings.set(b.id, { ...b });
      break;
    case "DEMOLISH":
      frame.buildings.delete(e.payload.buildingId as string);
      break;
    case "DISASTER":
      // 火事で休業した建物（docs/savings-driven-growth.md EVT-03）
      if (!e.payload.repaired) for (const s of (e.payload.buildings as BuildingSnap[] | undefined) ?? []) frame.buildings.set(s.id, { ...s });
      break;
    case "REPAIRED":
      if (b) frame.buildings.set(b.id, { ...b });
      break;
    case "PLOT_EXPANDED": {
      // 区画を開き、十字の道路を敷く（土地用途は描画に使わないので持たない）
      const plot = e.payload.plot as string;
      if (!frame.plots.includes(plot)) frame.plots = [...frame.plots, plot];
      for (const r of (e.payload.roads as BuildingSnap[] | undefined) ?? []) frame.buildings.set(r.id, { ...r });
      break;
    }
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
      plots: [...start.plots],
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

/** 花火を打ち上げる節目と、1回に打ち上げる数（タイムラプスの演出。docs/savings-driven-growth.md REC-06） */
export const FIREWORK_EVENTS: Record<string, number> = {
  DEV_LEVEL: 2,
  SAVINGS_MILESTONE: 2,
  TECH_UNLOCKED: 1,
  RESERVE_BUILT: 1,
  STATUE_COMPLETED: 1,
};
/** 再生が終わった時（街が完成した瞬間）に打ち上げる数 */
export const FIREWORK_FINALE = 6;

/** 時刻 t までに打ち上げた花火の数（描画側は、この数が増えた分だけ打ち上げる） */
export function fireworksAt(events: { at: number; type: string }[], t: number, finished = false): number {
  let n = 0;
  for (const e of events) if (e.at <= t) n += FIREWORK_EVENTS[e.type] ?? 0;
  return n + (finished ? FIREWORK_FINALE : 0);
}
