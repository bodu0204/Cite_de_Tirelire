// API クライアント。変更系の操作には毎回 Idempotency-Key を付け、再送で二重実行しない。

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = opts.key ?? crypto.randomUUID();
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "offline", "通信できません。オンラインになってからもう一度お試しください");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? "エラーが発生しました");
  }
  return data as T;
}

export const yen = (n: number) => `${Math.round(n).toLocaleString("ja-JP")}円`;
export const fmt = (n: number, digits = 0) =>
  n.toLocaleString("ja-JP", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function todayIn(tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts;
}

export function formatDateTime(t: number, tz: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
}

export function formatDate(t: number, tz: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).format(new Date(t));
}
