// 道路を行き交う人と車（OBJ-11）。シード付き乱数で決め、同じシードなら同じ動きになる。
import { hash2, type IsoMap } from "./map";

export type AgentKind = "person" | "car";

export interface Agent {
  kind: AgentKind;
  /** 見た目の種類（服や車の色） */
  variant: number;
  /** 連続したマス座標 */
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** マス/秒 */
  speed: number;
  /** 曲がる方向を決める乱数の状態 */
  rng: number;
}

const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** 見た目の種類の数（agent/<種類>/<番号>/<向き> の番号） */
export const AGENT_VARIANTS = 4;

/** 通れる道路の段階（IsoMap.road の値）。車は舗装道路から（未舗装道路しかない序盤は走らない） */
export const MIN_ROAD: Record<AgentKind, number> = { person: 1, car: 2 };

function canPass(m: IsoMap, kind: AgentKind, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.width && y < m.height && m.road[y * m.width + x] >= MIN_ROAD[kind];
}

/**
 * 人 people 人と車 cars 台を道路に置く。k 番目の人や車の位置と見た目は k とシードだけで決まるので、
 * 数が増えても既にいる人や車はそのまま（再読み込みやタイムラプスでも同じ見た目。OBJ-11）。
 */
export function createAgents(m: IsoMap, people: number, cars = 0, seed = 1): Agent[] {
  const roads: Record<AgentKind, number[]> = { person: [], car: [] };
  for (let i = 0; i < m.road.length; i++)
    for (const kind of ["person", "car"] as const) if (m.road[i] >= MIN_ROAD[kind]) roads[kind].push(i);
  const out: Agent[] = [];
  const add = (kind: AgentKind, k: number) => {
    const tiles = roads[kind];
    if (!tiles.length) return;
    const h = hash2(k, seed, kind === "car" ? 13 : 7);
    const i = tiles[h % tiles.length];
    const a: Agent = {
      kind,
      variant: (h >>> 8) % AGENT_VARIANTS,
      x: i % m.width,
      y: Math.floor(i / m.width),
      dx: 0,
      dy: 0,
      speed: kind === "car" ? 1.6 : 0.5 + ((h >> 4) % 4) * 0.1,
      rng: h | 1,
    };
    turn(a, m);
    out.push(a);
  };
  for (let k = 0; k < people; k++) add("person", k);
  for (let k = 0; k < cars; k++) add("car", k);
  return out;
}

/**
 * 進む向きの絵（東＝画面の右下、南＝左下、北＝右上、西＝左上）。前向き1枚と後ろ向き1枚を左右反転して4方向にする。
 * 人は前向きが右下向き（se）、車は前向きが左下向き（sw。生成した絵の向き）。後ろ向きはどちらも右上向き（ne）
 */
export function agentFacing(a: Pick<Agent, "kind" | "dx" | "dy">): { dir: "se" | "ne" | "sw"; flip: boolean } {
  if (a.kind === "car") {
    if (a.dy > 0) return { dir: "sw", flip: false };
    if (a.dx > 0) return { dir: "sw", flip: true };
    if (a.dy < 0) return { dir: "ne", flip: false };
    if (a.dx < 0) return { dir: "ne", flip: true };
    return { dir: "sw", flip: false };
  }
  if (a.dx > 0) return { dir: "se", flip: false };
  if (a.dy > 0) return { dir: "se", flip: true };
  if (a.dy < 0) return { dir: "ne", flip: false };
  if (a.dx < 0) return { dir: "ne", flip: true };
  return { dir: "se", flip: false };
}

function nextRand(a: Agent): number {
  // xorshift32
  let r = a.rng;
  r ^= r << 13;
  r ^= r >>> 17;
  r ^= r << 5;
  a.rng = r >>> 0 || 1;
  return a.rng;
}

/** マスの中心で行き先を選ぶ。戻るのは行き止まりの時だけ */
function turn(a: Agent, m: IsoMap) {
  const x = Math.round(a.x);
  const y = Math.round(a.y);
  const open = DIRS.filter(([dx, dy]) => canPass(m, a.kind, x + dx, y + dy));
  const forward = open.filter(([dx, dy]) => !(dx === -a.dx && dy === -a.dy && (a.dx || a.dy)));
  const choices = forward.length ? forward : open;
  if (!choices.length) {
    a.dx = 0;
    a.dy = 0;
    return;
  }
  const [dx, dy] = choices[nextRand(a) % choices.length];
  a.dx = dx;
  a.dy = dy;
}

/** dt 秒進める。マスの中心を通り過ぎたら、そこで向きを選び直す */
export function stepAgent(a: Agent, m: IsoMap, dt: number) {
  let left = a.speed * dt;
  while (left > 0 && (a.dx || a.dy)) {
    const along = a.dx ? a.x : a.y;
    const dir = a.dx || a.dy;
    const next = dir > 0 ? Math.floor(along + 1e-9) + 1 : Math.ceil(along - 1e-9) - 1;
    const dist = Math.abs(next - along);
    // 小数の誤差でマスの中心を踏み越えないよう、ほぼ届く時は届いたことにする
    if (dist > left + 1e-9) {
      if (a.dx) a.x += a.dx * left;
      else a.y += a.dy * left;
      return;
    }
    left = Math.max(0, left - dist);
    if (a.dx) a.x = next;
    else a.y = next;
    turn(a, m);
  }
}
