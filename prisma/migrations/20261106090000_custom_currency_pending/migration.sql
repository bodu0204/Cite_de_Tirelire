-- ユーザ通貨の未受取分。発生ルールで発生した分は配当資金の「受け取る」で所持に移す（既存の残高は受け取り済みとする）
ALTER TABLE "CurrencyLot" ADD COLUMN "pending" INTEGER NOT NULL DEFAULT 0;
