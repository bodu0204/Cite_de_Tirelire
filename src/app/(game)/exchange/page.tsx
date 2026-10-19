"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, Field, Tabs } from "@/components/ui";
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
  const [mode, setMode] = useState<"g2s" | "g2b" | "res">("res");
  const [currency, setCurrency] = useState<Currency>("gold");
  const [resource, setResource] = useState<StockKey>("wood");
  const [amount, setAmount] = useState("");
  /** 債券に替える元："gold" / ユーザ通貨の id */
  const [bondFrom, setBondFrom] = useState("gold");
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;

  const n = Number(amount || 0);
  const cur = v.currencies;
  const lv = v.exchange.levels;
  const q = quoteResourceExchange(currency, resource, n, lv);
  const resLabel = RES.find((r) => r.key === resource)!.label;

  const customFrom = cur.custom.find((c) => c.id === bondFrom);
  const source =
    mode === "g2b"
      ? customFrom
        ? { label: `${customFrom.icon}${customFrom.name}`, unit: "", balance: customFrom.balance }
        : { label: "金貨", unit: "G", balance: cur.gold }
      : { label: "金貨", unit: "G", balance: cur.gold };
  const g2sOk = n > 0 && n <= source.balance;
  const toLabel = mode === "g2b" ? "債券" : "銀貨";
  const resOk = n > 0 && q.gain > 0 && cur.gold >= q.goldCost && cur.silver >= q.silverCost;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">資源交換</h1>
        <p className="mt-1 text-sm text-muted">
          金貨は資源への交換効率が高く、銀貨は手動操作の手数料に使えます。金貨→銀貨は 1:1 で無料、逆はできません。金貨・ユーザ通貨は債券に 1:1 で無料で替えられます（債券からは戻せません。銀貨は記録の報酬なので替えられません）。
          金貨で資源を得た額（1G＝1円）は、現実で使わずに済んだお金として貯金目標に「見込み」で表示されます。
          債券は急な出費に備えるお金で、貯金目標の表示にそのまま含まれます（見込みには加えません）。
        </p>
      </div>
      <Tabs
        value={mode}
        onChange={setMode}
        items={[
          { value: "res", label: "資源に交換" },
          { value: "g2s", label: "金貨→銀貨" },
          { value: "g2b", label: "債券に交換" },
        ]}
      />
      <Card>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r =
              mode === "res"
                ? await act<{ gain: number }>("/api/exchange", { kind: "to_resource", currency, resource, amount: n })
                : mode === "g2s"
                  ? await act("/api/exchange", { kind: "gold_to_silver", amount: n })
                  : await act("/api/exchange", { kind: "to_bond", currency: customFrom ? "custom" : bondFrom, currencyId: customFrom?.id, amount: n });
            if (r) {
              const rr = r as { gain: number; estimatedAdded?: number };
              toast(
                mode === "g2s"
                  ? `銀貨 ${fmt(n)}S を手に入れました`
                  : mode === "g2b"
                    ? `${source.label} ${fmt(n)} を債券に替えました`
                    : `${resLabel} ${fmt(rr.gain)} を手に入れました${rr.estimatedAdded ? `（見込み貯金 +${fmt(rr.estimatedAdded)}円）` : ""}`,
                "reward",
              );
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
          {mode === "g2b" && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium">債券に替える通貨</legend>
              <div role="group" aria-label="債券に替える通貨" className="flex flex-wrap gap-1">
                {[
                  { id: "gold", label: "金貨", icon: <Coin kind="gold" />, balance: `${fmt(cur.gold)}G` },
                  ...cur.custom.map((c) => ({ id: c.id, label: c.name, icon: <span aria-hidden>{c.icon}</span>, balance: fmt(c.balance) })),
                ].map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={bondFrom === o.id}
                    onClick={() => setBondFrom(o.id)}
                    className={`flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 text-sm ${bondFrom === o.id ? "border-accent bg-surface font-semibold" : "border-line bg-surface-2 text-muted"}`}
                  >
                    {o.icon}
                    {o.label}
                    <span className="num text-xs text-muted">{o.balance}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <Field label={mode === "res" ? (currency === "gold" ? "金貨（G）" : "銀貨（S）") : `${source.label}${source.unit ? `（${source.unit}）` : ""}`}>
            <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))} placeholder="100" />
          </Field>

          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            {mode !== "res" ? (
              <dl className="grid grid-cols-2 gap-y-1">
                <dt className="text-muted">{source.label}</dt>
                <dd className="num text-right">
                  {fmt(source.balance)} → {fmt(source.balance - n)}
                  {source.unit}
                </dd>
                <dt className="text-muted">{toLabel}</dt>
                <dd className="num text-right">
                  {mode === "g2s" ? `${fmt(cur.silver)} → ${fmt(cur.silver + n)}S` : `${fmt(cur.bond)} → ${fmt(cur.bond + n)}`}
                </dd>
                {mode === "g2b" && (
                  <dd className="col-span-2 text-xs text-muted">
                    債券は元の通貨に戻せません。急な出費（金貨が足りない購入）の支払いに使われ、持っているほど街の発展が速くなります。
                    {customFrom && " ユーザ通貨は期限の近い分から替えます。"}
                  </dd>
                )}
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
                {q.goldCost > 0 && (
                  <>
                    <dt className="text-muted">見込み貯金</dt>
                    <dd className="num text-right">+{fmt(q.goldCost)}円</dd>
                  </>
                )}
              </dl>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={busy || !(mode === "res" ? resOk : g2sOk)}>
            {mode === "g2s" ? (
              <>
                <Coin kind="gold" /> 金貨を銀貨に交換
              </>
            ) : mode === "g2b" ? (
              <>
                <BondIcon /> {source.label}を債券に交換
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
