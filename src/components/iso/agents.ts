// 道路を行き交う人と車（OBJ-11）。シード付き乱数で決め、同じシードなら同じ動きになる。
import { hash2, isRoad, type IsoMap } from "./map";

export type AgentKind = "person" | "car";

export interface Agent {
  kind: AgentKind;
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

export function createAgents(m: IsoMap, n: number, seed = 1): Agent[] {
  const roads: number[] = [];
  for (let i = 0; i < m.road.length; i++) if (m.road[i]) roads.push(i);
  if (!roads.length) return [];
  const out: Agent[] = [];
  for (let k = 0; k < n; k++) {
    const h = hash2(k, seed, 7);
    const i = roads[h % roads.length];
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    const kind: AgentKind = h % 3 === 0 ? "car" : "person";
    const a: Agent = { kind, x, y, dx: 0, dy: 0, speed: kind === "car" ? 1.6 : 0.5 + ((h >> 4) % 4) * 0.1, rng: h | 1 };
    turn(a, m);
    out.push(a);
  }
  return out;
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
