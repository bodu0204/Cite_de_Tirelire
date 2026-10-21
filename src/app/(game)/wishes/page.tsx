"use client";

import { useState } from "react";
import { drawBuilding } from "@/components/city/draw";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Empty, Field, Gauge, Modal } from "@/components/ui";
import { statueStage } from "@/game/city/actions";
import { STATUE_DESCRIPTION, statueStageLabel } from "@/game/describe";
import { STATUE_RANK_LABELS, statueRank } from "@/game/levels";
import { fmt, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface Wish {
  id: string;
  name: string;
  price: number;
  priority: number;
  memo: string | null;
  purchasedAt: string | null;
  reserved: number;
}

const PRIORITY = ["", "高", "中", "低"];
const RANKS = ["bronze", "silver", "gold"] as const;

function StatueIcon({ w }: { w: Wish }) {
  return (
    <canvas
      width={16}
      height={16}
      aria-hidden
      className="pixelated h-12 w-12 shrink-0 rounded-md bg-[#66bb6a]"
      ref={(c) => {
        const ctx = c?.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, 16, 16);
        const stage = statueStage({ id: w.id, name: w.name, price: w.price, progress: w.reserved / w.price, purchased: !!w.purchasedAt });
        drawBuilding(ctx, { id: w.id, special: "statue", tier: RANKS.indexOf(statueRank(w.price)), level: stage, x: 0, y: 0 }, 0, 0, 1, 0);
      }}
    />
  );
}

/** 像の状態の1行説明 */
function StatueLine({ w, where }: { w: Wish; where?: { x: number; y: number } }) {
  const stage = statueStage({ id: w.id, name: w.name, price: w.price, progress: w.reserved / w.price, purchased: !!w.purchasedAt });
  return (
    <p className="mt-1 rounded-md bg-surface-2 px-2 py-1 text-xs">
      <span className="font-medium">{w.name}の像</span>
      <span className="text-muted">
        {" ・ "}
        {STATUE_RANK_LABELS[statueRank(w.price)]} ・ {statueStageLabel(stage)}
        {where && ` ・ ${where.x >= 0 ? `マス(${where.x + 1}, ${where.y + 1})` : "置く場所の空き待ち"}`}
        {!w.purchasedAt && stage < 4 && ` ・ 次の段階まであと${fmt(Math.max(0, Math.ceil(((stage + 1) * w.price) / 4) - w.reserved))}G`}
      </span>
    </p>
  );
}

function WishForm({ initial, onDone }: { initial?: Wish; onDone: () => void }) {
  const { act, busy, toast } = useGame();
  const [f, setF] = useState({ name: initial?.name ?? "", price: initial ? String(initial.price) : "", priority: String(initial?.priority ?? 2), memo: initial?.memo ?? "" });
  const price = Number(f.price || 0);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...f, price, priority: Number(f.priority) };
        const r = initial ? await act<{ returned?: number }>(`/api/wishes/${initial.id}`, body, "PATCH") : await act("/api/wishes", body);
        if (r) {
          const returned = (r as { returned?: number }).returned ?? 0;
          if (returned > 0) toast(`価格を超えていた積立 ${fmt(returned)}G を所持金貨に戻しました`);
          if (!initial) setF({ name: "", price: "", priority: "2", memo: "" });
          onDone();
        }
      }}
    >
      <Field label="商品名">
        <input required maxLength={100} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="価格（円）" hint={price > 0 ? `${STATUE_RANK_LABELS[statueRank(price)]}になります` : undefined}>
          <input inputMode="numeric" required value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/\D/g, "") })} />
        </Field>
        <Field label="購入優先度">
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            <option value="1">高</option>
            <option value="2">中</option>
            <option value="3">低</option>
          </select>
        </Field>
      </div>
      <Field label="メモ（任意）">
        <input maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      </Field>
      <Button type="submit" className="w-full" disabled={busy || !f.name.trim() || price <= 0}>
        {initial ? "保存" : "ほしい物を追加"}
      </Button>
    </form>
  );
}

export default function WishesPage() {
  const { act, toast, busy } = useGame();
  const v = useSeasonView();
  const { items, reload } = useList<Wish>("/api/wishes");
  const [edit, setEdit] = useState<Wish | null>(null);
  const [fund, setFund] = useState<Wish | null>(null);
  const [amount, setAmount] = useState("");
  const gold = v?.currencies.gold ?? 0;

  // 積立の入力チェック：価格を超える積立・所持金貨を超える積立・積立額を超える取消はできない
  const remaining = fund ? Math.max(0, fund.price - fund.reserved) : 0;
  const fundAmount = amount === "" || amount === "-" ? NaN : Number(amount);
  const fundError = !fund || !Number.isInteger(fundAmount) || fundAmount === 0
    ? null
    : fundAmount > 0 && fundAmount > remaining
      ? remaining > 0
        ? `積み立てられるのはあと ${fmt(remaining)}G までです（価格 ${yen(fund.price)}）`
        : "積立はすでに価格に達しています"
      : fundAmount > 0 && fundAmount > gold
        ? `所持金貨が足りません（所持 ${fmt(gold)}G）`
        : fundAmount < 0 && -fundAmount > fund.reserved
          ? `取り消せるのは積立済みの ${fmt(fund.reserved)}G までです`
          : null;

  const statueAt = (id: string) => v?.city.buildings.find((b) => b.special === "statue" && b.refId === id);
  const open = items?.filter((w) => !w.purchasedAt) ?? [];
  const done = items?.filter((w) => w.purchasedAt) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">ほしい物リスト</h1>
        <p className="mt-1 text-sm text-muted">
          ほしい物は街の像になります。金貨を少しずつ積み立てると像が育ち、実際に購入を記録すると完成します。積立は現実の預金ではなく、ゲーム内の予約です。
        </p>
      </div>
      <Card title="追加する">
        <WishForm onDone={reload} />
      </Card>
      <Card title="計画中の像">
        <p className="mb-3 text-xs text-muted">{STATUE_DESCRIPTION}</p>
        {open.length === 0 ? (
          <Empty>ほしい物はまだありません</Empty>
        ) : (
          <ul className="space-y-3">
            {open.map((w) => (
              <li key={w.id} className="flex items-center gap-3">
                <StatueIcon w={w} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium">{w.name}</span>
                    <span className="num shrink-0 text-sm">{yen(w.price)}</span>
                  </div>
                  <Gauge value={w.reserved} max={w.price} color="var(--gold)" label={`${w.name}の積立`} />
                  <StatueLine w={w} where={statueAt(w.id)} />
                  {w.memo && <p className="mt-1 text-xs whitespace-pre-wrap break-words">メモ：{w.memo}</p>}
                  <div className="mt-0.5 flex justify-between text-xs text-muted">
                    <span>
                      優先度{PRIORITY[w.priority]} ・ 積立 {fmt(w.reserved)}G（{Math.floor((w.reserved / w.price) * 100)}%）
                    </span>
                    <span className="flex gap-2">
                      <button className="underline" disabled={!v} onClick={() => (setFund(w), setAmount(""))}>
                        積立
                      </button>
                      <button className="underline" onClick={() => setEdit(w)}>
                        編集
                      </button>
                      <button
                        className="text-danger underline"
                        onClick={async () => {
                          if (!confirm(`${w.name}を削除しますか？積立済みの金貨は戻ります。`)) return;
                          if (await act(`/api/wishes/${w.id}`, undefined, "DELETE")) reload();
                        }}
                      >
                        削除
                      </button>
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">積立が価格に達すると、銀鉱の「支出」にこのほしい物が並びます。購入したらそこで保存してください。積立済みの金貨が価格の精算に充てられ、価格より安く買えた分は債券 → おまかせ交換に回ります。</p>
      </Card>
      {done.length > 0 && (
        <Card title="完成した像">
          <ul className="space-y-2">
            {done.map((w) => (
              <li key={w.id} className="flex items-center gap-3 text-sm">
                <StatueIcon w={w} />
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{w.name}</span>
                    <span className="num text-muted">{yen(w.price)}</span>
                  </div>
                  <StatueLine w={w} where={statueAt(w.id)} />
                  {w.memo && <p className="mt-1 text-xs whitespace-pre-wrap break-words">メモ：{w.memo}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title="ほしい物を編集">
        {edit && <WishForm key={edit.id} initial={edit} onDone={() => (setEdit(null), reload())} />}
      </Modal>
      <Modal open={!!fund} onClose={() => setFund(null)} title={`${fund?.name ?? ""}に金貨を積み立てる`}>
        {fund && (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = Number(amount);
              const r = await act(`/api/wishes/${fund.id}/contribute`, { amount: n });
              if (r) {
                toast(n > 0 ? `${fmt(n)}G を積み立てました` : `${fmt(-n)}G を取り消しました`);
                setFund(null);
                reload();
              }
            }}
          >
            <p className="text-sm text-muted">
              所持金貨 {fmt(gold)}G ・ 積立済み {fmt(fund.reserved)}G ・ 残り {fmt(remaining)}G
            </p>
            <Field label="金貨（取り消す場合はマイナス）">
              <input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d-]/g, ""))} placeholder="1000" />
            </Field>
            {fundError && (
              <p role="alert" className="text-sm text-danger">
                {fundError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" disabled={remaining <= 0 || gold <= 0} onClick={() => setAmount(String(Math.max(0, Math.min(gold, remaining))))}>
                残りを全部
              </Button>
              {fund.reserved > 0 && (
                <Button type="button" variant="secondary" onClick={() => setAmount(String(-fund.reserved))}>
                  全額取り消し
                </Button>
              )}
            </div>
            <Button type="submit" variant="gold" className="w-full" disabled={busy || !Number.isInteger(fundAmount) || fundAmount === 0 || !!fundError}>
              確定
            </Button>
          </form>
        )}
      </Modal>
    </div>
  );
}
