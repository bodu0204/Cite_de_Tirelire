"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CityView } from "@/components/city/CityView";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { EventLog } from "@/components/home/EventLog";
import { DevGauge, SavingsGauge, TechGauge, WishSavingsGauge } from "@/components/home/Gauges";
import { Onboarding } from "@/components/home/Onboarding";
import { TilePanel } from "@/components/home/TilePanel";
import { BondIcon, Button, Card, Coin, CustomIcon, LinkButton, Modal, Stat } from "@/components/ui";
import { expandablePlots, tileLabel } from "@/game/city/layout";
import { fmt } from "@/lib/api";

/** ホームに最初から出すユーザ通貨の数（残りは折りたたむ） */
const CUSTOM_SHOWN = 3;

export default function HomePage() {
  const { view, error, act, toast, busy } = useGame();
  const v = useSeasonView();
  const [tile, setTile] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [showZones, setShowZones] = useState(false);
  // 昼夜を時刻に合わせるか（OBJ-14）。端末ごとに覚える。読めなければ合わせる
  const [dayNight, setDayNight] = useState(true);
  useEffect(() => {
    try {
      setDayNight(localStorage.getItem("city-daynight") !== "off");
    } catch {
      // 保存できない環境では既定のまま
    }
  }, []);
  const toggleDayNight = (on: boolean) => {
    setDayNight(on);
    try {
      localStorage.setItem("city-daynight", on ? "on" : "off");
    } catch {
      // 保存できなくても表示は切り替わる
    }
  };
  const [away, setAway] = useState<NonNullable<NonNullable<typeof v>["away"]> | null>(null);
  const [highlights, setHighlights] = useState<Set<string>>(new Set());
  const [allCurrencies, setAllCurrencies] = useState(false);

  useEffect(() => {
    if (v?.away && (v.away.built || v.away.upgraded || v.away.evolved || v.away.expanded || v.away.population || v.away.devPoints)) {
      setAway(v.away);
      setHighlights(new Set(v.away.tiles.map(([x, y]) => `${x},${y}`)));
      const t = setTimeout(() => setHighlights(new Set()), 20_000);
      return () => clearTimeout(t);
    }
  }, [v?.away]);

  // 端末時刻とサーバー時刻の差（工事の進捗表示用）
  const offset = useMemo(() => (v ? v.serverNow - Date.now() : 0), [v]);

  if (error && !view) return <p className="text-danger">{error}</p>;
  if (!view) return <p className="text-muted">街を読み込んでいます…</p>;
  if (!v) return <Onboarding />;

  const m = v.metrics;
  const c = v.city;
  // 開拓できる区画には看板を立てる
  const expandable = expandablePlots(c);
  const uncollected = Math.floor(v.mine.uncollected);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        {v.season.status === "GOAL_REACHED" && (
          <Link href="/goal" className="rise block rounded-xl border-2 border-gold bg-gold-soft px-4 py-3">
            <span className="font-pixel text-lg">貯金目標に到達しました！</span>
            <span className="block text-sm">内容を確認して、街を完成させましょう →</span>
          </Link>
        )}

        <div>
          <CityView
            label={`${v.dev.name}の街。人口${Math.floor(m.population)}人、建物${c.buildings.length}棟。矢印キーでマスを選べます`}
            plots={c.plots}
            expandable={expandable}
            buildings={c.buildings}
            jobs={c.jobs}
            zones={c.zones}
            noAuto={c.noAuto}
            bankLevel={c.bankLevel}
            selected={tile}
            highlights={highlights}
            showZones={showZones}
            serverOffset={offset}
            onSelect={setTile}
            timezone={dayNight ? view.user.timezone : undefined}
            occupancy={m.housingCap > 0 ? m.population / m.housingCap : 0}
            population={m.population}
            logistics={m.logistics}
            supply={{ power: m.powerRatio, workers: m.laborRatio, food: m.foodRatio }}
            gold={{ uncollected: v.mine.uncollected, ratePerMinute: v.mine.ratePerMinute }}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>マスを選ぶと建物の操作ができます。街は操作しなくても自動で発展します。</span>
            <span className="flex shrink-0 flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 whitespace-nowrap">
                <input type="checkbox" className="w-auto" checked={showZones} onChange={(e) => setShowZones(e.target.checked)} />
                土地用途を表示
              </label>
              <label className="flex items-center gap-1.5 whitespace-nowrap">
                <input type="checkbox" className="w-auto" checked={dayNight} onChange={(e) => toggleDayNight(e.target.checked)} />
                時刻に合わせて昼夜を表示
              </label>
            </span>
          </div>
        </div>

        {tile && (
          <Card title={tileLabel(tile.x, tile.y)} action={<button className="text-sm text-muted" onClick={() => (setTile(null), setMoving(null))}>閉じる</button>}>
            <TilePanel v={v} tile={tile} moving={moving} setMoving={setMoving} />
          </Card>
        )}

        <Card title="街の様子">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="人口" value={`${fmt(Math.floor(m.population))}人`} sub={`住宅 ${fmt(m.housingCap)}人分`} />
            <Stat label="幸福度" value={fmt(c.happiness)} sub={`目標 ${fmt(m.happinessTarget)}`} />
            <Stat label="雇用" value={`${Math.round(m.employment * 100)}%`} sub={`仕事 ${fmt(m.jobSlots)}`} />
            <Stat label="都市資金" value={fmt(Math.floor(c.treasury))} sub={`+${fmt(m.production.treasury, 1)}/時`} />
            <Stat label="木材" value={fmt(Math.floor(c.stock.wood))} sub={`+${fmt(m.production.wood, 1)}/時`} />
            <Stat label="石材" value={fmt(Math.floor(c.stock.stone))} sub={`+${fmt(m.production.stone, 1)}/時`} />
            <Stat label="食料" value={fmt(Math.floor(c.stock.food))} sub={`${m.production.food - m.foodUse >= 0 ? "+" : ""}${fmt(m.production.food - m.foodUse, 1)}/時`} />
            <Stat label="電力" value={m.powerDemand > 0 ? `${Math.round(m.powerRatio * 100)}%` : "—"} sub={`供給 ${fmt(m.powerSupply)} / 需要 ${fmt(m.powerDemand)}`} />
          </div>
          <p className="mt-3 text-xs text-muted">
            物流効率 {Math.round(m.logistics * 100)}% ・ 技術倍率 ×{fmt(m.techMultiplier, 2)}（技術活用率 {Math.round(m.techUtilization * 100)}%） ・ 工事中 {c.jobs.length}件
          </p>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <div className="space-y-4">
            <SavingsGauge v={v} />
            <WishSavingsGauge v={v} />
            <TechGauge v={v} />
            <DevGauge v={v} />
          </div>
        </Card>

        <Card title="通貨" action={<Link href="/currencies" className="text-xs text-muted underline">ユーザ通貨を管理</Link>}>
          <ul className="num space-y-1.5 text-sm">
            <li className="flex items-center gap-2">
              <Coin kind="gold" />
              <span className="flex-1">金貨</span>
              <span>{fmt(v.currencies.gold)}G</span>
            </li>
            <li className="flex items-center gap-2">
              <Coin kind="silver" />
              <span className="flex-1">銀貨</span>
              <span>{fmt(v.currencies.silver)}S</span>
            </li>
            <li className="flex items-center gap-2">
              <BondIcon />
              <span className="flex-1">
                債券
                {v.dev.bondMultiplier > 1 && <span className="ml-1 text-xs text-muted">発展 ×{fmt(v.dev.bondMultiplier, 2)}</span>}
              </span>
              <span className={v.currencies.bond < 0 ? "font-semibold text-danger" : ""}>{fmt(v.currencies.bond)}</span>
            </li>
            {(allCurrencies ? v.currencies.custom : v.currencies.custom.slice(0, CUSTOM_SHOWN)).map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <CustomIcon icon={c.icon} />
                <span className="min-w-0 flex-1 truncate">
                  {c.name}
                  {c.nextIssue && <span className="ml-1 text-xs text-muted">次 {c.nextIssue.date.slice(5)} +{fmt(c.nextIssue.amount)}</span>}
                </span>
                <span>{fmt(c.balance)}</span>
              </li>
            ))}
          </ul>
          {v.currencies.custom.length > CUSTOM_SHOWN && (
            <button className="mt-2 text-xs text-muted underline" onClick={() => setAllCurrencies((x) => !x)}>
              {allCurrencies ? "たたむ" : `ほか ${v.currencies.custom.length - CUSTOM_SHOWN} 種類を表示`}
            </button>
          )}
        </Card>

        <div className="grid grid-cols-2 gap-2">
          <LinkButton href="/records" variant="primary" className="min-h-14 text-base">
            ⛏ 銀鉱に記録
          </LinkButton>
          <Button
            variant="gold"
            className="min-h-14 text-base"
            disabled={busy || uncollected < 1}
            onClick={async () => {
              const r = await act<{ collected: number }>("/api/mine/collect");
              if (r) toast(`金貨 ${fmt(r.collected)}G を回収しました`, "reward");
            }}
          >
            <Coin kind="gold" size={18} /> {fmt(uncollected)}G 回収
          </Button>
        </div>

        <Card title="自動発展ログ">
          <EventLog events={v.log} tz={view.user.timezone} />
        </Card>
      </div>

      <Modal open={!!away} onClose={() => setAway(null)} title={`前回から${away?.hours ?? 0}時間が経過しました`}>
        {away && (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {away.population !== 0 && <li>人口 {away.population > 0 ? "+" : ""}{fmt(away.population)}人</li>}
              {away.built > 0 && <li>建物 {away.built}棟を建設</li>}
              {away.upgraded > 0 && <li>建物 {away.upgraded}件をアップグレード</li>}
              {away.evolved > 0 && <li>建物 {away.evolved}棟が進化</li>}
              {away.expanded > 0 && <li>区画を {away.expanded}つ開拓</li>}
              <li>発展ポイント +{fmt(away.devPoints)}</li>
              <li>都市資金 {away.treasury >= 0 ? "+" : ""}{fmt(away.treasury)}</li>
              {away.bondResources.wood + away.bondResources.stone + away.bondResources.food + away.bondResources.treasury > 0 && (
                <li>
                  債券化で得た資源 木材 +{fmt(away.bondResources.wood)}・石材 +{fmt(away.bondResources.stone)}・食料 +{fmt(away.bondResources.food)}・都市資金 +
                  {fmt(away.bondResources.treasury)}
                </li>
              )}
            </ul>
            <p className="text-xs text-muted">変化した場所を地図上で光らせています。金貨・銀貨は使っていません。</p>
            <Button className="w-full" onClick={() => setAway(null)}>
              街を見る
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
