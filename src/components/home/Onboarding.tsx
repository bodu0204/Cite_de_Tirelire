"use client";

import { useState } from "react";
import { POLICY_PRESETS } from "@/game/city/init";
import { useGame } from "../GameProvider";
import { Button, Card, Field, LinkButton } from "../ui";

/** Phase 1：予算・目標・開発方針の設定 */
export function Onboarding() {
  const { view, act } = useGame();
  const [budget, setBudget] = useState(String(view?.user.monthlyBudget || ""));
  const [goal, setGoal] = useState("");
  const [preset, setPreset] = useState<keyof typeof POLICY_PRESETS>("balanced");
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
            act("/api/season", { goalAmount: Number(goal), monthlyBudget: Number(budget || 0), preset });
          }}
        >
          <Field label="月間自由予算（円）" hint="固定費や予定している貯金を除いた、毎月自由に使える金額。金鉱がこの額を1か月かけて金貨に変えます。">
            <input inputMode="numeric" required value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} placeholder="60000" />
          </Field>
          <Field label="今回の貯金目標（円）" hint="今の預金残高ではなく、これから新しく貯める金額。">
            <input inputMode="numeric" required value={goal} onChange={(e) => setGoal(e.target.value.replace(/\D/g, ""))} placeholder="100000" />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">街の開発方針</legend>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(POLICY_PRESETS) as (keyof typeof POLICY_PRESETS)[]).map((k) => (
                <label key={k} className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${preset === k ? "border-accent bg-surface-2 font-semibold" : "border-line"}`}>
                  <input type="radio" name="preset" value={k} checked={preset === k} onChange={() => setPreset(k)} className="sr-only" />
                  {POLICY_PRESETS[k].label}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">あとから設定や街の画面でいつでも変えられます。</p>
          </fieldset>
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
