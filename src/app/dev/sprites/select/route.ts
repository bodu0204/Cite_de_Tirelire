import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { devOnly, safeArtPath, selectedFile } from "../files";

// 候補から1枚を選び、art/sprites/<tw>/<キー>.png にコピーする（§4.1 の4。開発環境だけ）
export async function POST(req: Request) {
  if (!devOnly()) return new Response(null, { status: 404 });
  const { tw, key, file } = (await req.json()) as { tw: string; key: string; file: string };
  const from = safeArtPath(path.join("candidates", file));
  const to = selectedFile(tw, key);
  if (!from || !to || !from.endsWith(".png") || !existsSync(from)) return Response.json({ error: "候補が見つかりません" }, { status: 400 });
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
  return Response.json({ ok: true });
}
