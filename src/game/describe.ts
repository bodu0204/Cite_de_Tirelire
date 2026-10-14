// 自動発展ログ・タイムラプス用のイベント文言。
import { DEV_NAMES } from "./config";

export interface DescribableEvent {
  type: string;
  auto: boolean;
  payload: Record<string, unknown>;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export function describeEvent(e: DescribableEvent): string {
  const p = e.payload as Record<string, never>;
  const who = e.auto ? "" : "（手動）";
  switch (e.type) {
    case "BUILD":
      return `新しい${p.name}が建設されました${who}`;
    case "UPGRADE":
      return `${p.name}がLv${p.level}になりました${who}`;
    case "EVOLVE":
      return `${p.from}が${p.to}に進化しました${who}`;
    case "DEMOLISH":
      return `${p.name}を撤去しました`;
    case "MOVE":
      return "建物を移動しました";
    case "TECH_UNLOCKED": {
      const unlocks = (p.unlocks as unknown as string[]) ?? [];
      return `技術Lv${p.level}に到達！${unlocks.length ? `${unlocks.slice(0, 4).join("・")}が解放されました` : ""}`;
    }
    case "DEV_LEVEL":
      return `街が「${DEV_NAMES[(p.level as number) - 1]}」（発展Lv${p.level}）に成長しました`;
    case "DISTRICT_UNLOCKED":
      return `新しい地区「${p.name}」が解放されました`;
    case "POPULATION":
      return `人口が${p.population}人を超えました`;
    case "SHORTAGE_STARTED":
      return p.kind === "food" ? "食料が不足しています" : "電力が不足しています";
    case "SHORTAGE_RESOLVED":
      return p.kind === "food" ? "食料不足が解消しました" : "電力不足が解消しました";
    case "BANK_LEVEL":
      return (p.level as number) >= 6 ? "銀行が完成しました！" : `銀行がLv${p.level}になりました`;
    case "GOLD_MINE_LEVEL":
      return `金鉱がLv${p.level}になりました`;
    case "SILVER_MINE_LEVEL":
      return `銀鉱がLv${p.level}になりました`;
    case "PARK_OPENED":
      return `${p.name}の公園が開園しました`;
    case "PARK_CLOSED":
      return `${p.name}の公園が閉園しました`;
    case "STATUE_PROGRESS":
      return (p.progress as number) === 0 ? `${p.name}の像の建築計画ができました` : `${p.name}の像が${p.progress}%まで進みました`;
    case "STATUE_COMPLETED":
      return `${p.name}の像が完成しました！`;
    case "SAVINGS_MILESTONE":
      return `貯金目標の${p.percent}%を達成しました！`;
    case "SEASON_STARTED":
      return `シーズン${p.number}が始まりました（目標 ${yen(p.goal as number)}）`;
    case "SEASON_COMPLETED":
      return "貯金目標を達成し、街が完成しました！";
    default:
      return e.type;
  }
}
