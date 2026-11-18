"use client";

import { useEffect, useRef, useState } from "react";
import { AccountsCard } from "../AccountsCard";
import { useGame } from "../GameProvider";
import { Button, Card, Field, LinkButton, NumberInput } from "../ui";
import { BOND_CAP_MONTHS } from "@/game/config";
import { splitCarried } from "@/game/bond";
import { reserveLevel } from "@/game/fund";
import { api, fmt, formatDate, yen } from "@/lib/api";

/** 開始画面の初期値（GET /api/season/draft。docs/season-start-settings.md §11.3） */
interface Draft {
  first: boolean;
  number: number;
  incomeDayNow: boolean;
  period: { start: number; end: number };
  prorated: number;
  net: number;
  bondCap: number;
  previous: { id: string; number: number; goalName: string | null; amount: number } | null;
  savingsAccounts: number;
}

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const GOAL_NAME_MAX = 20;

/** Phase 1：シーズン開始時の設定（docs/season-start-settings.md）。必須は月間自由予算と貯金目標だけ */
export function Onboarding() {
  const { view, act, busy } = useGame();
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [budget, setBudget] = useState(String(view?.user.monthlyBudget || ""));
  const [incomeDay, setIncomeDay] = useState(String(view?.user.incomeDay ?? 1));
  const [remaining, setRemaining] = useState("");
  const [existing, setExisting] = useState("");
  const [carry, setCarry] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // すでにある貯金の欄を自分で触ったら、初期値で上書きしない
  const touched = useRef(false);
  const again = view?.hasArchive;

  // 按分の額・期間の残りは、入力中の予算と収入日で出し直す（RB-02・PD-04）
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const q = new URLSearchParams({ incomeDay });
        if (budget) q.set("budget", budget);
        const d = await api<Draft>(`/api/season/draft?${q}`);
        if (live) setDraft(d);
      } catch {
        // 入力の途中（範囲外など）は前の値のままにする
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [budget, incomeDay, reloadKey]);

  // すでにある貯金の初期値：前の街の貯金、なければ貯金用の置き場所の残高の合計（CO-01・RC-03）
  const previous = draft?.previous ?? null;
  const suggested = previous ? (carry ? previous.amount : 0) : (draft?.savingsAccounts ?? 0);
  useEffect(() => {
    if (!touched.current && draft) setExisting(suggested > 0 ? String(suggested) : "");
  }, [draft, suggested]);

  const b = Number(budget || 0);
  const cap = b * BOND_CAP_MONTHS;
  const split = splitCarried(Number(existing || 0), b);
  const startReserve = reserveLevel(split.reserve, b);
  const daysLeft = draft ? Math.max(1, Math.ceil((draft.period.end - Date.now()) / 86_400_000)) : null;
  const rem = remaining === "" ? null : Number(remaining);
  const remOver = rem !== null && rem > b;
  const gold = rem ?? draft?.prorated ?? null;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">{again ? "新しい街をはじめる" : "ようこそ、Cité de Tirelire へ"}</h1>
        <p className="mt-2 text-sm text-muted">
          現実の貯金目標を1つ決めると、小さな集落から新しい街が始まります。目標を達成するとその街は完成し、成長の記録をタイムラプスで振り返れます。
        </p>
      </div>
      <form
        id="season-start"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          act("/api/season", {
            goalAmount: Number(goal),
            goalName: name,
            monthlyBudget: b,
            incomeDay: Number(incomeDay),
            ...(rem !== null ? { remainingBudget: rem } : {}),
            existingSavings: Number(existing || 0),
            carryOver: !!previous && carry,
          });
        }}
      >
        <Card title="目標">
          <div className="space-y-4">
            <Field label="目標の名前（任意）" hint="何のための貯金かを書いておくと、街とタイムラプスの題になります。あとから変えられます。">
              <input value={name} maxLength={GOAL_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="例：北海道旅行" />
            </Field>
            <Field label="今回の貯金目標（円）" hint="今の預金残高ではなく、これから新しく貯める金額。">
              <NumberInput required value={goal} onValueChange={setGoal} placeholder="100000" />
            </Field>
          </div>
        </Card>

        <Card title="毎月のお金">
          <div className="space-y-4">
            <Field label="月間自由予算（円）" hint="固定費や予定している貯金を除いた、毎月自由に使える金額。銀行がこの額を1か月かけて金貨に変えます。">
              <NumberInput required value={budget} onValueChange={setBudget} placeholder="60000" />
            </Field>
            <Field
              label="毎月の収入が入る日"
              hint={
                draft && !draft.incomeDayNow
                  ? "この日から翌月のこの日の前日までを1か月として数えます。変更は次の収入日から反映されます。"
                  : "この日から翌月のこの日の前日までを1か月として数えます。その月にない日（31日など）は月末になります。"
              }
            >
              <select value={incomeDay} onChange={(e) => setIncomeDay(e.target.value)}>
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    毎月{d}日
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="今期の残りの自由予算（円・任意）"
              hint={
                draft
                  ? `次の収入日（${formatDate(draft.period.end, tz)}）まで あと${daysLeft}日。入れなければ、残りの日数で割った ${yen(draft.prorated)} が配当されます。もう多く使った・まだあまり使っていないときは、実際の残りを入れてください。`
                  : "次の収入日までに自由に使える額。入れなければ、残りの日数で割った額が配当されます。"
              }
            >
              <NumberInput value={remaining} onValueChange={setRemaining} placeholder={draft ? String(draft.prorated) : ""} />
            </Field>
            {remOver && <p className="text-xs text-danger">今期の残りは月間自由予算（{yen(b)}）までの額を入れてください。</p>}
          </div>
        </Card>

        <Card title="すでにある貯金（任意）">
          <div className="space-y-3">
            {previous && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="w-auto"
                  checked={carry}
                  onChange={(e) => {
                    touched.current = false;
                    setCarry(e.target.checked);
                  }}
                />
                前の街（{previous.goalName ?? `シーズン${previous.number}`}）までの貯金 {yen(previous.amount)} を持ち越す
              </label>
            )}
            <Field
              label="すでにある貯金（円）"
              hint="今ある貯金を入れると、もしもの備えとして街に持ち込めます。目標の達成率・技術Lv・建設資金には数えません（街はこれから貯めた分で育ちます）。前の街の目標に使った分があれば引いてください。"
            >
              <NumberInput
                value={existing}
                onValueChange={(v) => {
                  touched.current = true;
                  setExisting(v);
                }}
                placeholder="0"
              />
            </Field>
            {!previous && draft && draft.savingsAccounts > 0 && Number(existing || 0) !== draft.savingsAccounts && (
              <button
                type="button"
                className="text-xs underline"
                onClick={() => {
                  touched.current = true;
                  setExisting(String(draft.savingsAccounts));
                }}
              >
                貯金用の置き場所の残高 {yen(draft.savingsAccounts)} を入れる
              </button>
            )}
            {Number(existing || 0) > 0 && b > 0 && (
              <dl className="num grid grid-cols-[1fr_auto] gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <dt className="text-muted">持ち込みの備え（自由予算の{BOND_CAP_MONTHS}か月分 {yen(cap)} まで）</dt>
                <dd className="text-right">{yen(split.reserve)}</dd>
                {split.savings > 0 && (
                  <>
                    <dt className="text-muted">それを超える分（持ち込みの貯金）</dt>
                    <dd className="text-right">{yen(split.savings)}</dd>
                  </>
                )}
              </dl>
            )}
            <p className="text-xs text-muted">
              持ち込みの備えは、悪い出来事から街を守る備えLvに数えます。使い過ぎたときは、この範囲までは借金として扱いません（配当の強制の債券化が起きません）。使い過ぎの手数料と、貯金額が減るのは同じです。
            </p>
          </div>
        </Card>
      </form>

      {/* 置き場所の登録は別のフォーム（開始のフォームの外に置く） */}
      <AccountsCard
        tz={tz}
        onChange={() => setReloadKey((k) => k + 1)}
        note="任意：口座・財布の今の残高と、クレカの今の未払いを入れておくと、最初の日から残高が合います。飛ばして、あとで設定から登録することもできます。"
      />

      <Card>
        <ul className="mb-3 space-y-1 text-sm">
          {gold !== null && daysLeft !== null && (
            <li>
              今期の残り {daysLeft}日で <span className="num font-semibold">{fmt(gold)}G</span> が配当されます。
            </li>
          )}
          <li>
            {startReserve > 0 ? (
              <>
                備えLv<span className="num font-semibold">{startReserve}</span> から始まります。
              </>
            ) : (
              "備えLv0 から始まります（債券を貯めると上がります）。"
            )}
          </li>
        </ul>
        <Button type="submit" form="season-start" className="w-full" disabled={busy || !goal || Number(goal) < 1000 || !budget || remOver}>
          街をつくる
        </Button>
      </Card>
      {again && (
        <LinkButton href="/timelapse" className="w-full">
          完成した街のタイムラプスを見る
        </LinkButton>
      )}
    </div>
  );
}
