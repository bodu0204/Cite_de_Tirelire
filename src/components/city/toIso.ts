// ゲームの盤面を、アイソメトリック描画（src/components/iso）の形に変える。
// 描画側はマップの大きさやゲームの規則を知らないので（RND-10）、ここで絵のキーと重ね描きの情報に置き換える。
import { LINES, type LineId, type SpecialKind, type Zone } from "@/game/catalog";
import { LOGISTICS_FLOOR, MAP_SIZE } from "@/game/config";
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
  /** 人口と物流効率（LOGISTICS_FLOOR〜1）。道路を行き交う人と車の数に使う（OBJ-11） */
  population?: number;
  logistics?: number;
  /** 電気・働き手・食料の足りている割合（0〜1）。足りない分だけ建物に困りごとアイコンを出す（A3） */
  supply?: { power: number; workers: number; food: number };
  /** 金鉱の未回収の金と、1分あたりの採掘量。金鉱の前に金貨の山を出す（A4） */
  gold?: { uncollected: number; ratePerMinute: number };
}

/** 人と車の上限（NF-01 は合わせて 300 で確かめる）。道路の長さでも抑え（人は1マスに1人、車は3マスに1台）、短い道に詰め込まない */
export const MAX_PEOPLE = 200;
export const MAX_CARS = 100;

/** 道路を行き交う人と車の数：人は人口の4割、車は人口の12%に物流効率を掛ける */
export function agentCounts(population: number, logistics: number, roadTiles: number): { people: number; cars: number } {
  const flow = Math.max(0, Math.min(1, (logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR)));
  return {
    people: Math.min(MAX_PEOPLE, roadTiles, Math.round(Math.max(0, population) * 0.4)),
    cars: Math.min(MAX_CARS, Math.floor(roadTiles / 3), Math.round(Math.max(0, population) * 0.12 * (0.3 + 0.7 * flow))),
  };
}

/** 金貨の山の段階（0 は出さない）：未回収が採掘の1時間分まで小、半日分まで中、それより多いと大 */
export function goldStage(uncollected: number, ratePerMinute: number): number {
  if (uncollected < 1) return 0;
  const minutes = ratePerMinute > 0 ? uncollected / ratePerMinute : Infinity;
  return minutes < 60 ? 1 : minutes < 720 ? 2 : 3;
}

/**
 * 困りごとアイコン（A3）：足りない割合だけ、その資源を使う建物にアイコンを出す。どの建物に出すかはマスで決め、
 * 足りない割合が変わらなければ同じ建物に出し続ける。1棟に出すのは1つ（電気 → 働き手 → 食料の順）。
 * 食料は住宅に出す（住民が食べるため）。
 */
export function troubleIcons(buildings: Iterable<CityBuilding>, supply: { power: number; workers: number; food: number }): NonNullable<IsoOverlay["troubles"]> {
  const out: NonNullable<IsoOverlay["troubles"]> = [];
  const short = (ratio: number) => Math.max(0, Math.min(1, 1 - ratio));
  for (const b of buildings) {
    if (b.x < 0 || !b.line || b.line === "road") continue;
    const t = LINES[b.line].tiers[b.tier];
    if (!t) continue;
    const pick = (salt: number) => hash2(b.x, b.y, salt) / 0xffffffff;
    if (t.power && pick(21) < short(supply.power)) out.push({ x: b.x, y: b.y, kind: "power", dark: true });
    else if (t.workers && pick(22) < short(supply.workers)) out.push({ x: b.x, y: b.y, kind: "workers" });
    else if (t.housing && pick(23) < short(supply.food)) out.push({ x: b.x, y: b.y, kind: "food" });
  }
  return out;
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

  // 2回たどる（建物と困りごと）ので、一度だけ取り出す
  const buildings = [...input.buildings];
  for (const b of buildings) {
    if (b.x < 0) continue;
    if (b.line === "road") {
      road[b.y * size + b.x] = b.tier + 1;
      continue;
    }
    objects.push({ id: b.id, x: b.x, y: b.y, key: buildingKey(b, input.bankLevel) });
    // 金鉱の前に、未回収の金の量に応じた金貨の山（A4）
    const stage = b.special === "gold_mine" && input.gold ? goldStage(input.gold.uncollected, input.gold.ratePerMinute) : 0;
    if (stage) objects.push({ id: "gold", x: b.x, y: b.y, key: `props/gold/${stage}`, dz: 0.3, ox: 14, oy: 7 });
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

  const roadTiles = road.reduce((n, r) => n + (r ? 1 : 0), 0);
  const agents = input.population === undefined ? undefined : agentCounts(input.population, input.logistics ?? 1, roadTiles);
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
      people: agents?.people,
      cars: agents?.cars,
      troubles: input.supply ? troubleIcons(buildings, input.supply) : undefined,
    },
  };
}
