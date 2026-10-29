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
  /** 1 は2ドット四方の粒、2 は十字のきらめき */
  shape: 1 | 2;
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
