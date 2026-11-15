-- お金の置き場所と振替（docs/money-accounts.md）。支払い方法（PaymentMethod）を置き場所（MoneyAccount）に引き継ぐ（§10）

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('BANK', 'CASH', 'CARD', 'EMONEY');
CREATE TYPE "TransferKind" AS ENUM ('MANUAL', 'CARD_PAYMENT');
CREATE TYPE "CardBillStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateTable
CREATE TABLE "MoneyAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "openingBalance" INTEGER NOT NULL DEFAULT 0,
    "openingDate" TEXT NOT NULL,
    "isSavings" BOOLEAN NOT NULL DEFAULT false,
    "closingDay" INTEGER,
    "paymentDay" INTEGER,
    "paymentMonths" INTEGER,
    "debitAccountId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyAccount_pkey" PRIMARY KEY ("id")
);

-- 支払い方法を置き場所に写す（同じ id。現金 → 現金、クレカ → クレカ、その他 → 電子マネー）。
-- 開始残高は 0、開始日は移行した日（ユーザーのタイムゾーン）なので、これまでの記録は残高に数えない
INSERT INTO "MoneyAccount" ("id", "userId", "name", "kind", "openingBalance", "openingDate", "closingDay", "paymentDay", "paymentMonths", "sortOrder", "archivedAt", "createdAt")
SELECT pm."id", pm."userId", pm."name",
       (CASE pm."kind" WHEN 'CASH' THEN 'CASH' WHEN 'CARD' THEN 'CARD' ELSE 'EMONEY' END)::"AccountKind",
       0, to_char(CURRENT_TIMESTAMP AT TIME ZONE u."timezone", 'YYYY-MM-DD'),
       pm."closingDay", pm."paymentDay", pm."paymentMonths", pm."sortOrder", pm."archivedAt", pm."createdAt"
FROM "PaymentMethod" pm JOIN "User" u ON u."id" = pm."userId";

-- 支払い方法の列を置き場所の列に改名する（記入済みの支払い方法が出どころになる）
ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_paymentMethodId_fkey";
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_paymentMethodId_fkey";
DROP INDEX "Purchase_paymentMethodId_date_idx";
ALTER TABLE "Purchase" RENAME COLUMN "paymentMethodId" TO "accountId";
ALTER TABLE "Subscription" RENAME COLUMN "paymentMethodId" TO "accountId";

-- AlterTable
ALTER TABLE "Income" ADD COLUMN "accountId" TEXT;
ALTER TABLE "User" ADD COLUMN "defaultIncomeAccountId" TEXT,
ADD COLUMN "defaultSpendAccountId" TEXT;

-- 現金の支払い方法をいつもの置き場所にする
UPDATE "User" u SET "defaultSpendAccountId" = m."id" FROM "MoneyAccount" m WHERE m."userId" = u."id" AND m."kind" = 'CASH';

-- DropTable
ALTER TABLE "PaymentMethod" DROP CONSTRAINT "PaymentMethod_userId_fkey";
DROP TABLE "PaymentMethod";
DROP TYPE "PaymentKind";

-- CreateTable
CREATE TABLE "Transfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT,
    "date" TEXT NOT NULL,
    "fromAccountId" TEXT NOT NULL,
    "toAccountId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "memo" TEXT,
    "kind" "TransferKind" NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CardBill" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "CardBillStatus" NOT NULL DEFAULT 'PENDING',
    "transferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardBill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutsideRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutsideRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountAdjustment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adjustmentId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "computed" INTEGER NOT NULL,
    "actual" INTEGER NOT NULL,
    "diff" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MoneyAccount_userId_idx" ON "MoneyAccount"("userId");
CREATE INDEX "Transfer_userId_date_idx" ON "Transfer"("userId", "date");
CREATE INDEX "CardBill_userId_status_idx" ON "CardBill"("userId", "status");
CREATE UNIQUE INDEX "CardBill_cardId_dueDate_key" ON "CardBill"("cardId", "dueDate");
CREATE INDEX "OutsideRecord_userId_date_idx" ON "OutsideRecord"("userId", "date");
CREATE INDEX "AccountAdjustment_userId_accountId_idx" ON "AccountAdjustment"("userId", "accountId");
CREATE INDEX "AccountAdjustment_adjustmentId_idx" ON "AccountAdjustment"("adjustmentId");
CREATE INDEX "Purchase_accountId_date_idx" ON "Purchase"("accountId", "date");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MoneyAccount" ADD CONSTRAINT "MoneyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardBill" ADD CONSTRAINT "CardBill_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutsideRecord" ADD CONSTRAINT "OutsideRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountAdjustment" ADD CONSTRAINT "AccountAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Income" ADD CONSTRAINT "Income_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MoneyAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
