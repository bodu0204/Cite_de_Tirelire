import { existsSync, readFileSync } from "node:fs";
import { devOnly, safeArtPath } from "../../files";

// art/ の画像を返す（確認ページ用、開発環境だけ）
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!devOnly()) return new Response(null, { status: 404 });
  const { path } = await params;
  const file = safeArtPath(path.map(decodeURIComponent).join("/"));
  if (!file || !file.endsWith(".png") || !existsSync(file)) return new Response(null, { status: 404 });
  return new Response(readFileSync(file), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
}
