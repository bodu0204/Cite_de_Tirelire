-- CreateEnum
CREATE TYPE "IncomeKind" AS ENUM ('MONTHLY', 'EXTRA');

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "baseAmount" INTEGER,
ADD COLUMN     "periodKey" TEXT,
ADD COLUMN     "subscriptionId" TEXT;

-- AlterTable
-- 見込み貯金は「都市に使った金貨の累計」として引き継ぐ（貯金管理の記録では0に戻さない）
ALTER TABLE "Season" RENAME COLUMN "estimatedSavings" TO "citySpentGold";
ALTER TABLE "Season" ADD COLUMN     "customCuts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "maxSavingsAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mineCut" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "mineDividend" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "mineWindows" JSONB NOT NULL DEFAULT '[]';

-- 技術Lvの根拠を貯金額（債券 ＋ 都市に使った金貨）の最高到達額にする。今の貯金額から始める（技術Lvは下げない）
UPDATE "Season" SET "maxSavingsAmount" = GREATEST(0, "bond" + "citySpentGold");

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "estimateChecks" JSONB,
ADD COLUMN     "incomeDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "incomeEras" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "Income" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT,
    "kind" "IncomeKind" NOT NULL,
    "monthKey" TEXT,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "baseAmount" INTEGER NOT NULL DEFAULT 0,
    "memo" TEXT,
    "autoExchange" BOOLEAN NOT NULL DEFAULT false,
    "allocation" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Income_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledGrant" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "incomeId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "currency" "Currency" NOT NULL,
    "currencyId" TEXT,
    "amount" INTEGER NOT NULL,
    "dividend" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" TIMESTAMP(3),
    "canceled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ScheduledGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "bond" INTEGER NOT NULL DEFAULT 0,
    "resourced" INTEGER NOT NULL DEFAULT 0,
    "exchanged" INTEGER NOT NULL DEFAULT 0,
    "gains" JSONB,
    "feeSilver" INTEGER NOT NULL DEFAULT 0,
    "feeBond" INTEGER NOT NULL DEFAULT 0,
    "before" INTEGER,
    "after" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAdjustment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT,
    "date" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "estimated" INTEGER NOT NULL,
    "actual" INTEGER NOT NULL,
    "diff" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Income_userId_date_idx" ON "Income"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Income_userId_monthKey_key" ON "Income"("userId", "monthKey");

-- CreateIndex
CREATE INDEX "ScheduledGrant_seasonId_grantedAt_at_idx" ON "ScheduledGrant"("seasonId", "grantedAt", "at");

-- CreateIndex
CREATE INDEX "ScheduledGrant_incomeId_idx" ON "ScheduledGrant"("incomeId");

-- CreateIndex
CREATE INDEX "Resolution_refType_refId_idx" ON "Resolution"("refType", "refId");

-- CreateIndex
CREATE INDEX "Resolution_seasonId_createdAt_idx" ON "Resolution"("seasonId", "createdAt");

-- CreateIndex
CREATE INDEX "CashAdjustment_userId_createdAt_idx" ON "CashAdjustment"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_subscriptionId_periodKey_key" ON "Purchase"("subscriptionId", "periodKey");

-- AddForeignKey
ALTER TABLE "Income" ADD CONSTRAINT "Income_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledGrant" ADD CONSTRAINT "ScheduledGrant_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashAdjustment" ADD CONSTRAINT "CashAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

