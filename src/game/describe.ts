// 自動発展ログ・タイムラプス用のイベント文言。
import { DEV_NAMES } from "./config";

export interface DescribableEvent {
  type: string;
  auto: boolean;
  payload: Record<string, unknown>;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 公園の大きさ（parkSize の段階）。月額換算 500円・1,500円・3,000円 で一段ずつ大きくなる */
export const PARK_SIZE_LABELS = ["小さな広場", "公園", "大きな公園", "噴水のある庭園"];

export const PARK_DESCRIPTION =
  "契約中のサブスク1件につき公園が1つできます。月額が高いほど大きく（500円・1,500円・3,000円で一段ずつ）、開園中は街の幸福度を上げます。公園が増えるほど1つあたりの効果は小さくなります（合計+15まで）。解約すると閉園し、閉園した公園は撤去できます。";

export const STATUE_DESCRIPTION =
  "ほしい物1件につき像が1体できます。価格で銅像（5,000円未満）・銀像（30,000円未満）・金像に分かれ、金貨の積立が25%進むごとに像が高くなります。100%で資金準備完了、購入を記録すると完成します。像は自動開発で撤去されません。";

/** 像の段階（statueStage）の説明 */
export function statueStageLabel(stage: number): string {
  if (stage >= 5) return "完成（購入済み）";
  if (stage >= 4) return "資金準備完了（購入を記録すると完成）";
  if (stage === 0) return "土台のみ（積立0〜24%）";
  return `建築中（積立${stage * 25}%以上）`;
}

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
    case "PLOT_EXPANDED":
      return "新しい区画を開拓しました";
    case "POPULATION":
      return `人口が${p.population}人を超えました`;
    case "SHORTAGE_STARTED":
      return p.kind === "food" ? "食料が不足しています" : "電力が不足しています";
    case "SHORTAGE_RESOLVED":
      return p.kind === "food" ? "食料不足が解消しました" : "電力不足が解消しました";
    case "BANK_LEVEL":
      return (p.level as number) >= 6 ? "銀行が完成しました！" : `銀行がLv${p.level}になりました`;
    case "GOLD_MINE_LEVEL":
      return `銀行の配当Lvが${p.level}になりました`;
    case "SILVER_MINE_LEVEL":
      return `銀行の記録Lvが${p.level}になりました`;
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
