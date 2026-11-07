"use client";

// 銀貨の使い道：建物の命名と装飾（docs/savings-driven-growth.md REC-06）。どちらも見た目だけで、街の数値は変えない。
import { useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button } from "@/components/ui";
import { DECOR_KINDS, DECOR_LABELS, type DecorKind } from "@/game/catalog";
import { buildingSize } from "@/game/city/layout";
import { DECOR_SILVER, NAME_MAX, NAME_SILVER } from "@/game/config";
import type { Building } from "@/game/types";
import { fmt } from "@/lib/api";
import type { ActiveView } from "@/server/view";

export function Customize({ v, b }: { v: ActiveView; b: Building }) {
  const { act, toast, busy } = useGame();
  const [name, setName] = useState(b.name ?? "");
  // 別の建物を選んだら入力を戻す
  useEffect(() => setName(b.name ?? ""), [b.id, b.name]);
  const silver = v.currencies.silver;
  const trimmed = name.trim().replace(/\s+/g, " ");
  const tooLong = [...trimmed].length > NAME_MAX;

  const rename = async (next: string) => {
    const r = await act<{ silver: number }>("/api/city/name", { buildingId: b.id, name: next });
    if (r) toast(next ? `「${next}」と名づけました${r.silver ? `（銀貨 ${r.silver}S）` : ""}` : "名前を外しました", next ? "reward" : "info");
  };
  const decorate = async (decor: DecorKind | null) => {
    const r = await act<{ silver: number }>("/api/city/decor", { buildingId: b.id, decor });
    if (r) toast(decor ? `${DECOR_LABELS[decor]}を飾りました（銀貨 ${r.silver}S）` : "装飾を外しました", decor ? "reward" : "info");
  };

  return (
    <details className="rounded-lg border border-line bg-surface-2 p-2 text-xs">
      <summary className="cursor-pointer font-semibold">銀貨で飾る・名前をつける（所持 {fmt(silver)}S）</summary>
      <div className="mt-2 space-y-3">
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!tooLong && trimmed !== (b.name ?? "")) rename(trimmed);
          }}
        >
          <label className="block text-muted" htmlFor={`name-${b.id}`}>
            名前（{NAME_MAX}文字まで。つけると銀貨 {NAME_SILVER}S、外すのは無料）
          </label>
          <div className="flex gap-2">
            <input id={`name-${b.id}`} value={name} maxLength={NAME_MAX * 2} onChange={(e) => setName(e.target.value)} placeholder="例：ひだまり荘" className="min-w-0 flex-1" />
            <Button type="submit" variant="secondary" disabled={busy || tooLong || trimmed === (b.name ?? "") || (!!trimmed && silver < NAME_SILVER)}>
              {trimmed || !b.name ? `名づける（${NAME_SILVER}S）` : "外す"}
            </Button>
          </div>
          {tooLong && <p className="text-danger">名前は{NAME_MAX}文字までです</p>}
        </form>
        {buildingSize(b) < 2 ? (
          <p className="text-muted">装飾は 2×2 以上の建物の横（敷地の角）に置きます。この建物には置けません。</p>
        ) : (
          <div>
            <p className="text-muted">装飾（銀貨 {DECOR_SILVER}S。建物の横、敷地の角に置きます。見た目だけで、街の数値は変わりません）</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {DECOR_KINDS.map((d) => (
                <Button
                  key={d}
                  variant={b.decor === d ? "primary" : "secondary"}
                  aria-pressed={b.decor === d}
                  disabled={busy || b.decor === d || silver < DECOR_SILVER}
                  onClick={() => decorate(d)}
                >
                  {DECOR_LABELS[d]}
                </Button>
              ))}
              {b.decor && (
                <Button variant="secondary" disabled={busy} onClick={() => decorate(null)}>
                  外す
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
