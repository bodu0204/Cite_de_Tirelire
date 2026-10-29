// 描画に必要な絵のキーの一覧（LINT-01 の抜け漏れ検査の正本）。ゲームのカタログから作る。
import { LINES, LINE_IDS } from "../../src/game/catalog";

export const GRASS_VARIANTS = 4;
export const ROAD_MASKS = 16;
export const BANK_LEVELS = 6;
export const PARK_TIERS = 4;
export const STATUE_RANKS = ["bronze", "silver", "gold"] as const;
/** 建物Lv 2〜6 で1つずつ増える小物 */
export const LV_PROPS = ["props/lv/2", "props/lv/3", "props/lv/4", "props/lv/5", "props/lv/6"];
/** 人と車の見た目の種類（src/components/iso/agents.ts の AGENT_VARIANTS と揃える） */
export const AGENT_VARIANTS = 4;
/** 困りごとアイコン（A3）と金貨の山（A4）の段階 */
export const TROUBLES = ["power", "workers", "food"] as const;
export const GOLD_STAGES = 3;

export function requiredKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < GRASS_VARIANTS; i++) keys.push(`ground/grass/${i}`);
  for (const line of LINE_IDS) {
    const tiers = LINES[line].tiers.length;
    for (let t = 0; t < tiers; t++) {
      if (line === "road") for (let m = 0; m < ROAD_MASKS; m++) keys.push(`road/${t}/${m}`);
      else keys.push(`building/${line}/${t}`);
    }
  }
  for (let lv = 1; lv <= BANK_LEVELS; lv++) keys.push(`special/bank/${lv}`);
  keys.push("special/gold_mine", "special/silver_mine");
  for (let t = 0; t < PARK_TIERS; t++) keys.push(`special/park/${t}`);
  for (const r of STATUE_RANKS) keys.push(`special/statue/${r}`);
  keys.push("fx/scaffold", "fx/cover", "locked/forest", "locked/rocks", "locked/sign", ...LV_PROPS);
  for (let v = 0; v < AGENT_VARIANTS; v++) keys.push(`agent/person/${v}/se`, `agent/person/${v}/ne`, `agent/car/${v}/sw`, `agent/car/${v}/ne`);
  for (const t of TROUBLES) keys.push(`icons/${t}`);
  for (let s = 1; s <= GOLD_STAGES; s++) keys.push(`props/gold/${s}`);
  keys.push(...bigKeys());
  return keys;
}

/**
 * 2×2・3×3 の建物の絵（docs/map-layout-redesign.md §4.5）。道路・像以外の建物と特殊施設。
 * 1マスの絵のキーに big/ を付ける
 */
export function bigKeys(): string[] {
  const keys: string[] = [];
  for (const line of LINE_IDS) if (line !== "road") for (let t = 0; t < LINES[line].tiers.length; t++) keys.push(`big/building/${line}/${t}`);
  for (let lv = 1; lv <= BANK_LEVELS; lv++) keys.push(`big/special/bank/${lv}`);
  keys.push("big/special/gold_mine", "big/special/silver_mine");
  for (let t = 0; t < PARK_TIERS; t++) keys.push(`big/special/park/${t}`);
  return keys;
}

/** 系統ごとに段階順に並べたキー（LINT-07：段階が上がるほど高くなる） */
export function tierChains(): string[][] {
  const chains = LINE_IDS.filter((l) => l !== "road" && LINES[l].tiers.length > 1).map((l) => LINES[l].tiers.map((_, t) => `building/${l}/${t}`));
  chains.push(Array.from({ length: BANK_LEVELS }, (_, i) => `special/bank/${i + 1}`));
  chains.push(Array.from({ length: PARK_TIERS }, (_, i) => `special/park/${i}`));
  // 大きな建物も同じ並び（公園の4段階目だけ 3×3 なので、2×2 の3段階で比べる）
  for (const c of [...chains]) chains.push(c.filter((k) => k !== "special/park/3").map((k) => `big/${k}`));
  return chains;
}
