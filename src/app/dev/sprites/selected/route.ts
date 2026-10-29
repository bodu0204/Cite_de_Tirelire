import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { devOnly, SELECTED } from "../files";

// 選んだ絵のキーの一覧（試作ページが街の見本に使う。開発環境だけ）
export async function GET(req: Request) {
  if (!devOnly()) return new Response(null, { status: 404 });
  const tw = new URL(req.url).searchParams.get("tw") ?? "64";
  const root = path.join(SELECTED, tw.replace(/\D/g, ""));
  const keys: string[] = [];
  const walk = (rel: string) => {
    for (const f of readdirSync(path.join(root, rel))) {
      const r = rel ? `${rel}/${f}` : f;
      if (statSync(path.join(root, r)).isDirectory()) walk(r);
      else if (f.endsWith(".png")) keys.push(r.slice(0, -4));
    }
  };
  if (existsSync(root)) walk("");
  const anchorsFile = path.join(root, "anchors.json");
  const anchors = existsSync(anchorsFile) ? JSON.parse(readFileSync(anchorsFile, "utf8")) : {};
  return Response.json({ keys: keys.sort(), anchors });
}
