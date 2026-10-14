"use client";

import { useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Coin, Stat } from "@/components/ui";
import { goldMineBonus } from "@/game/levels";
import { fmt, yen } from "@/lib/api";

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
  // 状態を受け取ってから1分ごとに採掘が進む様子を表示する（正本はサーバー）
  const sinceMin = Math.max(0, Math.floor(((v.serverNow % 60_000) + now - receivedAt) / 60_000));
  const live = Math.max(0, mine.uncollected + (mine.debt > 0 ? 0 : sinceMin * mine.ratePerMinute));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">金鉱</h1>
        <p className="mt-1 text-sm text-muted">月間自由予算からサブスク料金を引いた額を、1か月かけて金貨に変えます（1G＝1円相当）。購入はまず金鉱の金貨から精算されます。</p>
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
          {v.currencies.gold < 0 && (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-center text-sm">
              所持金貨が <span className="num font-semibold text-danger">{fmt(v.currencies.gold)}G</span> です（所持金貨を超えて購入した分）。
              <br />
              <span className="text-xs text-muted">今後の採掘からまず返済されます。月末に残ったマイナスは予算超過として記録し、翌月には繰り越しません。</span>
            </p>
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="採掘速度" value={`${fmt(mine.ratePerMinute, 3)}G/分`} sub={`1日あたり ${fmt(mine.ratePerMinute * 1440)}G`} />
        <Stat label="所持金貨" value={<span className={v.currencies.gold < 0 ? "text-danger" : ""}>{fmt(v.currencies.gold)}G</span>} sub={v.currencies.reserved > 0 ? `像に積立 ${fmt(v.currencies.reserved)}G` : undefined} />
        <Stat label="当月の採掘累計" value={`${fmt(Math.floor(mine.minedThisMonth))}G`} sub={mine.monthKey} />
        <Stat label="当月の購入精算額" value={yen(mine.settledThisMonth)} />
        <Stat label="月間サブスク" value={yen(mine.subscriptionsMonthly)} sub={`予算 ${yen(v.user.monthlyBudget)}`} />
        <Stat
          label={`金鉱 Lv${mine.level}`}
          value={`交換 +${Math.round(goldMineBonus(mine.level) * 100)}%`}
          sub={mine.nextLevelAt !== null ? `次のLvまで 回収 ${fmt(mine.nextLevelAt - mine.totalCollected)}G` : "最大レベル"}
        />
      </div>
      {mine.overspends.length > 0 && (
        <Card title="予算超過の記録">
          <ul className="text-sm">
            {mine.overspends.map((o) => (
              <li key={o.monthKey} className="flex justify-between py-1">
                <span>{o.monthKey}</span>
                <span className="num">{yen(o.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">月内に精算できなかった購入額です。翌月には繰り越さず、建物や資源も没収されません。</p>
        </Card>
      )}
      <p className="text-xs text-muted">金鉱のレベルが上がると、金貨から資源への交換効率が上がります。採掘量（現実の予算）は増えません。</p>
    </div>
  );
}
