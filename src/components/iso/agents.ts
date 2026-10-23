// 道路を行き交う人と車（OBJ-11）。シード付き乱数で決め、同じシードなら同じ動きになる。
import { hash2, isRoad, type IsoMap } from "./map";

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

/**
 * 人 people 人と車 cars 台を道路に置く。k 番目の人や車の位置と見た目は k とシードだけで決まるので、
 * 数が増えても既にいる人や車はそのまま（再読み込みやタイムラプスでも同じ見た目。OBJ-11）。
 */
export function createAgents(m: IsoMap, people: number, cars = 0, seed = 1): Agent[] {
  const roads: number[] = [];
  for (let i = 0; i < m.road.length; i++) if (m.road[i]) roads.push(i);
  if (!roads.length) return [];
  const out: Agent[] = [];
  const add = (kind: AgentKind, k: number) => {
    const h = hash2(k, seed, kind === "car" ? 13 : 7);
    const i = roads[h % roads.length];
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
 * 進む向きの絵（東＝画面の右下、南＝左下、北＝右上、西＝左上）。左向きは右向きの絵を左右反転する。
 * 人は前向き（se）と後ろ向き（ne）の2枚。車は左下向き（sw）の1枚で、道の向き（右下がりか右上がりか）だけ合わせる
 * （24px では前後の違いがほとんど見えず、生成した後ろ向きの絵は向きが揃わなかったため）。
 */
export function agentFacing(a: Pick<Agent, "kind" | "dx" | "dy">): { dir: "se" | "ne" | "sw"; flip: boolean } {
  if (a.kind === "car") return { dir: "sw", flip: a.dx !== 0 };
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
  const open = DIRS.filter(([dx, dy]) => isRoad(m, x + dx, y + dy));
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
