"use client";

import Link from "next/link";
import { useState } from "react";
import {
  evolveCost,
  highestUnlockedTier,
  isTierUnlocked,
  LINE_IDS,
  LINES,
  SPECIAL_LABELS,
  tierDef,
  upgradeCost,
  ZONE_LABELS,
  type Cost,
  type LineId,
  type Zone,
} from "@/game/catalog";
import { buildingOutput } from "@/game/city/economy";
import { expandQuote } from "@/game/city/actions";
import {
  buildingSize,
  contains,
  expansionError,
  isNoAuto,
  isPlaced,
  isTileUnlocked,
  jobSize,
  placeCtx,
  placementError,
  plotKey,
  plotOf,
  zoneAt,
} from "@/game/city/layout";
import { FEE_MOVE, FEE_RUSH_PER_10MIN, feeBuild, feeUpgrade, MINUTE } from "@/game/config";
import { PARK_DESCRIPTION, PARK_SIZE_LABELS, STATUE_DESCRIPTION, statueStageLabel } from "@/game/describe";
import { STATUE_RANK_LABELS } from "@/game/levels";
import type { Building } from "@/game/types";
import { fmt, yen } from "@/lib/api";
import type { ActiveView } from "@/server/view";
import { useGame } from "../GameProvider";
import { Button } from "../ui";

function CostLine({ cost, fee, treasury }: { cost: Cost; fee?: number; treasury?: boolean }) {
  const parts = [];
  if (cost.wood) parts.push(`木材${fmt(cost.wood)}`);
  if (cost.stone) parts.push(`石材${fmt(cost.stone)}`);
  if (treasury && cost.treasury) parts.push(`都市資金${fmt(cost.treasury)}`);
  if (fee) parts.push(`銀貨${fee}S`);
  return <span className="num text-xs text-muted">{parts.join("・") || "無料"}</span>;
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

/** 開拓していない土地：その区画（5×5 マス）を開拓する（docs/map-layout-redesign.md §7.3） */
function ExpandPanel({ v, tile }: { v: ActiveView; tile: { x: number; y: number } }) {
  const { act, busy } = useGame();
  const city = v.city;
  const silver = v.currencies.silver;
  const { px, py } = plotOf(tile.x, tile.y);
  const job = city.jobs.find((j) => j.kind === "expand" && j.plot === plotKey(px, py));
  const plots = v.dev.plots;
  if (job) {
    const fee = Math.max(1, Math.ceil(Math.max(0, job.finishAt - v.serverNow) / (10 * MINUTE))) * FEE_RUSH_PER_10MIN;
    return (
      <div className="space-y-2 text-sm">
        <p className="font-semibold">区画を開拓中</p>
        <p className="text-muted">
          {job.auto ? "自動開発による開拓" : "手動の開拓"}・完了まで約{Math.max(1, Math.ceil((job.finishAt - v.serverNow) / MINUTE))}分
        </p>
        <Button variant="gold" disabled={busy || silver < fee} onClick={() => act("/api/city", { type: "rush", jobId: job.id })}>
          すぐ完成させる（{fee}S）
        </Button>
      </div>
    );
  }
  const why = expansionError(city, px, py);
  const q = expandQuote(city);
  const ok = !why && city.stock.wood >= q.cost.wood && city.stock.stone >= q.cost.stone && silver >= q.fee;
  return (
    <div className="space-y-2 text-sm">
      <p>まだ開拓されていない土地です。5×5 マスの区画ごとに、資材を使って開拓できます。開拓すると区画の真ん中に十字の道路が通ります。</p>
      {plots && (
        <p className="text-xs text-muted">
          開拓できる区画 {plots.used} / {plots.limit}（発展Lvを上げると増えます）
        </p>
      )}
      {why ? (
        <p className="text-xs text-muted">{why}</p>
      ) : (
        <div className="rounded-lg bg-surface-2 p-2">
          <Button className="w-full" disabled={busy || !ok} onClick={() => act("/api/city", { type: "expand", x: tile.x, y: tile.y })}>
            この区画を開拓する（約{q.minutes}分）
          </Button>
          <div className="mt-1 text-center">
            <CostLine cost={q.cost} fee={q.fee} />
          </div>
        </div>
      )}
    </div>
  );
}

export function TilePanel({
  v,
  tile,
  moving,
  setMoving,
}: {
  v: ActiveView;
  tile: { x: number; y: number };
  moving: string | null;
  setMoving: (id: string | null) => void;
}) {
  const { act, busy } = useGame();
  const city = v.city;
  const silver = v.currencies.silver;
  const dev = v.dev.level;
  // 大きな建物は、占有範囲のどのマスを選んでもその建物
  const b = city.buildings.find((o) => isPlaced(o) && contains(o, buildingSize(o), tile.x, tile.y));
  const job = city.jobs.find((j) => contains(j, j.kind === "build" ? jobSize(j) : 1, tile.x, tile.y) && (j.kind === "build" || (j.x === tile.x && j.y === tile.y)));
  const zone = zoneAt(city, tile.x, tile.y);
  const cityAct = (body: Record<string, unknown>) => act("/api/city", body);
  const [showAll, setShowAll] = useState(false);

  // 林を押しのけて置いた公園・像と道路は、未開放の区画でも建物として見せる
  if (!b && !isTileUnlocked(city, tile.x, tile.y)) {
    return <ExpandPanel v={v} tile={tile} />;
  }

  const zoneControls = (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-sm">
      <label className="flex items-center gap-2 whitespace-nowrap">
        <span className="text-muted">土地用途</span>
        <select className="w-auto py-1 text-sm" value={zone} onChange={(e) => cityAct({ type: "zone", x: tile.x, y: tile.y, zone: e.target.value as Zone })}>
          {(Object.keys(ZONE_LABELS) as Zone[]).map((z) => (
            <option key={z} value={z}>
              {ZONE_LABELS[z]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 whitespace-nowrap">
        <input type="checkbox" className="w-auto" checked={isNoAuto(city, tile.x, tile.y)} onChange={(e) => cityAct({ type: "noAuto", x: tile.x, y: tile.y, noAuto: e.target.checked })} />
        自動建設を禁止
      </label>
    </div>
  );

  if (moving) {
    const target = city.buildings.find((o) => o.id === moving);
    const why = target ? placementError(city, target, tile.x, tile.y, placeCtx(city, target.id)) : "移動する建物が見つかりません";
    return (
      <div className="space-y-2 text-sm">
        <p>
          {target?.line ? tierDef(target.line, target.tier).name : target?.special ? SPECIAL_LABELS[target.special] : "建物"}の移動先を選んでください（銀貨{FEE_MOVE}S）。
        </p>
        <div className="flex gap-2">
          <Button disabled={busy || !!why} onClick={() => cityAct({ type: "move", buildingId: moving, x: tile.x, y: tile.y }).then(() => setMoving(null))}>
            ここへ移動
          </Button>
          <Button variant="secondary" onClick={() => setMoving(null)}>
            やめる
          </Button>
        </div>
        {why && <p className="text-xs text-muted">{why}</p>}
      </div>
    );
  }

  if (job && job.kind === "build") {
    const fee = Math.max(1, Math.ceil(Math.max(0, job.finishAt - v.serverNow) / (10 * MINUTE))) * FEE_RUSH_PER_10MIN;
    return (
      <div className="space-y-2 text-sm">
        <p className="font-semibold">{tierDef(job.line, job.tier).name}を建設中</p>
        <p className="text-muted">{job.auto ? "自動開発による工事" : "手動の工事"}・完了まで約{Math.max(1, Math.ceil((job.finishAt - v.serverNow) / MINUTE))}分</p>
        <Button variant="gold" disabled={busy || silver < fee} onClick={() => cityAct({ type: "rush", jobId: job.id })}>
          すぐ完成させる（{fee}S）
        </Button>
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
    const canUpgrade = b.line && b.level < v.dev.levelCap;
    const nextTier = b.line && b.tier + 1 < LINES[b.line].tiers.length ? b.tier + 1 : null;
    const evolveOk = b.line && nextTier !== null && isTierUnlocked(b.line, nextTier, city.techLevel, dev);
    const rushFee = bJob ? Math.max(1, Math.ceil(Math.max(0, bJob.finishAt - v.serverNow) / (10 * MINUTE))) * FEE_RUSH_PER_10MIN : 0;
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
          {b.locked && b.line && <p className="mt-1 text-xs">固定中：自動開発の対象外です</p>}
        </div>

        {bJob ? (
          <div className="space-y-2">
            <p className="text-muted">
              {bJob.kind === "evolve" ? `${tierDef(bJob.line, bJob.tier).name}へ進化中` : `Lv${bJob.level}へアップグレード中`}・残り約
              {Math.max(1, Math.ceil((bJob.finishAt - v.serverNow) / MINUTE))}分
            </p>
            <Button variant="gold" disabled={busy || silver < rushFee} onClick={() => cityAct({ type: "rush", jobId: bJob.id })}>
              すぐ完成させる（{rushFee}S）
            </Button>
          </div>
        ) : (
          b.line && (
            <div className="grid gap-2 sm:grid-cols-2">
              {evolveOk && nextTier !== null && (
                <div className="rounded-lg bg-surface-2 p-2">
                  <Button className="w-full" disabled={busy || silver < feeBuild(nextTier)} onClick={() => cityAct({ type: "evolve", buildingId: b.id })}>
                    {tierDef(b.line, nextTier).name}へ進化
                  </Button>
                  <div className="mt-1 text-center">
                    <CostLine cost={evolveCost(b.line, nextTier)} fee={feeBuild(nextTier)} />
                  </div>
                </div>
              )}
              <div className="rounded-lg bg-surface-2 p-2">
                <Button className="w-full" variant="secondary" disabled={busy || !canUpgrade || silver < feeUpgrade(b.level)} onClick={() => cityAct({ type: "upgrade", buildingId: b.id })}>
                  Lv{b.level + 1}にアップグレード
                </Button>
                <div className="mt-1 text-center">
                  {canUpgrade ? <CostLine cost={upgradeCost(b.line, b.tier, b.level)} fee={feeUpgrade(b.level)} /> : <span className="text-xs text-muted">発展Lvを上げると上限が上がります</span>}
                </div>
              </div>
            </div>
          )
        )}

        <div className="flex flex-wrap gap-2">
          {!bJob && (!b.locked || b.special) && (
            <Button variant="secondary" disabled={busy || silver < FEE_MOVE} onClick={() => setMoving(b.id)}>
              移動（{FEE_MOVE}S）
            </Button>
          )}
          {(b.line || b.special === "park" || b.special === "statue") && (
            <Button variant="ghost" disabled={busy} onClick={() => cityAct({ type: "lock", buildingId: b.id, locked: !b.locked })}>
              {b.locked ? "固定を解除" : "固定する"}
            </Button>
          )}
          {!bJob && (b.line || (b.special === "park" && b.closed)) && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`${name}を撤去しますか？`)) cityAct({ type: "demolish", buildingId: b.id });
              }}
            >
              撤去
            </Button>
          )}
        </div>
        {zoneControls}
      </div>
    );
  }

  // 空き地：建設メニュー。選んだマスを含む空きがあり、銀行までつながった道路に接するものだけ建てられる
  const ctx = placeCtx(city);
  const lines = LINE_IDS.map((line) => {
    const tier = highestUnlockedTier(line, city.techLevel, dev);
    const size = buildingSize({ line, tier });
    return { line, tier, size, why: tier >= 0 ? placementError(city, { line, tier }, tile.x, tile.y, ctx) : null };
  }).filter((x) => x.tier >= 0);
  const suggested = lines.filter((l) => LINES[l.line].zone === zone || LINES[l.line].zone === "any");
  const list = showAll || suggested.length === 0 ? lines : suggested;
  return (
    <div className="text-sm">
      <p className="mb-2 text-muted">
        空き地（{ZONE_LABELS[zone]}）。手動建設は資材と銀貨で支払います。
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map(({ line, tier, size, why }) => {
          const t = tierDef(line, tier);
          const fee = feeBuild(tier);
          const ok = !why && city.stock.wood >= t.cost.wood && city.stock.stone >= t.cost.stone && silver >= fee;
          return (
            <li key={line}>
              <button
                disabled={busy || !ok}
                onClick={() => cityAct({ type: "build", line: line as LineId, x: tile.x, y: tile.y })}
                className="flex w-full flex-col items-start rounded-lg border border-line bg-surface-2 px-3 py-2 text-left hover:border-accent disabled:opacity-45"
              >
                <span className="font-medium">
                  {t.name}
                  <span className="ml-1 text-xs text-muted">{LINES[line].label}</span>
                </span>
                <CostLine cost={t.cost} fee={fee} />
                {(why || size > 1) && <span className="text-xs text-muted">{why ?? `${size}×${size} マス`}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {suggested.length > 0 && suggested.length < lines.length && (
        <button onClick={() => setShowAll((s) => !s)} className="mt-2 text-xs underline">
          {showAll ? "この用途の建物だけ表示" : "ほかの用途の建物も表示"}
        </button>
      )}
      {zoneControls}
    </div>
  );
}
