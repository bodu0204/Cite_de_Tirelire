"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import type { ActiveView, GameView } from "@/server/view";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "reward";
}

interface GameContextValue {
  view: GameView | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** 変更系 API を呼び、成功したら状態を取り直す */
  act: <T = unknown>(path: string, body?: unknown, method?: string) => Promise<T | null>;
  toast: (text: string, tone?: Toast["tone"]) => void;
  busy: boolean;
  /** 端末時刻で状態を受け取った時刻 */
  receivedAt: number;
}

const GameContext = createContext<GameContextValue | null>(null);

export function useGame() {
  const v = useContext(GameContext);
  if (!v) throw new Error("useGame must be used inside GameProvider");
  return v;
}

/** 進行中のシーズンがある状態（ホーム以外の施設画面用） */
export function useSeasonView(): ActiveView | null {
  const { view } = useGame();
  return view && "city" in view ? view : null;
}

export function GameProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [view, setView] = useState<GameView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [receivedAt, setReceivedAt] = useState(0);
  const seq = useRef(0);

  const toast = useCallback((text: string, tone: Toast["tone"] = "info") => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setView(await api<GameView>("/api/state"));
      setReceivedAt(Date.now());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace("/login");
        return;
      }
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    }
  }, [router]);

  const act = useCallback(
    async <T,>(path: string, body?: unknown, method?: string): Promise<T | null> => {
      setBusy(true);
      try {
        const result = await api<T>(path, { method: method ?? "POST", body: body ?? {} });
        await refresh();
        return result;
      } catch (e) {
        toast(e instanceof Error ? e.message : "エラーが発生しました", "error");
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast, router],
  );

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return (
    <GameContext.Provider value={{ view, error, refresh, act, toast, busy, receivedAt }}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rise pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm shadow-lg ${
              t.tone === "error" ? "bg-danger text-white" : t.tone === "reward" ? "bg-gold text-[#2b2620]" : "bg-ink text-bg"
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </GameContext.Provider>
  );
}
