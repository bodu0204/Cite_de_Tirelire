-- 記録による貯金の確定（docs/savings-driven-growth.md REC-01）。最後に確定した時刻、まだ確定していない日ごとの配当、手数料なしで取り崩せる債券
ALTER TABLE "Season" ADD COLUMN "mineConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Season" ADD COLUMN "mineUnconfirmed" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Season" ADD COLUMN "mineFreeBond" INTEGER NOT NULL DEFAULT 0;
