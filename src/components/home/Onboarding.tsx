"use client";

import { useState } from "react";
import { useGame } from "../GameProvider";
import { Button, Card, Field, LinkButton, NumberInput } from "../ui";

/** Phase 1：予算・目標の設定 */
export function Onboarding() {
  const { view, act } = useGame();
  const [budget, setBudget] = useState(String(view?.user.monthlyBudget || ""));
  const [goal, setGoal] = useState("");
  const again = view?.hasArchive;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">{again ? "新しい街をはじめる" : "ようこそ、Cité de Tirelire へ"}</h1>
        <p className="mt-2 text-sm text-muted">
          現実の貯金目標を1つ決めると、小さな集落から新しい街が始まります。目標を達成するとその街は完成し、成長の記録をタイムラプスで振り返れます。
        </p>
      </div>
      <Card>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            act("/api/season", { goalAmount: Number(goal), monthlyBudget: Number(budget || 0) });
          }}
        >
          <Field label="月間自由予算（円）" hint="固定費や予定している貯金を除いた、毎月自由に使える金額。銀行がこの額を1か月かけて金貨に変えます。">
            <NumberInput required value={budget} onValueChange={setBudget} placeholder="60000" />
          </Field>
          <Field label="今回の貯金目標（円）" hint="今の預金残高ではなく、これから新しく貯める金額。">
            <NumberInput required value={goal} onValueChange={setGoal} placeholder="100000" />
          </Field>
          <Button type="submit" className="w-full" disabled={!goal || Number(goal) < 1000}>
            街をつくる
          </Button>
        </form>
      </Card>
      {again && (
        <LinkButton href="/timelapse" className="w-full">
          完成した街のタイムラプスを見る
        </LinkButton>
      )}
    </div>
  );
}
