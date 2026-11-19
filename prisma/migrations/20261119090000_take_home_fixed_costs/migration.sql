-- 手取り月収と固定費（docs/take-home-and-fixed-costs.md）
-- 設定で入れる額を手取り月収にする（リリース前なので値はそのまま改名する）
ALTER TABLE "User" RENAME COLUMN "monthlyBudget" TO "monthlyIncome";

-- 固定費：サブスクと同じ記録に種類の印をつける。支払日と「この回は記録しない」にした期間
CREATE TYPE "SubscriptionKind" AS ENUM ('SUBSCRIPTION', 'FIXED');
ALTER TABLE "Subscription" ADD COLUMN "kind" "SubscriptionKind" NOT NULL DEFAULT 'SUBSCRIPTION';
ALTER TABLE "Subscription" ADD COLUMN "payDay" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "skippedPeriods" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 予算外の入出金をなくす（これまでの記録は引き継がない）
DROP TABLE "OutsideRecord";
