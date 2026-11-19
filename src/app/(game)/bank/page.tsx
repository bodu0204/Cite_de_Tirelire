"use client";

import { useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { SavingsGauge, TechGauge, WishSavingsGauge } from "@/components/home/Gauges";
import { Button, Card, Field, LinkButton, NumberInput, Stat } from "@/components/ui";
import { BANK_LEVEL_THRESHOLDS } from "@/game/config";
import { goldMineBonus, silverMineBonus } from "@/game/levels";
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

const GOAL_NAME_MAX = 20;

/** 目標の名前（いつでも無料で変えられる。docs/season-start-settings.md GN-04） */
function GoalName({ name, number }: { name: string | null; number: number }) {
  const { act, toast, busy } = useGame();
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState(name ?? "");
  if (!edit) {
    return (
      <p className="mt-1 text-sm">
        目標：<span className="font-medium">{name ?? `シーズン${number}`}</span>
        <button
          className="ml-2 text-xs text-muted underline"
          onClick={() => {
            setValue(name ?? "");
            setEdit(true);
          }}
        >
          {name ? "名前を変える" : "名前をつける"}
        </button>
      </p>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!(await act("/api/season", { goalName: value }, "PATCH"))) return;
        toast(value.trim() ? "目標の名前を変えました" : "目標の名前を外しました");
        setEdit(false);
      }}
    >
      <input aria-label="目標の名前" className="min-w-0 flex-1" value={value} maxLength={GOAL_NAME_MAX} onChange={(e) => setValue(e.target.value)} placeholder="例：北海道旅行" />
      <Button type="submit" disabled={busy}>
        保存
      </Button>
      <button type="button" className="text-xs text-muted underline" onClick={() => setEdit(false)}>
        やめる
      </button>
    </form>
  );
}

/** すでにある貯金の訂正（開始から24時間以内だけ。docs/season-start-settings.md RC-11） */
function CarriedEdit({ total }: { total: number }) {
  const { act, toast, busy } = useGame();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(String(total));
  if (!open) {
    return (
      <button className="mt-2 text-xs text-muted underline" onClick={() => setOpen(true)}>
        すでにある貯金の額を直す（開始から24時間以内）
      </button>
    );
  }
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!(await act("/api/season", { existingSavings: Number(value || 0) }, "PATCH"))) return;
        toast("すでにある貯金を直しました");
        setOpen(false);
      }}
    >
      <Field label="すでにある貯金（円）">
        <NumberInput value={value} onValueChange={setValue} />
      </Field>
      <Button type="submit" disabled={busy}>
        保存
      </Button>
    </form>
  );
}

export default function BankPage() {
  const v = useSeasonView();
  if (!v) return <p className="text-muted">進行中のシーズンがありません。</p>;
  const s = v.season;
  const c = s.carried;
  const carriedTotal = c.reserve + c.savings;
  const canEditCarried = v.serverNow < c.editableUntil;
  let net = 0;
  const points = [{ at: s.startedAt, value: 0 }, ...s.savingsTimeline.map((e) => ({ at: e.at, value: (net += e.delta) }))];
  const nextBank = s.bankLevel < 6 ? BANK_LEVEL_THRESHOLDS[s.bankLevel] : null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">貯金状況</h1>
        <p className="mt-1 text-sm text-muted">
          街の中心の銀行は、現実の貯金目標を表す施設です。達成率に応じて成長し、金貨・銀貨から資源への交換効率が上がります。金貨の配当と、記録の報酬の銀貨も銀行から受け取ります。
        </p>
        <GoalName name={s.name} number={s.number} />
      </div>
      <Card>
        <div className="space-y-4">
          <SavingsGauge v={v} />
          <WishSavingsGauge v={v} />
        </div>
      </Card>
      <Card title="貯金額の内訳">
        <dl className="num grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <dt className="text-muted">債券以外（ゲーム内で使った金貨）</dt>
          <dd className="text-right">{yen(s.citySpent)}</dd>
          <dt className="text-muted">債券</dt>
          <dd className={`text-right ${s.inDebt ? "text-danger" : ""}`}>
            {s.bond < 0 ? "−" : "+"}
            {yen(Math.abs(s.bond))}
          </dd>
          <dt className="border-t border-line pt-1 font-medium">貯金額</dt>
          <dd className="border-t border-line pt-1 text-right font-semibold">
            {yen(s.savings)}（{fmt(s.rate, 1)}%）
          </dd>
        </dl>
        <p className="mt-2 text-xs text-muted">
          貯金額は、ゲーム内で使った金貨（建設資金・銀貨への交換。金貨は使っても現実のお金は出ていきません）と債券の合計です。債券を現実の支払いに使うと貯金額は減ります。銀行Lv・技術Lv・目標達成はこの額で決まります。
        </p>
      </Card>
      {(carriedTotal > 0 || canEditCarried) && (
        <Card title="すでにある貯金と備え">
          <dl className="num grid grid-cols-[1fr_auto] gap-y-1 text-sm">
            <dt className="text-muted">持ち込みの備え（手取り月収の3か月分まで）</dt>
            <dd className="text-right">{yen(c.reserve)}</dd>
            {c.savings > 0 && (
              <>
                <dt className="text-muted">持ち込みの貯金（それを超える分）</dt>
                <dd className="text-right">{yen(c.savings)}</dd>
              </>
            )}
            <dt className="text-muted">このシーズンの貯金額</dt>
            <dd className="text-right">{yen(s.savings)}</dd>
            <dt className="border-t border-line pt-1 font-medium">貯金の合計</dt>
            <dd className="border-t border-line pt-1 text-right font-semibold">{yen(carriedTotal + s.savings)}</dd>
            <dt className="pt-2 text-muted">備え（債券 ＋ 持ち込みの備え）</dt>
            <dd className="pt-2 text-right">
              {yen(Math.max(0, s.bond + c.reserve))}・備えLv{v.dev.reserveLevel}
            </dd>
          </dl>
          {c.drawn > 0 && (
            <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${s.inDebt ? "bg-danger/10" : "bg-surface-2"}`}>
              {s.inDebt
                ? `持ち込みの備え ${yen(c.reserve)} を使い切り、さらに ${yen(-s.bond - c.reserve)} 足りていません。戻るまで配当の20%以上が債券に回ります。`
                : `持ち込みの備えから ${yen(c.drawn)} 取り崩し中です（残り ${yen(c.reserve - c.drawn)}）。この範囲では配当の強制の債券化は起きません。`}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {c.fromPrevious ? "前の街から持ち越した貯金です。" : "シーズンを始めるときに入れた、すでにある貯金です。"}
            持ち込みの備えは備えLvに数えますが、利息・建設資金・達成率・技術Lvには数えません。街はこのシーズンに貯めた分で育ちます。
          </p>
          {canEditCarried && <CarriedEdit total={carriedTotal} />}
        </Card>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="貯金目標" value={yen(s.goal)} sub={s.name ?? `シーズン${s.number}`} />
        <Stat label="貯金額" value={yen(s.savings)} sub={`最高 ${yen(s.max)}`} />
        <Stat label="銀行" value={s.bankLevel >= 6 ? "完成" : `Lv${s.bankLevel}`} sub={nextBank !== null ? `次は達成率${nextBank}%` : undefined} />
        <Stat label="交換ボーナス" value={`+${Math.round(s.bankBonus * 100)}%`} sub="金貨・銀貨とも" />
      </div>
      <Card title="銀行のレベル">
        <dl className="num grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">銀行 Lv（貯金の達成率）</dt>
          <dd className="text-right">
            {s.bankLevel >= 6 ? "完成" : `Lv${s.bankLevel}`} ・ 金貨・銀貨 +{Math.round(s.bankBonus * 100)}%
          </dd>
          <dt className="text-muted">配当 Lv（受け取った金貨）</dt>
          <dd className="text-right">
            Lv{v.mine.level} ・ 金貨 +{Math.round(goldMineBonus(v.mine.level) * 100)}%
          </dd>
          <dt className="text-muted">記録 Lv（有効な記録）</dt>
          <dd className="text-right">
            Lv{v.silverMine.level} ・ 銀貨 +{Math.round(silverMineBonus(v.silverMine.level) * 100)}%
          </dd>
        </dl>
        <p className="mt-2 text-xs text-muted">交換効率のボーナスは足し合わせて効きます。配当Lvは配当資金、記録Lvは収支記録の画面で進み具合を確かめられます。</p>
      </Card>
      <Card title="貯金管理（別口座への出し入れ）の推移">
        <SavingsChart points={points} goal={s.goal} />
        <p className="mt-2 text-xs text-muted">
          開始日 {formatDate(s.startedAt, v.user.timezone)} ・ 純増額 {yen(s.managed)}。貯金管理の記録は判定に使わず、手元のお金の推測に使います。
        </p>
      </Card>
      <Card>
        <TechGauge v={v} />
        <p className="mt-3 text-xs text-muted">
          技術Lvはこのシーズンの貯金額の最高到達額（{yen(s.max)}）で決まります。債券を使って貯金額が下がっても、解放済みの技術は失われません。現在の達成率は {fmt(s.rate, 1)}% です。
        </p>
      </Card>
      <LinkButton href="/records" variant="primary" className="w-full">
        収支を記録する
      </LinkButton>
    </div>
  );
}
