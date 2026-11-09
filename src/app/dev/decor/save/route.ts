import { devOnly } from "../../sprites/files";
import { writeSpots } from "../spots";

// 装飾の位置の台帳を保存する（/dev/decor。開発環境だけ）
export async function POST(req: Request) {
  if (!devOnly()) return new Response(null, { status: 404 });
  const error = writeSpots(await req.json());
  return error ? Response.json({ error }, { status: 400 }) : Response.json({ ok: true });
}
