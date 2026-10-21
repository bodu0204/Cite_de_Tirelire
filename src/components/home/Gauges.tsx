"use client";

import { DEV_THRESHOLDS, MAX_DEV, MAX_TECH, TECH_THRESHOLDS } from "@/game/config";
import { bankLevelBand } from "@/game/levels";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { Gauge } from "../ui";

export function SavingsGauge({ v }: { v: ActiveView }) {
  const s = v.season;
  // 貯金額 ＝ 債券 ＋ 都市に使った金貨。バーは都市に使った金貨を塗り、債券を斜線で重ねる（債券がマイナスなら減らす）
  const total = Math.max(0, s.savings);
  const city = Math.max(0, Math.min(s.citySpent, total));
  // バーは次の銀行Lvまでの達成率
  const band = bankLevelBand(s.goal, s.bankLevel);
  const done = band.next === null;
  const need = done ? 1 : band.next! - band.from;
  const solid = done ? 1 : Math.max(0, city - band.from);
  const extra = done ? 0 : Math.max(0, total - band.from) - solid;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">貯金目標</span>
        <span className="num text-right">
          <span className="font-pixel text-xl">{fmt(Math.min(999, s.rate), 1)}%</span>
          <span className="ml-1 text-sm text-muted">
            （{yen(total)}/{yen(s.goal)}）
          </span>
        </span>
      </div>
      <Gauge value={solid} extra={extra} max={need} color="var(--gold)" label="次の銀行Lvまでの達成率" />
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span className="num">{done ? "目標達成" : `${yen(Math.max(0, total - band.from))}/${yen(need)}`}</span>
        <span>銀行 {done ? "完成" : `Lv${s.bankLevel}`}</span>
      </div>
    </div>
  );
}

/** 欲しいもの貯金：ほしい物（像）への金貨の積立 */
export function WishSavingsGauge({ v }: { v: ActiveView }) {
  const w = v.wishSavings;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">欲しいもの貯金</span>
        <span className="num font-pixel text-xl">{w.target > 0 ? `${fmt(Math.min(100, (w.reserved / w.target) * 100), 1)}%` : "—"}</span>
      </div>
      <Gauge value={w.reserved} max={w.target} color="#b87333" label="欲しいもの貯金の積立率" />
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span className="num">
          {fmt(w.reserved)}G / {fmt(w.target)}G
        </span>
        <span>{w.count > 0 ? `ほしい物 ${w.count}件` : "ほしい物リストで登録"}</span>
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
        <span>
          {" "}
          ・ 発展速度 {fmt(d.ratePerHour, 1)}pt/時（稼働 {Math.round(d.operation * 100)}%{d.bondMultiplier > 1 && ` ・ 債券 ×${fmt(d.bondMultiplier, 2)}`}）
        </span>
        {d.nextDistrict && <span> ・ 次に「{d.nextDistrict}」を開放</span>}
      </p>
    </div>
  );
}
