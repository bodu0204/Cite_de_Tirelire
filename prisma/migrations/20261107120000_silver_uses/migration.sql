-- 銀貨の使い道（docs/savings-driven-growth.md REC-06）。銀貨で買ったタイムラプスの演出。建物の名前と装飾は街の状態（CityState.state）に持つ
ALTER TABLE "Season" ADD COLUMN "timelapseFx" TEXT[] DEFAULT ARRAY[]::TEXT[];
