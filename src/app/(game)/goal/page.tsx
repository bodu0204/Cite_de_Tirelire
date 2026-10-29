"use client";

import { useRouter } from "next/navigation";
import { CityView } from "@/components/city/CityView";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, LinkButton, Stat } from "@/components/ui";
import { devLevel } from "@/game/levels";
import { fmt, formatDate, yen } from "@/lib/api";

export default function GoalPage() {
  const router = useRouter();
  const { act, busy } = useGame();
  const v = useSeasonView();
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;
  const s = v.season;
  const tz = v.user.timezone;
  if (s.status !== "GOAL_REACHED") {
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="font-pixel text-2xl">目標達成まで</h1>
        <p className="text-sm text-muted">達成率 {fmt(s.rate, 1)}%。あと {yen(Math.max(0, s.goal - s.savings))} で街が完成します。</p>
        <LinkButton href="/">街へ戻る</LinkButton>
      </div>
    );
  }
  const days = Math.max(1, Math.ceil(((s.reachedAt ?? v.serverNow) - s.startedAt) / 86_400_000));
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="rise text-center">
        <p className="font-pixel text-sm text-gold">GOAL!</p>
        <h1 className="font-pixel text-3xl">貯金目標を達成しました</h1>
      </div>
      <CityView
        fixed
        label="完成間近の街"
        layout={v.city.v}
        plots={v.city.plots}
        buildings={v.city.buildings}
        jobs={[]}
        zones={v.city.zones}
        devLevel={devLevel(v.city.devPoints)}
        bankLevel={v.city.bankLevel}
        population={v.metrics.population}
        logistics={v.metrics.logistics}
      />
      <div className="grid grid-cols-2 gap-2">
        <Stat label="達成した貯金額" value={yen(s.savings)} sub={`目標 ${yen(s.goal)}`} />
        <Stat label="目標達成日" value={s.reachedAt ? formatDate(s.reachedAt, tz) : "—"} />
        <Stat label="プレイ期間" value={`${days}日`} sub={`${formatDate(s.startedAt, tz)}〜`} />
        <Stat label="街の最終状態" value={`${v.dev.name}`} sub={`人口 ${fmt(Math.floor(v.metrics.population))}人 ・ 技術Lv${v.tech.level}`} />
      </div>
      <Card>
        <p className="text-sm">
          「目標を完了する」を押すと、この街は完成としてアーカイブされ、成長のタイムラプスが見られるようになります。完成した街は編集できません。記録に誤りがあれば、先に銀鉱の記録履歴で直してください。
        </p>
        <Button
          variant="gold"
          className="mt-4 min-h-12 w-full text-base"
          disabled={busy}
          onClick={async () => {
            if (!confirm("目標を完了して、この街を完成させますか？")) return;
            const r = await act<{ seasonId: string }>("/api/season/complete");
            if (r) router.push(`/timelapse/${r.seasonId}`);
          }}
        >
          目標を完了する
        </Button>
      </Card>
    </div>
  );
}
