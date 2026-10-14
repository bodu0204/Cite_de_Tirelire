"use client";

import { useSeasonView } from "@/components/GameProvider";
import { SavingsGauge, TechGauge, WishSavingsGauge } from "@/components/home/Gauges";
import { Card, LinkButton, Stat } from "@/components/ui";
import { BANK_LEVEL_THRESHOLDS } from "@/game/config";
import { fmt, formatDate, yen } from "@/lib/api";

/** 貯金の推移（純増額の折れ線） */
function SavingsChart({ points, goal }: { points: { at: number; value: number }[]; goal: number }) {
  if (points.length < 2) return <p className="text-sm text-muted">記録が増えると推移が表示されます。</p>;
  const W = 600;
  const H = 180;
  const t0 = points[0].at;
  const t1 = Math.max(points[points.length - 1].at, t0 + 1);
  const top = Math.max(goal, ...points.map((p) => p.value));
  const x = (t: number) => ((t - t0) / (t1 - t0)) * (W - 20) + 10;
  const y = (v: number) => H - 16 - (Math.max(0, v) / top) * (H - 32);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="貯金純増額の推移">
      <line x1={10} x2={W - 10} y1={y(goal)} y2={y(goal)} stroke="var(--gold)" strokeDasharray="6 4" />
      <text x={W - 12} y={y(goal) - 6} textAnchor="end" fontSize="12" fill="var(--muted)">
        目標 {yen(goal)}
      </text>
      <line x1={10} x2={W - 10} y1={H - 16} y2={H - 16} stroke="var(--line)" />
      <path d={d} fill="none" stroke="var(--dev)" strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(p.at)} cy={y(p.value)} r={3} fill="var(--dev)" />
      ))}
    </svg>
  );
}

export default function BankPage() {
  const v = useSeasonView();
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;
  const s = v.season;
  let net = 0;
  const points = [{ at: s.startedAt, value: 0 }, ...s.savingsTimeline.map((e) => ({ at: e.at, value: (net += e.delta) }))];
  const nextBank = s.bankLevel < 6 ? BANK_LEVEL_THRESHOLDS[s.bankLevel] : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">銀行</h1>
        <p className="mt-1 text-sm text-muted">現実の貯金目標を表す施設です。達成率に応じて成長し、金貨・銀貨から資源への交換効率が上がります。</p>
      </div>
      <Card>
        <div className="space-y-4">
          <SavingsGauge v={v} />
          <WishSavingsGauge v={v} />
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="貯金目標" value={yen(s.goal)} sub={`シーズン${s.number}`} />
        <Stat label="今回の純増額" value={yen(s.net)} sub={s.estimated > 0 ? `見込み +${yen(s.estimated)}` : `最高 ${yen(s.max)}`} />
        <Stat label="銀行" value={s.bankLevel >= 6 ? "完成" : `Lv${s.bankLevel}`} sub={nextBank !== null ? `次は達成率${nextBank}%` : undefined} />
        <Stat label="交換ボーナス" value={`+${Math.round(s.bankBonus * 100)}%`} sub="金貨・銀貨とも" />
      </div>
      <Card title="貯金の推移">
        <SavingsChart points={points} goal={s.goal} />
        <p className="mt-2 text-xs text-muted">開始日 {formatDate(s.startedAt, v.user.timezone)}</p>
      </Card>
      <Card>
        <TechGauge v={v} />
        <p className="mt-3 text-xs text-muted">
          技術Lvはこのシーズンの貯金純増額の最高到達額（{yen(s.max)}）で決まります。引出しても解放済みの技術は失われません。現在の達成率は {fmt(s.rate, 1)}% です。
        </p>
      </Card>
      <LinkButton href="/records" variant="primary" className="w-full">
        貯金を記録する
      </LinkButton>
    </div>
  );
}
