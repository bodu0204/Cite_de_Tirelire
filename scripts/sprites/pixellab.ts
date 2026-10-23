// PixelLab REST v2 の薄いクライアント（docs/rendering-requirements.md §4）。開発者の手元でだけ使う。
// API キーは環境変数 PIXELLAB_API_TOKEN（.env か、クラウド環境のシークレット）。ブラウザには出さない。

export const API = "https://api.pixellab.ai/v2";

export class PixelLabError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`PixelLab ${status}: ${body.slice(0, 500)}`);
  }
}

function token(): string {
  const t = process.env.PIXELLAB_API_TOKEN;
  if (!t) throw new Error("PIXELLAB_API_TOKEN が設定されていません（.env かクラウド環境のシークレットに置く）");
  return t;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // 混雑時は待ってやり直す（有料の生成を増やさないよう、同じリクエストを再送するだけ）
    if ((res.status === 429 || res.status === 529) && attempt < 5) {
      const retry = Number(res.headers.get("retry-after")) || 2 ** attempt * 5;
      await sleep(retry * 1000);
      continue;
    }
    if (!res.ok) throw new PixelLabError(res.status, text);
    return text ? JSON.parse(text) : null;
  }
}

/** 残高（生成回数・クレジット） */
export function balance(): Promise<unknown> {
  return request("GET", "/balance");
}

/** 返答の中から背景ジョブの ID を探す */
function jobId(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Record<string, unknown>;
  for (const k of ["background_job_id", "job_id"]) if (typeof r[k] === "string") return r[k] as string;
  return null;
}

/**
 * 生成を呼び、非同期なら完了まで待つ。
 * 仕上げ中（status: processing）でも途中の画像が返答に入っているので、画像の有無ではなく status: completed で判断する。
 */
export async function generate(endpoint: string, body: unknown, opts: { timeoutMs?: number; log?: (s: string) => void } = {}): Promise<unknown> {
  const first = await request("POST", `/${endpoint}`, body);
  const id = jobId(first);
  if (!id) return first;
  opts.log?.(`  ジョブ ${id}`);
  return waitJob(id, opts);
}

/** 背景ジョブの完了を待つ。課金済みのジョブを取り直す時にも使う */
export async function waitJob(id: string, opts: { timeoutMs?: number; log?: (s: string) => void } = {}): Promise<unknown> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let wait = 3000;
  for (;;) {
    let job: unknown = null;
    try {
      job = await request("GET", `/background-jobs/${id}`);
    } catch (e) {
      // 作成直後は 404/423 が返ることがある
      if (!(e instanceof PixelLabError && (e.status === 404 || e.status === 423))) throw e;
    }
    const j = (job ?? {}) as Record<string, unknown>;
    if (j.status === "completed") return job;
    if (j.status === "failed") throw new PixelLabError(500, JSON.stringify(stripImages(job)));
    const last = j.last_response as Record<string, unknown> | undefined;
    opts.log?.(`  待機中 ${id} status=${String(j.status)}${last?.action ? ` ${last.action}` : ""}${last?.queue_position != null ? ` 順番=${last.queue_position}` : ""}`);
    if (Date.now() > deadline) throw new Error(`時間切れ：ジョブ ${id} はまだ終わっていません。課金済みなので再送せず、後で npm run sprites -- refetch で取り直してください`);
    await sleep(wait);
    wait = Math.min(10_000, Math.round(wait * 1.5));
  }
}

const B64_PNG = /^(data:image\/png;base64,)?iVBORw0KGgo/;

/** 返答の中の PNG（base64）をすべて取り出す。返答の形が端点ごとに違うので、木を全部たどる */
export function findImages(v: unknown, out: Buffer[] = []): Buffer[] {
  if (typeof v === "string") {
    if (B64_PNG.test(v)) out.push(Buffer.from(v.replace(/^data:image\/png;base64,/, ""), "base64"));
  } else if (Array.isArray(v)) {
    for (const x of v) findImages(x, out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) findImages(x, out);
  }
  return out;
}

/** 記録用に、返答から画像の中身を除く */
export function stripImages(v: unknown): unknown {
  if (typeof v === "string") return B64_PNG.test(v) ? `<png ${v.length} chars>` : v.length > 1000 ? `<${v.length} chars>` : v;
  if (Array.isArray(v)) return v.map(stripImages);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripImages(x)]));
  return v;
}

/** 参照画像を API に渡す形にする */
export function imageParam(png: Buffer): { type: "base64"; base64: string } {
  return { type: "base64", base64: png.toString("base64") };
}
