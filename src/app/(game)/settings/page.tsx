"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { AccountsCard } from "@/components/AccountsCard";
import { Button, Card, Field, Modal, NumberInput } from "@/components/ui";
import { api, ApiError, yen } from "@/lib/api";

interface Overrun {
  monthKey: string;
  over: number;
}

export default function SettingsPage() {
  const router = useRouter();
  const { view, toast, busy, refresh } = useGame();
  const [income, setIncome] = useState("");
  const [tz, setTz] = useState("");
  const [incomeDay, setIncomeDay] = useState("1");
  const [del, setDel] = useState(false);
  const [password, setPassword] = useState("");
  const [overruns, setOverruns] = useState<Overrun[]>([]);

  useEffect(() => {
    if (view) {
      setIncome(String(view.user.monthlyIncome));
      setTz(view.user.timezone);
      setIncomeDay(String(view.user.incomeDay));
    }
  }, [view]);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="font-pixel text-2xl">設定</h1>

      <Card title="家計">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            // 手取り月収を下げて、固定費・サブスク・ユーザ通貨の合計が手取り月収を超える月が出る場合は保存できない。超える月を表示する
            try {
              const day = Number(incomeDay);
              await api("/api/settings", {
                method: "PATCH",
                body: { monthlyIncome: Number(income || 0), timezone: tz, ...(view && day !== view.user.incomeDay ? { incomeDay: day } : {}) },
              });
              setOverruns([]);
              await refresh();
              toast("保存しました");
            } catch (err) {
              const details = err instanceof ApiError ? (err.details as { overruns?: Overrun[] } | undefined) : undefined;
              setOverruns(details?.overruns ?? []);
              toast(err instanceof Error ? err.message : "保存できませんでした", "error");
            }
          }}
        >
          <Field
            label="手取り月収（円）"
            hint="毎月、口座に入る金額（手取り）。ボーナスなど毎月でない収入は含めません（臨時の収入として記録します）。月によって変わる人は、少ない月の額を入れてください。変更は今この時点からの配当額に反映されます。過去の配当分は変わりません。"
          >
            <NumberInput value={income} onValueChange={setIncome} />
          </Field>
          {view && (
            <p className="num rounded-lg bg-surface-2 px-3 py-2 text-sm">
              自由予算 <span className="font-semibold">{yen(Math.max(0, Number(income || 0) - view.budget.fixed))}</span> ＝ 手取り月収 {yen(Number(income || 0))} − 固定費 {yen(view.budget.fixed)}（{view.budget.fixedCount}件）
              <Link href="/subscriptions" className="ml-2 text-xs underline">
                固定費・サブスクを登録
              </Link>
            </p>
          )}
          <Field
            label="毎月の収入が入る日"
            hint="この日を基準に月の収入の配当（金貨・ユーザ通貨）が発生し、この日から翌月のこの日の前日までを1か月として数えます。その月にない日（31日など）は月末になります。変更は次の収入日から反映され、今の期間はそこまで延びるか縮みます。"
          >
            <select value={incomeDay} onChange={(e) => setIncomeDay(e.target.value)}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  毎月{d}日
                </option>
              ))}
            </select>
          </Field>
          <Field label="タイムゾーン" hint="月の区切りと記録日の判定に使います。">
            <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Tokyo" />
          </Field>
          {overruns.length > 0 && (
            <div className="rounded-lg bg-danger/10 px-3 py-2 text-sm">
              <p className="font-medium">この手取り月収では、固定費・サブスク・ユーザ通貨の合計が手取り月収を超える月があるため保存できません。</p>
              <ul className="num mt-1 text-xs">
                {overruns.map((o) => (
                  <li key={o.monthKey}>
                    {o.monthKey}：{yen(o.over)} 超過
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">通貨の画面で発生の量を減らすか、固定費・サブスクを見直してから、もう一度保存してください。</p>
            </div>
          )}
          <Button type="submit" disabled={busy}>
            保存
          </Button>
        </form>
      </Card>

      <AccountsCard tz={view?.user.timezone ?? "Asia/Tokyo"} />

      <Card title="データ">
        <div className="flex flex-wrap gap-2">
          <a href="/api/export" className="inline-flex min-h-10 items-center rounded-lg border border-line bg-surface-2 px-3.5 text-sm">
            家計・ゲーム履歴をエクスポート（JSON）
          </a>
          <Button
            variant="secondary"
            onClick={async () => {
              await api("/api/auth/logout", { body: {} });
              router.replace("/login");
            }}
          >
            ログアウト
          </Button>
          <Button variant="danger" onClick={() => setDel(true)}>
            アカウントを削除
          </Button>
        </div>
        {view && <p className="mt-3 text-xs text-muted">ログイン中：{view.user.email}</p>}
      </Card>

      <Card title="ヘルプ">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-semibold">街はどう育つ？</dt>
            <dd className="text-muted">街は自分では稼ぎません。使わなかったお金（債券に入れた金貨や、建設資金に替えた金貨）が建設資金になり、その分だけ工事が進みます。貯めた分は放っておいても数時間〜数日かけて形になります。シーズンの最初の2週間は、貯金が最大2倍の建設資金になります。</dd>
          </div>
          <div>
            <dt className="font-semibold">技術Lvの上げ方</dt>
            <dd className="text-muted">
              貯金額（債券 ＋ ゲーム内で使った金貨）だけで上がります。金貨はゲーム内で使っても現実のお金は出ていかないので、ゲーム内で使った分はそのまま貯金になります。このシーズンの貯金額の最高到達額で決まり、債券を使っても下がりません。
              技術Lvが上がると新しい時代になり、3日間は建て替えが無料になって、街の建物が一斉に新しくなります。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">街を広げるには</dt>
            <dd className="text-muted">
              こまめに貯金するほど街は広くなります。その日の配当を使い切らずに貯金が出た日が「貯金した日」として自動で数えられ（何かを確定する必要はありません）、最初の7日は1日ごとに、そのあとは4日ごとに、開拓できる区画が1つ増えます。毎日の予算を使い切ってまとめて貯めるより、毎日少しずつ残すほうが広くなります。発展Lvが上がっても区画は増えます。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">金貨と銀貨</dt>
            <dd className="text-muted">
              金貨は自由予算（手取り月収 − 固定費）から時間で配当され（1G＝1円相当）、購入はユーザ通貨・金貨の順に精算されます。銀貨は記録の報酬で、悪い出来事の修繕、建物の装飾・命名（マスを選ぶと出ます）、タイムラプスの花火、手数料などに使います。債券（もしもの備え）を増やすと、備えLvごとに銀行のそばに防災倉庫・消防署・避難公園・銀行の金庫が建ちます。どちらもゲーム内の通貨で、換金はできません。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">債券とユーザ通貨</dt>
            <dd className="text-muted">
              債券は急な出費に備えるお金です。金貨が足りない購入を肩代わりし（使った額の10%・上限50Sの銀貨の手数料がかかります）、持っている間は残高の0.3%が毎日、利息として建設資金に入ります（上限は手取り月収の3か月分）。
              ユーザ通貨は「食費コイン」のように、自由予算の一部を決まったジャンルの購入用に分けたものです。その分は金貨の配当から差し引かれます。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">目標を達成すると</dt>
            <dd className="text-muted">確認のうえ完了すると街が完成し、タイムラプスで成長を振り返れます。次の目標では新しい街をゼロから始めます（家計の記録は残ります）。</dd>
          </div>
          {view && (
            <div className="text-xs text-muted">
              現在の手取り月収：{yen(view.budget.income)}・固定費：{yen(view.budget.fixed)}・自由予算：{yen(view.budget.free)}
            </div>
          )}
        </dl>
      </Card>

      <Modal open={del} onClose={() => setDel(false)} title="アカウントを削除">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/api/account", { body: { password } });
              router.replace("/signup");
            } catch (err) {
              toast(err instanceof Error ? err.message : "削除できませんでした", "error");
            }
          }}
        >
          <p className="text-sm">購入・貯金の記録、サブスク、ほしい物、すべての街とタイムラプスが完全に削除されます。元に戻せません。</p>
          <Field label="確認のためパスワードを入力">
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="danger" className="w-full">
            完全に削除する
          </Button>
        </form>
      </Modal>
    </div>
  );
}
