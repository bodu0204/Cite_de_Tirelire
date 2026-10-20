"use client";

import { useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { BondIcon, Button, Card, Coin, Stat } from "@/components/ui";
import { BOND_FORCED_RATE } from "@/game/config";
import { goldMineBonus } from "@/game/levels";
import { fmt, yen } from "@/lib/api";

const RATES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export default function GoldMinePage() {
  const { act, toast, busy, receivedAt } = useGame();
  const v = useSeasonView();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;

  const mine = v.mine;
  const b = mine.breakdown;
  const bond = mine.bond;
  // 状態を受け取ってから1分ごとに採掘が進む様子を表示する（正本はサーバー）
  const sinceMin = Math.max(0, Math.floor(((v.serverNow % 60_000) + now - receivedAt) / 60_000));
  const live = Math.max(0, mine.uncollected + sinceMin * mine.ratePerMinute * (1 - bond.share / 100));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">金鉱</h1>
        <p className="mt-1 text-sm text-muted">
          月間自由予算からサブスク料金とユーザ通貨の発生額を引いた額を、1か月かけて金貨に変えます（1G＝1円相当）。購入はユーザ通貨・金貨の順に精算され、足りない分は債券が肩代わりします。
        </p>
      </div>
      <Card>
        <div className="flex flex-col items-center gap-3 py-2">
          <div className="text-sm text-muted">未回収の金貨</div>
          <div className="num flex items-center gap-2 font-pixel text-4xl">
            <Coin kind="gold" size={28} />
            {fmt(Math.floor(live))}
            <span className="text-lg">G</span>
          </div>
          <Button
            variant="gold"
            className="min-h-12 w-full max-w-xs text-base"
            disabled={busy || Math.floor(mine.uncollected) < 1}
            onClick={async () => {
              const r = await act<{ collected: number }>("/api/mine/collect");
              if (r) toast(`金貨 ${fmt(r.collected)}G を回収しました`, "reward");
            }}
          >
            回収する
          </Button>
        </div>
      </Card>

      <Card title="採掘速度の内訳（月あたり）">
        <dl className="num grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="text-muted">月間自由予算 B</dt>
          <dd className="text-right">{yen(b.budget)}</dd>
          <dt className="text-muted">サブスク S</dt>
          <dd className="text-right">−{yen(b.subs)}</dd>
          <dt className="text-muted">ユーザ通貨 C（今月の発生額）</dt>
          <dd className="text-right">−{yen(b.custom)}</dd>
          <dt className="border-t border-line pt-1 font-medium">採掘</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">{yen(b.net)}</dd>
        </dl>
        {v.currencies.custom.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            ユーザ通貨：{v.currencies.custom.map((c) => `${c.icon}${c.name}`).join("・")}。自由予算の内訳なので、その分を採掘から差し引いています。
          </p>
        )}
      </Card>

      <Card title={<span className="flex items-center gap-1.5"><BondIcon size={16} />採掘の債券化</span>}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted">債券</span>
          <span className={`num font-pixel text-2xl ${v.currencies.bond < 0 ? "text-danger" : ""}`}>{fmt(v.currencies.bond)}</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          採掘の一部を債券に回します。債券は急な出費（金貨が足りない購入）を肩代わりし、持っているほど街の時間発展が速くなります（今 ×{fmt(v.dev.bondMultiplier, 2)}）。上限 {fmt(bond.cap)}（自由予算の3か月分）に達したら自動で止まります。
        </p>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block font-medium">債券化率</span>
          <select
            value={bond.rate}
            disabled={busy}
            onChange={async (e) => {
              if (await act("/api/settings", { bondMiningRate: Number(e.target.value) }, "PATCH")) toast("債券化率を変更しました");
            }}
          >
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </label>
        <p
          className={`mt-2 rounded-lg px-3 py-2 text-sm ${bond.status === "forced" ? "bg-danger/10" : "bg-surface-2"}`}
        >
          {bond.status === "forced" && (
            <>
              債券がマイナスのため、採掘の <span className="num font-semibold">{bond.share}%</span> を強制的に債券に回しています（最低 {BOND_FORCED_RATE}%）。0に戻ると設定の {bond.rate}% に戻ります。発展速度は下がりません。0に戻るまでの分には資源がつきません。
            </>
          )}
          {bond.status === "capped" && <>債券が上限に達したため、債券化を止めています。採掘はすべて金貨になります。</>}
          {bond.status === "active" && (
            <>
              採掘の <span className="num font-semibold">{bond.share}%</span> を債券に回しています。同じ量の金貨でおまかせ交換したのと同じ資源も、街に入ります。
            </>
          )}
          {bond.status === "off" && <>債券化していません。採掘はすべて金貨になります。</>}
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="採掘速度" value={`${fmt(mine.ratePerMinute, 3)}G/分`} sub={`1日あたり ${fmt(mine.ratePerMinute * 1440)}G`} />
        <Stat label="所持金貨" value={`${fmt(v.currencies.gold)}G`} sub={v.currencies.reserved > 0 ? `像に積立 ${fmt(v.currencies.reserved)}G` : undefined} />
        <Stat label="当月の採掘累計" value={`${fmt(Math.floor(mine.minedThisMonth))}G`} sub={mine.monthKey} />
        <Stat label="当月の購入精算額" value={yen(mine.settledThisMonth)} />
        <Stat label="月間サブスク" value={yen(mine.subscriptionsMonthly)} sub={`予算 ${yen(v.user.monthlyBudget)}`} />
        <Stat
          label={`金鉱 Lv${mine.level}`}
          value={`交換 +${Math.round(goldMineBonus(mine.level) * 100)}%`}
          sub={mine.nextLevelAt !== null ? `次のLvまで ${fmt(mine.nextLevelAt - mine.totalCollected)}G` : "最大レベル"}
        />
      </div>
      {mine.overspends.length > 0 && (
        <Card title="債券で肩代わりした額">
          <ul className="text-sm">
            {mine.overspends.map((o) => (
              <li key={o.monthKey} className="flex justify-between py-1">
                <span>{o.monthKey}</span>
                <span className="num">{yen(o.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">ユーザ通貨と金貨で払いきれず、債券から払った購入額です。建物や資源は没収されません。</p>
        </Card>
      )}
      <p className="text-xs text-muted">金鉱のレベルは回収した金貨と債券化した採掘の累計で上がり、金貨から資源への交換効率が上がります。採掘量（現実の予算）は増えません。</p>
    </div>
  );
}
