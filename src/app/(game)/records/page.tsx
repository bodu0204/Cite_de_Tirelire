"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { AdjustTab } from "@/components/records/AdjustTab";
import { ExpenseTab } from "@/components/records/ExpenseTab";
import { HistoryTab } from "@/components/records/HistoryTab";
import { IncomeTab } from "@/components/records/IncomeTab";
import { SavingsTab } from "@/components/records/SavingsTab";
import { Coin, Tabs } from "@/components/ui";
import { REWARD_PURCHASE, REWARD_SAVINGS } from "@/game/config";

type Tab = "income" | "expense" | "adjust" | "savings" | "history";

/** 収支記録（SCR-02）：収入・支出・誤差調整の3種類と、貯金管理・履歴（docs/record-input-redesign.md §9.5） */
export default function RecordsPage() {
  const { view } = useGame();
  const v = useSeasonView();
  const [tab, setTab] = useState<Tab>("income");
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
          現実の収入と支出を記録すると銀貨がもらえます（収入・支出 {REWARD_PURCHASE}S・貯金管理 {REWARD_SAVINGS}S、1日 {v?.silverMine.dailyCap ?? 300}S まで）。金額の大小で報酬は変わりません。
        </p>
        {v && (
          <p className="mt-1 text-xs text-muted">
            記録 Lv{v.silverMine.level}（有効な記録 {v.silverMine.records}件{v.silverMine.nextLevelAt !== null && ` ・ 次のLvまで ${v.silverMine.nextLevelAt - v.silverMine.records}件`}） ・ 今日の報酬 {v.silverMine.todayRewarded}/
            {v.silverMine.dailyCap}S ・ 当期 {v.income.periodKey}（毎月{v.income.day}日から）
          </p>
        )}
        {view && !v && <p className="mt-2 text-sm">進行中のシーズンがないため、記録は家計履歴にのみ残り、銀貨は付与されません。</p>}
      </div>
      <div className="overflow-x-auto">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: "income", label: "収入" },
            { value: "expense", label: "支出" },
            { value: "adjust", label: "誤差調整" },
            { value: "savings", label: "貯金管理" },
            { value: "history", label: "履歴" },
          ]}
        />
      </div>
      {tab === "income" && <IncomeTab onDone={done} />}
      {tab === "expense" && <ExpenseTab tz={tz} onDone={done} />}
      {tab === "adjust" && <AdjustTab onDone={done} />}
      {tab === "savings" && <SavingsTab tz={tz} />}
      {tab === "history" && <HistoryTab reloadKey={reloadKey} />}
    </div>
  );
}
