// 入力の検証。メッセージはそのままプレイヤーに表示する。
import { fail } from "@/game/errors";

export function int(v: unknown, label: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n)) fail("invalid", `${label}は整数で入力してください`);
  const min = opts.min ?? 0;
  const max = opts.max ?? 1_000_000_000;
  if ((n as number) < min || (n as number) > max) fail("invalid", `${label}は${min.toLocaleString()}〜${max.toLocaleString()}の範囲で入力してください`);
  return n as number;
}

export function str(v: unknown, label: string, opts: { max?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return "";
    fail("invalid", `${label}を入力してください`);
  }
  if (typeof v !== "string") fail("invalid", `${label}が不正です`);
  const s = (v as string).trim();
  if (!s && !opts.optional) fail("invalid", `${label}を入力してください`);
  if (s.length > (opts.max ?? 200)) fail("invalid", `${label}は${opts.max ?? 200}文字以内で入力してください`);
  return s;
}

export function optStr(v: unknown, label: string, max = 500): string | null {
  const s = str(v, label, { max, optional: true });
  return s ? s : null;
}

export function date(v: unknown, label: string): string {
  const s = str(v, label, { max: 10 });
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail("invalid", `${label}はYYYY-MM-DDの形式で入力してください`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail("invalid", `${label}が正しい日付ではありません`);
  return s;
}

export function optDate(v: unknown, label: string): string | null {
  return v === undefined || v === null || v === "" ? null : date(v, label);
}

export function bool(v: unknown): boolean {
  return v === true || v === "true";
}

export function oneOf<T extends string>(v: unknown, values: readonly T[], label: string): T {
  if (typeof v !== "string" || !values.includes(v as T)) fail("invalid", `${label}が不正です`);
  return v as T;
}
