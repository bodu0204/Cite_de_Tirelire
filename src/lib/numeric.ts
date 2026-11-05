/**
 * 数値入力の正規化。全角キーボード（日本語入力）で打った数字も受け付けるため、
 * 全角数字・全角マイナス・長音記号などを半角へ寄せてから数字以外を落とす。
 */
const toHalfWidth = (s: string) =>
  s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    // 全角ハイフンマイナス・マイナス記号・長音記号・ダッシュ類はマイナスとみなす
    .replace(/[－−ー‐‑‒–—―﹣]/g, "-");

/** 0 以上の整数として、数字だけを残す */
export const digits = (s: string) => toHalfWidth(s).replace(/\D/g, "");

/** 先頭のマイナスだけを許す整数として残す */
export const signedDigits = (s: string) => {
  const t = toHalfWidth(s).replace(/[^\d-]/g, "");
  return (t.startsWith("-") ? "-" : "") + t.replace(/-/g, "");
};
