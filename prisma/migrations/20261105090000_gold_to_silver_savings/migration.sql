-- 金貨→銀貨の交換に使った金貨も貯金額（ゲーム内で使った金貨）に数える。進行中のシーズンの過去の交換をさかのぼって加える
UPDATE "Season" s
SET "citySpentGold" = s."citySpentGold" + COALESCE((
  SELECT SUM(-l."delta") FROM "CurrencyLedger" l
  WHERE l."seasonId" = s."id" AND l."currency" = 'GOLD' AND l."reason" = 'exchange_g2s'
), 0)
WHERE s."status" = 'ACTIVE';

UPDATE "Season" SET "maxSavingsAmount" = GREATEST("maxSavingsAmount", "bond" + GREATEST(0, "citySpentGold")) WHERE "status" = 'ACTIVE';
