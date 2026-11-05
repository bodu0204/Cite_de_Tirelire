"use client";

import { useGame, useSeasonView } from "@/components/GameProvider";
import { fmt } from "@/lib/api";

interface CollectResult {
  collected: number;
  custom: { currencyId: string; amount: number }[];
}

/** 配当（金貨と未受取のユーザ通貨）をまとめて受け取る */
export function useCollect() {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const gold = v ? Math.floor(v.mine.uncollected) : 0;
  const custom = v ? v.currencies.custom.filter((c) => c.pending > 0) : [];
  const can = !busy && (gold >= 1 || custom.length > 0);
  const collect = async () => {
    const r = await act<CollectResult>("/api/mine/collect");
    if (!r) return;
    const parts = r.collected > 0 ? [`金貨 ${fmt(r.collected)}G`] : [];
    for (const c of r.custom) {
      const def = v?.currencies.custom.find((x) => x.id === c.currencyId);
      parts.push(`${def ? `${def.icon}${def.name}` : "ユーザ通貨"} ${fmt(c.amount)}`);
    }
    toast(parts.length ? `${parts.join("・")} を受け取りました` : "受け取れる配当はありません", parts.length ? "reward" : "info");
  };
  return { gold, custom, can, collect };
}
