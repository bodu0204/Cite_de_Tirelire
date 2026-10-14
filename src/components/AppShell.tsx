"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { fmt } from "@/lib/api";
import { useGame } from "./GameProvider";
import { Coin } from "./ui";

const NAV = [
  { href: "/", label: "街", icon: "🏘" },
  { href: "/records", label: "銀鉱・記録", short: "記録", icon: "⛏" },
  { href: "/gold", label: "金鉱", icon: "✦" },
  { href: "/bank", label: "銀行", icon: "🏦" },
  { href: "/exchange", label: "資源交換", short: "交換", icon: "⇄" },
  { href: "/wishes", label: "ほしい物", icon: "🗿" },
  { href: "/subscriptions", label: "サブスク", icon: "🌳" },
  { href: "/timelapse", label: "タイムラプス", icon: "▶" },
  { href: "/settings", label: "設定", icon: "⚙" },
];
const MOBILE = ["/", "/records", "/gold", "/exchange"];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { view } = useGame();
  const [menu, setMenu] = useState(false);
  const cur = view && "currencies" in view ? view.currencies : null;

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col md:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r border-line px-3 py-5 md:flex">
        <Link href="/" className="mb-6 px-2 font-pixel text-xl leading-tight">
          Cité de
          <br />
          Tirelire
        </Link>
        <nav className="flex flex-col gap-0.5" aria-label="メイン">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={isActive(path, n.href) ? "page" : undefined}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${isActive(path, n.href) ? "bg-surface-2 font-semibold" : "text-muted hover:bg-surface-2"}`}
            >
              <span aria-hidden className="w-5 text-center">
                {n.icon}
              </span>
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-line bg-bg/95 px-4 py-2.5 backdrop-blur">
          <Link href="/" className="font-pixel text-lg md:hidden">
            Tirelire
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            {cur && (
              <>
                <span className={`num flex items-center gap-1 ${cur.gold < 0 ? "font-semibold text-danger" : ""}`} title="所持金貨">
                  <Coin kind="gold" />
                  {fmt(cur.gold)}G
                </span>
                <span className="num flex items-center gap-1" title="所持銀貨">
                  <Coin kind="silver" />
                  {fmt(cur.silver)}S
                </span>
              </>
            )}
          </div>
        </header>
        <main className="flex-1 px-4 pt-4 pb-28 md:pb-10">{children}</main>
      </div>

      <nav aria-label="メイン" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.filter((n) => MOBILE.includes(n.href)).map((n) => (
          <Link
            key={n.href}
            href={n.href}
            aria-current={isActive(path, n.href) ? "page" : undefined}
            className={`flex min-h-14 flex-col items-center justify-center text-[11px] ${isActive(path, n.href) ? "font-semibold text-ink" : "text-muted"}`}
          >
            <span aria-hidden className="text-lg leading-none">
              {n.icon}
            </span>
            {n.short ?? n.label}
          </Link>
        ))}
        <button onClick={() => setMenu((m) => !m)} aria-expanded={menu} className="flex min-h-14 flex-col items-center justify-center text-[11px] text-muted">
          <span aria-hidden className="text-lg leading-none">
            ☰
          </span>
          メニュー
        </button>
      </nav>
      {menu && (
        <div className="fixed inset-x-0 bottom-14 z-40 border-t border-line bg-surface p-2 shadow-lg md:hidden" onClick={() => setMenu(false)}>
          {NAV.filter((n) => !MOBILE.includes(n.href)).map((n) => (
            <Link key={n.href} href={n.href} className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm hover:bg-surface-2">
              <span aria-hidden className="w-5 text-center">
                {n.icon}
              </span>
              {n.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
