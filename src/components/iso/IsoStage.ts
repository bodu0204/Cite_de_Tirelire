// PixiJS で街を描く本体（docs/rendering-requirements.md §3）。React からは IsoCity を通して使う。
import { AnimatedSprite, Application, Container, Graphics, RenderTexture, Sprite } from "pixi.js";
import { type Agent, agentFacing, createAgents, stepAgent } from "./agents";
import {
  type Camera,
  type Viewport,
  clampToLand,
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
import { type ChunkId, type Rect, CHUNK, chunkKey, chunkOf, chunkRect, visibleChunks } from "./chunks";
import { nightColor } from "./compose";
import { type EffectKind, EFFECT_MS, MAX_EFFECTS, effectKind, flashAlpha, particles, popScale } from "./effects";
import { type IsoMap, type IsoObject, type IsoOverlay, groundKey, hash2, lockedKey, mapRect, objectCenter, tileAt, tileIndex } from "./map";
import { type Iso, depth, iso, mapBounds, toScreen, toTile, toTileF } from "./projection";
import { type ArtSource, type Entry, TextureBook } from "./textures";

export interface StageOptions {
  /** 基準タイルの幅（64 か 32。§10 の M0 で比べる） */
  tw: number;
  /** 絵の読み込み元。"atlas" は public/sprites/ のアトラス、ArtSource は開発用の選んだ絵。なければ仮の絵だけで描く */
  art?: ArtSource | "atlas";
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
  /** 工事の進み具合に使う時刻の補正（サーバー時刻 − 端末時刻） */
  serverOffset?: number;
}

interface Placed {
  id: string;
  /** 建物の絵と夜の窓の灯りをまとめた入れ物（並べ替えはこの単位） */
  node: Container;
  sprite: Sprite;
  /** 夜の窓の灯り（加算。夜の色は掛けない） */
  glow: Sprite | null;
  /** 進化の時に建物を光らせる、同じ絵の加算の重ね */
  flash: Sprite | null;
  key: string;
  entry: Entry;
  /** 占有範囲の左上のマスと一辺 */
  x: number;
  y: number;
  size: number;
}

/** 用途の色と記号（OBJ-08：色だけに頼らない） */
const ZONE_STYLE: Record<string, { color: number; mark: "house" | "circle" | "square" | "plus" | "diamond" | "star" } | undefined> = {
  residential: { color: 0xffd54f, mark: "house" },
  commercial: { color: 0x4fc3f7, mark: "circle" },
  industrial: { color: 0xa1887f, mark: "square" },
  agricultural: { color: 0xc5e1a5, mark: "plus" },
  public: { color: 0xce93d8, mark: "diamond" },
  special: { color: 0xffb74d, mark: "star" },
};

/** 完成・進化の演出の1件（OBJ-13） */
interface Effect {
  kind: EffectKind;
  id: string;
  x: number;
  y: number;
  /** 建物の絵の、基準点から上の高さ（64px タイル基準のドット） */
  height: number;
  seed: number;
  t0: number;
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
  private zoneGfx = new Graphics();
  private objLayer = new Container();
  private fxLayer = new Container();
  private fxGfx = new Graphics();
  private highlightSprites: Sprite[] = [];
  private overlay: IsoOverlay = {};
  private groundKeys: string[] = [];
  private chunkSig = new Map<string, string>();
  private map!: IsoMap;
  /** 盤面の範囲（マス） */
  private tiles: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** 開いている土地を囲む矩形（ワールド座標。カメラの移動範囲を決める） */
  private land: Rect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private chunkObjects = new Map<string, Placed[]>();
  /** 盤面の絵（建物など）をチャンクごとに分けたもの */
  private mapChunks = new Map<string, IsoObject[]>();
  private baked = new Map<string, Sprite>();
  private shown = new Set<string>();
  private bakeQueue: ChunkId[] = [];
  private visibleObjects: Placed[] = [];
  private agents: Agent[] = [];
  private agentSprites: AnimatedSprite[] = [];
  /** 人や車がいま使っている絵のキー（向きが変わった時だけ絵を替える） */
  private agentFace: string[] = [];
  private roadSig = "";
  /** 前の盤面の絵のキー（id → キー）。演出を決めるのに使う。最初の読み込みの前は null */
  private objKeys: Map<string, string> | null = null;
  private effects: Effect[] = [];
  private placedById = new Map<string, Placed>();
  /** マス（"x,y"）→ そのマスを占める建物（大きな建物は占有範囲のすべてのマス） */
  private cover = new Map<string, Placed>();
  /** 困りごとアイコン（A3）。建物の上に出し、夜の色は掛けない */
  private troubleLayer = new Container();
  private troubleSprites: { sp: Sprite; y: number }[] = [];
  private troubleSig = "";
  private darkTiles = new Set<string>();
  private heights = new Map<string, number>();
  private select: Sprite;
  /**
   * 選んだマスを建物の上にも出す（OBJ-10・RND-04 の一番上の層）：建物に隠れないよう、ひし形の枠を半透明で重ね、
   * マスの建物の輪郭を白く光らせる
   */
  private selectLayer = new Container();
  private selectGhost: Sprite;
  private selected: { x: number; y: number } | null = null;
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
  private fxDrawn = false;
  /** 再生中の動く絵の数（動きがある間は描画回数を下げすぎない） */
  private animCount = 0;
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
    this.selectGhost = new Sprite();
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
    // 絵が読めなくても仮の絵で描けるので、止めずに続ける
    if (opts.art === "atlas") await s.book.loadAtlas().catch((e) => console.warn(e));
    else if (opts.art) await s.book.load(opts.art).catch((e) => console.warn(e));
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
    this.world.addChild(this.groundLayer, this.markLayer, this.objLayer, this.fxLayer, this.troubleLayer, this.selectLayer);
    this.objLayer.sortableChildren = true;
    this.app.stage.addChild(this.world);

    const sel = this.book.get("ui/select");
    this.select.texture = sel.texture;
    this.select.anchor.set(sel.ax / sel.w, sel.ay / sel.h);
    this.select.visible = false;
    this.selectGhost.texture = sel.texture;
    this.selectGhost.anchor.copyFrom(this.select.anchor);
    this.selectGhost.alpha = 0.5;
    const hl = this.book.get("ui/highlight");
    this.highlight.texture = hl.texture;
    this.highlight.anchor.set(hl.ax / hl.w, hl.ay / hl.h);
    this.highlight.visible = false;
    this.markLayer.addChild(this.zoneGfx, this.select, this.highlight);
    this.fxLayer.addChild(this.fxGfx);

    this.setMap(map);
    const v = this.viewport;
    if (this.opts.interactive === false) {
      this.fitAll();
    } else if (this.opts.camera) {
      this.setCamera({ ...this.opts.camera, zoom: snapZoom(this.opts.camera.zoom, v.dpr) });
    } else {
      // 盤面の指定がなければ、開いている土地の中心
      const c = map.home ? toScreen(this.p, map.home.x, map.home.y) : { sx: (this.land.minX + this.land.maxX) / 2, sy: (this.land.minY + this.land.maxY) / 2 };
      this.setCamera({ cx: c.sx, cy: c.sy, zoom: defaultZoom(v.dpr, this.p.tw) });
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

  /**
   * 盤面を入れ替える。変わったところだけ描き直す（タイムラプスは毎フレーム呼ぶ）。
   * 地面は絵のキーが変わったマスのチャンクだけ焼き直し、建物はチャンクごとに中身が変わった時だけ作り直す。
   */
  setMap(map: IsoMap) {
    const rect = mapRect(map);
    const prev = this.tiles;
    const resized = !this.map || rect.minX !== prev.minX || rect.minY !== prev.minY || rect.maxX !== prev.maxX || rect.maxY !== prev.maxY;
    this.map = map;
    this.tiles = rect;
    // 範囲が変わると配列の番号がずれるので、地面を全部焼き直す（開拓した時だけ）
    if (resized) {
      for (const s of this.baked.values()) s.destroy({ texture: true, textureSource: true });
      this.baked.clear();
      this.groundKeys = [];
      this.bakeQueue = [];
    }
    // 地面と、開いている土地の範囲
    const keys = new Array<string>(map.width * map.height);
    const dirty = new Set<string>();
    const open = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (let i = 0; i < keys.length; i++) {
      const { x, y } = tileAt(map, i);
      keys[i] = groundKey(map, x, y);
      if (keys[i] !== this.groundKeys[i]) dirty.add(chunkKey(chunkOf(x, y)));
      if (map.locked[i]) continue;
      open.minX = Math.min(open.minX, x);
      open.minY = Math.min(open.minY, y);
      open.maxX = Math.max(open.maxX, x);
      open.maxY = Math.max(open.maxY, y);
    }
    this.groundKeys = keys;
    const land = mapBounds(this.p, open.minX === Infinity ? rect : open);
    const landChanged = land.minX !== this.land.minX || land.minY !== this.land.minY || land.maxX !== this.land.maxX || land.maxY !== this.land.maxY;
    this.land = land;
    if (landChanged && this.inited && !this.destroyed) {
      if (this.opts.interactive === false) this.fitAll();
      else this.setCamera(this.cam);
    }
    for (const k of dirty) {
      this.baked.get(k)?.destroy({ texture: true, textureSource: true });
      this.baked.delete(k);
    }
    // 建物などの絵
    const byChunk = new Map<string, IsoObject[]>();
    for (const o of map.objects) {
      // 大きな建物は手前の角のマスで数える。絵は手前の角から上へ伸びるので、左上のマスで数えると
      // そのチャンクが画面の外に出た時に、まだ見えている建物まで消えてしまう
      const n = (o.size ?? 1) - 1;
      const k = chunkKey(chunkOf(o.x + n, o.y + n));
      const list = byChunk.get(k) ?? [];
      list.push(o);
      byChunk.set(k, list);
    }
    // 完成・進化の演出（OBJ-13）：前の盤面との差から決める。最初の読み込みと大きさが変わった時は出さない
    const prevKeys = this.objKeys;
    this.objKeys = new Map(map.objects.map((o) => [o.id, o.key]));
    const born: { o: IsoObject; kind: EffectKind }[] = [];
    if (prevKeys && !resized && !this.opts.reducedMotion)
      for (const o of map.objects) {
        const kind = effectKind(prevKeys.get(o.id), o.key);
        if (kind) born.push({ o, kind });
      }
    this.mapChunks = byChunk;
    const allChunks = new Set([...byChunk.keys(), ...this.chunkObjects.keys()]);
    let changed = false;
    for (const k of allChunks) if (this.buildChunk(k)) changed = true;
    if (changed) {
      this.visibleObjects = [...this.shown].flatMap((k) => this.chunkObjects.get(k) ?? []);
      this.cover.clear();
      for (const o of this.placedById.values()) {
        if (!/^(big\/)?(building|special)\//.test(o.key)) continue;
        for (let dy = 0; dy < o.size; dy++) for (let dx = 0; dx < o.size; dx++) this.cover.set(`${o.x + dx},${o.y + dy}`, o);
      }
      // 建物が変わると屋根の高さも変わるので、アイコンと選択の輪郭を置き直す
      this.troubleSig = "";
      this.drawTroubles();
      this.drawSelection();
    }
    const now = performance.now();
    for (const { o, kind } of born) {
      // 同じ建物の演出は新しい方に置き換える
      this.effects = this.effects.filter((e) => e.id !== o.id);
      if (this.effects.length >= MAX_EFFECTS) break;
      const pl = this.placedById.get(o.id);
      const c = objectCenter(o);
      this.effects.push({ kind, id: o.id, x: c.x, y: c.y, height: pl ? (this.artHeight(o.key) * 64) / this.p.tw : 32, seed: hash2(o.x, o.y, 5), t0: now });
    }
    // 道路が変わったら人と車を置き直す（道路の上にしかいられないため）
    const roadSig = map.road.join("");
    if (resized || roadSig !== this.roadSig) {
      this.roadSig = roadSig;
      this.resetAgents();
    }
    if (dirty.size || resized) this.camDirty = true;
  }

  /**
   * チャンクの中の絵：盤面の絵と、盤面の範囲の外を林と岩で埋める絵（map.outside）。
   * 中身が変わった時だけ作り直し、作り直したら true
   */
  private buildChunk(k: string): boolean {
    const list = [...(this.mapChunks.get(k) ?? [])];
    if (this.map.outside === "locked") {
      const [cx, cy] = k.split(",").map(Number);
      for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++)
        for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) if (tileIndex(this.map, x, y) < 0) list.push({ id: `fill:${x},${y}`, x, y, key: lockedKey(x, y) });
    }
    const sig = list.map((o) => `${o.id}:${o.key}:${o.x},${o.y}:${o.dz ?? 0}:${o.ox ?? 0},${o.oy ?? 0}`).join("|");
    if ((this.chunkSig.get(k) ?? "") === sig) return false;
    this.chunkSig.set(k, sig);
    const shown = this.shown.has(k);
    for (const o of this.chunkObjects.get(k) ?? []) {
      if (shown) this.objLayer.removeChild(o.node);
      if (o.sprite instanceof AnimatedSprite) this.animCount--;
      if (this.placedById.get(o.id) === o) this.placedById.delete(o.id);
      o.node.destroy({ children: true });
    }
    const placed = list.map((o) => this.place(o));
    for (const o of placed) this.placedById.set(o.id, o);
    this.chunkObjects.set(k, placed);
    if (shown && placed.length) this.objLayer.addChild(...placed.map((o) => o.node));
    return true;
  }

  /** 人と車の数（overlay で指定がなければ、試作ページの agents を人2：車1 で分ける） */
  private get agentCounts(): { people: number; cars: number } {
    const o = this.overlay;
    if (o.people !== undefined || o.cars !== undefined) return { people: o.people ?? 0, cars: o.cars ?? 0 };
    const n = this.opts.agents ?? 0;
    const people = Math.round((n * 2) / 3);
    return { people, cars: n - people };
  }

  private resetAgents() {
    for (const sp of this.agentSprites) {
      this.objLayer.removeChild(sp);
      sp.destroy();
    }
    const { people, cars } = this.agentCounts;
    this.agents = createAgents(this.map, people, cars);
    this.agentFace = [];
    this.agentSprites = this.agents.map((a) => {
      const sp = new AnimatedSprite([this.book.get(this.agentKey(a)).texture]);
      sp.tint = this.nightTint;
      return sp;
    });
    this.agents.forEach((_, i) => this.faceAgent(i));
    if (this.agentSprites.length) this.objLayer.addChild(...this.agentSprites);
    this.camDirty = true;
  }

  private agentKey(a: Agent): string {
    const { dir, flip } = agentFacing(a);
    return `agent/${a.kind}/${a.variant}/${dir}${flip ? "@flip" : ""}`;
  }

  /** 進む向きの絵にする。人は歩くコマを再生する（動きを減らす設定では止めた絵） */
  private faceAgent(i: number) {
    const key = this.agentKey(this.agents[i]);
    if (this.agentFace[i] === key) return;
    this.agentFace[i] = key;
    const sp = this.agentSprites[i];
    const anim = this.opts.reducedMotion ? null : this.book.getAnim(key);
    const first = anim ? anim.entries[0] : this.book.get(key);
    if (anim) {
      sp.textures = anim.entries.map((e) => e.texture);
      sp.animationSpeed = anim.fps / 60;
      sp.play();
    } else {
      sp.textures = [first.texture];
      sp.stop();
    }
    sp.anchor.set(first.ax / first.w, first.ay / first.h);
  }

  private place(o: IsoObject): Placed {
    // 動く絵はコマ送りで再生する（OBJ-12）。動きを減らす設定の時は止めた絵（1コマ目と同じ見た目）を出す
    const anim = this.opts.reducedMotion ? null : this.book.getAnim(o.key);
    const entry = anim ? anim.entries[0] : this.book.get(o.key);
    let sprite: Sprite;
    if (anim) {
      const a = new AnimatedSprite(anim.entries.map((e) => e.texture));
      a.animationSpeed = anim.fps / 60;
      // 同じ絵が並んでも揃って動かないよう、マスごとに始めのコマをずらす
      const n = anim.entries.length;
      a.gotoAndPlay((((o.x * 3 + o.y * 5) % n) + n) % n);
      sprite = a;
      this.animCount++;
    } else sprite = new Sprite(entry.texture);
    sprite.anchor.set(entry.ax / entry.w, entry.ay / entry.h);
    sprite.tint = this.nightTint;
    const node = new Container();
    node.addChild(sprite);
    // 大きな建物は占有範囲の中心に置き、重なり順も中心で決める（隣の道路を通る人や車が建物の手前に出る）
    const c = objectCenter(o);
    const s = toScreen(this.p, c.x, c.y);
    const u = this.p.tw / 64;
    node.position.set(Math.round(s.sx + (o.ox ?? 0) * u), Math.round(s.sy + (o.oy ?? 0) * u));
    node.zIndex = depth(c.x, c.y) + (o.dz ?? 0);
    const placed: Placed = { id: o.id, node, sprite, glow: null, flash: null, key: o.key, entry, x: o.x, y: o.y, size: o.size ?? 1 };
    this.updateGlow(placed);
    return placed;
  }

  /** 夜の窓の灯りを付け外しする（夜の暗さと灯る割合に合わせる） */
  private updateGlow(o: Placed) {
    const night = this.overlay.night ?? 0;
    // 電気が足りない建物（困りごとアイコンの dark）は窓を灯さない
    const dark = this.darkTiles.has(`${o.x},${o.y}`);
    const g = night > 0 && !dark ? this.book.getGlow(o.key, this.overlay.lights ?? 1) : null;
    if (!g) {
      if (o.glow) {
        o.glow.destroy();
        o.glow = null;
      }
      return;
    }
    if (!o.glow) {
      o.glow = new Sprite();
      o.glow.blendMode = "add";
      o.node.addChild(o.glow);
    }
    o.glow.texture = g.texture;
    o.glow.anchor.set(g.ax / g.w, g.ay / g.h);
    o.glow.alpha = night;
  }

  /** 昼夜の色（OBJ-14）：夜ほど暗い青を掛ける。窓の灯りには掛けない */
  private get nightTint(): number {
    const [r, g, b] = nightColor(this.overlay.night ?? 0);
    return (r << 16) | (g << 8) | b;
  }

  private applyNight() {
    const tint = this.nightTint;
    for (const sp of this.baked.values()) sp.tint = tint;
    for (const list of this.chunkObjects.values())
      for (const o of list) {
        o.sprite.tint = tint;
        this.updateGlow(o);
      }
    for (const a of this.agentSprites) a.tint = tint;
  }

  setServerOffset(ms: number) {
    this.opts.serverOffset = ms;
  }

  /** 用途・対象外の印・工事のバー・強調（盤面とは別に描き直す） */
  setOverlay(o: IsoOverlay) {
    const nightChanged = (o.night ?? 0) !== (this.overlay.night ?? 0) || (o.lights ?? 1) !== (this.overlay.lights ?? 1);
    const agentsChanged = o.people !== this.overlay.people || o.cars !== this.overlay.cars;
    const dark = new Set((o.troubles ?? []).filter((t) => t.dark).map((t) => `${t.x},${t.y}`));
    const darkChanged = [...dark].join() !== [...this.darkTiles].join();
    this.darkTiles = dark;
    this.overlay = o;
    if ((nightChanged || darkChanged) && this.map) this.applyNight();
    if (this.map) this.drawTroubles();
    if (agentsChanged && this.map) this.resetAgents();
    this.drawZones();
    // 強調（B6）：マスの枠を点滅させる
    const want = o.highlights ?? [];
    while (this.highlightSprites.length < want.length) {
      const e = this.book.get("ui/highlight");
      const sp = new Sprite(e.texture);
      sp.anchor.set(e.ax / e.w, e.ay / e.h);
      this.markLayer.addChild(sp);
      this.highlightSprites.push(sp);
    }
    this.highlightSprites.forEach((sp, i) => {
      const k = want[i];
      sp.visible = !!k;
      if (!k) return;
      const [x, y] = k.split(",").map(Number);
      const s = toScreen(this.p, x, y);
      sp.position.set(s.sx, s.sy);
    });
  }

  /**
   * 絵の、基準点から一番上の不透明な画素までの高さ（ドット）。止めた絵で測る（煙のコマは上に余白を足してあり、
   * 生成した絵も上に透明な余白があるため、基準点の位置だけでは屋根の高さが分からない）
   */
  private artHeight(key: string): number {
    let h = this.heights.get(key);
    if (h === undefined) {
      const e = this.book.get(key);
      let top = 0;
      while (top < e.h && !e.mask.subarray(top * e.w, (top + 1) * e.w).some((v) => v)) top++;
      h = Math.max(0, e.ay - top);
      this.heights.set(key, h);
    }
    return h;
  }

  /** 困りごとアイコンを建物の上に置き直す（並びが変わった時だけ） */
  private drawTroubles() {
    const list = this.overlay.troubles ?? [];
    const sig = list.map((t) => `${t.x},${t.y},${t.kind}`).join("|");
    if (sig === this.troubleSig) return;
    this.troubleSig = sig;
    for (const t of this.troubleSprites) t.sp.destroy();
    const u = this.p.tw / 64;
    this.troubleSprites = list.map((t) => {
      const e = this.book.get(`icons/${t.kind}`);
      const sp = new Sprite(e.texture);
      sp.anchor.set(e.ax / e.w, e.ay / e.h);
      // 建物の絵の位置（大きな建物は占有範囲の中心）
      const pl = this.cover.get(`${t.x},${t.y}`);
      const s = pl ? { sx: pl.node.x, sy: pl.node.y } : toScreen(this.p, t.x, t.y);
      // 屋根の一番上に少し重ねる（離れて浮くと、どの建物のアイコンか分かりにくい）
      const y = Math.round(s.sy - (pl ? this.artHeight(pl.key) : 16 * u) + 4 * u);
      sp.position.set(Math.round(s.sx), y);
      this.troubleLayer.addChild(sp);
      return { sp, y };
    });
  }

  private diamond(g: Graphics, x: number, y: number, scale = 1) {
    const s = toScreen(this.p, x, y);
    const hw = (this.p.tw / 2) * scale;
    const hh = (this.p.th / 2) * scale;
    g.poly([s.sx, s.sy - hh, s.sx + hw, s.sy, s.sx, s.sy + hh, s.sx - hw, s.sy]);
  }

  private drawZones() {
    const g = this.zoneGfx;
    g.clear();
    const { zones, showZones, plannedRoads } = this.overlay;
    if (!showZones || !zones) return;
    const u = this.p.tw / 64;
    // 推奨道路（まだ道路のないところ）は、白い点線のひし形で示す
    plannedRoads?.forEach((on, i) => {
      if (!on) return;
      const t = tileAt(this.map, i);
      this.diamond(g, t.x, t.y, 0.7);
      g.stroke({ color: 0xffffff, alpha: 0.6, width: u });
    });
    for (let i = 0; i < zones.length; i++) {
      const st = ZONE_STYLE[zones[i]];
      if (!st) continue;
      const { x, y } = tileAt(this.map, i);
      this.diamond(g, x, y, 0.92);
      g.fill({ color: st.color, alpha: 0.45 });
      // 記号はマスの左の角寄りに小さく描く（建物に隠れにくい）
      const c = toScreen(this.p, x, y);
      const mx = c.sx - 18 * u;
      const my = c.sy;
      const r = 3 * u;
      if (st.mark === "house") g.poly([mx - r, my + r, mx - r, my, mx, my - r, mx + r, my, mx + r, my + r]);
      else if (st.mark === "circle") g.circle(mx, my, r);
      else if (st.mark === "square") g.rect(mx - r, my - r, r * 2, r * 2);
      else if (st.mark === "plus") g.rect(mx - r, my - u, r * 2, 2 * u).rect(mx - u, my - r, 2 * u, r * 2);
      else if (st.mark === "diamond") g.poly([mx, my - r, mx + r, my, mx, my + r, mx - r, my]);
      else g.star(mx, my, 5, r * 1.3, r * 0.6);
      g.fill({ color: 0x3e2723, alpha: 0.85 });
    }
  }

  /** 工事のバーと対象外の印（毎フレーム。工事中だけ） */
  private drawFx(now: number) {
    const g = this.fxGfx;
    g.clear();
    const u = this.p.tw / 64;
    const { noAuto, jobs } = this.overlay;
    if (noAuto)
      noAuto.forEach((on, i) => {
        if (!on) return;
        // ひし形の左の角に、鍵の形の印（OBJ-09）
        const t = tileAt(this.map, i);
        const c = toScreen(this.p, t.x, t.y);
        const x = c.sx - 26 * u;
        const y = c.sy - 2 * u;
        g.roundRect(x - 3 * u, y - u, 6 * u, 5 * u, u).fill(0x5d4037);
        g.circle(x, y - 2 * u, 2 * u).stroke({ color: 0x5d4037, width: u });
      });
    for (const j of jobs ?? []) {
      const ratio = Math.max(0, Math.min(1, (now - j.startedAt) / Math.max(1, j.finishAt - j.startedAt)));
      const jc = objectCenter(j);
      const c = toScreen(this.p, jc.x, jc.y);
      const w = 36 * u;
      const x = Math.round(c.sx - w / 2);
      const y = Math.round(c.sy + 6 * u);
      g.rect(x - u, y - u, w + 2 * u, 5 * u).fill(0x3e2723);
      g.rect(x, y, Math.max(u, Math.round(w * ratio)), 3 * u).fill(0xffca28);
    }
  }

  /** 完成・進化の演出を進める（建物の伸び縮み・光と、粒）。終わったものは消す */
  private drawEffects(now: number) {
    const g = this.fxGfx;
    const u = this.p.tw / 64;
    this.effects = this.effects.filter((e) => {
      const t = now - e.t0;
      const done = t >= EFFECT_MS[e.kind];
      const pl = this.placedById.get(e.id);
      if (pl && !pl.node.destroyed) {
        const sc = e.kind === "build" && !done ? popScale(t) : { x: 1, y: 1 };
        pl.node.scale.set(sc.x, sc.y);
        const a = e.kind === "evolve" && !done ? flashAlpha(t) : 0;
        if (a > 0) {
          if (!pl.flash) {
            pl.flash = new Sprite(pl.sprite.texture);
            pl.flash.anchor.copyFrom(pl.sprite.anchor);
            pl.flash.blendMode = "add";
            pl.node.addChild(pl.flash);
          }
          pl.flash.alpha = a;
        } else if (pl.flash) {
          pl.flash.destroy();
          pl.flash = null;
        }
      }
      if (done) return false;
      const c = toScreen(this.p, e.x, e.y);
      for (const q of particles(e.kind, t, e.height, e.seed)) {
        const x = Math.round(c.sx + q.x * u);
        const y = Math.round(c.sy + q.y * u);
        if (q.shape === 2) g.rect(x - u, y, 3 * u, u).rect(x, y - u, u, 3 * u);
        else g.rect(x, y, 2 * u, 2 * u);
        g.fill(q.color);
      }
      return true;
    });
  }

  setSelected(tile: { x: number; y: number } | null) {
    this.selected = tile;
    this.drawSelection();
  }

  /**
   * 選択の印を作り直す（選んだマスか、そのマスの建物が変わった時）。大きな建物のマスを選んだら、
   * 印を占有範囲の大きさにし、建物の輪郭を光らせる
   */
  private drawSelection() {
    for (const c of this.selectLayer.removeChildren()) if (c !== this.selectGhost) c.destroy();
    const t = this.selected;
    this.select.visible = !!t;
    if (!t || !this.map) return;
    const pl = this.cover.get(`${t.x},${t.y}`);
    const c = pl ? objectCenter(pl) : t;
    const s = toScreen(this.p, c.x, c.y);
    for (const sp of [this.select, this.selectGhost]) {
      sp.position.set(s.sx, s.sy);
      sp.scale.set(pl?.size ?? 1);
    }
    this.selectLayer.addChild(this.selectGhost);
    if (!pl) return;
    const e = this.book.getOutline(pl.key);
    const sp = new Sprite(e.texture);
    sp.anchor.set(e.ax / e.w, e.ay / e.h);
    sp.position.copyFrom(pl.node.position);
    this.selectLayer.addChild(sp);
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

  /** 盤面の範囲（マス） */
  get mapRect(): Rect {
    return { ...this.tiles };
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
    // destroy(true) は PixiJS 全体で共有する資源（バッチのプールなど）まで解放し、
    // 同時に動いている別の描画（作り直した直後の新しい描画）を壊すので、canvas を外すだけにする
    this.app.destroy({ removeView: true }, { children: true });
  }

  // ---- カメラ ----

  private setCamera(c: Camera) {
    this.cam = clampToLand(c, this.land, this.viewport);
    this.camDirty = true;
  }

  private fitAll() {
    // 開いている土地を、背の高い建物が上にはみ出す分も含めて収める
    const b = { ...this.land };
    b.minY -= (TALL * this.p.tw) / 64 / 2;
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
    const tiles = this.map.outside === "locked" ? this.viewTiles(r, tall) : this.tiles;
    // 3x3 の建物は手前の角のマスより左右に1マス分はみ出すので、その分だけ横にも広げて判定する
    const wide = { ...r, minX: r.minX - this.p.tw, maxX: r.maxX + this.p.tw };
    const keep = visibleChunks(this.p, wide, tiles, tall, 1);
    const draw = visibleChunks(this.p, wide, tiles, tall, 0);
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
    for (const k of removed) for (const o of this.chunkObjects.get(k) ?? []) this.objLayer.removeChild(o.node);
    for (const k of added) {
      // 盤面の範囲の外のチャンクは、見えるようになった時に林と岩で埋める
      if (!this.chunkObjects.has(k)) this.buildChunk(k);
      const list = this.chunkObjects.get(k);
      if (list?.length) this.objLayer.addChild(...list.map((o) => o.node));
    }
    this.visibleObjects = [];
    for (const k of drawKeys) for (const o of this.chunkObjects.get(k) ?? []) this.visibleObjects.push(o);
  }

  /** 画面に入るマスを囲む矩形（盤面の範囲を含む。範囲の外も描く時に使う） */
  private viewTiles(r: Rect, tall: number): Rect {
    const corners = [toTileF(this.p, r.minX, r.minY), toTileF(this.p, r.maxX, r.minY), toTileF(this.p, r.minX, r.maxY + tall), toTileF(this.p, r.maxX, r.maxY + tall)];
    return {
      minX: Math.min(this.tiles.minX, Math.floor(Math.min(...corners.map((c) => c.x)))),
      minY: Math.min(this.tiles.minY, Math.floor(Math.min(...corners.map((c) => c.y)))),
      maxX: Math.max(this.tiles.maxX, Math.ceil(Math.max(...corners.map((c) => c.x)))),
      maxY: Math.max(this.tiles.maxY, Math.ceil(Math.max(...corners.map((c) => c.y)))),
    };
  }

  private bake(c: ChunkId) {
    const k = chunkKey(c);
    if (this.baked.has(k)) return;
    const r = chunkRect(this.p, c);
    const tmp = new Container();
    const x0 = c.cx * CHUNK;
    const y0 = c.cy * CHUNK;
    // 範囲の外も描く時は、チャンク全体を焼く（範囲の外は暗い地面）
    const t = this.map.outside === "locked" ? { minX: x0, minY: y0, maxX: x0 + CHUNK - 1, maxY: y0 + CHUNK - 1 } : this.tiles;
    for (let y = Math.max(y0, t.minY); y < Math.min(y0 + CHUNK, t.maxY + 1); y++)
      for (let x = Math.max(x0, t.minX); x < Math.min(x0 + CHUNK, t.maxX + 1); x++) {
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
    sprite.tint = this.nightTint;
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
        this.faceAgent(i);
        const s = toScreen(this.p, a.x, a.y);
        const sp = this.agentSprites[i];
        const on = s.sx > r.minX - pad && s.sx < r.maxX + pad && s.sy > r.minY - pad && s.sy < r.maxY + pad;
        sp.visible = on;
        if (!on) continue;
        // 進む向きの右側を通る（人は歩道寄り、車は車線の中ほど）
        const u = this.p.tw / 64;
        const side = (a.kind === "person" ? 9 : 5) * u;
        // 人は4分の1マス進むごとに1ドット弾ませて、歩いているように見せる
        const bob = a.kind === "person" && Math.floor((a.x + a.y) * 4) % 2 ? Math.max(1, Math.round(u)) : 0;
        sp.position.set(Math.round(s.sx - a.dy * side), Math.round(s.sy + (a.dx * side) / 2) - bob);
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

    // 困りごとアイコンは 450 ミリ秒ごとに1ドット上下させて目を引く（点滅はさせない）
    if (this.troubleSprites.length) {
      const up = !this.opts.reducedMotion && Math.floor(now / 450) % 2 === 0 ? Math.max(1, Math.round(this.p.tw / 64)) : 0;
      for (const t of this.troubleSprites) t.sp.y = t.y - up;
    }
    const blink = Math.floor(now / 250) % 2 === 0;
    this.highlight.visible = now < this.highlightUntil && blink;
    if (this.highlightSprites.length) {
      const on = this.opts.reducedMotion || Math.floor(now / 450) % 2 === 0;
      const want = this.overlay.highlights ?? [];
      this.highlightSprites.forEach((sp, i) => (sp.visible = !!want[i] && on));
    }
    if (this.overlay.jobs?.length || this.overlay.noAuto || this.effects.length || this.fxDrawn) {
      this.drawFx(Date.now() + (this.opts.serverOffset ?? 0));
      this.drawEffects(now);
      this.fxDrawn = !!(this.overlay.jobs?.length || this.overlay.noAuto || this.effects.length);
    }

    if (this.camDirty) {
      this.camDirty = false;
      this.applyCamera();
    }
    if (this.bakeQueue.length) this.bake(this.bakeQueue.shift()!);

    // 動きがない時は描画回数を下げる（NF-02）
    const busy =
      this.pointers.size > 0 || !!this.focus || Math.abs(this.vel.x) > 0.01 || Math.abs(this.vel.y) > 0.01 || now < this.highlightUntil || this.effects.length > 0;
    // 動く絵のコマ送り（6〜12fps）が飛ばないよう、動きがある時は 12fps より下げない
    this.app.ticker.maxFPS = busy ? 0 : this.agents.length && !this.opts.reducedMotion ? 30 : this.animCount > 0 ? 12 : 10;

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
    const sorted = [...this.visibleObjects].sort((a, b) => b.node.zIndex - a.node.zIndex);
    for (const o of sorted) {
      const lx = Math.floor(w.x - (o.node.x - o.entry.ax));
      const ly = Math.floor(w.y - (o.node.y - o.entry.ay));
      if (lx < 0 || ly < 0 || lx >= o.entry.w || ly >= o.entry.h) continue;
      if (o.entry.mask[ly * o.entry.w + lx]) return { x: o.x, y: o.y };
    }
    const t = toTile(this.p, w.x, w.y);
    return tileIndex(this.map, t.x, t.y) < 0 ? null : t;
  }

  private onResize = () => {
    if (this.opts.interactive === false) this.fitAll();
    else this.setCamera(this.cam);
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
