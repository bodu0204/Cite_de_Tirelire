"use client";

import { useSeasonView } from "@/components/GameProvider";
import { BondIcon, Coin, CustomIcon } from "@/components/ui";
import { fmt } from "@/lib/api";

export const digits = (s: string) => s.replace(/\D/g, "");

export interface Gains {
  wood: number;
  stone: number;
  food: number;
  treasury: number;
}

/** 差分の解消1回分（サーバーの Resolution / ResolutionView） */
export interface Resolution {
  amount: number;
  bond: number;
  resourced: number;
  exchanged: number;
  gains: (Gains & { total?: number; cutMining?: number; cutCustom?: number; canceled?: number }) | null;
  feeSilver: number;
  feeBond: number;
  before?: number | null;
  after?: number | null;
}

export const GAIN_LABELS: [keyof Gains, string][] = [
  ["wood", "木材"],
  ["stone", "石材"],
  ["food", "食料"],
  ["treasury", "都市資金"],
];

export function GainsText({ g }: { g: Gains | null | undefined }) {
  if (!g) return null;
  const parts = GAIN_LABELS.filter(([k]) => Math.floor(g[k] ?? 0) > 0).map(([k, l]) => `${l}+${fmt(Math.floor(g[k]))}`);
  return parts.length ? <span>{parts.join(" ")}</span> : null;
}

/** 差分の解消の内訳（＋差分：債券 → おまかせ交換、−差分：未配当分 → 債券＋手数料） */
export function ResolutionLine({ r, prefix }: { r: Resolution; prefix?: string }) {
  const d = r.gains;
  const total = d?.total ?? Math.abs(r.amount);
  const surplus = r.amount > 0;
  return (
    <span className="num flex flex-wrap items-center gap-x-2 text-xs text-muted">
      {prefix && <span>{prefix}</span>}
      <span className={surplus ? "text-dev" : "text-danger"}>
        {surplus ? "＋差分" : "−差分"} {fmt(total)}
      </span>
      {(d?.canceled ?? 0) > 0 && <span>予約を取りやめ {fmt(d!.canceled!)}</span>}
      {(d?.cutMining ?? 0) > 0 && <span>残りの採掘 −{fmt(d!.cutMining!)}G</span>}
      {(d?.cutCustom ?? 0) > 0 && <span>ユーザ通貨の未発生分 −{fmt(d!.cutCustom!)}</span>}
      {r.bond !== 0 && (
        <span className="inline-flex items-center gap-0.5">
          <BondIcon size={12} />
          債券 {r.bond > 0 ? "+" : ""}
          {fmt(r.bond)}
        </span>
      )}
      {r.exchanged > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Coin kind="gold" size={12} />
          おまかせ {fmt(r.exchanged)}G
        </span>
      )}
      <GainsText g={d} />
      {r.feeSilver + r.feeBond > 0 && <span>手数料 {fmt(r.feeSilver)}S{r.feeBond > 0 ? `＋債券${fmt(r.feeBond)}` : ""}</span>}
    </span>
  );
}

/** プレビュー用：差分の解消の見込み */
export function ResolutionPreview({ r, title }: { r: Resolution | null; title?: string }) {
  if (!r) return null;
  const surplus = r.amount > 0;
  return (
    <div className={`rounded-lg px-3 py-2 text-xs ${surplus ? "bg-surface-2" : "bg-danger/10"}`}>
      <div className="mb-0.5 font-medium">{title ?? (surplus ? "＋差分の解消（債券 → おまかせ交換）" : "−差分の解消（債券から）")}</div>
      <ResolutionLine r={r} />
      {surplus && r.exchanged > 0 && <p className="mt-1">債券が上限に達するため、入りきらない分をおまかせ交換します（貯金額に数えます）。</p>}
    </div>
  );
}

export function useCustomIcon() {
  const v = useSeasonView();
  return (id: string | null | undefined) => v?.currencies.custom.find((c) => c.id === id) ?? null;
}

export function CurrencyChip({ currency, currencyId }: { currency: string; currencyId?: string | null }) {
  const cur = useCustomIcon()(currencyId);
  if (currency === "GOLD") return <Coin kind="gold" size={12} />;
  if (currency === "BOND") return <BondIcon size={12} />;
  if (currency === "CUSTOM") return <CustomIcon icon={cur?.icon ?? "🪙"} size={12} />;
  return <span>貯蓄</span>;
}
