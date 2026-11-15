"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { ExpenseTab } from "@/components/records/ExpenseTab";
import { HistoryTab } from "@/components/records/HistoryTab";
import { IncomeTab } from "@/components/records/IncomeTab";
import { MoneyTab } from "@/components/records/MoneyTab";
import { Button, Coin, Tabs } from "@/components/ui";
import { confirmedText, type Confirmed } from "@/components/records/shared";
import { AUTO_CONFIRM_DAYS, REWARD_EXTRA, REWARD_EXTRA_DAILY_CAP, REWARD_PURCHASE } from "@/game/config";
import { fmt } from "@/lib/api";

type Tab = "income" | "expense" | "money" | "history";

/** 収支記録（SCR-02）：支出・収入と、お金の管理（置き場所・振替・残高を合わせる）・履歴（docs/money-accounts.md §12.4） */
export default function RecordsPage() {
  const { view, act, toast, busy } = useGame();
  const v = useSeasonView();
  const [tab, setTab] = useState<Tab>("expense");
  const [reloadKey, setReloadKey] = useState(0);
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const done = () => setReloadKey((k) => k + 1);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 font-pixel text-2xl">
          <Coin kind="silver" size={22} />
          収支記録
        </h1>
        <p className="mt-1 text-sm text-muted">
          現実の収入と支出を記録すると銀貨がもらえます（収入・支出 {REWARD_PURCHASE}S、1日 {v?.silverMine.dailyCap ?? 300}S まで）。振替と、支出の出どころを自分で選んだときは、別に {REWARD_EXTRA}S（1日 {REWARD_EXTRA_DAILY_CAP}S まで）。金額の大小で報酬は変わりません。
        </p>
        {v && (
          <p className="mt-1 text-xs text-muted">
            記録 Lv{v.silverMine.level}（有効な記録 {v.silverMine.records}件{v.silverMine.nextLevelAt !== null && ` ・ 次のLvまで ${v.silverMine.nextLevelAt - v.silverMine.records}件`}） ・ 今日の報酬 {v.silverMine.todayRewarded}/
            {v.silverMine.dailyCap}S ・ 振替・出どころ {v.silverMine.extra.todayRewarded}/{v.silverMine.extra.dailyCap}S ・ 当期 {v.income.periodKey}（毎月{v.income.day}日から）
          </p>
        )}
        {view && !v && <p className="mt-2 text-sm">進行中のシーズンがないため、記録は家計履歴にのみ残り、銀貨は付与されません。</p>}
      </div>
      {v && (
        <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
          <p>
            記録すると、それまでの使わなかった配当（<span className="num font-semibold">{fmt(Math.floor(v.mine.uncollected))}G</span>）が貯金として確定し、債券と建設資金になって街に入ります。
            記録しない日の分は{AUTO_CONFIRM_DAYS}日後に、推定の支出を引いて確定します
            {v.mine.confirmedAt !== null && `（最後の確定：${Math.max(0, Math.floor((v.serverNow - v.mine.confirmedAt) / 86_400_000))}日前）`}。
          </p>
          <Button
            className="mt-2 w-full"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              const r = await act<{ reward: number; confirmed: Confirmed }>("/api/records/no-spend");
              if (!r) return;
              const c = confirmedText(r.confirmed);
              toast(r.reward > 0 ? `今日は支出なしで記録しました！ 銀貨 +${r.reward}S${c}` : `記録しました${c}`, r.reward > 0 ? "reward" : "info");
              done();
            }}
          >
            今日は支出なし
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "expense", label: "支出" },
            { value: "income", label: "収入" },
            { value: "money", label: "お金の管理" },
            { value: "history", label: "履歴" },
          ]}
        />
      </div>
      {tab === "income" && <IncomeTab onDone={done} />}
      {tab === "expense" && <ExpenseTab tz={tz} onDone={done} reloadKey={reloadKey} />}
      {tab === "money" && <MoneyTab tz={tz} reloadKey={reloadKey} onDone={done} />}
      {tab === "history" && <HistoryTab reloadKey={reloadKey} />}
    </div>
  );
}
