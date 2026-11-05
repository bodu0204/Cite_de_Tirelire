"use client";

import Link from "next/link";
import { SPECIAL_LABELS, tierDef, ZONE_LABELS } from "@/game/catalog";
import { buildingOutput } from "@/game/city/economy";
import { buildingSize, contains, expansionError, isPlaced, isTileUnlocked, jobSize, plotKey, plotOf, zoneAt } from "@/game/city/layout";
import { FEE_RUSH_PER_10MIN, MINUTE } from "@/game/config";
import { PARK_DESCRIPTION, PARK_SIZE_LABELS, STATUE_DESCRIPTION, statueStageLabel } from "@/game/describe";
import { STATUE_RANK_LABELS } from "@/game/levels";
import type { Building } from "@/game/types";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { useGame } from "../GameProvider";
import { Button } from "../ui";

const rushFeeOf = (finishAt: number, now: number) => Math.max(1, Math.ceil(Math.max(0, finishAt - now) / (10 * MINUTE))) * FEE_RUSH_PER_10MIN;
const minutesLeft = (finishAt: number, now: number) => Math.max(1, Math.ceil((finishAt - now) / MINUTE));

/** 工事中の表示と、即時完了（銀貨）のボタン */
function JobLine({ v, label, job }: { v: ActiveView; label: string; job: { id: string; finishAt: number } }) {
  const { act, busy } = useGame();
  const fee = rushFeeOf(job.finishAt, v.serverNow);
  return (
    <div className="space-y-2">
      <p className="text-muted">
        {label}・完了まで約{minutesLeft(job.finishAt, v.serverNow)}分
      </p>
      <Button variant="gold" disabled={busy || v.currencies.silver < fee} onClick={() => act("/api/city", { type: "rush", jobId: job.id })}>
        すぐ完成させる（{fee}S）
      </Button>
    </div>
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
  if (o.wood) parts.push(`木材 +${fmt(o.wood, 1)}/時`);
  if (o.stone) parts.push(`石材 +${fmt(o.stone, 1)}/時`);
  if (o.treasury) parts.push(`都市資金 +${fmt(o.treasury, 1)}/時`);
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

/** 開拓していない土地：区画（5×5 マス）は自動開発が開拓する（docs/map-layout-redesign.md §7.3） */
function ExpandPanel({ v, tile }: { v: ActiveView; tile: { x: number; y: number } }) {
  const city = v.city;
  const { px, py } = plotOf(tile.x, tile.y);
  const job = city.jobs.find((j) => j.kind === "expand" && j.plot === plotKey(px, py));
  const plots = v.dev.plots;
  if (job) {
    return (
      <div className="space-y-2 text-sm">
        <p className="font-semibold">区画を開拓中</p>
        <JobLine v={v} label="自動開発による開拓" job={job} />
      </div>
    );
  }
  const why = expansionError(city, px, py);
  return (
    <div className="space-y-2 text-sm">
      <p>まだ開拓されていない土地です。建てる場所が足りなくなると、自動開発が5×5 マスの区画ごとに開拓します。開拓すると区画の真ん中に十字の道路が通ります。</p>
      {plots && (
        <p className="text-xs text-muted">
          開拓できる区画 {plots.used} / {plots.limit}（発展Lvを上げると増えます）
        </p>
      )}
      {why && <p className="text-xs text-muted">{why}</p>}
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
        <JobLine v={v} label="自動開発による工事" job={job} />
      </div>
    );
  }

  if (b) {
    const park = b.special === "park" && b.refId ? v.specials.parks[b.refId] : undefined;
    const statue = b.special === "statue" && b.refId ? v.specials.statues[b.refId] : undefined;
    // 公園・像は「[対象名]の公園」「[対象名]の像」と表示する
    const name = b.line
      ? tierDef(b.line, b.tier).name
      : park
        ? `${park.name}の公園`
        : statue
          ? `${statue.name}の像`
          : b.special
            ? SPECIAL_LABELS[b.special]
            : "";
    const bJob = city.jobs.find((j) => j.buildingId === b.id);
    return (
      <div className="space-y-3 text-sm">
        <div>
          <p className="font-pixel text-base">
            {name}
            {b.line && <span className="ml-2 text-xs text-muted">Lv{b.level}</span>}
          </p>
          {b.line && <p className="mt-1 text-xs text-muted">{outputText(v, b)}</p>}
          {b.special === "park" && <SpecialDetail rows={parkRows(b, park)} description={PARK_DESCRIPTION} href="/subscriptions" linkLabel="サブスク一覧で編集" />}
          {b.special === "statue" && <SpecialDetail rows={statueRows(b, statue)} description={STATUE_DESCRIPTION} href="/wishes" linkLabel="ほしい物リストで積立・編集" />}
        </div>
        {bJob && <JobLine v={v} label={bJob.kind === "evolve" ? `${tierDef(bJob.line, bJob.tier).name}へ進化中` : `Lv${bJob.level}へアップグレード中`} job={bJob} />}
        {b.line && <p className="text-xs text-muted">土地用途：{ZONE_LABELS[zone]}</p>}
      </div>
    );
  }

  return <p className="text-sm text-muted">空き地（{ZONE_LABELS[zone]}）。自動開発が、街に足りないものに合わせて建物を建てます。</p>;
}
