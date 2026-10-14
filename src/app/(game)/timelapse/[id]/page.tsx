"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { CityCanvas } from "@/components/city/CityCanvas";
import { useGame } from "@/components/GameProvider";
import { Button, Card, Gauge, LinkButton } from "@/components/ui";
import { DEV_NAMES } from "@/game/config";
import { describeEvent } from "@/game/describe";
import { createReplay, rateAt, type ReplayEvent, type ReplayStart } from "@/game/replay";
import type { CityState } from "@/game/types";
import { api, fmt, formatDate, yen } from "@/lib/api";

interface Data {
  season: { id: string; number: number; goal: number; startedAt: number; reachedAt: number | null; completedAt: number | null };
  start: CityState | null;
  events: (ReplayEvent & { auto: boolean; important: boolean })[];
  savings: { at: number; delta: number }[];
}

const DURATION_MS = 60_000;
const SPEEDS = [1, 2, 4];

export default function TimelapsePlayer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { view } = useGame();
  const tz = view?.user.timezone ?? "Asia/Tokyo";
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const last = useRef<number | null>(null);

  useEffect(() => {
    api<Data>(`/api/seasons/${id}/timelapse`)
      .then((d) => {
        setData(d);
        setPlaying(true);
      })
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (!playing) {
      last.current = null;
      return;
    }
    let raf = 0;
    const step = (t: number) => {
      const dt = last.current === null ? 0 : t - last.current;
      last.current = t;
      setProgress((p) => {
        const next = Math.min(1, p + (dt * speed) / DURATION_MS);
        if (next >= 1) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  const replay = useMemo(() => {
    if (!data?.start) return null;
    const start: ReplayStart = { buildings: data.start.buildings, zones: data.start.zones, techLevel: data.start.techLevel };
    return createReplay(start, data.events);
  }, [data]);

  if (error) return <p className="text-danger">{error}</p>;
  if (!data || !replay) return <p className="text-muted">タイムラプスを読み込んでいます…</p>;

  const s = data.season;
  const end = s.completedAt ?? s.reachedAt ?? s.startedAt + 1;
  const t = s.startedAt + (end - s.startedAt) * progress;
  const frame = replay.at(t);
  const rate = rateAt(data.savings, s.goal, t);
  const recent = data.events.filter((e) => e.important && e.at <= t).slice(-3).reverse();
  const finished = progress >= 1;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="font-pixel text-2xl">シーズン{s.number}</h1>
        <span className="text-sm text-muted">目標 {yen(s.goal)}</span>
      </div>
      <div className="relative">
        <CityCanvas
          label={`${formatDate(t, tz)}時点の街`}
          buildings={[...frame.buildings.values()]}
          zones={frame.zones}
          devLevel={frame.devLevel}
          bankLevel={frame.bankLevel}
        />
        {finished && (
          <div className="rise pointer-events-none absolute inset-0 flex flex-col items-center justify-center rounded-xl bg-black/40 text-center text-white">
            <p className="font-pixel text-3xl">COMPLETE</p>
            <p className="mt-1 text-sm">{yen(s.goal)} の貯金を達成</p>
          </div>
        )}
      </div>
      <Card>
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="num">{formatDate(t, tz)}</span>
          <span>
            {DEV_NAMES[frame.devLevel - 1]} ・ 技術Lv{frame.techLevel}
          </span>
        </div>
        <Gauge value={rate} max={100} color="var(--gold)" label="その時点の達成率" />
        <p className="num mt-1 text-xs text-muted">達成率 {fmt(Math.min(100, rate), 1)}%</p>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(e) => setProgress(Number(e.target.value) / 1000)}
          aria-label="再生位置"
          className="mt-3 border-0 p-0"
        />
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span>開始 {formatDate(s.startedAt, tz)}</span>
          <span>達成 {s.reachedAt ? formatDate(s.reachedAt, tz) : "—"}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              if (finished) setProgress(0);
              setPlaying((p) => !p || finished);
            }}
          >
            {playing ? "一時停止" : finished ? "もう一度再生" : "再生"}
          </Button>
          <div role="group" aria-label="再生速度" className="flex gap-1">
            {SPEEDS.map((sp) => (
              <Button key={sp} variant={speed === sp ? "primary" : "secondary"} onClick={() => setSpeed(sp)} aria-pressed={speed === sp}>
                {sp}倍
              </Button>
            ))}
          </div>
        </div>
      </Card>
      <Card title="出来事">
        <ul className="min-h-16 space-y-1 text-sm">
          {recent.map((e, i) => (
            <li key={`${e.at}-${i}`}>{describeEvent(e)}</li>
          ))}
        </ul>
      </Card>
      <LinkButton href="/timelapse" className="w-full">
        一覧へ戻る
      </LinkButton>
    </div>
  );
}
