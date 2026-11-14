"use client";

import Link from "next/link";
import { useGame } from "@/components/GameProvider";
import { Button } from "@/components/ui";
import { DECOR_LABELS, RESERVE_FACILITIES, SPECIAL_LABELS, tierDef, ZONE_LABELS } from "@/game/catalog";
import { buildingOutput } from "@/game/city/economy";
import { buildingSize, contains, expansionError, isPlaced, isTileUnlocked, jobSize, plotKey, plotOf, zoneAt } from "@/game/city/layout";
import { DISCOUNT_PER_BUILDING, HOUR, MINUTE, REPAIR_SILVER, RESERVE_LEVEL_MONTHS } from "@/game/config";
import { PARK_DESCRIPTION, PARK_SIZE_LABELS, STATUE_DESCRIPTION, statueStageLabel } from "@/game/describe";
import { STATUE_RANK_LABELS } from "@/game/levels";
import type { Building } from "@/game/types";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { Customize } from "./Customize";

const minutesLeft = (finishAt: number, now: number) => Math.max(1, Math.ceil((finishAt - now) / MINUTE));

/** 工事中の表示 */
function JobLine({ v, label, job }: { v: ActiveView; label?: string; job: { finishAt: number } }) {
  return (
    <p className="text-muted">
      {label ? `${label}・` : ""}完了まで約{minutesLeft(job.finishAt, v.serverNow)}分
    </p>
  );
}

function outputText(v: ActiveView, b: Building): string {
  if (!b.line) return "";
  const m = v.metrics;
  const t = tierDef(b.line, b.tier);
  const o = buildingOutput(t, b.level, {
    laborRatio: m.laborRatio,
    powerRatio: m.powerRatio,
    logistics: m.logistics,
    techMultiplier: m.techMultiplier,
    demandRatio: m.commerceCap > 0 ? Math.min(1, m.population / m.commerceCap) : 0,
  });
  const lm = 1 + 0.25 * (b.level - 1);
  const parts: string[] = [];
  if (t.housing) parts.push(`住民 ${fmt(t.housing * lm)}人まで`);
  if (o.food) parts.push(`食料 +${fmt(o.food, 1)}/時`);
  // 木材加工所・石材加工所・工場は建設費の割引の施設（docs/savings-driven-growth.md GRW-05）
  if (b.line === "lumber" || b.line === "quarry" || b.line === "factory") parts.push(`建設費 −${Math.round(DISCOUNT_PER_BUILDING * 100)}%`);
  if (t.powerSupply) parts.push(`電力 ${fmt(t.powerSupply * lm)}`);
  if (t.logistics) parts.push(`物流 ${fmt(t.logistics * lm)}棟分`);
  if (t.serve) parts.push(`${fmt(t.serve * lm)}人をカバー`);
  if (t.workers) parts.push(`働き手 ${fmt(t.workers * lm, 1)}人`);
  if (t.power) parts.push(`電力消費 ${fmt(t.power * lm, 1)}`);
  return parts.join(" ・ ");
}

type ParkInfo = ActiveView["specials"]["parks"][string];
type StatueInfo = ActiveView["specials"]["statues"][string];

function parkRows(b: Building, p?: ParkInfo): [string, string][] {
  const rows: [string, string][] = [
    ["状態", b.closed ? "閉園中（解約済み）" : "開園中"],
    ["大きさ", PARK_SIZE_LABELS[b.tier] ?? ""],
  ];
  if (p) {
    rows.push(["料金", p.cycle === "YEARLY" ? `${yen(p.amount)}/年（月${yen(p.monthly)}）` : `${yen(p.amount)}/月`]);
    rows.push(["契約期間", `${p.startDate}〜${p.endDate ?? ""}`]);
  }
  return rows;
}

function statueRows(b: Building, w?: StatueInfo): [string, string][] {
  const rows: [string, string][] = [
    ["種類", STATUE_RANK_LABELS[(["bronze", "silver", "gold"] as const)[b.tier]]],
    ["状態", statueStageLabel(b.level)],
  ];
  if (w) {
    rows.push(["価格", yen(w.price)]);
    if (!w.purchased) rows.push(["積立", `${fmt(w.reserved)}G（${Math.floor((w.reserved / w.price) * 100)}%）`]);
    rows.push(["優先度", ["", "高", "中", "低"][w.priority] ?? ""]);
  }
  return rows;
}

/** 備えの施設（docs/savings-driven-growth.md RSV-03） */
function reserveRows(b: Building, v: ActiveView): [string, string][] {
  const lv = b.tier + 1;
  return [
    ["備えLv", `${lv}（債券が自由予算の${RESERVE_LEVEL_MONTHS[b.tier]}か月分）`],
    ["状態", b.closed ? `閉鎖中（今の備えLv${v.dev.reserveLevel}）` : "稼働中"],
    ["備え", RESERVE_FACILITIES[b.tier]?.effect ?? ""],
  ];
}

const RESERVE_DESCRIPTION = "債券（もしもの備え）が増えると、備えLvごとに銀行のそばに施設が建ち、悪い出来事の被害が軽くなります。債券が減ると施設は閉まり、戻ると再開します。";

function SpecialDetail({ rows, description, href, linkLabel }: { rows: [string, string][]; description: string; href: string; linkLabel: string }) {
  return (
    <div className="mt-2 space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, val]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="num">{val}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">{description}</p>
      <Link href={href} className="inline-block text-xs underline">
        {linkLabel}
      </Link>
    </div>
  );
}

/** 開拓していない土地：区画（5×5 マス）は街が発展するにつれて開拓される（docs/map-layout-redesign.md §7.3） */
function ExpandPanel({ v, tile }: { v: ActiveView; tile: { x: number; y: number } }) {
  const city = v.city;
  const { px, py } = plotOf(tile.x, tile.y);
  const job = city.jobs.find((j) => j.kind === "expand" && j.plot === plotKey(px, py));
  const plots = v.dev.plots;
  if (job) {
    return (
      <div className="space-y-2 text-sm">
        <p className="font-semibold">区画を開拓中</p>
        <JobLine v={v} job={job} />
      </div>
    );
  }
  const why = expansionError(city, px, py);
  return (
    <div className="space-y-2 text-sm">
      <p>まだ開拓されていない土地です。建てる場所が足りなくなると、5×5 マスの区画ごとに開拓されます。開拓すると区画の真ん中に十字の道路が通ります。</p>
      {plots && (
        <p className="text-xs text-muted">
          開拓できる区画 {plots.used} / {plots.limit}
          {plots.habit > 0 ? `（発展Lv ${plots.base} ＋ こまめボーナス ${plots.habit}）` : ""}。発展Lvを上げるか、こまめに貯金すると増えます
          {plots.nextHabitIn !== null && `（あと${plots.nextHabitIn}日の貯金で1つ）`}
        </p>
      )}
      {why && <p className="text-xs text-muted">{why}</p>}
    </div>
  );
}

/** 火事で休業した建物：自動で再開するまでの時間と、銀貨での修繕（docs/savings-driven-growth.md EVT-05） */
function Repair({ v, id, until }: { v: ActiveView; id: string; until: number }) {
  const { act, toast, busy } = useGame();
  const hours = Math.max(1, Math.ceil((until - v.serverNow) / HOUR));
  return (
    <div className="rounded-lg border border-line bg-surface-2 p-2 text-xs">
      <p>
        <span className="font-semibold text-danger">火事で休業中</span>：あと約{hours}時間で再開します。銀貨で修繕すると、すぐ再開します。
      </p>
      <Button
        className="mt-2 w-full"
        variant="secondary"
        disabled={busy || v.currencies.silver < REPAIR_SILVER}
        onClick={async () => {
          const r = await act("/api/city/repair", { buildingId: id });
          if (r) toast(`修繕しました（銀貨 −${REPAIR_SILVER}S）`, "reward");
        }}
      >
        銀貨 {REPAIR_SILVER}S で修繕する（所持 {fmt(v.currencies.silver)}S）
      </Button>
    </div>
  );
}

export function TilePanel({ v, tile }: { v: ActiveView; tile: { x: number; y: number } }) {
  const city = v.city;
  // 大きな建物は、占有範囲のどのマスを選んでもその建物
  const b = city.buildings.find((o) => isPlaced(o) && contains(o, buildingSize(o), tile.x, tile.y));
  const job = city.jobs.find((j) => contains(j, j.kind === "build" ? jobSize(j) : 1, tile.x, tile.y) && (j.kind === "build" || (j.x === tile.x && j.y === tile.y)));
  const zone = zoneAt(city, tile.x, tile.y);

  // 林を押しのけて置いた公園・像と道路は、未開放の区画でも建物として見せる
  if (!b && !isTileUnlocked(city, tile.x, tile.y)) {
    return <ExpandPanel v={v} tile={tile} />;
  }

  if (job && job.kind === "build") {
    return (
      <div className="space-y-2 text-sm">
        <p className="font-semibold">{tierDef(job.line, job.tier).name}を建設中</p>
        <JobLine v={v} job={job} />
      </div>
    );
  }

  if (b) {
    const park = b.special === "park" && b.refId ? v.specials.parks[b.refId] : undefined;
    const statue = b.special === "statue" && b.refId ? v.specials.statues[b.refId] : undefined;
    // 公園・像は「[対象名]の公園」「[対象名]の像」と表示する
    const kind = b.line
      ? tierDef(b.line, b.tier).name
      : park
        ? `${park.name}の公園`
        : statue
          ? `${statue.name}の像`
          : b.special === "reserve"
            ? (RESERVE_FACILITIES[b.tier]?.name ?? SPECIAL_LABELS.reserve)
            : b.special
              ? SPECIAL_LABELS[b.special]
              : "";
    // 銀貨でつけた名前（REC-06）があれば、それを見出しにして種類を添える
    const name = b.name ? `「${b.name}」` : kind;
    const bJob = city.jobs.find((j) => j.buildingId === b.id);
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="font-pixel text-base">
            {name}
            {b.name && <span className="ml-2 text-xs text-muted">{kind}</span>}
            {b.line && <span className="ml-2 text-xs text-muted">Lv{b.level}</span>}
          </p>
          {b.decor && <p className="text-xs text-muted">装飾：{DECOR_LABELS[b.decor]}</p>}
          {b.line && <p className="mt-1 text-xs text-muted">{outputText(v, b)}</p>}
          {b.special === "park" && <SpecialDetail rows={parkRows(b, park)} description={PARK_DESCRIPTION} href="/subscriptions" linkLabel="サブスク一覧で編集" />}
          {b.special === "statue" && <SpecialDetail rows={statueRows(b, statue)} description={STATUE_DESCRIPTION} href="/wishes" linkLabel="ほしい物リストで積立・編集" />}
          {b.special === "reserve" && <SpecialDetail rows={reserveRows(b, v)} description={RESERVE_DESCRIPTION} href="/gold" linkLabel="債券を見る" />}
        </div>
        {bJob && <JobLine v={v} label={bJob.kind === "evolve" ? `${tierDef(bJob.line, bJob.tier).name}へ進化中` : `Lv${bJob.level}へアップグレード中`} job={bJob} />}
        {b.line && city.closedUntil?.[b.id] !== undefined && <Repair v={v} id={b.id} until={city.closedUntil[b.id]} />}
        {b.line && <p className="text-xs text-muted">土地用途：{ZONE_LABELS[zone]}</p>}
        {b.line !== "road" && <Customize v={v} b={b} />}
      </div>
    );
  }

  return <p className="text-sm text-muted">空き地（{ZONE_LABELS[zone]}）。街に足りないものに合わせて、建物が建ちます。</p>;
}
