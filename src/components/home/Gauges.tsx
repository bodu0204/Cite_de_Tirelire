"use client";

import { DEV_THRESHOLDS, MAX_DEV, MAX_TECH, TECH_THRESHOLDS } from "@/game/config";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { Gauge } from "../ui";

export function SavingsGauge({ v }: { v: ActiveView }) {
  const s = v.season;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">貯金目標</span>
        <span className="num font-pixel text-xl">{fmt(Math.min(999, s.rate), 1)}%</span>
      </div>
      <Gauge value={Math.max(0, s.net)} max={s.goal} color="var(--gold)" label="貯金目標の達成率" />
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span className="num">
          {yen(Math.max(0, s.net))} / {yen(s.goal)}
        </span>
        <span>銀行 {s.bankLevel >= 6 ? "完成" : `Lv${s.bankLevel}`}</span>
      </div>
    </div>
  );
}

export function TechGauge({ v }: { v: ActiveView }) {
  const t = v.tech;
  const prev = TECH_THRESHOLDS[t.level - 1];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">技術Lv</span>
        <span className="font-pixel text-xl" style={{ color: "var(--tech)" }}>
          {t.level}
          <span className="text-sm text-muted"> / {MAX_TECH}</span>
        </span>
      </div>
      <Gauge value={t.next === null ? 1 : t.max - prev} max={t.next === null ? 1 : t.next - prev} color="var(--tech)" label="次の技術Lvまで" />
      <p className="mt-1 text-xs text-muted">
        {t.next === null ? (
          "すべての技術を解放しました"
        ) : (
          <>
            あと <span className="num font-semibold text-ink">{yen(t.remaining)}</span> 貯金すると Lv{t.level + 1}
            {t.nextUnlocks.length > 0 && <>：{t.nextUnlocks.slice(0, 4).join("・")}</>}
          </>
        )}
      </p>
    </div>
  );
}

export function DevGauge({ v }: { v: ActiveView }) {
  const d = v.dev;
  const prev = DEV_THRESHOLDS[d.level - 1];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">発展Lv・{d.name}</span>
        <span className="font-pixel text-xl" style={{ color: "var(--dev)" }}>
          {d.level}
          <span className="text-sm text-muted"> / {MAX_DEV}</span>
        </span>
      </div>
      <Gauge value={d.next === null ? 1 : d.points - prev} max={d.next === null ? 1 : d.next - prev} color="var(--dev)" label="次の発展Lvまで" />
      <p className="mt-1 text-xs text-muted">
        {d.next === null ? "最大の都市規模です。建物の高層化で成長を続けます" : <>あと {fmt(d.next - d.points)}pt</>}
        <span> ・ 発展速度 {fmt(d.ratePerHour, 1)}pt/時（稼働 {Math.round(d.operation * 100)}%）</span>
        {d.nextDistrict && <span> ・ 次に「{d.nextDistrict}」を開放</span>}
      </p>
    </div>
  );
}
