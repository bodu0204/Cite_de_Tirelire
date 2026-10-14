"use client";

import Link from "next/link";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export function Card({ children, className = "", title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`rounded-xl border border-line bg-surface p-4 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="font-pixel text-base">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "gold";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90",
  secondary: "border border-line bg-surface-2 text-ink hover:bg-line/60",
  ghost: "text-ink hover:bg-surface-2",
  danger: "border border-danger text-danger hover:bg-danger/10",
  gold: "bg-gold text-[#2b2620] hover:opacity-90",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${className}`}
    />
  );
}

export function LinkButton({ href, children, variant = "secondary", className = "" }: { href: string; children: ReactNode; variant?: Variant; className?: string }) {
  return (
    <Link href={href} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition ${VARIANTS[variant]} ${className}`}>
      {children}
    </Link>
  );
}

/** extra は value の後ろに続く「見込み」の区間（斜線で表示） */
export function Gauge({ value, max, color, label, extra = 0 }: { value: number; max: number; color: string; label: string; extra?: number }) {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const pct = max > 0 ? clamp((value / max) * 100) : 100;
  const extraPct = max > 0 ? clamp(((value + extra) / max) * 100) - pct : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="flex h-3 w-full overflow-hidden rounded-sm border border-line bg-surface-2">
      <div className="h-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} />
      {extraPct > 0 && (
        <div
          className="h-full transition-[width] duration-700"
          style={{ width: `${extraPct}%`, background: `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`, opacity: 0.75 }}
        />
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div role="tablist" className="flex gap-1 rounded-lg border border-line bg-surface-2 p-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={`min-h-9 flex-1 rounded-md px-2 text-sm ${value === it.value ? "bg-surface font-semibold shadow-sm" : "text-muted"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-ink backdrop:bg-black/50"
    >
      <div className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-pixel text-lg">{title}</h2>
          <button onClick={onClose} aria-label="閉じる" className="rounded-md px-2 py-1 text-muted hover:bg-surface-2">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="num font-pixel text-lg leading-tight">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Coin({ kind, size = 14 }: { kind: "gold" | "silver"; size?: number }) {
  const fill = kind === "gold" ? "#f2c14e" : "#c9d3da";
  const edge = kind === "gold" ? "#a0740b" : "#7d8a94";
  return (
    <svg width={size} height={size} viewBox="0 0 8 8" className="pixelated inline-block shrink-0" aria-hidden>
      <rect x="2" y="0" width="4" height="8" fill={edge} />
      <rect x="0" y="2" width="8" height="4" fill={edge} />
      <rect x="1" y="1" width="6" height="6" fill={edge} />
      <rect x="2" y="1" width="4" height="6" fill={fill} />
      <rect x="1" y="2" width="6" height="4" fill={fill} />
      <rect x="3" y="2" width="1" height="3" fill="#fff" opacity="0.6" />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-muted">{children}</p>;
}
