"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Field, Modal, NumberInput } from "@/components/ui";
import { NEED_LABELS } from "@/game/city/init";
import { NEED_ORDER } from "@/game/types";
import { api, ApiError, yen } from "@/lib/api";

interface Overrun {
  monthKey: string;
  over: number;
}

export default function SettingsPage() {
  const router = useRouter();
  const { view, toast, busy, refresh } = useGame();
  const [budget, setBudget] = useState("");
  const [tz, setTz] = useState("");
  const [incomeDay, setIncomeDay] = useState("1");
  const [del, setDel] = useState(false);
  const [password, setPassword] = useState("");
  const [overruns, setOverruns] = useState<Overrun[]>([]);

  useEffect(() => {
    if (view) {
      setBudget(String(view.user.monthlyBudget));
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
            // 予算を下げてユーザ通貨が自由予算を超える月が出る場合は保存できない。超える月を表示する
            try {
              const day = Number(incomeDay);
              await api("/api/settings", {
                method: "PATCH",
                body: { monthlyBudget: Number(budget || 0), timezone: tz, ...(view && day !== view.user.incomeDay ? { incomeDay: day } : {}) },
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
          <Field label="月間自由予算（円）" hint="変更は今この時点からの配当額に反映されます。過去の配当分は変わりません。">
            <NumberInput value={budget} onValueChange={setBudget} />
          </Field>
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
              <p className="font-medium">この予算では、ユーザ通貨の発生額が自由予算を超える月があるため保存できません。</p>
              <ul className="num mt-1 text-xs">
                {overruns.map((o) => (
                  <li key={o.monthKey}>
                    {o.monthKey}：{yen(o.over)} 超過
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">通貨の画面で発生の量を減らしてから、もう一度保存してください。</p>
            </div>
          )}
          <Button type="submit" disabled={busy}>
            保存
          </Button>
        </form>
      </Card>

      <Card title="街の自動開発">
        <p className="mb-2 text-sm text-muted">街の建設・アップグレード・進化・区画の開拓は、すべて自動開発が行います。次の順に、街に足りないものから対応します。</p>
        <ol className="space-y-1">
          {NEED_ORDER.map((n, i) => (
            <li key={n} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-sm">
              <span className="num w-5 text-muted">{i + 1}</span>
              <span className="flex-1">{NEED_LABELS[n]}</span>
            </li>
          ))}
        </ol>
      </Card>

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
            <dd className="text-muted">街は内部経済（人口・生産・都市資金）にしたがって、自動開発だけで発展します。金貨・銀貨を使わなくても育ち、資源の交換や工事の即時完了で速くなります。</dd>
          </div>
          <div>
            <dt className="font-semibold">技術Lvの上げ方</dt>
            <dd className="text-muted">
              貯金額（債券 ＋ ゲーム内で使った金貨）だけで上がります。金貨はゲーム内で使っても現実のお金は出ていかないので、ゲーム内で使った分はそのまま貯金になります。このシーズンの貯金額の最高到達額で決まり、債券を使っても下がりません。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">金貨と銀貨</dt>
            <dd className="text-muted">
              金貨は自由予算から時間で配当され（1G＝1円相当）、購入はユーザ通貨・金貨の順に精算されます。銀貨は記録の報酬で、工事の即時完了や資源交換の手数料に使います。どちらもゲーム内の通貨で、換金はできません。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">債券とユーザ通貨</dt>
            <dd className="text-muted">
              債券は急な出費に備えるお金です。金貨が足りない購入を肩代わりし（使った額の10%・上限50Sの銀貨の手数料がかかります）、持っているほど街の時間発展が速くなります（最大1.5倍）。
              ユーザ通貨は「食費コイン」のように、自由予算の一部を決まったジャンルの購入用に分けたものです。その分は金貨の配当から差し引かれます。
            </dd>
          </div>
          <div>
            <dt className="font-semibold">目標を達成すると</dt>
            <dd className="text-muted">確認のうえ完了すると街が完成し、タイムラプスで成長を振り返れます。次の目標では新しい街をゼロから始めます（家計の記録は残ります）。</dd>
          </div>
          {view && <div className="text-xs text-muted">現在の自由予算：{yen(view.user.monthlyBudget)}</div>}
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
