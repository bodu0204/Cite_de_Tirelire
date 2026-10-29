import { existsSync } from "node:fs";
import { notFound } from "next/navigation";
import { BUILDING_LINES } from "@/components/iso/map";
import { LINES } from "@/game/catalog";
import { listCandidates, selectedFile } from "./files";
import { CandidatePicker, Lineup } from "./SpriteReview";

export const dynamic = "force-dynamic";

// 確認ページ（docs/rendering-requirements.md §5.2）。開発環境だけで開ける。
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  const runs = listCandidates();
  const tws = ["64", "32"];
  const selected: Record<string, string[]> = {};
  for (const tw of tws) {
    selected[tw] = [];
    for (const line of BUILDING_LINES)
      LINES[line].tiers.forEach((_, t) => {
        const key = `building/${line}/${t}`;
        const f = selectedFile(tw, key);
        if (f && existsSync(f)) selected[tw].push(key);
      });
  }
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-3">
      <h1 className="text-lg font-bold">素材の確認ページ</h1>
      <section className="space-y-2">
        <h2 className="font-bold">系統ごとの全段階（等倍と2倍）</h2>
        <p className="text-xs text-muted">選んだ絵があればそれを、なければ M0 の仮の絵を出します。等倍で段階を見分けられるかを見ます。</p>
        <Lineup selected={selected} />
      </section>
      <section className="space-y-2">
        <h2 className="font-bold">生成の候補</h2>
        {runs.length === 0 ? (
          <p className="text-sm">
            候補はまだありません。<code>npm run sprites -- --tw 64 --stage M0</code> で生成します。
          </p>
        ) : (
          <CandidatePicker runs={runs} />
        )}
      </section>
    </main>
  );
}
