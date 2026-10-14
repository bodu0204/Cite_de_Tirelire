"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useGame, useSeasonView } from "@/components/GameProvider";
import { Button, Card, Field, Modal } from "@/components/ui";
import { NEED_LABELS, POLICY_PRESETS } from "@/game/city/init";
import type { NeedKey } from "@/game/types";
import { api, yen } from "@/lib/api";

export default function SettingsPage() {
  const router = useRouter();
  const { view, act, toast, busy } = useGame();
  const v = useSeasonView();
  const [budget, setBudget] = useState("");
  const [tz, setTz] = useState("");
  const [del, setDel] = useState(false);
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (view) {
      setBudget(String(view.user.monthlyBudget));
      setTz(view.user.timezone);
    }
  }, [view]);

  const policy = v?.city.policy;
  const move = (i: number, d: -1 | 1) => {
    if (!policy) return;
    const p = [...policy.priorities];
    const j = i + d;
    if (j < 0 || j >= p.length) return;
    [p[i], p[j]] = [p[j], p[i]];
    act("/api/city", { type: "policy", priorities: p });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="font-pixel text-2xl">設定</h1>

      <Card title="家計">
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await act("/api/settings", { monthlyBudget: Number(budget || 0), timezone: tz }, "PATCH")) toast("保存しました");
          }}
        >
          <Field label="月間自由予算（円）" hint="変更は今この時点からの採掘量に反映されます。過去の採掘分は変わりません。">
            <input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, ""))} />
          </Field>
          <Field label="タイムゾーン" hint="月の区切りと記録日の判定に使います。">
            <input value={tz} onChange={(e) => setTz(e.target.value)} placeholder="Asia/Tokyo" />
          </Field>
          <Button type="submit" disabled={busy}>
            保存
          </Button>
        </form>
      </Card>

      {policy && (
        <Card title="街の自動開発">
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-auto" checked={policy.autoEnabled} onChange={(e) => act("/api/city", { type: "policy", autoEnabled: e.target.checked })} />
            自動開発を有効にする（無効にすると建設・アップグレードは手動だけになります）
          </label>
          <div className="mb-3 flex flex-wrap gap-2">
            {(Object.keys(POLICY_PRESETS) as (keyof typeof POLICY_PRESETS)[]).map((k) => (
              <Button key={k} variant={policy.preset === k ? "primary" : "secondary"} disabled={busy} onClick={() => act("/api/city", { type: "policy", preset: k })}>
                {POLICY_PRESETS[k].label}
              </Button>
            ))}
          </div>
          <p className="mb-2 text-sm text-muted">優先順位（上ほど先に対応します）</p>
          <ol className="space-y-1">
            {policy.priorities.map((n: NeedKey, i: number) => (
              <li key={n} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-sm">
                <span className="num w-5 text-muted">{i + 1}</span>
                <span className="flex-1">{NEED_LABELS[n]}</span>
                <button aria-label="上へ" className="px-2 disabled:opacity-30" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                  ▲
                </button>
                <button aria-label="下へ" className="px-2 disabled:opacity-30" disabled={busy || i === policy.priorities.length - 1} onClick={() => move(i, 1)}>
                  ▼
                </button>
              </li>
            ))}
          </ol>
        </Card>
      )}

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
            <dd className="text-muted">街は内部経済（人口・生産・都市資金）で自動的に発展します。金貨・銀貨を使わなくても育ち、手動で建てると速くなります。</dd>
          </div>
          <div>
            <dt className="font-semibold">技術Lvの上げ方</dt>
            <dd className="text-muted">現実の貯金を記録したときだけ上がります。このシーズンの貯金純増額の最高到達額で決まり、引出しても下がりません。</dd>
          </div>
          <div>
            <dt className="font-semibold">金貨と銀貨</dt>
            <dd className="text-muted">
              金貨は自由予算から時間で採掘され（1G＝1円相当）、購入はまず金貨で精算されます。銀貨は記録の報酬で、手動操作の手数料に使います。どちらもゲーム内の通貨で、換金はできません。
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
