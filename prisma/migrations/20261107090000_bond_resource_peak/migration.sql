-- 資源をつけた債券の最高到達額。これを超えて債券に入った分にだけ資源をつける（使って戻すたびに資源がつかないように）。
-- 既存のシーズンは、台帳の債券の残高の最高値（と今の残高）を上限 3M までで入れる
ALTER TABLE "Season" ADD COLUMN "bondResourcePeak" INTEGER NOT NULL DEFAULT 0;

UPDATE "Season" s
SET "bondResourcePeak" = LEAST(
  GREATEST(0, u."monthlyBudget") * 3,
  GREATEST(0, s."bond", COALESCE((SELECT MAX(l."balanceAfter") FROM "CurrencyLedger" l WHERE l."seasonId" = s."id" AND l."currency" = 'BOND'), 0))
)
FROM "User" u
WHERE u."id" = s."userId";
