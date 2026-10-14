-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('ACTIVE', 'GOAL_REACHED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('GOLD', 'SILVER', 'RESERVED');

-- CreateEnum
CREATE TYPE "SavingsKind" AS ENUM ('DEPOSIT', 'WITHDRAW');

-- CreateEnum
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "monthlyBudget" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tokyo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "goalAmount" INTEGER NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reachedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "gold" INTEGER NOT NULL DEFAULT 0,
    "silver" INTEGER NOT NULL DEFAULT 0,
    "reservedGold" INTEGER NOT NULL DEFAULT 0,
    "mineUncollected" BIGINT NOT NULL DEFAULT 0,
    "mineDebt" BIGINT NOT NULL DEFAULT 0,
    "mineLastAccrualAt" TIMESTAMP(3) NOT NULL,
    "mineMonthKey" TEXT NOT NULL,
    "mineMinedMonth" BIGINT NOT NULL DEFAULT 0,
    "mineSettledMonth" INTEGER NOT NULL DEFAULT 0,
    "mineTotalCollected" INTEGER NOT NULL DEFAULT 0,
    "rewardedRecords" INTEGER NOT NULL DEFAULT 0,
    "milestones" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenStats" JSONB,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CityState" (
    "seasonId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CityState_pkey" PRIMARY KEY ("seasonId")
);

-- CreateTable
CREATE TABLE "CityEvent" (
    "id" BIGSERIAL NOT NULL,
    "seasonId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB NOT NULL,

    CONSTRAINT "CityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitySnapshot" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "state" JSONB NOT NULL,

    CONSTRAINT "CitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrencyLedger" (
    "id" BIGSERIAL NOT NULL,
    "seasonId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrencyLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyOverspend" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "MonthlyOverspend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT,
    "amount" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "memo" TEXT,
    "isSubscription" BOOLEAN NOT NULL DEFAULT false,
    "wishItemId" TEXT,
    "settledAmount" INTEGER NOT NULL DEFAULT 0,
    "settledMonth" TEXT,
    "reservedApplied" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavingsTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT,
    "kind" "SavingsKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SavingsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "cycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "startDate" TEXT NOT NULL,
    "endDate" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 2,
    "memo" TEXT,
    "purchasedAt" TIMESTAMP(3),
    "purchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WishContribution" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "wishItemId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WishContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "recordKey" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("userId","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Season_userId_status_idx" ON "Season"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Season_userId_number_key" ON "Season"("userId", "number");

-- CreateIndex
CREATE INDEX "CityEvent_seasonId_at_id_idx" ON "CityEvent"("seasonId", "at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CitySnapshot_seasonId_kind_key" ON "CitySnapshot"("seasonId", "kind");

-- CreateIndex
CREATE INDEX "CurrencyLedger_seasonId_createdAt_idx" ON "CurrencyLedger"("seasonId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyOverspend_seasonId_monthKey_key" ON "MonthlyOverspend"("seasonId", "monthKey");

-- CreateIndex
CREATE INDEX "Purchase_userId_date_idx" ON "Purchase"("userId", "date");

-- CreateIndex
CREATE INDEX "SavingsTransaction_userId_seasonId_idx" ON "SavingsTransaction"("userId", "seasonId");

-- CreateIndex
CREATE INDEX "Subscription_userId_idx" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "WishItem_userId_idx" ON "WishItem"("userId");

-- CreateIndex
CREATE INDEX "WishContribution_seasonId_wishItemId_idx" ON "WishContribution"("seasonId", "wishItemId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardClaim_recordKey_key" ON "RewardClaim"("recordKey");

-- CreateIndex
CREATE INDEX "RewardClaim_userId_dayKey_idx" ON "RewardClaim"("userId", "dayKey");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CityState" ADD CONSTRAINT "CityState_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CityEvent" ADD CONSTRAINT "CityEvent_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitySnapshot" ADD CONSTRAINT "CitySnapshot_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurrencyLedger" ADD CONSTRAINT "CurrencyLedger_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthlyOverspend" ADD CONSTRAINT "MonthlyOverspend_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavingsTransaction" ADD CONSTRAINT "SavingsTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishItem" ADD CONSTRAINT "WishItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishContribution" ADD CONSTRAINT "WishContribution_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishContribution" ADD CONSTRAINT "WishContribution_wishItemId_fkey" FOREIGN KEY ("wishItemId") REFERENCES "WishItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardClaim" ADD CONSTRAINT "RewardClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
