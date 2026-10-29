// 確認ページ（§5.2）が読む art/ の中身。開発環境だけで使う。
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const ART = path.join(process.cwd(), "art");
export const CANDIDATES = path.join(ART, "candidates");
export const SELECTED = path.join(ART, "sprites");

export function devOnly() {
  return process.env.NODE_ENV !== "production";
}

/** art/ の外を指していないか確かめて、絶対パスを返す */
export function safeArtPath(rel: string): string | null {
  const p = path.resolve(ART, rel);
  return p.startsWith(ART + path.sep) ? p : null;
}

const dirs = (p: string) => (existsSync(p) ? readdirSync(p).filter((d) => statSync(path.join(p, d)).isDirectory()) : []);

export interface CandidateRun {
  tw: string;
  key: string;
  run: string;
  images: string[];
  error?: boolean;
}

/** art/candidates/<tw>/<キー…>/<実行時刻>/NN.png を集める。キーは "/" を含むので、png のあるフォルダを実行とみなす */
export function listCandidates(): CandidateRun[] {
  const out: CandidateRun[] = [];
  const walk = (tw: string, rel: string[]) => {
    const abs = path.join(CANDIDATES, tw, ...rel);
    const files = readdirSync(abs);
    const pngs = files.filter((f) => f.endsWith(".png")).sort();
    if (pngs.length || files.includes("error.txt")) {
      out.push({ tw, key: rel.slice(0, -1).join("/"), run: rel[rel.length - 1], images: pngs, error: files.includes("error.txt") });
      return;
    }
    for (const d of dirs(abs)) walk(tw, [...rel, d]);
  };
  for (const tw of dirs(CANDIDATES)) walk(tw, []);
  return out.sort((a, b) => a.key.localeCompare(b.key) || b.run.localeCompare(a.run));
}

/** art/sprites/<tw>/<キー>.png（選んだ絵） */
export function selectedFile(tw: string, key: string): string | null {
  return safeArtPath(path.join("sprites", tw, `${key}.png`));
}
