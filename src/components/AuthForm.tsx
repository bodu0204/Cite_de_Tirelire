"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Field } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === "signup";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api(`/api/auth/${mode}`, { body: { email, password, timezone } });
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "エラーが発生しました");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 font-pixel text-3xl">Cité de Tirelire</h1>
      <p className="mb-8 text-sm text-muted">節約と貯金で、街が育つ。</p>
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-5">
        <h2 className="font-pixel text-lg">{signup ? "はじめる" : "ログイン"}</h2>
        <Field label="メールアドレス">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="パスワード" hint={signup ? "8文字以上" : undefined}>
          <input
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            required
            minLength={signup ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {signup ? "アカウントを作成" : "ログイン"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        {signup ? (
          <>
            アカウントをお持ちの方は <Link href="/login" className="underline">ログイン</Link>
          </>
        ) : (
          <>
            はじめての方は <Link href="/signup" className="underline">アカウント作成</Link>
          </>
        )}
      </p>
    </main>
  );
}
