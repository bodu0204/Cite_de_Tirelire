-- シーズン開始時の設定（docs/season-start-settings.md）：目標の名前・持ち込みの備え・持ち込みの貯金・持ち越し元・今期の残りの自由予算
ALTER TABLE "Season" ADD COLUMN "goalName" TEXT;
ALTER TABLE "Season" ADD COLUMN "reserveCarried" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Season" ADD COLUMN "carriedSavings" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Season" ADD COLUMN "carriedFromSeasonId" TEXT;
ALTER TABLE "Season" ADD COLUMN "startRemaining" INTEGER;
