-- CreateEnum
CREATE TYPE "RemainderPolicy" AS ENUM ('KEEP', 'TO_BOND');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Currency" ADD VALUE 'BOND';
ALTER TYPE "Currency" ADD VALUE 'CUSTOM';

-- AlterTable
ALTER TABLE "CurrencyLedger" ADD COLUMN     "currencyId" TEXT;

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "categoryId" TEXT;

-- AlterTable
ALTER TABLE "Season" ADD COLUMN     "bond" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mineBondFraction" BIGINT NOT NULL DEFAULT 0;

-- 採掘負債を債券のマイナスに置き換える（切り上げ。手数料は取らない）
UPDATE "Season" SET "bond" = -CEIL("mineDebt"::numeric / 1000000)::integer WHERE "mineDebt" > 0;

ALTER TABLE "Season" DROP COLUMN "mineDebt";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bondMiningRate" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PurchasePayment" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "kind" TEXT NOT NULL,
    "currencyId" TEXT,
    "lotId" TEXT,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "PurchasePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyDef" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "categoryIds" TEXT[],
    "rules" JSONB NOT NULL,
    "remainder" "RemainderPolicy" NOT NULL DEFAULT 'KEEP',
    "remainderDays" INTEGER,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CurrencyDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyLot" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "currencyId" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "amount" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,

    CONSTRAINT "CurrencyLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyAccrual" (
    "seasonId" TEXT NOT NULL,
    "currencyId" TEXT NOT NULL,
    "lastAccrualAt" TIMESTAMP(3) NOT NULL,
    "fraction" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "CurrencyAccrual_pkey" PRIMARY KEY ("seasonId","currencyId")
);

-- CreateIndex
CREATE INDEX "PurchasePayment_purchaseId_idx" ON "PurchasePayment"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");

-- CreateIndex
CREATE INDEX "CurrencyDef_userId_idx" ON "CurrencyDef"("userId");

-- CreateIndex
CREATE INDEX "CurrencyLot_seasonId_currencyId_expiresAt_idx" ON "CurrencyLot"("seasonId", "currencyId", "expiresAt");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchasePayment" ADD CONSTRAINT "PurchasePayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrencyDef" ADD CONSTRAINT "CurrencyDef_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrencyLot" ADD CONSTRAINT "CurrencyLot_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrencyAccrual" ADD CONSTRAINT "CurrencyAccrual_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 購入のカテゴリ（文字列）からジャンルのマスタを作り、categoryId を埋める
INSERT INTO "Category" ("id", "userId", "name")
SELECT 'c' || replace(gen_random_uuid()::text, '-', ''), "userId", "name"
FROM (SELECT DISTINCT "userId", btrim("category") AS "name" FROM "Purchase" WHERE "category" IS NOT NULL AND btrim("category") <> '') p;

UPDATE "Purchase" p SET "categoryId" = c."id"
FROM "Category" c
WHERE c."userId" = p."userId" AND c."name" = btrim(p."category");
