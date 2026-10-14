"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Coin, Field, Tabs } from "@/components/ui";
import { FEE_EXCHANGE } from "@/game/config";
import { quoteResourceExchange, type Currency } from "@/game/exchange";
import type { StockKey } from "@/game/types";
import { fmt } from "@/lib/api";

const RES: { key: StockKey; label: string }[] = [
  { key: "wood", label: "木材" },
  { key: "stone", label: "石材" },
  { key: "food", label: "食料" },
];

export default function ExchangePage() {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const [mode, setMode] = useState<"g2s" | "res">("res");
  const [currency, setCurrency] = useState<Currency>("gold");
  const [resource, setResource] = useState<StockKey>("wood");
  const [amount, setAmount] = useState("");
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;

  const n = Number(amount || 0);
  const cur = v.currencies;
  const lv = v.exchange.levels;
  const q = quoteResourceExchange(currency, resource, n, lv);
  const resLabel = RES.find((r) => r.key === resource)!.label;

  const g2sOk = n > 0 && n <= cur.gold;
  const resOk = n > 0 && q.gain > 0 && cur.gold >= q.goldCost && cur.silver >= q.silverCost;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">資源交換</h1>
        <p className="mt-1 text-sm text-muted">
          金貨は資源への交換効率が高く、銀貨は手動操作の手数料に使えます。金貨→銀貨は 1:1 で無料、逆はできません。
        </p>
      </div>
      <Tabs
        value={mode}
        onChange={setMode}
        items={[
          { value: "res", label: "資源に交換" },
          { value: "g2s", label: "金貨→銀貨" },
        ]}
      />
      <Card>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r =
              mode === "g2s"
                ? await act("/api/exchange", { kind: "gold_to_silver", amount: n })
                : await act<{ gain: number }>("/api/exchange", { kind: "to_resource", currency, resource, amount: n });
            if (r) {
              toast(mode === "g2s" ? `銀貨 ${fmt(n)}S を手に入れました` : `${resLabel} ${fmt((r as { gain: number }).gain)} を手に入れました`, "reward");
              setAmount("");
            }
          }}
        >
          {mode === "res" && (
            <>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">支払う通貨</legend>
                <Tabs
                  value={currency}
                  onChange={setCurrency}
                  items={[
                    { value: "gold", label: "金貨" },
                    { value: "silver", label: "銀貨" },
                  ]}
                />
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">受け取る資源</legend>
                <Tabs value={resource} onChange={setResource} items={RES.map((r) => ({ value: r.key, label: r.label }))} />
              </fieldset>
            </>
          )}
          <Field label={mode === "g2s" ? "金貨（G）" : currency === "gold" ? "金貨（G）" : "銀貨（S）"}>
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="100" />
          </Field>

          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            {mode === "g2s" ? (
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted">金貨</dt>
                <dd className="num text-right">
                  {fmt(cur.gold)} → {fmt(cur.gold - n)}G
                </dd>
                <dt className="text-muted">銀貨</dt>
                <dd className="num text-right">
                  {fmt(cur.silver)} → {fmt(cur.silver + n)}S
                </dd>
              </dl>
            ) : (
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted">交換効率</dt>
                <dd className="num text-right">
                  1{currency === "gold" ? "G" : "S"} → {resLabel} {fmt(q.rate, 2)}
                </dd>
                <dt className="text-muted">獲得量</dt>
                <dd className="num text-right font-semibold">
                  {resLabel} +{fmt(q.gain)}
                </dd>
                <dt className="text-muted">金貨</dt>
                <dd className="num text-right">
                  {fmt(cur.gold)} → {fmt(cur.gold - q.goldCost)}G
                </dd>
                <dt className="text-muted">銀貨（手数料 {FEE_EXCHANGE}S 込み）</dt>
                <dd className="num text-right">
                  {fmt(cur.silver)} → {fmt(cur.silver - q.silverCost)}S
                </dd>
              </dl>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={busy || !(mode === "g2s" ? g2sOk : resOk)}>
            {mode === "g2s" ? (
              <>
                <Coin kind="gold" /> 金貨を銀貨に交換
              </>
            ) : (
              "交換を確定"
            )}
          </Button>
        </form>
      </Card>
      <Card title="現在の交換効率">
        <table className="num w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="font-normal">1枚あたり</th>
              {RES.map((r) => (
                <th key={r.key} className="text-right font-normal">
                  {r.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(["gold", "silver"] as const).map((c) => (
              <tr key={c}>
                <td className="py-1">{c === "gold" ? "金貨" : "銀貨"}</td>
                {RES.map((r) => (
                  <td key={r.key} className="text-right">
                    {fmt(v.exchange.rates[c][r.key], 2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">
          銀行 Lv{lv.bank}・金鉱 Lv{lv.goldMine}・銀鉱 Lv{lv.silverMine} のボーナス込み。手元の資材：木材 {fmt(Math.floor(v.city.stock.wood))}・石材 {fmt(Math.floor(v.city.stock.stone))}・食料 {fmt(Math.floor(v.city.stock.food))}
        </p>
      </Card>
    </div>
  );
}
