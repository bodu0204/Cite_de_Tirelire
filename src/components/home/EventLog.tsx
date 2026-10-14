"use client";

import { describeEvent } from "@/game/describe";
import { formatDateTime } from "@/lib/api";
import { Empty } from "../ui";

export function EventLog({ events, tz, limit = 12 }: { events: { at: number; type: string; auto: boolean; payload: unknown }[]; tz: string; limit?: number }) {
  if (!events.length) return <Empty>まだ出来事はありません。街はこれから育っていきます。</Empty>;
  return (
    <ol className="space-y-1.5 text-sm">
      {events.slice(0, limit).map((e, i) => (
        <li key={`${e.at}-${i}`} className="flex gap-3">
          <time className="num w-20 shrink-0 text-xs leading-5 text-muted">{formatDateTime(e.at, tz)}</time>
          <span>{describeEvent({ type: e.type, auto: e.auto, payload: e.payload as Record<string, unknown> })}</span>
        </li>
      ))}
    </ol>
  );
}
