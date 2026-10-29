import { describe, expect, it } from "vitest";
import { agentFacing, createAgents, stepAgent } from "../agents";
import { effectKind, flashAlpha, particles, popScale } from "../effects";
import { clampCamera, clampToLand, fitZoom, scaleOf, screenToWorld, snapZoom, stepZoom, viewRect, worldOffset, zoomAt, zoomRange } from "../camera";
import { CHUNK, chunkKey, chunkRect, visibleChunks } from "../chunks";
import { BUILDING_LINES, dummyMap, groundKey, isRoad, lockedKey, mapRect, roadMask, tileAt, tileIndex } from "../map";
import { depth, iso, mapBounds, toScreen, toTile } from "../projection";

const P = iso(64);
/** (0, 0) から w × h マスの範囲 */
const R = (w: number, h: number) => ({ minX: 0, minY: 0, maxX: w - 1, maxY: h - 1 });

describe("RND-01 座標変換", () => {
  it("sx = (x − y) × 32、sy = (x + y) × 16", () => {
    expect(toScreen(P, 3, 1)).toEqual({ sx: 64, sy: 64 });
  });

  it("ひし形の内側の点は、そのマスに戻る", () => {
    for (const [x, y] of [
      [0, 0],
      [5, 2],
      [127, 64],
    ]) {
      const { sx, sy } = toScreen(P, x, y);
      for (const [ox, oy] of [
        [0, 0],
        [30, 0],
        [-30, 0],
        [0, 15],
        [0, -15],
        [14, 7],
      ])
        expect(toTile(P, sx + ox, sy + oy)).toEqual({ x, y });
    }
  });

  it("ひし形の外の点は隣のマスになる", () => {
    const { sx, sy } = toScreen(P, 5, 5);
    expect(toTile(P, sx + 20, sy + 12)).toEqual({ x: 6, y: 5 });
  });
});

describe("RND-03 描く順番", () => {
  it("x + y が小さいほど先、同じなら x が小さいほど先", () => {
    expect(depth(1, 1)).toBeLessThan(depth(0, 3));
    expect(depth(0, 2)).toBeLessThan(depth(1, 1));
    expect(depth(1.5, 1)).toBeGreaterThan(depth(1, 1));
  });
});

describe("RND-11・12 チャンク", () => {
  it("チャンクの矩形は 16tw × 16th で、中のマスのひし形をすべて含む", () => {
    const r = chunkRect(P, { cx: 1, cy: 2 });
    expect(r.maxX - r.minX).toBe(CHUNK * P.tw);
    expect(r.maxY - r.minY).toBe(CHUNK * P.th);
    for (let y = 32; y < 48; y++)
      for (let x = 16; x < 32; x++) {
        const { sx, sy } = toScreen(P, x, y);
        expect(sx - 32).toBeGreaterThanOrEqual(r.minX);
        expect(sx + 32).toBeLessThanOrEqual(r.maxX);
        expect(sy - 16).toBeGreaterThanOrEqual(r.minY);
        expect(sy + 16).toBeLessThanOrEqual(r.maxY);
      }
  });

  it("画面に入るチャンクと、その周り1つ分だけを返す", () => {
    const all = visibleChunks(P, mapBounds(P, R(128, 128)), R(128, 128));
    expect(all.length).toBe(64);
    const { sx, sy } = toScreen(P, 64, 64);
    const view = { minX: sx - 200, maxX: sx + 200, minY: sy - 400, maxY: sy + 400 };
    const seen = visibleChunks(P, view, R(128, 128), 0, 0);
    const near = visibleChunks(P, view, R(128, 128));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThanOrEqual(6);
    expect(near.length).toBeGreaterThan(seen.length);
    expect(near.length).toBeLessThan(32);
  });

  it("負の座標の範囲も、その範囲にかかるチャンクだけを返す", () => {
    const tiles = { minX: -20, minY: -20, maxX: 19, maxY: 19 };
    const all = visibleChunks(P, mapBounds(P, tiles), tiles);
    expect(all.map(chunkKey).sort()).toEqual(["-1,-1", "-1,0", "-2,-1", "-2,-2", "-2,0", "-1,-2", "0,-1", "0,-2", "0,0", "0,1", "1,-1", "1,-2", "1,0", "1,1", "-1,1", "-2,1"].sort());
    const { sx, sy } = toScreen(P, -10, -10);
    const seen = visibleChunks(P, { minX: sx - 10, maxX: sx + 10, minY: sy - 10, maxY: sy + 10 }, tiles, 0, 0);
    expect(seen.map(chunkKey)).toEqual(["-1,-1"]);
  });
});

describe("盤面の範囲（docs/map-layout-redesign.md §6.4）", () => {
  it("左上のマスがずれた盤面でも、マスと配列の番号が行き来できる", () => {
    const m = { x0: -7, y0: -3, width: 10, height: 6 };
    expect(mapRect(m)).toEqual({ minX: -7, minY: -3, maxX: 2, maxY: 2 });
    expect(tileIndex(m, -7, -3)).toBe(0);
    expect(tileIndex(m, 2, 2)).toBe(59);
    expect(tileIndex(m, 3, 2)).toBe(-1);
    expect(tileIndex(m, -8, 0)).toBe(-1);
    for (const i of [0, 13, 59]) expect(tileIndex(m, tileAt(m, i).x, tileAt(m, i).y)).toBe(i);
  });

  it("道路と地面のキーは、ずれた範囲のマスで引く", () => {
    const m = { x0: -2, y0: -2, width: 3, height: 3, road: new Uint8Array(9), locked: new Uint8Array(9), objects: [] };
    m.road[tileIndex(m, -1, -2)] = 1;
    m.road[tileIndex(m, -1, -1)] = 2;
    expect(isRoad(m, -1, -1)).toBe(true);
    expect(isRoad(m, 0, 0)).toBe(false);
    expect(groundKey(m, -1, -1)).toBe("road/1/1");
  });

  it("範囲の外は、outside が locked なら未開放の地面。林と岩の並びはマスで決まる", () => {
    const m = { x0: 0, y0: 0, width: 2, height: 2, road: new Uint8Array(4), locked: new Uint8Array(4), objects: [] };
    expect(groundKey({ ...m, outside: "locked" as const }, 5, 5)).toBe("ground/locked");
    expect(groundKey(m, 5, 5)).toMatch(/^ground\/grass\//);
    expect(lockedKey(-30, 7)).toBe(lockedKey(-30, 7));
    const keys = new Set(Array.from({ length: 40 }, (_, i) => lockedKey(i, -i)));
    expect(keys).toEqual(new Set(["locked/forest", "locked/rocks"]));
  });

  it("人と車は、ずれた範囲の道路の上に置く", () => {
    const m = { x0: -5, y0: -5, width: 4, height: 1, road: new Uint8Array([1, 1, 1, 1]), locked: new Uint8Array(4), objects: [] };
    for (const a of createAgents(m, 5)) {
      expect(a.y).toBe(-5);
      expect(a.x).toBeGreaterThanOrEqual(-5);
      expect(a.x).toBeLessThanOrEqual(-2);
    }
  });
});

describe("CAM-03・04 カメラ", () => {
  const v = { w: 390, h: 844, dpr: 3 };

  it("倍率は整数に吸い付き、範囲に収まる", () => {
    expect(zoomRange(3)).toEqual({ min: 1, max: 9 });
    expect(zoomRange(1)).toEqual({ min: 1, max: 4 });
    expect(snapZoom(2.4, 3)).toBe(2);
    expect(snapZoom(0.2, 3)).toBe(1);
    expect(stepZoom(2.4, 1, 3)).toBe(3);
    expect(stepZoom(2.4, -1, 3)).toBe(2);
    expect(stepZoom(9, 1, 3)).toBe(9);
  });

  it("ワールドの位置は物理ピクセル単位に丸まる", () => {
    const o = worldOffset({ cx: 10.37, cy: -3.11, zoom: 2 }, v);
    expect(Math.abs(o.x * 3 - Math.round(o.x * 3))).toBeLessThan(1e-9);
    expect(Math.abs(o.y * 3 - Math.round(o.y * 3))).toBeLessThan(1e-9);
  });

  it("ズームしても指の下の点は動かない", () => {
    const cam = { cx: 100, cy: 50, zoom: 2 };
    const before = screenToWorld(cam, v, 300, 200);
    const after = screenToWorld(zoomAt(cam, v, 5, 300, 200), v, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
  });

  it("中心はマップの外へ出ない", () => {
    const b = mapBounds(P, R(10, 10));
    const c = clampCamera({ cx: 1e6, cy: -1e6, zoom: 1 }, b);
    expect(c.cx).toBe(b.maxX);
    expect(c.cy).toBe(b.minY);
  });

  it("Q5：土地の端は画面の 75% の位置までしか動かない（倍率を変えても同じ）", () => {
    const land = mapBounds(P, { minX: -30, minY: -30, maxX: 29, maxY: 29 });
    for (const zoom of [1, 2, 3]) {
      const s = scaleOf(zoom, v.dpr);
      // 右へ行き過ぎると、土地の右端が画面の左から 75% で止まる
      const right = clampToLand({ cx: 1e6, cy: 0, zoom }, land, v);
      // 位置は物理ピクセルに丸めるので、ずれは1物理ピクセル未満
      expect(Math.abs((land.maxX - viewRect(right, v).minX) * s - v.w * 0.75)).toBeLessThan(1 / v.dpr);
      // 上へ行き過ぎると、土地の上端が画面の上から 25% で止まる
      const up = clampToLand({ cx: 0, cy: -1e6, zoom }, land, v);
      expect(Math.abs((land.minY - viewRect(up, v).minY) * s - v.h * 0.25)).toBeLessThan(1 / v.dpr);
      // 範囲の中なら動かさない
      expect(clampToLand({ cx: 10, cy: 20, zoom }, land, v)).toEqual({ cx: 10, cy: 20, zoom });
    }
  });

  it("Q5：土地が画面の半分より小さい向きは、土地の中心に寄せる", () => {
    const land = mapBounds(P, { minX: -5, minY: -5, maxX: 4, maxY: 4 });
    const c = clampToLand({ cx: 500, cy: -500, zoom: 9 }, { ...land, maxY: land.minY + 10 }, v);
    expect(c.cy).toBe(land.minY + 5);
  });

  it("街全体を収める倍率：収まれば整数、収まらなければ 1/n", () => {
    expect(Number.isInteger(fitZoom(mapBounds(P, R(10, 10)), v))).toBe(true);
    const z = fitZoom(mapBounds(P, R(128, 128)), v);
    expect(z).toBeLessThan(1);
    expect(Number.isInteger(1 / z)).toBe(true);
  });
});

describe("ダミーマップと地面のキー", () => {
  const m = dummyMap(128);

  it("建物のキーは catalog の系統・段階の範囲に収まる", () => {
    expect(m.objects.length).toBeGreaterThan(5000);
    for (const o of m.objects) {
      const [, line, tier] = o.key.split("/");
      expect(BUILDING_LINES).toContain(line);
      expect(Number(tier)).toBeGreaterThanOrEqual(0);
    }
  });

  it("同じ大きさ・シードなら同じマップ", () => {
    expect(dummyMap(128).objects.map((o) => o.key)).toEqual(m.objects.map((o) => o.key));
  });

  it("道路のキーは隣接の向きを表す", () => {
    // 交差点 (2, 2) は四方に道路がある
    expect(isRoad(m, 20, 20)).toBe(true);
    expect(roadMask(m, 20, 20)).toBe(15);
    expect(groundKey(m, 20, 20)).toMatch(/^road\/\d\/15$/);
  });
});

describe("OBJ-11 人と車", () => {
  const m = dummyMap(64);

  it("いつも道路の上にいる", () => {
    const agents = createAgents(m, 100);
    for (let t = 0; t < 200; t++)
      for (const a of agents) {
        stepAgent(a, m, 0.1);
        expect(isRoad(m, Math.round(a.x), Math.round(a.y))).toBe(true);
      }
  });

  it("同じシードなら同じ動き", () => {
    const a = createAgents(m, 20, 3);
    const b = createAgents(m, 20, 3);
    for (let t = 0; t < 50; t++) {
      a.forEach((x) => stepAgent(x, m, 0.25));
      b.forEach((x) => stepAgent(x, m, 0.25));
    }
    expect(a).toEqual(b);
  });

  it("車は舗装道路だけを走り、未舗装道路しかなければ出ない", () => {
    const dirt = { ...m, road: m.road.map((r) => (r ? 1 : 0)) };
    expect(createAgents(dirt, 5, 5).filter((a) => a.kind === "car")).toHaveLength(0);
    // 半分を未舗装道路にしても、車は舗装道路から出ない
    const mixed = { ...m, road: m.road.map((r, i) => (r ? (i % 2 ? 2 : 1) : 0)) };
    const cars = createAgents(mixed, 0, 30);
    for (let t = 0; t < 200; t++)
      for (const a of cars) {
        stepAgent(a, mixed, 0.1);
        expect(mixed.road[Math.round(a.y) * mixed.width + Math.round(a.x)]).toBe(2);
      }
  });

  it("人と車の数を分けて置き、増やしても前からいる人は変わらない", () => {
    const few = createAgents(m, 10, 4);
    const more = createAgents(m, 20, 8);
    expect(few.filter((a) => a.kind === "person")).toHaveLength(10);
    expect(few.filter((a) => a.kind === "car")).toHaveLength(4);
    expect(more.slice(0, 10)).toEqual(few.slice(0, 10));
    expect(more.filter((a) => a.kind === "car").slice(0, 4)).toEqual(few.slice(10));
  });

  it("向きの絵：前向きと後ろ向きを反転して4方向", () => {
    expect(agentFacing({ kind: "person", dx: 1, dy: 0 })).toEqual({ dir: "se", flip: false });
    expect(agentFacing({ kind: "person", dx: 0, dy: 1 })).toEqual({ dir: "se", flip: true });
    expect(agentFacing({ kind: "person", dx: 0, dy: -1 })).toEqual({ dir: "ne", flip: false });
    expect(agentFacing({ kind: "person", dx: -1, dy: 0 })).toEqual({ dir: "ne", flip: true });
    expect(agentFacing({ kind: "car", dx: 0, dy: 1 })).toEqual({ dir: "sw", flip: false });
    expect(agentFacing({ kind: "car", dx: 1, dy: 0 })).toEqual({ dir: "sw", flip: true });
    expect(agentFacing({ kind: "car", dx: 0, dy: -1 })).toEqual({ dir: "ne", flip: false });
    expect(agentFacing({ kind: "car", dx: -1, dy: 0 })).toEqual({ dir: "ne", flip: true });
  });
});

describe("OBJ-13 完成・進化の演出", () => {
  it("差分から種類を決める", () => {
    expect(effectKind(undefined, "building/housing/0")).toBe("build");
    expect(effectKind("building/housing/0", "building/housing/1")).toBe("evolve");
    expect(effectKind("building/housing/1", "building/housing/1@lv2")).toBe("level");
    expect(effectKind("special/statue/gold@stage4", "special/statue/gold")).toBe("build");
    expect(effectKind("special/park/1", "special/park/1@closed")).toBeNull();
    expect(effectKind("building/housing/1", "building/housing/1")).toBeNull();
    expect(effectKind(undefined, "locked/forest")).toBeNull();
    expect(effectKind(undefined, "fx/scaffold")).toBeNull();
  });

  it("粒は同じ入力なら同じで、終われば消える", () => {
    expect(particles("build", 200, 40, 7)).toEqual(particles("build", 200, 40, 7));
    expect(particles("build", 200, 40, 7).length).toBeGreaterThan(0);
    expect(particles("build", 900, 40, 7)).toEqual([]);
    expect(particles("evolve", 1000, 40, 7)).toEqual([]);
  });

  it("跳ねて元の大きさに戻り、光は消える", () => {
    expect(popScale(0).y).toBeLessThan(0.1);
    expect(popScale(350)).toEqual({ x: 1, y: 1 });
    expect(flashAlpha(80)).toBeCloseTo(0.9);
    expect(flashAlpha(500)).toBe(0);
  });
});
