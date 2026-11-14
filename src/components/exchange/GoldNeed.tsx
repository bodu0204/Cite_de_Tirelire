// 建設資金の不足を、交換に要る金貨で示す。開拓期ボーナスの間は、ボーナスで増える建設資金ではなく
// 要る金貨が減る形で見せる（例：~~92G~~ → 46G。docs/savings-driven-growth.md §16.4）。
import { savingsForFund } from "@/game/fund";
import { fmt } from "@/lib/api";
import type { ActiveView } from "@/server/view";

export interface GoldFor {
  /** ボーナスなしで要る金貨 */
  normal: number;
  /** 開拓期ボーナス込みで要る金貨（ボーナスがなければ normal と同じ） */
  bonus: number;
}

/** 建設資金 fund 円を入れるのに要る金貨（交換効率と開拓期ボーナスの倍率・残りから求める） */
export function goldForOf(v: ActiveView): (fund: number) => GoldFor {
  const rate = Math.max(1e-9, v.exchange.rates.gold.treasury);
  return (fund) => ({
    normal: Math.ceil(fund / rate),
    bonus: Math.ceil(savingsForFund(fund, v.dev.earlyBonusRate, v.dev.earlyBonusRoom) / rate),
  });
}

/** 要る金貨。開拓期ボーナスで減る時は、ボーナスなしの額に横線を引いて並べる */
export function GoldNeed({ need }: { need: GoldFor }) {
  if (need.bonus >= need.normal) return <span className="num">{fmt(need.normal)}G</span>;
  return (
    <span className="num">
      <s className="text-muted" aria-label={`開拓期ボーナスなしなら ${fmt(need.normal)}G`}>
        {fmt(need.normal)}G
      </s>{" "}
      → <span className="font-semibold text-dev">{fmt(need.bonus)}G</span>
    </span>
  );
}
