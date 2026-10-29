// ゲームの盤面を、アイソメトリック描画（src/components/iso）の形に変える。
// 描画側はマップの大きさやゲームの規則を知らないので（RND-10）、ここで絵のキーと重ね描きの情報に置き換える。
import { LINES, type LineId, type SpecialKind, type Zone } from "@/game/catalog";
import { LOGISTICS_FLOOR, PLOT_SIZE } from "@/game/config";
import { buildingSize, isPlannedRoad, landBounds, plotKey, plotOf, tileKey, type Rect } from "@/game/city/layout";
import { MIN_ROAD } from "@/components/iso/agents";
import { hash2, type IsoMap, type IsoObject, type IsoOverlay, lockedKey, tileIndex } from "@/components/iso/map";

export interface CityBuilding {
  id: string;
  line?: LineId;
  special?: SpecialKind;
  tier: number;
  level: number;
  x: number;
  y: number;
  closed?: boolean;
  placed?: false;
}

export interface CityJob {
  x: number;
  y: number;
  kind: string;
  /** 新築の大きさを決める */
  line?: LineId;
  tier?: number;
  /** 開拓（kind "expand"）の区画 */
  plot?: string;
  startedAt: number;
  finishAt: number;
}

export interface CityInput {
  /** 開拓した区画（"px,py"） */
  plots: string[];
  /** 開拓できる区画（"px,py"）。真ん中に看板を立てる */
  expandable?: string[];
  buildings: Iterable<CityBuilding>;
  jobs?: CityJob[];
  /** マスの土地用途（"x,y"） */
  zones: Record<string, Zone>;
  /** 自動建設を禁止したマス（"x,y"） */
  noAuto?: string[];
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

/**
 * 道路を行き交う人と車の数：人は人口の4割、車は人口の12%に物流効率を掛ける。
 * 車は舗装道路（paved マス）だけを走るので、未舗装道路しかない序盤は 0 台
 */
export function agentCounts(population: number, logistics: number, roadTiles: number, paved = roadTiles): { people: number; cars: number } {
  const flow = Math.max(0, Math.min(1, (logistics - LOGISTICS_FLOOR) / (1 - LOGISTICS_FLOOR)));
  return {
    people: Math.min(MAX_PEOPLE, roadTiles, Math.round(Math.max(0, population) * 0.4)),
    cars: Math.min(MAX_CARS, Math.floor(paved / 3), Math.round(Math.max(0, population) * 0.12 * (0.3 + 0.7 * flow))),
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
    if (b.placed === false || !b.line || b.line === "road") continue;
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

/**
 * 建物1棟の絵のキー。建物Lv は @lv で小物を重ねる（OBJ-05）。
 * 2×2・3×3 の建物は big/ の付いた大きな絵を使う（docs/map-layout-redesign.md §4.5。なければ描画側が1マスの絵で代える）
 */
export function buildingKey(b: CityBuilding, bankLevel: number, size = 1): string {
  const key = smallKey(b, bankLevel);
  return size > 1 ? `big/${key}` : key;
}

function smallKey(b: CityBuilding, bankLevel: number): string {
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

/**
 * 盤面の範囲に含める、開いている土地の外の帯（マス）。開拓できる区画の看板と開拓中の区画が入る1区画分。
 * その外は描画側が林と岩で画面いっぱいに埋める（IsoMap.outside）
 */
export const LOCKED_BAND = PLOT_SIZE;

/** 占有範囲のマスが属する区画（"px,py"） */
function footprintPlots(x: number, y: number, size: number): string[] {
  const out: string[] = [];
  for (let dy = 0; dy < size; dy++)
    for (let dx = 0; dx < size; dx++) {
      const { px, py } = plotOf(x + dx, y + dy);
      out.push(plotKey(px, py));
    }
  return out;
}

/** 盤面の範囲と、マスが開いているか。林を押しのけて置いた公園・像（まわり1マスを含む）と道路のマスも開いているものとして描く */
function landOf(input: CityInput, buildings: CityBuilding[]): { rect: Rect; open: (x: number, y: number) => boolean } {
  const plots = new Set(input.plots);
  const land = landBounds({ plots: input.plots });
  const pushed = new Set<string>();
  for (const b of buildings) {
    if (b.placed === false) continue;
    // 林に置いた建物はまわり1マスも切り開き、隣の林の木が建物にかぶらないようにする（道路は道の幅だけ）
    const size = buildingSize(b);
    const inForest = b.line !== "road" && footprintPlots(b.x, b.y, size).some((t) => !plots.has(t));
    const m = inForest ? 1 : 0;
    for (let dy = -m; dy < size + m; dy++) for (let dx = -m; dx < size + m; dx++) pushed.add(tileKey(b.x + dx, b.y + dy));
  }
  return {
    rect: { minX: land.minX - LOCKED_BAND, minY: land.minY - LOCKED_BAND, maxX: land.maxX + LOCKED_BAND, maxY: land.maxY + LOCKED_BAND },
    open: (x, y) => {
      const { px, py } = plotOf(x, y);
      return plots.has(plotKey(px, py)) || pushed.has(tileKey(x, y));
    },
  };
}

export function cityToIso(input: CityInput): { map: IsoMap; overlay: IsoOverlay } {
  // 2回たどる（建物と困りごと）ので、一度だけ取り出す
  const buildings = [...input.buildings];
  const { rect, open } = landOf(input, buildings);
  const shape = { x0: rect.minX, y0: rect.minY, width: rect.maxX - rect.minX + 1, height: rect.maxY - rect.minY + 1 };
  const n = shape.width * shape.height;
  const road = new Uint8Array(n);
  const locked = new Uint8Array(n);
  const lot = new Uint8Array(n);
  const objects: IsoObject[] = [];
  /** 大きな建物の占有範囲の地面を敷地にする */
  const markLot = (x: number, y: number, size: number) => {
    if (size < 2) return;
    for (let dy = 0; dy < size; dy++)
      for (let dx = 0; dx < size; dx++) {
        const i = tileIndex(shape, x + dx, y + dy);
        if (i >= 0) lot[i] = 1;
      }
  };

  for (const b of buildings) {
    if (b.placed === false) continue;
    const i = tileIndex(shape, b.x, b.y);
    if (i < 0) continue;
    if (b.line === "road") {
      road[i] = b.tier + 1;
      continue;
    }
    const size = buildingSize(b);
    markLot(b.x, b.y, size);
    objects.push({ id: b.id, x: b.x, y: b.y, key: buildingKey(b, input.bankLevel, size), ...(size > 1 ? { size } : {}) });
    // 金鉱の前に、未回収の金の量に応じた金貨の山（A4）
    const stage = b.special === "gold_mine" && input.gold ? goldStage(input.gold.uncollected, input.gold.ratePerMinute) : 0;
    if (stage) objects.push({ id: "gold", x: b.x, y: b.y, key: `props/gold/${stage}`, dz: 0.3, ox: 14, oy: 7 });
  }

  // 未開放の区画（OBJ-02）：林か岩で覆い、開拓できる区画の真ん中に看板を立てる。開拓中の区画は林を切り開いた地面にする
  const clearing = new Set((input.jobs ?? []).flatMap((j) => (j.kind === "expand" && j.plot ? [j.plot] : [])));
  const signs = new Set((input.expandable ?? []).map((k) => k.split(",").map((v) => Number(v) * PLOT_SIZE + 2).join(",")));
  for (let y = rect.minY; y <= rect.maxY; y++)
    for (let x = rect.minX; x <= rect.maxX; x++) {
      if (open(x, y)) continue;
      locked[tileIndex(shape, x, y)] = 1;
      const { px, py } = plotOf(x, y);
      if (clearing.has(plotKey(px, py))) continue;
      if (signs.has(tileKey(x, y))) {
        objects.push({ id: `locked:${x},${y}`, x, y, key: "locked/sign" });
        continue;
      }
      objects.push({ id: `locked:${x},${y}`, x, y, key: lockedKey(x, y) });
    }

  // 工事（OBJ-07）：新築は足場、改築・進化は建物の手前に覆い
  // 改築・進化の覆いは、建物と同じ大きさで建物の手前に重ねる
  const sizeAt = new Map(buildings.filter((b) => b.placed !== false).map((b) => [tileKey(b.x, b.y), buildingSize(b)]));
  const jobSize = (j: CityJob) =>
    j.kind === "expand" ? PLOT_SIZE : j.kind === "build" ? (j.line ? buildingSize({ line: j.line, tier: j.tier ?? 0 }) : 1) : (sizeAt.get(tileKey(j.x, j.y)) ?? 1);
  for (const j of input.jobs ?? []) {
    const size = jobSize(j);
    // 開拓は区画の真ん中に足場を置く（バーも真ん中に出る）
    if (j.kind === "expand") {
      objects.push({ id: `job:${j.x},${j.y}`, x: j.x + 2, y: j.y + 2, key: "fx/scaffold" });
      continue;
    }
    const sz = size > 1 ? { size } : {};
    if (j.kind === "build") markLot(j.x, j.y, size);
    objects.push(
      j.kind === "build" ? { id: `job:${j.x},${j.y}`, x: j.x, y: j.y, key: "fx/scaffold", ...sz } : { id: `job:${j.x},${j.y}`, x: j.x, y: j.y, key: "fx/cover", dz: 0.25, ...sz },
    );
  }

  // 重ね描きの配列は、盤面の範囲の行優先
  const zones: Zone[] = new Array(n);
  const noAutoSet = new Set(input.noAuto ?? []);
  const noAuto: boolean[] = new Array(n).fill(false);
  const plannedRoads: boolean[] = new Array(n).fill(false);
  for (let y = rect.minY; y <= rect.maxY; y++)
    for (let x = rect.minX; x <= rect.maxX; x++) {
      const i = tileIndex(shape, x, y);
      zones[i] = input.zones[tileKey(x, y)] ?? "none";
      if (noAutoSet.has(tileKey(x, y))) noAuto[i] = true;
      if (!locked[i] && !road[i] && !lot[i] && isPlannedRoad(x, y)) plannedRoads[i] = true;
    }

  const roadTiles = road.reduce((n, r) => n + (r ? 1 : 0), 0);
  const paved = road.reduce((n, r) => n + (r >= MIN_ROAD.car ? 1 : 0), 0);
  const agents = input.population === undefined ? undefined : agentCounts(input.population, input.logistics ?? 1, roadTiles, paved);
  return {
    map: { ...shape, road, locked, lot, objects, home: { x: 0, y: 0 }, outside: "locked" },
    overlay: {
      zones,
      showZones: input.showZones,
      noAuto: noAutoSet.size ? noAuto : undefined,
      plannedRoads: plannedRoads.some(Boolean) ? plannedRoads : undefined,
      jobs: input.jobs?.map((j) => ({ x: j.x, y: j.y, size: jobSize(j), startedAt: j.startedAt, finishAt: j.finishAt })),
      highlights: input.highlights ? [...input.highlights] : undefined,
      night: input.hour === undefined ? 0 : nightLevel(input.hour),
      lights: lightRatio(input.occupancy),
      people: agents?.people,
      cars: agents?.cars,
      troubles: input.supply ? troubleIcons(buildings, input.supply) : undefined,
    },
  };
}
