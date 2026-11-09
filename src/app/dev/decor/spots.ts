// 装飾の位置の台帳（art/sprites/64/decor-spots.json）を読み書きする。開発環境の編集ページ（/dev/decor）だけで使う。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DecorSpot, DecorSpots } from "@/components/city/toIso";
import { ART } from "../sprites/files";

export const SPOTS_FILE = path.join(ART, "sprites", "64", "decor-spots.json");

export function readSpots(): DecorSpots & { $comment?: string } {
  return JSON.parse(readFileSync(SPOTS_FILE, "utf8"));
}

/** 位置1つを確かめる（整数のドット、建物から大きく離れすぎない） */
function spotOf(v: unknown): DecorSpot | null {
  const o = v as Partial<DecorSpot> | null;
  if (!o || typeof o !== "object") return null;
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 400;
  if (!ok(o.ox) || !ok(o.oy) || typeof o.front !== "boolean") return null;
  return { ox: o.ox, oy: o.oy, front: o.front };
}

/** 受け取った台帳を確かめて書き込む。キーは並べ替え、説明（$comment）は残す。不正なら理由を返す */
export function writeSpots(body: unknown): string | null {
  const b = body as Partial<DecorSpots> | null;
  if (!b || typeof b !== "object" || typeof b.default !== "object" || typeof b.spots !== "object") return "台帳の形が正しくありません";
  const sorted = <T,>(r: Record<string, T>) => Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
  const def: Record<string, DecorSpot> = {};
  for (const [k, v] of Object.entries(b.default ?? {})) {
    const s = spotOf(v);
    if (!/^[1-9]$/.test(k) || !s) return `既定の位置が正しくありません：${k}`;
    def[k] = s;
  }
  const spots: Record<string, DecorSpot> = {};
  for (const [k, v] of Object.entries(b.spots ?? {})) {
    const s = spotOf(v);
    if (!/^big\/(building|special)\/[a-z_]+(\/[a-z0-9_]+)?$/.test(k) || !s) return `建物の位置が正しくありません：${k}`;
    spots[k] = s;
  }
  const out = { $comment: readSpots().$comment, default: sorted(def), spots: sorted(spots) };
  // 1件1行にして、差分を読みやすくする
  const line = (s: DecorSpot) => `{ "ox": ${s.ox}, "oy": ${s.oy}, "front": ${s.front} }`;
  const block = (r: Record<string, DecorSpot>) =>
    Object.keys(r).length ? `{\n${Object.entries(r).map(([k, s]) => `    ${JSON.stringify(k)}: ${line(s)}`).join(",\n")}\n  }` : "{}";
  writeFileSync(SPOTS_FILE, `{\n  "$comment": ${JSON.stringify(out.$comment ?? "")},\n  "default": ${block(out.default)},\n  "spots": ${block(out.spots)}\n}\n`);
  return null;
}
