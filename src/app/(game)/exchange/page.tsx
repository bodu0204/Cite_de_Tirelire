"use client";

import { useState } from "react";
import { PlanList } from "@/components/exchange/PlanList";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, Field, Tabs } from "@/components/ui";
import { FEE_EXCHANGE } from "@/game/config";
import { bondResourceEligible } from "@/game/bond";
import { quoteNeedsExchange, quoteResourceExchange, totalGains, ZERO_GAINS, type Currency } from "@/game/exchange";
import type { GainKey, Gains } from "@/game/types";
import { fmt } from "@/lib/api";

/** 交換で得られるもの */
const RES: { key: GainKey; label: string }[] = [
  { key: "wood", label: "木材" },
  { key: "stone", label: "石材" },
  { key: "food", label: "食料" },
  { key: "treasury", label: "都市資金" },
];

type Mode = "g2b" | "res" | "g2s";

const gainsText = (g: Gains) =>
  RES.filter((r) => g[r.key] > 0)
    .map((r) => `${r.label} +${fmt(g[r.key])}`)
    .join("・") || "なし";

export default function ExchangePage() {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  /** 選んだタブ。選ぶまでは債券に交換、債券が上限に達していれば資源に交換 */
  const [picked, setMode] = useState<Mode | null>(null);
  const [currency, setCurrency] = useState<Currency>("gold");
  /** "auto" は都市の必要資源の割合で振り分ける（おまかせ） */
  const [resource, setResource] = useState<GainKey | "auto">("auto");
  const [amount, setAmount] = useState("");
  /** 債券に替える元："gold" / ユーザ通貨の id */
  const [bondFrom, setBondFrom] = useState("gold");
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;

  const n = Number(amount || 0);
  const cur = v.currencies;
  const mode: Mode = picked ?? (cur.bond >= v.exchange.bondCap ? "res" : "g2b");
  const lv = v.exchange.levels;
  const needs = v.exchange.needs;
  const auto = resource === "auto";
  const one = auto ? null : quoteResourceExchange(currency, resource, n, lv);
  const q = auto ? quoteNeedsExchange(currency, n, needs, lv) : { ...one!, gains: { ...ZERO_GAINS, [resource]: one!.gain } };
  const totalGain = totalGains(q.gains);
  const resLabel = auto ? "おまかせ" : RES.find((r) => r.key === resource)!.label;
  const next = v.exchange.nextPlan;
  const nextLabel = next.expansion ? `拡張計画（${next.name}相当）` : `${next.name}${next.kind === "upgrade" ? ` Lv${next.level}` : ""}`;

  // 債券に入る分のうち、資源がつく分（マイナスを0に戻す分・上限を超える分は対象外）
  const eligible = bondResourceEligible(cur.bond, n, v.exchange.bondCap);
  const belowZero = cur.bond < 0 ? Math.min(n, -cur.bond) : 0;
  const overCap = Math.max(0, n - belowZero - eligible);
  const bondGains = quoteNeedsExchange("gold", eligible, needs, lv, { fee: false }).gains;

  const customFrom = cur.custom.find((c) => c.id === bondFrom);
  const source =
    mode === "g2b"
      ? customFrom
        ? { label: `${customFrom.icon}${customFrom.name}`, unit: "", balance: customFrom.balance }
        : { label: "金貨", unit: "G", balance: cur.gold }
      : { label: "金貨", unit: "G", balance: cur.gold };
  const g2sOk = n > 0 && n <= source.balance;
  const toLabel = mode === "g2b" ? "債券" : "銀貨";
  const resOk = n > 0 && totalGain > 0 && cur.gold >= q.goldCost && cur.silver >= q.silverCost;
  const shareText = RES.map((r) => `${r.label} ${fmt(v.exchange.needShares[r.key] * 100)}%`).join("・");

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">貯金・資源交換</h1>
        <p className="mt-1 text-sm text-muted">
          「貯金」の付いた交換に使った金貨（1G＝1円）は、現実で使わずに済んだお金として貯金額に加わります。債券に替えた分は債券として、資源に替えた分は都市に使った金貨として数えます（二重には数えません）。
          債券は急な出費に備えるお金で、上限（自由予算の3か月分）に達するまでは債券への交換から始まります。
          金貨は資源への交換効率が高く、銀貨は手動操作の手数料に使えます。金貨→銀貨は 1:1 で無料、逆はできません。金貨・ユーザ通貨は債券に 1:1 で無料で替えられます（債券からは戻せません。銀貨は記録の報酬なので替えられません）。
          金貨・銀貨は自動開発の予算になる都市資金にも替えられます。「おまかせ」は街がいま必要としている資源・都市資金の割合で振り分けます。債券に入った分（0〜上限の範囲）には、同じ量の金貨でおまかせ交換した資源もつきます。
        </p>
      </div>
      <Tabs
        value={mode}
        onChange={setMode}
        items={[
          { value: "g2b", label: "債券に交換", note: "貯金" },
          { value: "res", label: "資源に交換", note: "貯金" },
          { value: "g2s", label: "金貨→銀貨" },
        ]}
      />
      <Card>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r =
              mode === "res"
                ? await act("/api/exchange", { kind: "to_resource", currency, resource, amount: n })
                : mode === "g2s"
                  ? await act("/api/exchange", { kind: "gold_to_silver", amount: n })
                  : await act("/api/exchange", { kind: "to_bond", currency: customFrom ? "custom" : bondFrom, currencyId: customFrom?.id, amount: n });
            if (r) {
              const rr = r as { gains?: Gains; citySpentAdded?: number };
              const got = rr.gains ? gainsText(rr.gains) : "";
              toast(
                mode === "g2s"
                  ? `銀貨 ${fmt(n)}S を手に入れました`
                  : mode === "g2b"
                    ? `${source.label} ${fmt(n)} を債券に替えました${got !== "なし" ? `（街に ${got}）` : ""}`
                    : `${got} を手に入れました${rr.citySpentAdded ? `（貯金額 +${fmt(rr.citySpentAdded)}円）` : ""}`,
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
                <Tabs
                  value={resource}
                  onChange={setResource}
                  items={[
                    { value: "auto" as const, label: "おまかせ" },
                    ...RES.map((r) => ({ value: r.key, label: r.label })),
                  ]}
                />
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
                  <>
                    <dt className="text-muted">街に入る資源</dt>
                    <dd className="num text-right font-semibold">{gainsText(bondGains)}</dd>
                    {(belowZero > 0 || overCap > 0) && n > 0 && (
                      <dd className="col-span-2 text-xs text-muted">
                        {belowZero > 0 && `債券がマイナスの間の ${fmt(belowZero)} は資源なし。`}
                        {overCap > 0 && `上限 ${fmt(v.exchange.bondCap)} を超える ${fmt(overCap)} は資源なし。`}
                      </dd>
                    )}
                  </>
                )}
                {mode === "g2b" && (
                  <dd className="col-span-2 text-xs text-muted">
                    債券は元の通貨に戻せません。急な出費（金貨が足りない購入）の支払いに使われ、持っているほど街の発展が速くなります。
                    {customFrom && " ユーザ通貨は期限の近い分から替えます。"}
                  </dd>
                )}
              </dl>
            ) : (
              <dl className="grid grid-cols-2 gap-y-1">
                {auto ? (
                  <>
                    <dt className="text-muted">必要割合</dt>
                    <dd className="num text-right">{shareText}</dd>
                    <dt className="text-muted">次の計画</dt>
                    <dd className="text-right">{nextLabel}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted">交換効率</dt>
                    <dd className="num text-right">
                      1{currency === "gold" ? "G" : "S"} → {resLabel} {fmt(one!.rate, 2)}
                    </dd>
                  </>
                )}
                <dt className="text-muted">獲得量</dt>
                <dd className="num text-right font-semibold">{gainsText(q.gains)}</dd>
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
                    <dt className="text-muted">貯金額（都市に使った金貨）</dt>
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
      {mode !== "g2s" && (
        <PlanList
          queue={v.exchange.planQueue}
          stock={{ wood: v.city.stock.wood, stone: v.city.stock.stone, treasury: v.city.treasury }}
          foodNeed={needs.food}
          gains={mode === "res" ? q.gains : bondGains}
        />
      )}
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
          銀行 Lv{lv.bank}・配当 Lv{lv.goldMine}・記録 Lv{lv.silverMine} のボーナス込み。手元の資材：木材 {fmt(Math.floor(v.city.stock.wood))}・石材 {fmt(Math.floor(v.city.stock.stone))}・食料 {fmt(Math.floor(v.city.stock.food))}・都市資金 {fmt(Math.floor(v.city.treasury))}
        </p>
      </Card>
    </div>
  );
}
