// 完成・進化の演出（OBJ-13・A6）。盤面の差分から「何が起きたか」を決め、粒の動きを時刻から計算する。
// 描画（IsoStage）から切り離し、同じ入力なら同じ粒になるようにする（タイムラプスでも同じ見た目）。
import { hash2 } from "./map";

export type EffectKind = "build" | "evolve" | "level";

/** 演出の長さ（ミリ秒） */
export const EFFECT_MS: Record<EffectKind, number> = { build: 800, evolve: 1000, level: 700 };

/** 一度に出す演出の上限（タイムラプスで一斉に変わっても重くしない） */
export const MAX_EFFECTS = 40;

const base = (key: string) => key.split("@")[0];

/**
 * 前の盤面の絵のキー（id → キー）と今のキーから演出の種類を決める。
 * 建物・特殊施設（大きな建物の big/ を含む）だけが対象で、林や足場などは演出しない。
 *   新しく建った・像が完成した → build（跳ねて現れ、土ぼこりと金の粒）
 *   段階が変わった（キーの @ より前が変わった） → evolve（建物が光り、きらめきが上る）
 *   建物Lv・像の段階が上がった → level（小さなきらめき）。閉園は演出しない
 */
export function effectKind(prev: string | undefined, next: string): EffectKind | null {
  if (!/^(big\/)?(building|special)\//.test(next)) return null;
  if (prev === undefined) return "build";
  if (prev === next) return null;
  if (base(prev) !== base(next)) return "evolve";
  if (prev.includes("@stage") && !next.includes("@stage")) return "build";
  if (next.includes("@closed")) return null;
  return "level";
}

export interface Particle {
  /** 基準点（足元）からのずれ（64px タイル基準のドット） */
  x: number;
  y: number;
  color: number;
  /** 1 は2ドット四方の粒、2 は十字のきらめき、3 は光る点のついた3ドット四方の金貨 */
  shape: 1 | 2 | 3;
}

const DUST = [0xefe6d2, 0xd7c8a8, 0xbfae92];
const GOLD = [0xffe082, 0xffd54f, 0xfff8e1];
const SPARK = [0xffffff, 0xfff59d, 0xb3e5fc];

/**
 * t ミリ秒後の粒。height は建物の絵の、基準点から上の高さ（ドット、64px タイル基準）。
 * seed は建物ごとに変え、同じ建物なら毎回同じ粒になる。
 */
export function particles(kind: EffectKind, t: number, height: number, seed: number): Particle[] {
  const out: Particle[] = [];
  const s = t / 1000;
  if (kind === "build") {
    // 足元から左右に広がる土ぼこり（重力で落ちる）
    for (let k = 0; k < 14; k++) {
      const h = hash2(k, seed, 31);
      const life = 0.35 + ((h >>> 4) % 30) / 100;
      if (s > life) continue;
      const vx = ((h % 41) - 20) * 2.2;
      const vy = 28 + ((h >>> 8) % 30);
      out.push({ x: vx * s, y: 4 + ((h >>> 12) % 8) - vy * s + 90 * s * s, color: DUST[k % DUST.length], shape: 1 });
    }
    // 屋根の上で弾ける金の粒
    for (let k = 0; k < 8; k++) {
      const h = hash2(k, seed, 37);
      const delay = 0.15 + ((h >>> 6) % 20) / 100;
      const age = s - delay;
      if (age < 0 || age > 0.5) continue;
      const vx = ((h % 31) - 15) * 2.5;
      out.push({ x: vx * age, y: -height - 30 * age + 80 * age * age, color: GOLD[k % GOLD.length], shape: age < 0.25 ? 2 : 1 });
    }
  } else {
    // 建物の幅と高さの中から、ゆっくり上るきらめき
    const n = kind === "evolve" ? 12 : 5;
    for (let k = 0; k < n; k++) {
      const h = hash2(k, seed, kind === "evolve" ? 41 : 43);
      const delay = ((h >>> 6) % 40) / 100;
      const age = s - delay;
      const life = 0.45;
      if (age < 0 || age > life) continue;
      const x = ((h % 45) - 22) * (kind === "evolve" ? 1 : 0.8);
      const y = -((h >>> 10) % Math.max(8, Math.round(height))) - 18 * age;
      // 前半は十字、後半は1ドットにして消える
      out.push({ x, y, color: SPARK[k % SPARK.length], shape: age < life * 0.6 ? 2 : 1 });
    }
  }
  return out;
}

/** 跳ねて現れる時の縦横の倍率（build の最初の 350 ミリ秒） */
export function popScale(t: number): { x: number; y: number } {
  const u = Math.min(1, t / 350);
  if (u >= 1) return { x: 1, y: 1 };
  // 縦に伸びて少し行き過ぎ、元に戻る。横は逆に縮む
  const y = u < 0.6 ? (u / 0.6) * 1.12 : 1.12 - ((u - 0.6) / 0.4) * 0.12;
  return { x: 1 + (1 - y) * 0.4, y: Math.max(0.05, y) };
}

/** 進化の時に建物を光らせる強さ（evolve の最初の 500 ミリ秒） */
export function flashAlpha(t: number): number {
  if (t >= 500) return 0;
  return t < 80 ? (t / 80) * 0.9 : 0.9 * (1 - (t - 80) / 420);
}

// ---- 銀行から工事現場へ飛ぶ金貨（docs/savings-driven-growth.md FX-02） ----

/** 1枚の金貨が飛ぶ時間、1つの現場へ飛ばす枚数と、その間隔（ミリ秒） */
export const COIN_FLIGHT_MS = 650;
export const COINS_PER_SITE = 5;
export const COIN_GAP_MS = 60;
/** 次の現場へ飛ばし始めるまでのずれ（工事が一斉に始まる様子を、順に飛ぶ金貨で見せる） */
export const SITE_GAP_MS = 110;
/** 一度に金貨を飛ばす現場の上限 */
export const MAX_FLIGHTS = 16;
/** 金貨が着いた所のきらめきの長さ */
const LAND_MS = 180;

/** 1つの現場への金貨の演出全体の長さ */
export const flightMs = () => (COINS_PER_SITE - 1) * COIN_GAP_MS + COIN_FLIGHT_MS + LAND_MS;

/**
 * t ミリ秒後の、銀行から現場へ飛ぶ金貨。基準点は銀行の足元で、dx・dy は現場の足元までのずれ、
 * lift は金貨が出る高さ（銀行の屋根のあたり。どれも 64px タイル基準のドット）。
 * 金貨は放物線を描いて現場の足元に落ち、着いた所で小さくきらめく。seed で金貨ごとのばらつきを決める
 */
export function coinFlight(t: number, dx: number, dy: number, lift: number, seed: number): Particle[] {
  const out: Particle[] = [];
  const arc = 24 + Math.min(60, Math.hypot(dx, dy) * 0.2);
  for (let k = 0; k < COINS_PER_SITE; k++) {
    const age = t - k * COIN_GAP_MS;
    if (age < 0) continue;
    const h = hash2(k, seed, 47);
    const jx = ((h % 7) - 3) * 0.8;
    const jy = (((h >>> 4) % 5) - 2) * 0.6;
    const u = age / COIN_FLIGHT_MS;
    if (u <= 1) {
      // 上へ弾み出てから落ちる（出る高さ → 足元。途中で arc だけ持ち上げる）
      const x = dx * u + jx * (1 - u);
      const y = -lift * (1 - u) + dy * u - arc * 4 * u * (1 - u) + jy * (1 - u);
      out.push({ x, y, color: GOLD[k % GOLD.length], shape: 3 });
    } else if (age - COIN_FLIGHT_MS < LAND_MS) {
      out.push({ x: dx + jx, y: dy - 4 + jy, color: SPARK[k % SPARK.length], shape: 2 });
    }
  }
  return out;
}

// ---- タイムラプスの花火（docs/savings-driven-growth.md REC-06。銀貨で買う演出） ----

/** 花火1発の長さ：打ち上げ（RISE）と、弾けて消えるまで（BURST） */
const RISE_MS = 520;
const BURST_MS = 1100;
export const FIREWORK_MS = RISE_MS + BURST_MS;
/** 一度に打ち上げる花火の上限 */
export const MAX_FIREWORKS = 8;

const FIREWORK_COLORS = [
  [0xff8a80, 0xffcdd2],
  [0x82b1ff, 0xe3f2fd],
  [0xb9f6ca, 0xf1f8e9],
  [0xffe082, 0xfff8e1],
  [0xea80fc, 0xf3e5f5],
];

/**
 * t ミリ秒後の花火1発。基準点は打ち上げる地面で、rise ドット上がってから丸く弾け、ゆっくり落ちて消える。
 * 色と広がり方は seed で決める（同じ seed なら同じ花火）
 */
export function firework(t: number, rise: number, seed: number): Particle[] {
  const out: Particle[] = [];
  const [main, light] = FIREWORK_COLORS[hash2(seed, 3, 53) % FIREWORK_COLORS.length];
  if (t < RISE_MS) {
    // 尾を引いて上る火の玉（減速しながら）
    const u = t / RISE_MS;
    const y = -rise * (1 - (1 - u) * (1 - u));
    out.push({ x: 0, y, color: 0xfff8e1, shape: 1 });
    if (u > 0.15) out.push({ x: 0, y: y + 5, color: light, shape: 1 });
    return out;
  }
  const age = (t - RISE_MS) / 1000;
  if (age * 1000 >= BURST_MS) return out;
  const n = 22;
  const speed = 42 + (hash2(seed, 5, 59) % 18);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (hash2(seed, 7, 61) % 100) / 100;
    const v = speed * (0.75 + ((hash2(k, seed, 67) % 25) / 100));
    // 外へ広がりながら減速し、少しずつ落ちる
    const r = v * age * (1 - Math.min(0.9, age * 0.55));
    const x = Math.cos(a) * r;
    const y = -rise + Math.sin(a) * r * 0.85 + 22 * age * age;
    // 最後の3分の1は点滅させて消す
    const late = age * 1000 > BURST_MS * 0.66;
    if (late && (k + Math.floor(age * 20)) % 2) continue;
    out.push({ x, y, color: age < 0.35 ? light : main, shape: age < 0.3 ? 2 : 1 });
  }
  return out;
}
