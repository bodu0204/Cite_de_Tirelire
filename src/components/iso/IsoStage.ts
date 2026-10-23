// PixiJS で街を描く本体（docs/rendering-requirements.md §3）。React からは IsoCity を通して使う。
import { Application, Container, RenderTexture, Sprite } from "pixi.js";
import { type Agent, createAgents, stepAgent } from "./agents";
import {
  type Camera,
  type Viewport,
  clampCamera,
  decay,
  defaultZoom,
  fitZoom,
  scaleOf,
  screenToWorld,
  snapZoom,
  stepZoom,
  viewRect,
  worldOffset,
  zoomAt,
  zoomRange,
} from "./camera";
import { type ChunkId, CHUNK, chunkKey, chunkRect, visibleChunks } from "./chunks";
import { type IsoMap, groundKey } from "./map";
import { type Iso, depth, iso, mapBounds, toScreen, toTile } from "./projection";
import { type ArtSource, type Entry, TextureBook } from "./textures";

export interface StageOptions {
  /** 基準タイルの幅（64 か 32。§10 の M0 で比べる） */
  tw: number;
  /** 選んだ絵（なければ仮の絵だけで描く） */
  art?: ArtSource;
  /** 人と車の数（OBJ-11） */
  agents?: number;
  /** false ならカメラを固定し、街全体を収める（CAM-09） */
  interactive?: boolean;
  reducedMotion?: boolean;
  camera?: Camera | null;
  onSelect?: (tile: { x: number; y: number }) => void;
  onCamera?: (cam: Camera) => void;
  /** panFps・panMinFps は直近5秒の、動かしていた間の平均と最低（0 なら動かしていない） */
  onStats?: (s: { fps: number; panFps: number; panMinFps: number; sprites: number; chunks: number }) => void;
  onContextLost?: () => void;
}

interface Placed {
  sprite: Sprite;
  entry: Entry;
  x: number;
  y: number;
}

/** 背の高い建物が上のチャンクへはみ出す分（ドット、64px タイル基準） */
const TALL = 160;
/** 焼き付けた地面を残しておく数（これを超えたら見えていないものから捨てる） */
const BAKE_KEEP = 24;
/** タップとみなす動きの上限（CSS px）と時間 */
const TAP_PX = 8;
const TAP_MS = 500;

export class IsoStage {
  readonly app = new Application();
  private p: Iso;
  private book: TextureBook;
  private world = new Container();
  private groundLayer = new Container();
  private markLayer = new Container();
  private objLayer = new Container();
  private map!: IsoMap;
  private chunkObjects = new Map<string, Placed[]>();
  private baked = new Map<string, Sprite>();
  private shown = new Set<string>();
  private bakeQueue: ChunkId[] = [];
  private visibleObjects: Placed[] = [];
  private agents: Agent[] = [];
  private agentSprites: Sprite[] = [];
  private select: Sprite;
  private highlight: Sprite;
  private highlightUntil = 0;
  private cam: Camera = { cx: 0, cy: 0, zoom: 1 };
  private camDirty = true;
  private vel = { x: 0, y: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: { startX: number; startY: number; t: number; moved: boolean; pinchDist?: number; pinchZoom?: number } | null = null;
  private focus: { from: Camera; to: Camera; t0: number; ms: number } | null = null;
  private lastMove = { x: 0, y: 0, t: 0 };
  private panFrames: { t: number; dt: number }[] = [];
  private wasBusy = false;
  private lastStats = 0;
  private destroyed = false;
  /** app.init が終わったか（終わる前に destroy されたら、終わった時点で片付ける） */
  private inited = false;
  private torn = false;

  private constructor(private opts: StageOptions) {
    this.p = iso(opts.tw);
    this.book = new TextureBook(opts.tw);
    this.select = new Sprite();
    this.highlight = new Sprite();
  }

  static async create(host: HTMLElement, map: IsoMap, opts: StageOptions): Promise<IsoStage> {
    const s = new IsoStage(opts);
    await s.app.init({
      resizeTo: host,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      antialias: false,
      background: "#2b3a2a",
      preference: "webgl",
    });
    s.inited = true;
    if (s.destroyed) {
      s.teardown();
      return s;
    }
    if (opts.art) await s.book.load(opts.art).catch((e) => console.warn(e));
    if (s.destroyed) {
      s.teardown();
      return s;
    }
    host.appendChild(s.app.canvas);
    s.setup(map);
    return s;
  }

  private get viewport(): Viewport {
    return { w: this.app.screen.width, h: this.app.screen.height, dpr: this.app.renderer.resolution };
  }

  private setup(map: IsoMap) {
    const canvas = this.app.canvas;
    canvas.style.touchAction = "none";
    canvas.style.display = "block";
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.world.addChild(this.groundLayer, this.markLayer, this.objLayer);
    this.objLayer.sortableChildren = true;
    this.app.stage.addChild(this.world);

    const sel = this.book.get("ui/select");
    this.select.texture = sel.texture;
    this.select.anchor.set(sel.ax / sel.w, sel.ay / sel.h);
    this.select.visible = false;
    const hl = this.book.get("ui/highlight");
    this.highlight.texture = hl.texture;
    this.highlight.anchor.set(hl.ax / hl.w, hl.ay / hl.h);
    this.highlight.visible = false;
    this.markLayer.addChild(this.select, this.highlight);

    this.setMap(map);
    const v = this.viewport;
    if (this.opts.interactive === false) {
      this.fitAll();
    } else if (this.opts.camera) {
      this.cam = clampCamera({ ...this.opts.camera, zoom: snapZoom(this.opts.camera.zoom, v.dpr) }, this.bounds());
    } else {
      const c = toScreen(this.p, (map.width - 1) / 2, (map.height - 1) / 2);
      this.cam = { cx: c.sx, cy: c.sy, zoom: defaultZoom(v.dpr, this.p.tw) };
    }

    if (this.opts.interactive !== false) {
      canvas.addEventListener("pointerdown", this.onDown);
      canvas.addEventListener("pointermove", this.onMove);
      canvas.addEventListener("pointerup", this.onUp);
      canvas.addEventListener("pointercancel", this.onUp);
      canvas.addEventListener("wheel", this.onWheel, { passive: false });
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.app.renderer.on("resize", this.onResize);
    this.app.ticker.add(this.update);
  }

  /** 盤面を入れ替える。地面の焼き付けと建物の絵を作り直す */
  setMap(map: IsoMap) {
    this.map = map;
    for (const s of this.baked.values()) s.destroy({ texture: true, textureSource: true });
    this.baked.clear();
    for (const list of this.chunkObjects.values()) for (const o of list) o.sprite.destroy();
    this.chunkObjects.clear();
    this.shown.clear();
    this.bakeQueue = [];
    this.objLayer.removeChildren();
    this.visibleObjects = [];
    for (const o of map.objects) {
      const k = chunkKey({ cx: Math.floor(o.x / CHUNK), cy: Math.floor(o.y / CHUNK) });
      const entry = this.book.get(o.key);
      const sprite = new Sprite(entry.texture);
      sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
      const s = toScreen(this.p, o.x, o.y);
      sprite.position.set(s.sx, s.sy);
      sprite.zIndex = depth(o.x, o.y);
      const list = this.chunkObjects.get(k) ?? [];
      list.push({ sprite, entry, x: o.x, y: o.y });
      this.chunkObjects.set(k, list);
    }
    for (const s of this.agentSprites) s.destroy();
    this.agents = createAgents(map, this.opts.agents ?? 0);
    this.agentSprites = this.agents.map((a, i) => {
      const e = this.book.get(`agent/${a.kind}/${i % 5}`);
      const s = new Sprite(e.texture);
      s.anchor.set(e.ax / e.w, e.ay / e.h);
      return s;
    });
    if (this.agentSprites.length) this.objLayer.addChild(...this.agentSprites);
    this.camDirty = true;
  }

  setSelected(tile: { x: number; y: number } | null) {
    this.select.visible = !!tile;
    if (tile) {
      const s = toScreen(this.p, tile.x, tile.y);
      this.select.position.set(s.sx, s.sy);
    }
  }

  /** ＋−ボタン（CAM-02）。画面の中心を基準にする */
  zoomBy(dir: 1 | -1) {
    const v = this.viewport;
    this.setCamera(zoomAt(this.cam, v, stepZoom(this.cam.zoom, dir, v.dpr), v.w / 2, v.h / 2));
  }

  /** 一覧から地図の現場へ飛ぶ（CAM-08）。カメラが滑らかに移り、マスを点滅させる */
  focusTile(x: number, y: number) {
    const s = toScreen(this.p, x, y);
    const to = { ...this.cam, cx: s.sx, cy: s.sy };
    this.highlight.position.set(s.sx, s.sy);
    this.highlightUntil = performance.now() + 2000;
    if (this.opts.reducedMotion) this.setCamera(to);
    else this.focus = { from: { ...this.cam }, to, t0: performance.now(), ms: 400 };
  }

  /** 選択マスが画面の端に近づいたらカメラを寄せる（CAM-06） */
  follow(x: number, y: number) {
    const s = toScreen(this.p, x, y);
    const r = viewRect(this.cam, this.viewport);
    const mx = this.p.tw * 2;
    const my = this.p.th * 3;
    if (s.sx < r.minX + mx || s.sx > r.maxX - mx || s.sy < r.minY + my || s.sy > r.maxY - my) this.focusTile(x, y);
  }

  get camera(): Camera {
    return { ...this.cam };
  }

  get mapSize() {
    return { width: this.map.width, height: this.map.height };
  }

  /** 何度呼んでもよい。作成の途中なら、作成が終わった時点で片付ける */
  destroy() {
    this.destroyed = true;
    if (this.inited) this.teardown();
  }

  private teardown() {
    if (this.torn) return;
    this.torn = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.app.ticker.stop();
    this.app.ticker.remove(this.update);
    this.app.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    for (const s of this.baked.values()) s.destroy({ texture: true, textureSource: true });
    this.baked.clear();
    this.book.destroy();
    this.app.destroy(true, { children: true });
  }

  // ---- カメラ ----

  private bounds() {
    return mapBounds(this.p, this.map.width, this.map.height);
  }

  private setCamera(c: Camera) {
    this.cam = clampCamera(c, this.bounds());
    this.camDirty = true;
  }

  private fitAll() {
    const b = this.bounds();
    this.cam = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, zoom: fitZoom(b, this.viewport) };
    this.camDirty = true;
  }

  private applyCamera() {
    const v = this.viewport;
    const s = scaleOf(this.cam.zoom, v.dpr);
    const o = worldOffset(this.cam, v);
    this.world.scale.set(s);
    this.world.position.set(o.x, o.y);
    this.updateVisible();
    this.opts.onCamera?.(this.camera);
  }

  // ---- 画面外の省略と地面の焼き付け（RND-11・12） ----

  private updateVisible() {
    const r = viewRect(this.cam, this.viewport);
    const tall = (TALL * this.p.tw) / 64;
    const keep = visibleChunks(this.p, r, this.map.width, this.map.height, tall, 1);
    const draw = visibleChunks(this.p, r, this.map.width, this.map.height, tall, 0);
    const drawKeys = new Set(draw.map(chunkKey));

    // 見えている分はすぐ焼く。余白の分は1フレームに1つずつ焼き、パン中の引っかかりを防ぐ（NF-01）
    for (const c of draw) this.bake(c);
    this.bakeQueue = keep.filter((c) => !this.baked.has(chunkKey(c)));
    for (const [k, s] of this.baked) s.visible = drawKeys.has(k);
    if (this.baked.size > BAKE_KEEP) {
      const keepKeys = new Set(keep.map(chunkKey));
      for (const [k, s] of this.baked)
        if (!keepKeys.has(k)) {
          s.destroy({ texture: true, textureSource: true });
          this.baked.delete(k);
        }
    }

    // 増えたチャンク・減ったチャンクの建物だけを出し入れする
    const removed = [...this.shown].filter((k) => !drawKeys.has(k));
    const added = [...drawKeys].filter((k) => !this.shown.has(k));
    if (!removed.length && !added.length) return;
    this.shown = drawKeys;
    for (const k of removed) for (const o of this.chunkObjects.get(k) ?? []) this.objLayer.removeChild(o.sprite);
    for (const k of added) {
      const list = this.chunkObjects.get(k);
      if (list?.length) this.objLayer.addChild(...list.map((o) => o.sprite));
    }
    this.visibleObjects = [];
    for (const k of drawKeys) for (const o of this.chunkObjects.get(k) ?? []) this.visibleObjects.push(o);
  }

  private bake(c: ChunkId) {
    const k = chunkKey(c);
    if (this.baked.has(k)) return;
    const r = chunkRect(this.p, c);
    const tmp = new Container();
    const x0 = c.cx * CHUNK;
    const y0 = c.cy * CHUNK;
    for (let y = y0; y < Math.min(y0 + CHUNK, this.map.height); y++)
      for (let x = x0; x < Math.min(x0 + CHUNK, this.map.width); x++) {
        const e = this.book.get(groundKey(this.map, x, y));
        const s = new Sprite(e.texture);
        const p = toScreen(this.p, x, y);
        s.position.set(p.sx - e.ax - r.minX, p.sy - e.ay - r.minY);
        tmp.addChild(s);
      }
    const rt = RenderTexture.create({ width: r.maxX - r.minX, height: r.maxY - r.minY, resolution: 1, scaleMode: "nearest" });
    this.app.renderer.render({ container: tmp, target: rt, clear: true });
    tmp.destroy({ children: true });
    const sprite = new Sprite(rt);
    sprite.position.set(r.minX, r.minY);
    // 余白として先に焼いた分は、見えるようになるまで描かない
    sprite.visible = this.shown.has(k);
    this.groundLayer.addChild(sprite);
    this.baked.set(k, sprite);
  }

  // ---- 毎フレーム ----

  private update = () => {
    const now = performance.now();
    const dt = this.app.ticker.deltaMS;
    const v = this.viewport;

    if (this.focus) {
      const t = Math.min(1, (now - this.focus.t0) / this.focus.ms);
      const e = 1 - (1 - t) ** 3;
      const { from, to } = this.focus;
      this.setCamera({ zoom: to.zoom, cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e });
      if (t >= 1) this.focus = null;
    } else if (!this.pointers.size && (Math.abs(this.vel.x) > 0.01 || Math.abs(this.vel.y) > 0.01)) {
      const s = scaleOf(this.cam.zoom, v.dpr);
      this.setCamera({ ...this.cam, cx: this.cam.cx - (this.vel.x * dt) / s, cy: this.cam.cy - (this.vel.y * dt) / s });
      this.vel.x = decay(this.vel.x, dt);
      this.vel.y = decay(this.vel.y, dt);
    }

    if (!this.opts.reducedMotion && this.agents.length) {
      const r = viewRect(this.cam, v);
      const pad = this.p.tw;
      for (let i = 0; i < this.agents.length; i++) {
        const a = this.agents[i];
        stepAgent(a, this.map, dt / 1000);
        const s = toScreen(this.p, a.x, a.y);
        const sp = this.agentSprites[i];
        const on = s.sx > r.minX - pad && s.sx < r.maxX + pad && s.sy > r.minY - pad && s.sy < r.maxY + pad;
        sp.visible = on;
        if (!on) continue;
        // 道の左側を歩く（向きで少しずらす）
        sp.position.set(Math.round(s.sx + a.dy * 6 * (this.p.tw / 64)), Math.round(s.sy - a.dx * 3 * (this.p.tw / 64)));
        // 並べ替えはマス単位で足りる。値が変わった時だけ並べ替えが起きるよう、マスに丸める
        sp.zIndex = depth(Math.round(a.x), Math.round(a.y)) + 0.5;
      }
    } else if (this.agents.length && this.camDirty) {
      for (let i = 0; i < this.agents.length; i++) {
        const s = toScreen(this.p, this.agents[i].x, this.agents[i].y);
        this.agentSprites[i].position.set(Math.round(s.sx), Math.round(s.sy));
        this.agentSprites[i].zIndex = depth(Math.round(this.agents[i].x), Math.round(this.agents[i].y)) + 0.5;
      }
    }

    this.highlight.visible = now < this.highlightUntil && Math.floor(now / 250) % 2 === 0;

    if (this.camDirty) {
      this.camDirty = false;
      this.applyCamera();
    }
    if (this.bakeQueue.length) this.bake(this.bakeQueue.shift()!);

    // 動きがない時は描画回数を下げる（NF-02）
    const busy = this.pointers.size > 0 || !!this.focus || Math.abs(this.vel.x) > 0.01 || Math.abs(this.vel.y) > 0.01 || now < this.highlightUntil;
    this.app.ticker.maxFPS = busy ? 0 : this.agents.length && !this.opts.reducedMotion ? 30 : 10;

    this.stats(now, busy, dt);
  };

  /** fps の表示。NF-01 は「パン中」の値なので、動かしている間のフレーム間隔を別に集める */
  private stats(now: number, busy: boolean, dt: number) {
    if (!this.opts.onStats) return;
    // 動き始めの1フレームは、止まっていた間（30fps 以下に抑えていた間）の間隔なので数えない
    if (busy && this.wasBusy) this.panFrames.push({ t: now, dt });
    this.wasBusy = busy;
    this.panFrames = this.panFrames.filter((f) => now - f.t < 5000);
    if (now - this.lastStats < 500) return;
    this.lastStats = now;
    const worst = this.panFrames.reduce((m, f) => Math.max(m, f.dt), 0);
    const avg = this.panFrames.length ? this.panFrames.reduce((m, f) => m + f.dt, 0) / this.panFrames.length : 0;
    this.opts.onStats({
      fps: Math.round(this.app.ticker.FPS),
      panFps: avg ? Math.round(1000 / avg) : 0,
      panMinFps: worst ? Math.round(1000 / worst) : 0,
      sprites: this.visibleObjects.length + this.agentSprites.filter((s) => s.visible).length,
      chunks: [...this.baked.values()].filter((s) => s.visible).length,
    });
  }

  // ---- 入力（CAM-01・02・05） ----

  private local(e: PointerEvent | WheelEvent) {
    const r = this.app.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    this.app.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    this.vel = { x: 0, y: 0 };
    this.focus = null;
    if (this.pointers.size === 1) {
      this.gesture = { startX: p.x, startY: p.y, t: performance.now(), moved: false };
      this.lastMove = { x: p.x, y: p.y, t: performance.now() };
    } else if (this.pointers.size === 2 && this.gesture) {
      const [a, b] = [...this.pointers.values()];
      this.gesture.moved = true;
      this.gesture.pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      this.gesture.pinchZoom = this.cam.zoom;
    }
  };

  private onMove = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev || !this.gesture) return;
    const p = this.local(e);
    const v = this.viewport;
    if (this.pointers.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      if (Math.hypot(p.x - this.gesture.startX, p.y - this.gesture.startY) > TAP_PX) this.gesture.moved = true;
      const s = scaleOf(this.cam.zoom, v.dpr);
      this.setCamera({ ...this.cam, cx: this.cam.cx - dx / s, cy: this.cam.cy - dy / s });
      const now = performance.now();
      const dt = Math.max(1, now - this.lastMove.t);
      // 指を離した後の慣性（CAM-01）。直近の速さをなめらかに追う
      this.vel = { x: this.vel.x * 0.5 + (dx / dt) * 0.5, y: this.vel.y * 0.5 + (dy / dt) * 0.5 };
      this.lastMove = { x: p.x, y: p.y, t: now };
      this.pointers.set(e.pointerId, p);
      return;
    }
    // ピンチ中は連続的に動かし、指を離したら整数倍へ吸い付かせる（CAM-03）
    const before = [...this.pointers.values()];
    const midBefore = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
    this.pointers.set(e.pointerId, p);
    const [a, b] = [...this.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const r = zoomRange(v.dpr);
    const z = Math.max(r.min * 0.75, Math.min(r.max * 1.25, (this.gesture.pinchZoom ?? this.cam.zoom) * (Math.hypot(a.x - b.x, a.y - b.y) / (this.gesture.pinchDist ?? 1))));
    const zoomed = zoomAt(this.cam, v, z, mid.x, mid.y);
    const s = scaleOf(z, v.dpr);
    this.setCamera({ ...zoomed, cx: zoomed.cx - (mid.x - midBefore.x) / s, cy: zoomed.cy - (mid.y - midBefore.y) / s });
  };

  private onUp = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p || !this.gesture) return;
    const v = this.viewport;
    if (this.pointers.size === 1) {
      // ピンチの片方の指を離した：残りの指でパンを続ける
      const [rest] = [...this.pointers.values()];
      this.setCamera(zoomAt(this.cam, v, snapZoom(this.cam.zoom, v.dpr), rest.x, rest.y));
      this.vel = { x: 0, y: 0 };
      return;
    }
    if (this.pointers.size > 0) return;
    const g = this.gesture;
    this.gesture = null;
    if (!Number.isInteger(this.cam.zoom)) this.setCamera(zoomAt(this.cam, v, snapZoom(this.cam.zoom, v.dpr), p.x, p.y));
    if (performance.now() - this.lastMove.t > 80 || this.opts.reducedMotion) this.vel = { x: 0, y: 0 };
    if (!g.moved && performance.now() - g.t < TAP_MS) {
      this.vel = { x: 0, y: 0 };
      const tile = this.pick(p.x, p.y);
      if (tile) this.opts.onSelect?.(tile);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const v = this.viewport;
    this.setCamera(zoomAt(this.cam, v, stepZoom(this.cam.zoom, e.deltaY < 0 ? 1 : -1, v.dpr), p.x, p.y));
  };

  /** 手前の建物の不透明な画素を先に調べ、当たらなければ地面のマス（CAM-05） */
  private pick(px: number, py: number): { x: number; y: number } | null {
    const w = screenToWorld(this.cam, this.viewport, px, py);
    const sorted = [...this.visibleObjects].sort((a, b) => b.sprite.zIndex - a.sprite.zIndex);
    for (const o of sorted) {
      const lx = Math.floor(w.x - (o.sprite.x - o.entry.ax));
      const ly = Math.floor(w.y - (o.sprite.y - o.entry.ay));
      if (lx < 0 || ly < 0 || lx >= o.entry.w || ly >= o.entry.h) continue;
      if (o.entry.mask[ly * o.entry.w + lx]) return { x: o.x, y: o.y };
    }
    const t = toTile(this.p, w.x, w.y);
    if (t.x < 0 || t.y < 0 || t.x >= this.map.width || t.y >= this.map.height) return null;
    return t;
  }

  private onResize = () => {
    if (this.opts.interactive === false) this.fitAll();
    this.camDirty = true;
  };

  private onVisibility = () => {
    if (!this.app.ticker) return;
    if (document.hidden) this.app.ticker.stop();
    else this.app.ticker.start();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.opts.onContextLost?.();
  };
}
