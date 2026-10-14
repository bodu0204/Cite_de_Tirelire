"use client";

import Link from "next/link";
import { useGame } from "@/components/GameProvider";
import { Card, Empty } from "@/components/ui";
import { formatDate, yen } from "@/lib/api";
import { useList } from "@/lib/useList";

interface SeasonRow {
  id: string;
  number: number;
  goalAmount: number;
  startedAt: string;
  reachedAt: string | null;
  completedAt: string | null;
}

export default function TimelapseListPage() {
  const { view } = useGame();
  const { items } = useList<SeasonRow>("/api/seasons");
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="font-pixel text-2xl">タイムラプス</h1>
        <p className="mt-1 text-sm text-muted">貯金目標を達成して完成した街の、成長の記録です。進行中の街は完成するまで見られません。</p>
      </div>
      <Card>
        {!items?.length ? (
          <Empty>まだ完成した街はありません。最初の貯金目標を達成すると、ここにタイムラプスが追加されます。</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((s) => (
              <li key={s.id}>
                <Link href={`/timelapse/${s.id}`} className="flex items-center justify-between gap-3 py-3 hover:opacity-80">
                  <span>
                    <span className="font-pixel">シーズン{s.number}</span>
                    <span className="ml-2 text-sm text-muted">目標 {yen(s.goalAmount)}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {formatDate(new Date(s.startedAt).getTime(), tz)}〜{s.reachedAt ? formatDate(new Date(s.reachedAt).getTime(), tz) : ""} ▶
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
