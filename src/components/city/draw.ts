// 2Dドット絵の街。1マス16×16のドットで描き、CSSで拡大する（image-rendering: pixelated）。
import type { LineId, SpecialKind, Zone } from "@/game/catalog";
import { tileUnlockLevel } from "@/game/city/layout";
import { MAP_SIZE } from "@/game/config";

export const T = 16;
export const CANVAS_PX = T * MAP_SIZE;

export interface DrawBuilding {
  id: string;
  line?: LineId;
  special?: SpecialKind;
  tier: number;
  level: number;
  x: number;
  y: number;
  closed?: boolean;
}

export interface DrawJob {
  x: number;
  y: number;
  kind: string;
  startedAt: number;
  finishAt: number;
}

export interface DrawInput {
  buildings: Iterable<DrawBuilding>;
  jobs?: DrawJob[];
  zones: Zone[];
  noAuto?: boolean[];
  devLevel: number;
  bankLevel: number;
  selected?: { x: number; y: number } | null;
  highlights?: Set<string>;
  showZones?: boolean;
  now: number;
  /** アニメーション用のフレーム番号 */
  frame: number;
}

type Ctx = CanvasRenderingContext2D;

const ZONE_TINT: Record<Zone, string | null> = {
  residential: "#ffd54f",
  commercial: "#4fc3f7",
  industrial: "#a1887f",
  agricultural: "#c5e1a5",
  public: "#ce93d8",
  special: "#ffb74d",
  none: null,
};

export const ZONE_COLORS = ZONE_TINT;

function painter(c: Ctx, ox: number, oy: number) {
  return (x: number, y: number, w: number, h: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(ox + x, oy + y, w, h);
  };
}
type P = ReturnType<typeof painter>;

/** 窓のある建物の箱 */
function block(p: P, x: number, y: number, w: number, h: number, wall: string, win: string, cols = 2, gap = 3) {
  p(x, y, w, h, wall);
  p(x, y + h - 1, w, 1, "rgba(0,0,0,0.25)");
  for (let wy = y + 2; wy < y + h - 2; wy += gap) {
    for (let i = 0; i < cols; i++) {
      const wx = x + 2 + Math.floor((i * (w - 4)) / cols);
      p(wx, wy, 1 + (w > 9 ? 1 : 0), 1, win);
    }
  }
}

function roof(p: P, x: number, y: number, w: number, color: string) {
  for (let i = 0; i * 2 < w; i++) p(x + i, y - i, w - i * 2, 1, color);
}

function smoke(p: P, x: number, y: number, frame: number) {
  const o = frame % 4;
  p(x, y - o, 2, 2, "rgba(236,239,241,0.8)");
  p(x + 1, y - 3 - o, 2, 2, "rgba(236,239,241,0.5)");
}

function tree(p: P, x: number, y: number, leaf = "#2e7d32") {
  p(x + 1, y + 3, 1, 2, "#5d4037");
  p(x, y, 3, 3, leaf);
  p(x + 1, y - 1, 1, 1, leaf);
}

function drawHousing(p: P, tier: number) {
  switch (tier) {
    case 0:
      p(4, 9, 8, 5, "#a1887f");
      roof(p, 3, 8, 10, "#c62828");
      p(7, 11, 2, 3, "#5d4037");
      break;
    case 1:
      p(3, 8, 10, 6, "#d7b98e");
      roof(p, 2, 7, 12, "#8d4b2b");
      p(5, 10, 2, 2, "#fff59d");
      p(9, 10, 2, 4, "#5d4037");
      break;
    case 2:
      p(3, 7, 10, 7, "#c0504d");
      for (let y = 8; y < 14; y += 2) p(3, y, 10, 1, "#a33c3a");
      roof(p, 2, 6, 12, "#4e342e");
      p(11, 2, 2, 4, "#6d4c41");
      p(5, 9, 2, 2, "#fff59d");
      p(9, 9, 2, 2, "#fff59d");
      break;
    case 3:
      block(p, 3, 4, 10, 10, "#b0bec5", "#fff59d", 3);
      p(3, 3, 10, 1, "#78909c");
      break;
    case 4:
      block(p, 3, 2, 10, 12, "#e0e0e0", "#81d4fa", 3, 2);
      p(3, 1, 10, 1, "#9e9e9e");
      break;
    default:
      block(p, 4, 1, 8, 13, "#64b5f6", "#e3f2fd", 2, 2);
      p(7, 0, 1, 1, "#ef5350");
  }
}

function field(p: P, crop: string, soil = "#8d6e63") {
  p(1, 7, 14, 8, soil);
  for (let y = 8; y < 15; y += 2) p(2, y, 12, 1, crop);
}

function drawFarm(p: P, tier: number, frame: number) {
  switch (tier) {
    case 0:
      field(p, "#7cb342");
      tree(p, 2, 2);
      break;
    case 1:
      field(p, "#9ccc65");
      p(9, 3, 6, 4, "#c62828");
      roof(p, 9, 3, 6, "#eeeeee");
      break;
    case 2:
      field(p, "#c0ca33");
      p(9, 2, 6, 5, "#c62828");
      p(2 + (frame % 6), 9, 4, 3, "#fdd835");
      p(2 + (frame % 6), 12, 1, 1, "#212121");
      p(5 + (frame % 6), 12, 1, 1, "#212121");
      break;
    case 3:
      field(p, "#fbc02d", "#a1887f");
      p(12, 1, 3, 9, "#9e9e9e");
      p(12, 0, 3, 1, "#757575");
      p(8, 3, 4, 5, "#c62828");
      break;
    default:
      field(p, "#66bb6a", "#546e7a");
      p(4, 1, 8, 6, "#b3e5fc");
      p(4, 1, 8, 1, "#e1f5fe");
      p(7, 2, 2, 4, "#81d4fa");
  }
}

function drawIndustry(p: P, line: LineId, tier: number, frame: number) {
  if (line === "lumber") {
    tree(p, 2, 2);
    tree(p, 6, 1);
    p(2, 10, 8, 4, "#6d4c41");
    for (let x = 2; x < 10; x += 3) p(x, 11, 2, 2, "#d7ccc8");
    p(10, 6, 5, 8, "#8d6e63");
    roof(p, 10, 6, 5, "#5d4037");
    return;
  }
  if (line === "quarry") {
    p(1, 8, 14, 6, "#9e9e9e");
    p(2, 5, 5, 4, "#bdbdbd");
    p(8, 6, 5, 3, "#757575");
    p(4, 11, 3, 2, "#e0e0e0");
    p(10, 10, 4, 3, "#616161");
    return;
  }
  // factory
  switch (tier) {
    case 0:
      p(3, 7, 10, 7, "#a1887f");
      for (let x = 3; x < 13; x += 3) roof(p, x, 7, 3, "#795548");
      p(6, 10, 3, 4, "#4e342e");
      break;
    case 1:
      block(p, 2, 7, 12, 7, "#8d8d8d", "#ffe082", 3);
      p(11, 2, 2, 5, "#616161");
      smoke(p, 11, 1, frame);
      break;
    case 2:
      block(p, 1, 6, 8, 8, "#7d7d7d", "#ffe082", 2);
      block(p, 9, 8, 6, 6, "#9e9e9e", "#ffe082", 2);
      p(3, 1, 2, 5, "#616161");
      p(12, 3, 2, 5, "#616161");
      smoke(p, 3, 0, frame);
      smoke(p, 12, 2, frame + 2);
      break;
    default:
      block(p, 2, 4, 12, 10, "#cfd8dc", "#4fc3f7", 3);
      p(6, 7, 4, 4, "#fdd835");
      p(7, 8, 2, 2, "#cfd8dc");
  }
}

function drawCommerce(p: P, line: LineId, tier: number) {
  if (line === "office") {
    if (tier === 0) block(p, 4, 1, 8, 13, "#78909c", "#e1f5fe", 2, 2);
    else {
      block(p, 5, 1, 6, 13, "#29b6f6", "#e1f5fe", 2, 2);
      p(7, 0, 2, 1, "#eceff1");
      p(4, 13, 8, 1, "#455a64");
    }
    return;
  }
  switch (tier) {
    case 0:
      p(3, 9, 10, 5, "#a1887f");
      for (let x = 2; x < 14; x += 2) p(x, 6, 2, 3, x % 4 === 2 ? "#e53935" : "#fafafa");
      p(5, 10, 2, 1, "#ffca28");
      break;
    case 1:
      p(3, 6, 10, 8, "#ffe0b2");
      for (let x = 2; x < 14; x += 2) p(x, 5, 2, 2, x % 4 === 2 ? "#1e88e5" : "#fafafa");
      p(4, 9, 4, 3, "#b3e5fc");
      p(10, 9, 2, 5, "#6d4c41");
      break;
    case 2:
      for (let i = 0; i < 3; i++) {
        const c = ["#e53935", "#43a047", "#fdd835"][i];
        p(1 + i * 5, 8, 4, 6, "#d7ccc8");
        roof(p, 1 + i * 5, 8, 4, c);
      }
      break;
    case 3:
      block(p, 2, 4, 12, 10, "#f8bbd0", "#fff9c4", 3);
      p(4, 5, 8, 2, "#ec407a");
      break;
    default:
      block(p, 2, 1, 12, 13, "#ffccbc", "#fff9c4", 3, 2);
      p(2, 1, 12, 2, "#d84315");
  }
}

function drawRoad(p: P, tier: number, frame: number) {
  const base = ["#bcaaa4", "#757575", "#616161", "#455a64"][tier] ?? "#455a64";
  p(0, 3, 16, 10, base);
  p(0, 3, 16, 1, "rgba(0,0,0,0.2)");
  p(0, 12, 16, 1, "rgba(0,0,0,0.2)");
  if (tier === 0) {
    p(3, 6, 2, 1, "#a1887f");
    p(10, 9, 3, 1, "#a1887f");
  } else if (tier === 1) {
    for (let x = 1; x < 16; x += 4) p(x, 7, 2, 1, "#fafafa");
  } else if (tier === 2) {
    p(0, 7, 16, 1, "#fdd835");
    p(0, 5, 16, 1, "rgba(255,255,255,0.4)");
    p(0, 10, 16, 1, "rgba(255,255,255,0.4)");
  } else {
    p(0, 7, 16, 1, "#4dd0e1");
    p((frame * 3) % 16, 5, 2, 1, "#e0f7fa");
    p((frame * 3 + 8) % 16, 10, 2, 1, "#e0f7fa");
  }
}

function drawInfra(p: P, line: LineId, tier: number, frame: number) {
  if (line === "road") return drawRoad(p, tier, frame);
  if (line === "power") {
    if (tier === 0) {
      p(2, 8, 7, 6, "#9e9e9e");
      p(10, 5, 5, 9, "#eceff1");
      p(9, 4, 7, 1, "#cfd8dc");
      smoke(p, 11, 3, frame);
    } else if (tier === 1) {
      for (const x of [3, 10]) {
        p(x, 5, 1, 9, "#fafafa");
        const a = (frame + x) % 2;
        p(x - 2 + a, 4, 5 - a * 2, 1, "#eceff1");
        p(x, 2 + a, 1, 5 - a * 2, "#eceff1");
      }
    } else {
      p(3, 6, 10, 8, "#00838f");
      p(4, 4, 8, 2, "#80deea");
      p(6, 3, 4, 1, "#e0f7fa");
      p(7, 8 + (frame % 2), 2, 2, "#e0f7fa");
    }
    return;
  }
  if (line === "rail") {
    p(0, 11, 16, 3, "#8d6e63");
    for (let x = 0; x < 16; x += 3) p(x, 11, 1, 3, "#5d4037");
    p(0, 11, 16, 1, "#bdbdbd");
    p(0, 13, 16, 1, "#bdbdbd");
    p(3, 4, 10, 6, "#ffcc80");
    roof(p, 2, 4, 12, "#6d4c41");
    return;
  }
  // logistics
  p(2, 4, 12, 9, "#90a4ae");
  for (let x = 3; x < 14; x += 4) p(x, 8, 3, 5, "#607d8b");
  p(1 + (frame % 4), 13, 5, 2, "#ef6c00");
}

function drawPublic(p: P, line: LineId, tier: number) {
  if (line === "school") {
    p(2, 6, 12, 8, tier === 2 ? "#eceff1" : "#ffe082");
    for (let x = 4; x < 13; x += 3) p(x, 8, 2, 2, "#81d4fa");
    if (tier === 0) {
      p(8, 1, 1, 5, "#5d4037");
      p(9, 1, 3, 2, "#e53935");
    } else if (tier === 1) {
      p(6, 3, 4, 3, "#1565c0");
      p(7, 2, 2, 1, "#1565c0");
    } else {
      p(11, 2, 3, 2, "#b0bec5");
      p(12, 4, 1, 2, "#78909c");
    }
    return;
  }
  if (line === "clinic") {
    p(3, 4, 10, 10, "#fafafa");
    p(7, 6, 2, 6, "#e53935");
    p(5, 8, 6, 2, "#e53935");
    return;
  }
  if (line === "culture") {
    p(2, 12, 12, 2, "#bdbdbd");
    for (let x = 3; x < 14; x += 3) p(x, 6, 1, 6, "#eeeeee");
    roof(p, 2, 5, 12, tier === 0 ? "#8d6e63" : "#7e57c2");
    return;
  }
  // future
  p(5, 2, 6, 12, "#311b92");
  p(6, 0, 4, 2, "#e040fb");
  for (let y = 3; y < 14; y += 2) p(6, y, 4, 1, "#18ffff");
}

function drawSpecial(p: P, b: DrawBuilding, bankLevel: number, frame: number) {
  switch (b.special) {
    case "bank": {
      const lv = Math.min(6, Math.max(1, bankLevel));
      const top = 10 - lv;
      p(2, top, 12, 14 - top, lv >= 6 ? "#fff8e1" : "#eceff1");
      for (let x = 3; x < 14; x += 3) p(x, top + 2, 1, 12 - top - 2, "#bdbdbd");
      roof(p, 1, top, 14, lv >= 6 ? "#ffb300" : "#78909c");
      p(7, top + 3, 2, 2, "#ffd600");
      if (lv >= 6 && frame % 2) p(13, top - 4, 1, 1, "#fffde7");
      break;
    }
    case "gold_mine":
    case "silver_mine": {
      const ore = b.special === "gold_mine" ? "#ffd600" : "#e0e0e0";
      for (let i = 0; i < 7; i++) p(1 + i, Math.round(13 - i * 1.5), 14 - i * 2, 2, i % 2 ? "#795548" : "#8d6e63");
      p(6, 9, 4, 5, "#3e2723");
      p(3, 8, 1, 1, ore);
      p(11, 10, 1, 1, ore);
      p(8, 5, 1, 1, ore);
      if (frame % 3 === 0) p(5, 4, 1, 1, "#ffffff");
      p(10, 12, 3, 2, "#616161");
      p(10, 11, 3, 1, ore);
      break;
    }
    case "park": {
      const dull = b.closed;
      p(0, 0, 16, 16, dull ? "#9e9d89" : "#66bb6a");
      const trees = [
        [2, 2],
        [11, 3],
        [3, 10],
        [11, 10],
      ].slice(0, b.tier + 1);
      for (const [x, y] of trees) tree(p, x, y, dull ? "#6d6d5a" : "#2e7d32");
      if (b.tier >= 1) p(6, 6, 4, 3, dull ? "#8e9aa0" : "#4fc3f7");
      if (b.tier >= 3) p(7, 5 - (frame % 2), 2, 1, "#e1f5fe");
      if (dull) {
        p(0, 0, 16, 1, "#5d4037");
        p(0, 15, 16, 1, "#5d4037");
        for (let x = 0; x < 16; x += 3) p(x, 0, 1, 16, "rgba(93,64,55,0.6)");
      }
      break;
    }
    case "statue": {
      const metal = ["#b87333", "#c0c0c0", "#ffd700"][b.tier] ?? "#b87333";
      p(4, 12, 8, 3, "#9e9e9e");
      p(5, 11, 6, 1, "#bdbdbd");
      const stage = b.level;
      const h = stage >= 5 ? 9 : Math.max(0, stage * 2);
      if (h > 0) {
        p(6, 11 - h, 4, h, metal);
        p(7, 10 - h, 2, 2, metal);
      }
      if (stage < 5) {
        p(3, 2, 1, 10, "#a1887f");
        p(12, 2, 1, 10, "#a1887f");
        p(3, 2, 10, 1, "#a1887f");
      } else if (frame % 2) {
        p(4, 1, 1, 1, "#ffffff");
        p(11, 4, 1, 1, "#ffffff");
      }
      break;
    }
  }
}

export function drawBuilding(c: Ctx, b: DrawBuilding, ox: number, oy: number, bankLevel: number, frame: number) {
  const p = painter(c, ox, oy);
  if (b.special) return drawSpecial(p, b, bankLevel, frame);
  switch (b.line) {
    case "housing":
      drawHousing(p, b.tier);
      break;
    case "farm":
      drawFarm(p, b.tier, frame);
      break;
    case "lumber":
    case "quarry":
    case "factory":
      drawIndustry(p, b.line, b.tier, frame);
      break;
    case "commerce":
    case "office":
      drawCommerce(p, b.line, b.tier);
      break;
    case "road":
    case "power":
    case "rail":
    case "logistics":
      drawInfra(p, b.line, b.tier, frame);
      break;
    default:
      if (b.line) drawPublic(p, b.line, b.tier);
  }
  // 建物Lv（2以上）を小さな点で示す
  for (let i = 1; i < b.level; i++) p(1 + (i - 1) * 2, 15, 1, 1, "#fff59d");
}

function ground(c: Ctx, x: number, y: number, input: DrawInput) {
  const p = painter(c, x * T, y * T);
  const i = y * MAP_SIZE + x;
  if (tileUnlockLevel(x, y) > input.devLevel) {
    p(0, 0, T, T, "#3b4a3a");
    for (let k = 0; k < T; k += 4) p(k, (k + x * 3) % T, 2, 1, "#2f3b2e");
    return;
  }
  p(0, 0, T, T, (x + y) % 2 ? "#8bc34a" : "#86bd46");
  p(3, 5, 1, 1, "#9ccc65");
  p(11, 12, 1, 1, "#7cb342");
  if (input.showZones) {
    const tint = ZONE_TINT[input.zones[i]];
    if (tint) {
      c.globalAlpha = 0.45;
      p(0, 0, T, T, tint);
      c.globalAlpha = 1;
    }
  }
  if (input.noAuto?.[i]) {
    p(1, 1, 3, 1, "#d32f2f");
    p(1, 1, 1, 3, "#d32f2f");
  }
}

export function drawCity(c: Ctx, input: DrawInput) {
  c.imageSmoothingEnabled = false;
  for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) ground(c, x, y, input);

  for (const b of input.buildings) {
    if (b.x < 0) continue;
    drawBuilding(c, b, b.x * T, b.y * T, input.bankLevel, input.frame);
  }

  for (const j of input.jobs ?? []) {
    const p = painter(c, j.x * T, j.y * T);
    if (j.kind === "build") {
      p(2, 6, 1, 9, "#8d6e63");
      p(13, 6, 1, 9, "#8d6e63");
      p(2, 6, 12, 1, "#8d6e63");
      p(2, 10, 12, 1, "#8d6e63");
    } else {
      p(1, 1, 1, 13, "rgba(141,110,99,0.9)");
      p(14, 1, 1, 13, "rgba(141,110,99,0.9)");
    }
    const ratio = Math.max(0, Math.min(1, (input.now - j.startedAt) / Math.max(1, j.finishAt - j.startedAt)));
    p(2, 13, 12, 2, "#3e2723");
    p(2, 13, Math.max(1, Math.round(12 * ratio)), 2, "#ffca28");
  }

  if (input.highlights?.size) {
    const on = input.frame % 2 === 0;
    for (const key of input.highlights) {
      const [x, y] = key.split(",").map(Number);
      c.strokeStyle = on ? "#fff176" : "#ffb300";
      c.lineWidth = 1;
      c.strokeRect(x * T + 0.5, y * T + 0.5, T - 1, T - 1);
    }
  }

  if (input.selected) {
    const { x, y } = input.selected;
    c.strokeStyle = "#ffffff";
    c.lineWidth = 1;
    c.strokeRect(x * T + 0.5, y * T + 0.5, T - 1, T - 1);
    c.strokeStyle = "#1a237e";
    c.strokeRect(x * T - 0.5, y * T - 0.5, T + 1, T + 1);
  }
}
