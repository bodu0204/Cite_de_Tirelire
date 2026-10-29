import { describe, expect, it } from "vitest";
import { fit, room } from "../align";
import { lint, warnings } from "../build-atlas";
import { type Png, readPng } from "../png";
import { frameMask } from "../glow-frames";
import { sideShare, trim, SOIL } from "../trim-base";

const GRASS: [number, number, number] = [0x47, 0x92, 0x2b];
const SOIL_RGB: [number, number, number] = [0x4c, 0x35, 0x2c];

function png(width: number, height: number, color: (x: number, y: number) => [number, number, number] | null): Png {
  const rgba = new Uint8Array(width * height * 4);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const c = color(x, y);
      if (!c) continue;
      rgba.set([...c, 255], (y * width + x) * 4);
      alpha[y * width + x] = 255;
    }
  return { width, height, rgba, alpha };
}

/** 幅 w のひし形の上の面（下の頂点が bottom の行、中心の列が cx）と、その下の厚み depth の土の側面 */
function plate(w: number, h: number, bottom: number, depth = 0, cx = w / 2): Png {
  const drop = (x: number) => Math.floor(Math.abs(x + 0.5 - cx) / 2);
  return png(w, h, (x, y) => {
    const edge = bottom - depth - drop(x);
    const top = bottom - depth - (w / 2 - 1) + drop(x);
    if (Math.abs(x + 0.5 - cx) > w / 2 || y < top) return null;
    if (y <= edge) return GRASS;
    return y <= edge + depth ? SOIL_RGB : null;
  });
}

describe("align.ts の fit（LINT-08）", () => {
  it("中央にあるひし形はずれなし", () => {
    const p = plate(128, 96, 90);
    expect(fit(p, room([p]))).toEqual({ dx: 0, apex: 90 });
  });

  it("横に寄った絵は、中央に戻すずれを返す", () => {
    const p = plate(96, 64, 50, 0, 40);
    // 幅 96 の絵の中に、幅 96 のひし形を中心 40 で描いた（右に 8 空き、左は切れている）
    const { dx } = fit(p, room([p]));
    expect(dx).toBe(8);
  });

  it("前に飛び出した小物があると、前の角をその分だけ下げる", () => {
    const base = plate(128, 112, 90);
    const p = png(128, 112, (x, y) => (x === 30 && y > 70 && y <= 100 ? GRASS : base.alpha[y * 128 + x] ? GRASS : null));
    // x = 30 の列の中心は中央から 33.5 列離れているので、V 字の辺は頂点より 16 ドット上。100 + 16 = 116
    expect(fit(p, room([p])).apex).toBe(116);
  });

  it("基準点がずれている大きな絵を LINT-08 で止める", () => {
    const p = plate(128, 96, 90);
    const ok = { key: "big/building/x/0", png: p, ax: 64, ay: 90 - 31 };
    const bad = { ...ok, key: "big/building/x/1", ay: 90 - 31 - 6 };
    const errors = lint(new Map([ok, bad].map((s) => [s.key, s])), new Set()).filter((e) => e.startsWith("LINT-08"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("big/building/x/1");
  });
});

describe("trim-base.ts（LINT-09）", () => {
  it("土の側面が付いた絵は警告し、削ると警告が消えて足元が上がる", () => {
    const p = plate(64, 48, 44, 4);
    expect(sideShare(p)).toBeGreaterThan(0.9);
    const sprite = { key: "locked/forest", png: p, ax: 32, ay: 29 };
    expect(warnings(new Map([[sprite.key, sprite]]))).toHaveLength(1);
    expect(warnings(new Map([[sprite.key, sprite]]), { "locked/forest": "確認済み" })).toHaveLength(0);

    const trimmed = readPng(trim(p, 6, new Set(SOIL)));
    expect(sideShare(trimmed)).toBe(0);
    expect(fit(trimmed, room([trimmed])).apex).toBe(40);
  });

  it("上の面と同じ茶色でも、厚みより上は削らない", () => {
    const p = png(64, 48, (x, y) => (y >= 20 && y < 44 && x >= 16 && x < 48 ? SOIL_RGB : null));
    const trimmed = readPng(trim(p, 3, new Set(SOIL)));
    expect(trimmed.alpha.reduce((n, a) => n + (a ? 1 : 0), 0)).toBe(32 * 21);
  });
});

describe("glow-frames.ts（動く絵のコマごとの窓の灯り）", () => {
  it("窓の前を部品が通る画素の灯りを消し、窓の色が変わっただけの画素は残す", () => {
    const GLASS: [number, number, number] = [0xa8, 0xe6, 0xee];
    const GLASS2: [number, number, number] = [0x3f, 0x79, 0xa6];
    const RING: [number, number, number] = [0xeb, 0xf0, 0xef];
    const win = (x: number, y: number) => x >= 4 && x < 12 && y >= 4 && y < 12;
    const still = png(16, 16, (x, y) => (win(x, y) ? GLASS : null));
    const glow = png(16, 16, (x, y) => (win(x, y) ? [0xff, 0xe5, 0x8a] : null));
    // コマ：ガラスの色が変わり、y = 8 の行を輪が横切る。コマの絵は上に 2 ドットの余白がある
    const frame = png(16, 18, (x, y) => (!win(x, y - 2) ? null : y - 2 === 8 ? RING : GLASS2));
    const out = frameMask(still, glow, frame, 0, 2);
    const lit = (x: number, y: number) => out[(y * 16 + x) * 4 + 3] > 0;
    expect(lit(5, 5)).toBe(true);
    expect(lit(5, 8)).toBe(false);
    expect(lit(5, 9)).toBe(true);
  });
});
