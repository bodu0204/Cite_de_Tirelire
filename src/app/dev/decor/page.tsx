import { existsSync } from "node:fs";
import { notFound } from "next/navigation";
import { LINE_IDS, LINES } from "@/game/catalog";
import { buildingSize } from "@/game/city/layout";
import { selectedFile } from "../sprites/files";
import { DecorEditor, type DecorItem } from "./DecorEditor";
import { readSpots } from "./spots";

export const dynamic = "force-dynamic";

// 装飾（REC-06）を置く位置を、建物の絵ごとに手で合わせるページ。開発環境だけで開ける
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  const items: DecorItem[] = [];
  for (const line of LINE_IDS) {
    if (line === "road") continue;
    LINES[line].tiers.forEach((t, tier) =>
      items.push({ key: `big/building/${line}/${tier}`, label: `${t.name}（段階${tier}）`, group: LINES[line].label, size: buildingSize({ line, tier }) }),
    );
  }
  for (let lv = 1; lv <= 6; lv++) items.push({ key: `big/special/bank/${lv}`, label: `銀行Lv${lv}`, group: "銀行", size: buildingSize({ special: "bank", tier: 0 }) });
  for (let tier = 0; tier <= 3; tier++)
    items.push({ key: `big/special/park/${tier}`, label: `公園（段階${tier}）`, group: "公園", size: buildingSize({ special: "park", tier }) });
  // 絵がまだない建物は出さない
  const shown = items.filter((i) => {
    const f = selectedFile("64", i.key);
    return f && existsSync(f);
  });
  return (
    <main className="mx-auto max-w-7xl space-y-3 p-3">
      <h1 className="text-lg font-bold">装飾の位置の編集</h1>
      <p className="text-xs text-muted">
        建物の絵ごとに、銀貨で添える装飾を置く位置を決めます。装飾をドラッグするか、矢印キー（Shift で4ドット）で動かします。敷地の外にはみ出してもかまいません。保存すると
        <code>art/sprites/64/decor-spots.json</code> に書き込み、ゲームの描画（<code>toIso.ts</code>）がその位置を使います。決めていない建物は、大きさごとの既定の位置になります。
      </p>
      <DecorEditor items={shown} initial={readSpots()} />
    </main>
  );
}
