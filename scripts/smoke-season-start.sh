#!/usr/bin/env bash
# シーズン開始時の設定のスモークテスト（docs/season-start-settings.md §13、AT-097〜107）。
# 使い方: BASE=http://localhost:3000 PSQL="psql -h localhost -p 5433 -U tirelire tirelire" bash scripts/smoke-season-start.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3000}
PSQL=${PSQL:-docker compose exec -T db psql -U tirelire}
JAR=$(mktemp)
req() { # method path [json]
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" -H "content-type: application/json" -H "origin: $BASE" -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" ${3:+-d "$3"}
  echo
}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(JSON.stringify($1))})" "${@:2}"; }
signup() { JAR=$(mktemp); EMAIL="$1$(date +%s%N)@example.com"; req POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"timezone\":\"Asia/Tokyo\"}" >/dev/null; }
sql() { $PSQL -qtAc "$1"; }
active() { echo "(SELECT s.id FROM \"Season\" s JOIN \"User\" u ON u.id = s.\"userId\" WHERE u.email = '$EMAIL' AND s.status <> 'COMPLETED')"; }
TODAY=$(TZ=Asia/Tokyo date +%F)
AGO40=$(TZ=Asia/Tokyo date -d "$TODAY -40 days" +%F)
DAY=$((10#$(TZ=Asia/Tokyo date +%d)))

echo "== AT-097 budget and goal only: same as before (no carried reserve, prorated dividend, no name)"
signup plain
req GET /api/season/draft | j '[o.first, o.number, o.incomeDayNow, o.previous, o.savingsAccounts]'
req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000}' >/dev/null
req GET /api/state | j '[o.season.name, o.season.carried.reserve, o.season.carried.savings, o.season.inDebt, o.dev.reserveLevel, o.currencies.bond]'
sql "SELECT \"startRemaining\" IS NULL, \"mineWindows\"::text, \"mineCut\" FROM \"Season\" WHERE id = $(active)"

echo "== AT-098 existing savings 120,000 (M=60,000): bond 0, reserve Lv3, savings/rate/tech/fund stay 0"
signup carry
req POST /api/season '{"goalAmount":100000,"goalName":"北海道旅行","monthlyBudget":60000,"existingSavings":120000}' >/dev/null
req GET /api/state | j '[o.season.name, o.season.carried, o.dev.reserveLevel, o.dev.nextReserveAt, o.currencies.bond, o.season.savings, o.season.rate, o.tech.level, o.dev.fund, o.dev.interestPerDay]'
req GET /api/state | j 'o.log.filter(e=>e.type==="SEASON_STARTED").map(e=>e.payload)'

echo "== AT-100 overspend within the carried reserve: bond negative, not in debt, no forced bond share"
req POST /api/purchases "{\"amount\":15000,\"date\":\"$TODAY\",\"name\":\"家電\"}" | j '[o.settled, o.payment && o.payment.bond]'
req GET /api/state | j '[o.currencies.bond < 0, o.season.inDebt, o.season.carried.drawn > 0, o.mine.bond.status, o.mine.bond.share, o.dev.reserveLevel, o.dev.interestPerDay]'
echo "   beyond the carried reserve: in debt, forced"
sql "UPDATE \"Season\" SET bond = -130000 WHERE id = $(active)" >/dev/null
req GET /api/state | j '[o.season.inDebt, o.season.carried.drawn, o.mine.bond.status, o.mine.bond.share, o.dev.reserveLevel]'
sql "UPDATE \"Season\" SET bond = 0 WHERE id = $(active)" >/dev/null

echo "== AT-103 goal name: change, clear, too long"
req PATCH /api/season '{"goalName":"  沖縄  旅行 "}' >/dev/null; req GET /api/state | j 'o.season.name'
req PATCH /api/season '{"goalName":"あいうえおかきくけこさしすせそたちつてとな"}' | j 'o.error.message'
req PATCH /api/season '{"goalName":""}' >/dev/null; req GET /api/state | j 'o.season.name'
req PATCH /api/season '{"goalName":"沖縄旅行"}' >/dev/null

echo "== AT-099 / RC-11 correct existing savings within 24h: over 3M splits into reserve + savings; after 24h it is locked"
req PATCH /api/season '{"existingSavings":1000000}' >/dev/null
req GET /api/state | j '[o.season.carried.reserve, o.season.carried.savings, o.dev.reserveLevel, o.season.savings, o.season.rate]'
sql "UPDATE \"Season\" SET \"startedAt\" = \"startedAt\" - interval '25 hours' WHERE id = $(active)" >/dev/null
req PATCH /api/season '{"existingSavings":5}' | j 'o.error.message'
req PATCH /api/season '{"goalName":"沖縄旅行2"}' | j 'o.ok'

echo "== AT-102 complete, then the next start screen offers the previous savings; carry over or not"
sql "UPDATE \"Season\" SET bond = 30000, \"citySpentGold\" = 80000 WHERE id = $(active)" >/dev/null
req GET /api/state | j '[o.season.status, o.season.savings]'
req POST /api/season/complete >/dev/null
req GET /api/seasons | j 'o.items.map(s=>[s.number, s.goalName])'
req GET /api/season/draft | j '[o.first, o.number, o.incomeDayNow, o.previous && [o.previous.number, o.previous.goalName, o.previous.amount]]'
req POST /api/season '{"goalAmount":50000,"monthlyBudget":60000,"existingSavings":1110000,"carryOver":true}' >/dev/null
req GET /api/state | j '[o.season.number, o.season.name, o.season.carried, o.currencies.bond, o.season.savings, o.dev.reserveLevel]'
req GET /api/state | j 'o.log.filter(e=>e.type==="SEASON_STARTED").map(e=>e.payload)'
echo "   negative bond is not carried"
sql "UPDATE \"Season\" SET bond = -2000000, \"citySpentGold\" = 50000, \"reserveCarried\" = 0, \"carriedSavings\" = 0 WHERE id = $(active)" >/dev/null
sql "UPDATE \"Season\" SET status = 'GOAL_REACHED' WHERE id = $(active)" >/dev/null
sql "UPDATE \"Season\" SET status = 'COMPLETED', \"completedAt\" = now() WHERE id = $(active)" >/dev/null
req GET /api/season/draft | j 'o.previous.amount'
req POST /api/season '{"goalAmount":50000}' >/dev/null
req GET /api/state | j '[o.season.number, o.season.carried.reserve, o.season.carried.fromPrevious]'

echo "== AT-104 remaining budget below the prorated amount: the rest of the period pays that much"
signup rem
D=$(req GET "/api/season/draft?budget=60000")
echo "$D" | j '[o.prorated > 0, o.prorated <= 60000, o.net]'
req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000,"remainingBudget":100}' >/dev/null
sql "SELECT \"startRemaining\", \"mineCut\" > 0, \"mineWindows\"::text FROM \"Season\" WHERE id = $(active)"
req POST /api/season '{"goalAmount":20000}' | j 'o.error.code'
echo "   over the monthly budget is rejected"
signup rem2
req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000,"remainingBudget":60001}' | j 'o.error.message'
echo "== AT-105 remaining budget above the prorated amount: a window to the end of the period"
P=$(req GET "/api/season/draft?budget=60000" | j 'o.prorated')
if [ "$P" -lt 60000 ]; then
  req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000,"remainingBudget":60000}' >/dev/null
  sql "SELECT \"startRemaining\", \"mineCut\", jsonb_array_length(\"mineWindows\"), (\"mineWindows\"->0->>'incomeId'), abs((\"mineWindows\"->0->>'total')::bigint / 1000000 - (60000 - $P)) <= 2 FROM \"Season\" WHERE id = $(active)"
else
  echo "(today is the income day: the prorated amount is the whole budget; skipped)"
fi

echo "== AT-106 income day on the first season applies at once; later seasons from the next income day"
signup pay
ND=$(( DAY % 28 + 1 ))
req GET "/api/season/draft?budget=60000&incomeDay=$ND" | j '[o.incomeDay, o.incomeDayNow, new Date(o.period.end + 9*3600e3).getUTCDate()]'
echo "   expected income day: $ND"
req POST /api/season "{\"goalAmount\":20000,\"monthlyBudget\":60000,\"incomeDay\":$ND}" >/dev/null
req GET /api/state | j '[o.user.incomeDay, o.income.day, new Date(o.income.end + 9*3600e3).getUTCDate(), new Date(o.income.start + 9*3600e3).getUTCDate()]'
sql "SELECT \"incomeEras\"::text FROM \"User\" WHERE email = '$EMAIL'"
sql "UPDATE \"Season\" SET bond = 30000 WHERE id = $(active)" >/dev/null
req GET /api/state >/dev/null; req POST /api/season/complete >/dev/null
ND2=$(( ND % 28 + 1 ))
req GET "/api/season/draft?incomeDay=$ND2" | j '[o.first, o.incomeDayNow]'
req POST /api/season "{\"goalAmount\":20000,\"incomeDay\":$ND2}" >/dev/null
sql "SELECT \"incomeDay\", jsonb_array_length(\"incomeEras\") FROM \"User\" WHERE email = '$EMAIL'"

echo "== AT-107 accounts registered before the start show balances; savings accounts feed the default"
signup acc
req GET /api/accounts | j 'o.items.map(a=>[a.name,a.kind,a.balance])'
BANK=$(req POST /api/accounts "{\"name\":\"口座A\",\"kind\":\"BANK\",\"openingBalance\":300000,\"openingDate\":\"$TODAY\"}" | j 'o.id' | tr -d '"')
req POST /api/accounts "{\"name\":\"貯金\",\"kind\":\"BANK\",\"openingBalance\":250000,\"openingDate\":\"$TODAY\",\"isSavings\":true}" >/dev/null
req POST /api/accounts "{\"name\":\"クレカA\",\"kind\":\"CARD\",\"openingBalance\":42000,\"openingDate\":\"$TODAY\",\"closingDay\":$(( DAY > 1 ? DAY - 1 : 31 )),\"paymentDay\":$DAY,\"paymentMonths\":1,\"debitAccountId\":\"$BANK\"}" >/dev/null
req GET /api/season/draft | j '[o.savingsAccounts, o.bondCap]'
req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000,"existingSavings":250000}' >/dev/null
req GET /api/accounts | j '[o.items.map(a=>[a.name,a.balance]), o.total]'
req GET /api/state | j '[o.season.carried.reserve, o.season.carried.savings, o.dev.reserveLevel]'
echo "== OA-06 the first pending bill of a card with an opening unpaid balance carries a note"
# 締め日は今日の前日・引き落としは翌月の今日 → 40日前の利用は今日が引き落とし日
CARD=$(req GET /api/accounts | j 'o.items.find(a=>a.kind==="CARD").id' | tr -d '"')
req POST /api/purchases "{\"amount\":3000,\"date\":\"$AGO40\",\"name\":\"本\",\"accountId\":\"$CARD\"}" >/dev/null
req GET /api/accounts | j 'o.bills.map(b=>[b.cardName, b.amount, b.openingUnpaid])'
echo "done"
