-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('CASH', 'CARD', 'OTHER');

-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN     "paymentMethodId" TEXT,
ADD COLUMN     "paymentRecordedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "paymentMethodId" TEXT;

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "closingDay" INTEGER,
    "paymentDay" INTEGER,
    "paymentMonths" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_idx" ON "PaymentMethod"("userId");

-- CreateIndex
CREATE INDEX "Purchase_paymentMethodId_date_idx" ON "Purchase"("paymentMethodId", "date");

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

