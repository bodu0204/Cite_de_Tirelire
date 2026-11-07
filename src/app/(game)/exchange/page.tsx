"use client";

import { useState, type ReactNode } from "react";
import { PlanList } from "@/components/exchange/PlanList";
import { waitingFor } from "@/components/home/waiting";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, Field, NumberInput, Tabs } from "@/components/ui";
import { FEE_EXCHANGE } from "@/game/config";
import { bondResourceEligible } from "@/game/bond";
import { bondInterestPerDay } from "@/game/fund";
import { quoteBondGains, quoteNeedsExchange, quoteResourceExchange, totalGains, ZERO_GAINS, type Currency } from "@/game/exchange";
import type { GainKey, Gains } from "@/game/types";
import { fmt } from "@/lib/api";

/** 交換で得られるもの：木材・石材・都市資金は建設資金1種類にまとめた（docs/savings-driven-growth.md GRW-02） */
const RES: { key: GainKey; label: string }[] = [{ key: "treasury", label: "建設資金" }];

/** 交換のしかた：債券に／金貨で建設資金に／銀貨で建設資金に／金貨→銀貨 */
type Mode = "g2b" | "gres" | "sres" | "g2s";

/** 交換のしかたごとの「何を何に」「貯金になるか」「建設資金になるか」 */
interface Route {
  value: Mode;
  from: ReactNode;
  to: ReactNode;
  savings: { ok: boolean; note: string };
  resource: { ok: boolean; note: string };
  /** 債券だけ：毎日の利息が増える */
  speed?: { ok: boolean; note: string };
}

/** 「貯金」「建設資金」の札。対象外なら × と取り消し線 */
function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1 py-px text-[10px] font-semibold ${ok ? "bg-gold-soft text-ink" : "border border-line text-muted line-through"}`}
      aria-label={`${label}${ok ? "あり" : "なし"}`}
    >
      <span aria-hidden>{ok ? "✓" : "×"}</span>
      {label}
    </span>
  );
}

/** 有効数字2桁で表示する（少額でも 0.0% にならないように） */
const sig2 = (x: number) => x.toLocaleString("ja-JP", { maximumSignificantDigits: 2 });

const gainsText = (g: Gains) =>
  RES.filter((r) => g[r.key] > 0)
    .map((r) => `${r.label} +${fmt(g[r.key])}`)
    .join("・") || "なし";

export default function ExchangePage() {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  /** 選んだタブ。選ぶまでは債券に交換、債券が上限に達していれば建設資金に交換 */
  const [picked, setMode] = useState<Mode | null>(null);
  /** 交換で得るのはいつも建設資金（おまかせ） */
  const resource = "auto" as GainKey | "auto";
  const [amount, setAmount] = useState("");
  /** 債券に替える元："gold" / ユーザ通貨の id */
  const [bondFrom, setBondFrom] = useState("gold");
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;

  const n = Number(amount || 0);
  const cur = v.currencies;
  const bondFull = cur.bond >= v.exchange.bondCap;
  const mode: Mode = picked ?? (bondFull ? "gres" : "g2b");
  const res = mode === "gres" || mode === "sres";
  const currency: Currency = mode === "sres" ? "silver" : "gold";
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
  const bondGains = quoteBondGains(eligible, resource, needs, lv);

  const customFrom = cur.custom.find((c) => c.id === bondFrom);
  const source =
    mode === "g2b"
      ? customFrom
        ? { label: `${customFrom.icon}${customFrom.name}`, unit: "", balance: customFrom.balance }
        : { label: "金貨", unit: "G", balance: cur.gold }
      : { label: "金貨", unit: "G", balance: cur.gold };
  const g2sOk = n > 0 && n <= source.balance;
  const toLabel = mode === "g2b" ? "債券" : "銀貨";
  /** この交換で増える貯金額（円） */
  const savingsAdd = mode === "g2b" ? n : mode === "g2s" ? n : mode === "gres" ? q.goldCost : 0;
  /** 債券の利息（円/日）の今と交換後（RSV-02） */
  const speedNow = v.dev.interestPerDay;
  const speedAfter = mode === "g2b" ? bondInterestPerDay(cur.bond + n, v.exchange.bondCap) : speedNow;
  const speedMaxed = cur.bond >= v.exchange.bondCap;
  const cityGains = mode === "g2b" ? bondGains : res ? q.gains : ZERO_GAINS;
  const routes: Route[] = [
    {
      value: "g2b",
      from: (
        <>
          <Coin kind="gold" />
          金貨{cur.custom.length > 0 && "等"}
        </>
      ),
      to: (
        <>
          <BondIcon />
          債券
        </>
      ),
      savings: { ok: true, note: "債券として数える" },
      resource: bondFull
        ? { ok: false, note: `債券が上限 ${fmt(v.exchange.bondCap)} に達しているので建設資金はつかない` }
        : { ok: true, note: `上限 ${fmt(v.exchange.bondCap)} までの分に、同じ額の建設資金がつく` },
      speed: speedMaxed
        ? { ok: false, note: `債券が上限に達しているので、利息はこれ以上増えない（今 +${fmt(Math.floor(speedNow))}円/日）` }
        : { ok: true, note: `持っている債券の 0.3% が毎日、利息として建設資金に入る（今 +${fmt(Math.floor(speedNow))}円/日）` },
    },
    {
      value: "gres",
      from: (
        <>
          <Coin kind="gold" />
          金貨
        </>
      ),
      to: (
        <>
          🏗️建設資金
        </>
      ),
      savings: { ok: true, note: "使った金貨の分が貯金に（1G＝1円）" },
      resource: { ok: true, note: `1G＝1円・手数料 ${FEE_EXCHANGE}S` },
    },
    {
      value: "sres",
      from: (
        <>
          <Coin kind="silver" />
          銀貨
        </>
      ),
      to: (
        <>
          🏗️建設資金
        </>
      ),
      savings: { ok: false, note: "銀貨は記録の報酬なので貯金にならない" },
      resource: { ok: true, note: `1S＝0.1円と低め・手数料 ${FEE_EXCHANGE}S` },
    },
    {
      value: "g2s",
      from: (
        <>
          <Coin kind="gold" />
          金貨
        </>
      ),
      to: (
        <>
          <Coin kind="silver" />
          銀貨
        </>
      ),
      savings: { ok: true, note: "使った金貨の分が貯金に（1G＝1円）" },
      resource: { ok: false, note: "1:1・無料。建設資金はつかない（銀貨は手数料や建設資金への交換に使う）" },
    },
  ];
  const route = routes.find((r) => r.value === mode)!;
  const resOk = n > 0 && totalGain > 0 && cur.gold >= q.goldCost && cur.silver >= q.silverCost;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">貯金・建設資金</h1>
        <p className="mt-1 text-sm text-muted">
          金貨（1G＝1円）はゲーム内で使っても現実のお金は出ていかないので、使った分がそのまま貯金額に加わります。何を何に替えるかを選んでください。
        </p>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">何に交換する？</legend>
        <div role="radiogroup" aria-label="交換のしかた" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {routes.map((r) => {
            const on = mode === r.value;
            return (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setMode(r.value)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 ${on ? "border-accent bg-surface shadow-sm ring-1 ring-accent" : "border-line bg-surface-2"}`}
              >
                <span className={`flex items-center gap-1 whitespace-nowrap text-sm ${on ? "font-semibold" : ""}`}>
                  <span className="inline-flex items-center gap-0.5">{r.from}</span>
                  <span className="text-muted" aria-label="から">
                    →
                  </span>
                  <span className="inline-flex items-center gap-0.5">{r.to}</span>
                </span>
                <span className="flex flex-wrap justify-center gap-1">
                  <Chip ok={r.savings.ok} label="貯金" />
                  <Chip ok={r.resource.ok} label="建設資金" />
                  {r.speed && <Chip ok={r.speed.ok} label="利息↑" />}
                </span>
              </button>
            );
          })}
        </div>
        {/* 項目ごとに改行する */}
        <p className="mt-1.5 text-xs text-muted">
          {[
            { ok: route.savings.ok, yes: "貯金になる", no: "貯金にならない", note: route.savings.note },
            { ok: route.resource.ok, yes: "建設資金になる", no: "建設資金にならない", note: route.resource.note },
            ...(route.speed ? [{ ok: route.speed.ok, yes: "利息が増える", no: "利息は増えない", note: route.speed.note }] : []),
          ].map((it) => (
            <span key={it.yes} className="block">
              <span className={it.ok ? "font-semibold text-ink" : ""}>{it.ok ? it.yes : it.no}</span>：{it.note}。
            </span>
          ))}
        </p>
      </fieldset>
      <Card>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r =
              res
                ? await act("/api/exchange", { kind: "to_resource", currency, resource, amount: n })
                : mode === "g2s"
                  ? await act("/api/exchange", { kind: "gold_to_silver", amount: n })
                  : await act("/api/exchange", { kind: "to_bond", currency: customFrom ? "custom" : bondFrom, currencyId: customFrom?.id, resource, amount: n });
            if (r) {
              const rr = r as { gains?: Gains; citySpentAdded?: number };
              const got = rr.gains ? gainsText(rr.gains) : "";
              const saved = mode === "g2b" ? n : (rr.citySpentAdded ?? 0);
              const savedText = saved > 0 ? `貯金額 +${fmt(saved)}円` : "";
              toast(
                mode === "g2s"
                  ? `銀貨 ${fmt(n)}S を手に入れました（${savedText}）`
                  : mode === "g2b"
                    ? `${source.label} ${fmt(n)} を債券に替えました（${[savedText, got !== "なし" ? `街に ${got}` : ""].filter(Boolean).join("・")}）`
                    : `${got} を手に入れました${savedText ? `（${savedText}）` : ""}`,
                "reward",
              );
              setAmount("");
            }
          }}
        >
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
          <Field label={res ? (currency === "gold" ? "金貨（G）" : "銀貨（S）") : `${source.label}${source.unit ? `（${source.unit}）` : ""}`}>
            <NumberInput value={amount} onValueChange={setAmount} placeholder="100" />
          </Field>

          <div className="grid grid-cols-2 gap-2 text-center" aria-live="polite">
            <div className={`rounded-lg border px-2 py-2 ${savingsAdd > 0 ? "border-gold bg-gold-soft" : "border-line bg-surface-2"}`}>
              <div className="text-xs text-muted">貯金額</div>
              <div className="num text-base font-semibold">{savingsAdd > 0 ? `+${fmt(savingsAdd)}円` : mode === "sres" ? "増えません" : "—"}</div>
              <div className="num text-[11px] text-muted">
                {fmt(v.season.savings)} → {fmt(v.season.savings + savingsAdd)}円
              </div>
            </div>
            <div className={`rounded-lg border px-2 py-2 ${totalGains(cityGains) > 0 ? "border-accent bg-surface" : "border-line bg-surface-2"}`}>
              <div className="text-xs text-muted">街に入る建設資金</div>
              <div className="num text-sm font-semibold">{mode === "g2s" ? "入りません" : n > 0 ? gainsText(cityGains) : "—"}</div>
              {mode === "g2s" && <div className="text-[11px] text-muted">銀貨でも建設資金に替えられます（効率は低め）</div>}
              {mode !== "g2s" && v.dev.earlyBonusRate > 1 && <div className="text-[11px] text-dev">開拓期ボーナスで ×{fmt(v.dev.earlyBonusRate, 1)}</div>}
            </div>
            {mode === "g2b" && (
              <div className={`col-span-2 rounded-lg border px-2 py-2 ${speedAfter > speedNow ? "border-dev bg-surface" : "border-line bg-surface-2"}`}>
                <div className="text-xs text-muted">債券の利息（毎日、建設資金に入る）</div>
                <div className="num text-sm font-semibold">
                  +{fmt(Math.floor(speedNow))} → +{fmt(Math.floor(speedAfter))}円/日
                  {speedNow > 0 && speedAfter > speedNow && <span className="ml-1 text-dev">（+{sig2((speedAfter / speedNow - 1) * 100)}%）</span>}
                </div>
                <div className="text-[11px] text-muted">
                  {speedMaxed ? "債券が上限に達しています" : "債券を持っているあいだ、残高の 0.3% が毎日入ります（上限は自由予算の3か月分）"}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-lg bg-surface-2 p-3 text-sm">
            {!res ? (
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
                    <dt className="text-muted">街に入る建設資金</dt>
                    <dd className="num text-right font-semibold">{gainsText(bondGains)}</dd>
                    {(belowZero > 0 || overCap > 0) && n > 0 && (
                      <dd className="col-span-2 text-xs text-muted">
                        {belowZero > 0 && `債券がマイナスの間の ${fmt(belowZero)} は建設資金なし。`}
                        {overCap > 0 && `上限 ${fmt(v.exchange.bondCap)} を超える ${fmt(overCap)} は建設資金なし。`}
                      </dd>
                    )}
                  </>
                )}
                {mode === "g2s" && <dd className="col-span-2 text-xs text-muted">銀貨から金貨には戻せません。銀貨は手数料や建設資金への交換に使えます。</dd>}
                {mode === "g2b" && (
                  <dd className="col-span-2 text-xs text-muted">
                    債券は元の通貨に戻せません。急な出費（金貨が足りない購入）の支払いに使われ、持っている間は毎日利息が建設資金として街に入ります。
                    {customFrom && " ユーザ通貨は期限の近い分から替えます。"}
                  </dd>
                )}
              </dl>
            ) : (
              <dl className="grid grid-cols-2 gap-y-1">
                {auto ? (
                  <>
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
              </dl>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={busy || !(res ? resOk : g2sOk)}>
            {mode === "g2s" ? (
              <>
                <Coin kind="gold" /> 金貨を銀貨に交換
              </>
            ) : mode === "g2b" ? (
              <>
                <BondIcon /> {source.label}を債券に交換
              </>
            ) : (
              <>
                <Coin kind={currency} /> {currency === "gold" ? "金貨" : "銀貨"}を建設資金に交換
              </>
            )}
          </Button>
        </form>
      </Card>
      {mode !== "g2s" && (
        <PlanList
          queue={v.exchange.planQueue}
          stock={{ wood: v.city.stock.wood, stone: v.city.stock.stone, treasury: v.city.treasury }}
          foodNeed={needs.food}
          gains={cityGains}
          waiting={waitingFor(v)}
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
          銀行 Lv{lv.bank}・配当 Lv{lv.goldMine}・記録 Lv{lv.silverMine} のボーナス込み（開拓期ボーナスは別）。建設資金 {fmt(Math.floor(v.city.treasury))}円・食料 {fmt(Math.floor(v.city.stock.food))}
        </p>
      </Card>
    </div>
  );
}
