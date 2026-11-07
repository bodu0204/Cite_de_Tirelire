// 街のできごと・タイムラプス用のイベント文言。
import { DEV_NAMES } from "./config";

export interface DescribableEvent {
  type: string;
  payload: Record<string, unknown>;
}

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 公園の大きさ（parkSize の段階）。月額換算 500円・1,500円・3,000円 で一段ずつ大きくなる */
export const PARK_SIZE_LABELS = ["小さな広場", "公園", "大きな公園", "噴水のある庭園"];

export const PARK_DESCRIPTION =
  "契約中のサブスク1件につき公園が1つできます。月額が高いほど大きく（500円・1,500円・3,000円で一段ずつ）、開園中は街の幸福度を上げます。公園が増えるほど1つあたりの効果は小さくなります（合計+15まで）。解約すると閉園し、閉園した公園は撤去できます。";

export const STATUE_DESCRIPTION =
  "ほしい物1件につき像が1体できます。価格で銅像（5,000円未満）・銀像（30,000円未満）・金像に分かれ、金貨の積立が25%進むごとに像が高くなります。100%で資金準備完了、購入を記録すると完成します。像は街の発展で撤去されません。";

/** 像の段階（statueStage）の説明 */
export function statueStageLabel(stage: number): string {
  if (stage >= 5) return "完成（購入済み）";
  if (stage >= 4) return "資金準備完了（購入を記録すると完成）";
  if (stage === 0) return "土台のみ（積立0〜24%）";
  return `建築中（積立${stage * 25}%以上）`;
}

const DISASTER_NAMES: Record<string, string> = { typhoon: "台風", crop: "不作", fire: "火事", surge: "資材の値上がり", blackout: "停電" };

interface DisasterPayload {
  kind: string;
  prevented: boolean;
  reserveLevel: number;
  hours?: number;
  percent?: number;
  names?: string[];
  repaired?: boolean;
}

/** 悪い出来事の文言（docs/savings-driven-growth.md EVT-06） */
function describeDisaster(p: DisasterPayload): string {
  const name = DISASTER_NAMES[p.kind] ?? p.kind;
  if (p.prevented) {
    const what: Record<string, string> = {
      typhoon: "台風が来ましたが",
      crop: "不作になりかけましたが",
      fire: "火事が起きかけましたが",
      surge: "資材が値上がりしかけましたが",
      blackout: "停電しかけましたが",
    };
    return `${what[p.kind] ?? `${name}がありましたが`}、備えのおかげで被害はありませんでした`;
  }
  const h = (v?: number) => `${Math.round(v ?? 0)}時間`;
  switch (p.kind) {
    case "typhoon":
      return `台風で工事が${h(p.hours)}止まりました`;
    case "crop":
      return `不作で食料の生産が${h(p.hours)}、${p.percent}%減ります`;
    case "surge":
      return `資材が値上がりし、${h(p.hours)}は工事の値段が${p.percent}%上がります`;
    case "blackout":
      return `停電で電力の供給が${h(p.hours)}、${p.percent}%減ります`;
    case "fire": {
      const names = (p.names ?? []).join("・");
      return p.repaired ? `火事がありましたが、備えのおかげで${names}をすぐ修繕しました` : `火事で${names}が休業しました（銀貨で修繕するか、3日で再開します）`;
    }
    default:
      return name;
  }
}

export function describeEvent(e: DescribableEvent): string {
  const p = e.payload as Record<string, never>;
  switch (e.type) {
    case "BUILD":
      return `新しい${p.name}が建設されました`;
    case "UPGRADE":
      return `${p.name}がLv${p.level}になりました`;
    case "EVOLVE":
      return `${p.from}が${p.to}に進化しました`;
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
    case "DISASTER":
      return describeDisaster(p as unknown as DisasterPayload);
    case "REPAIRED":
      return p.by === "silver" ? `${p.name}を銀貨で修繕し、再開しました` : `${p.name}が再開しました`;
    case "RESERVE_BUILT":
      return `備えLv${p.level}：${p.name}が建ちました`;
    case "RESERVE_CLOSED":
      return `債券が減り、${p.name}が閉まりました（備えLv${(p.level as number) - 1}）`;
    case "RESERVE_OPENED":
      return `債券が戻り、${p.name}が再開しました（備えLv${p.level}）`;
    case "DECORATED":
      return p.decor ? `${p.name}に${p.label}を飾りました` : `${p.name}の装飾を外しました`;
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
