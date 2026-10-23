// ゲームの盤面を、アイソメトリック描画（src/components/iso）の形に変える。
// 描画側はマップの大きさやゲームの規則を知らないので（RND-10）、ここで絵のキーと重ね描きの情報に置き換える。
import type { LineId, SpecialKind, Zone } from "@/game/catalog";
import { MAP_SIZE } from "@/game/config";
import { tileUnlockLevel } from "@/game/city/layout";
import { hash2, type IsoMap, type IsoObject, type IsoOverlay } from "@/components/iso/map";

export interface CityBuilding {
  id: string;
  line?: LineId;
  special?: SpecialKind;
  tier: number;
  level: number;
  x: number;
  y: number;
  closed?: boolean;
}

export interface CityJob {
  x: number;
  y: number;
  kind: string;
  startedAt: number;
  finishAt: number;
}

export interface CityInput {
  buildings: Iterable<CityBuilding>;
  jobs?: CityJob[];
  zones: Zone[];
  noAuto?: boolean[];
  devLevel: number;
  bankLevel: number;
  highlights?: Set<string>;
  showZones?: boolean;
  /** その土地の時刻（0〜24 時）。省略すると昼（OBJ-14） */
  hour?: number;
  /** 住宅の埋まり具合（人口 ÷ 住宅の定員）。夜に灯る窓の割合に使う */
  occupancy?: number;
}

/**
 * 夜の暗さ（0 = 昼、1 = 夜）。夕方 17〜19 時に暗くなり、明け方 5〜7 時に明るくなる。
 */
export function nightLevel(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 7 && h < 17) return 0;
  if (h >= 17 && h < 19) return (h - 17) / 2;
  if (h >= 5 && h < 7) return 1 - (h - 5) / 2;
  return 1;
}

/** 灯る窓の割合：人口に比例させる（住民がいなくても街灯代わりに少しは灯す） */
export function lightRatio(occupancy: number | undefined): number {
  return Math.max(0, Math.min(1, 0.2 + 0.8 * (occupancy ?? 1)));
}

/** タイムゾーンでの時刻（0〜24 時、分は小数） */
export function hourIn(timeZone: string | undefined, at = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") + get("minute") / 60;
}

const STATUE_RANKS = ["bronze", "silver", "gold"];
/** 像の段階（statueStage）：5 で完成 */
const STATUE_DONE = 5;

/** 建物1棟の絵のキー。建物Lv は @lv で小物を重ねる（OBJ-05） */
export function buildingKey(b: CityBuilding, bankLevel: number): string {
  const lv = b.level > 1 ? `@lv${Math.min(6, b.level)}` : "";
  switch (b.special) {
    case "bank":
      return `special/bank/${Math.min(6, Math.max(1, bankLevel))}`;
    case "gold_mine":
    case "silver_mine":
      return `special/${b.special}${lv}`;
    case "park":
      return `special/park/${Math.min(3, Math.max(0, b.tier))}${b.closed ? "@closed" : ""}`;
    case "statue": {
      const rank = STATUE_RANKS[b.tier] ?? "bronze";
      return b.level >= STATUE_DONE ? `special/statue/${rank}` : `special/statue/${rank}@stage${Math.max(0, b.level)}`;
    }
  }
  return `building/${b.line}/${b.tier}${lv}`;
}

export function cityToIso(input: CityInput): { map: IsoMap; overlay: IsoOverlay } {
  const size = MAP_SIZE;
  const road = new Uint8Array(size * size);
  const locked = new Uint8Array(size * size);
  const objects: IsoObject[] = [];

  for (const b of input.buildings) {
    if (b.x < 0) continue;
    if (b.line === "road") {
      road[b.y * size + b.x] = b.tier + 1;
      continue;
    }
    objects.push({ id: b.id, x: b.x, y: b.y, key: buildingKey(b, input.bankLevel) });
  }

  // 未開放の区画（OBJ-02）：林か岩で覆い、次に開く区画にはところどころ看板を立てる
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const need = tileUnlockLevel(x, y);
      if (need <= input.devLevel) continue;
      locked[y * size + x] = 1;
      const h = hash2(x, y, 11);
      const key = need === input.devLevel + 1 && h % 3 === 0 ? "locked/sign" : h % 4 === 0 ? "locked/rocks" : "locked/forest";
      objects.push({ id: `locked:${x},${y}`, x, y, key });
    }

  // 工事（OBJ-07）：新築は足場、改築・進化は建物の手前に覆い
  for (const j of input.jobs ?? []) {
    objects.push(
      j.kind === "build" ? { id: `job:${j.x},${j.y}`, x: j.x, y: j.y, key: "fx/scaffold" } : { id: `job:${j.x},${j.y}`, x: j.x, y: j.y, key: "fx/cover", dz: 0.25 },
    );
  }

  return {
    map: { width: size, height: size, road, locked, objects },
    overlay: {
      zones: input.zones,
      showZones: input.showZones,
      noAuto: input.noAuto,
      jobs: input.jobs?.map((j) => ({ x: j.x, y: j.y, startedAt: j.startedAt, finishAt: j.finishAt })),
      highlights: input.highlights ? [...input.highlights] : undefined,
      night: input.hour === undefined ? 0 : nightLevel(input.hour),
      lights: lightRatio(input.occupancy),
    },
  };
}
