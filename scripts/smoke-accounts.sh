#!/usr/bin/env bash
# お金の置き場所と振替のスモークテスト（docs/money-accounts.md §14、AT-083〜093）。
# 使い方: BASE=http://localhost:3100 PSQL="psql -h localhost -p 5433 -U tirelire tirelire" bash scripts/smoke-accounts.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3100}
PSQL=${PSQL:-docker compose exec -T db psql -U tirelire}
JAR=$(mktemp)
EMAIL="acc$(date +%s)@example.com"
req() { # method path [json]
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" -H "content-type: application/json" -H "origin: $BASE" -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" ${3:+-d "$3"}
  echo
}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})" "${@:2}"; }
bal() { req GET /api/accounts | j 'Object.fromEntries(o.items.map(a=>[a.name,a.balance]))'; }
# ゲームの通貨が動いていないか（放置中の債券化で数G増えることはあるので、差が 5 以内なら同じとみなす）
same() { node -e "const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);console.log('game unchanged:', a.every((v,i)=>Math.abs(v-b[i])<=5)?'yes':'no '+a+' / '+b)" "$1" "$2"; }
TODAY=$(TZ=Asia/Tokyo date +%F)
AGO40=$(TZ=Asia/Tokyo date -d "$TODAY -40 days" +%F)
DAY=$((10#$(TZ=Asia/Tokyo date +%d)))

req POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"timezone\":\"Asia/Tokyo\"}" >/dev/null
req POST /api/season '{"goalAmount":20000,"monthlyIncome":60000}' >/dev/null

echo "== wallet A exists from the start and is the default spend account"
req GET /api/accounts | j '[o.items.map(a=>[a.name,a.kind]), o.defaults.spend===o.items[0].id, o.reward]'
WAL=$(req GET /api/accounts | j 'o.items[0].id')

echo "== AT-083 register accounts with opening balances (card unpaid is negative), opened 40 days ago"
BANK=$(req POST /api/accounts "{\"name\":\"口座A\",\"kind\":\"BANK\",\"openingBalance\":100000,\"openingDate\":\"$AGO40\",\"defaultIncome\":true}" | j 'o.id')
SAVE=$(req POST /api/accounts "{\"name\":\"口座B\",\"kind\":\"BANK\",\"isSavings\":true,\"openingDate\":\"$AGO40\"}" | j 'o.id')
# 締め日は今日の前日（今日の利用は来月の請求）。引き落としは翌月の今日 → 40日前の利用は今日が引き落とし日
CLOSE=$(( DAY > 1 ? DAY - 1 : 31 ))
CARD=$(req POST /api/accounts "{\"name\":\"クレカA\",\"kind\":\"CARD\",\"openingBalance\":2000,\"openingDate\":\"$AGO40\",\"closingDay\":$CLOSE,\"paymentDay\":$DAY,\"paymentMonths\":1,\"debitAccountId\":\"$BANK\"}" | j 'o.id')
IC=$(req POST /api/accounts "{\"name\":\"Suica\",\"kind\":\"EMONEY\",\"openingDate\":\"$AGO40\"}" | j 'o.id')
req PATCH /api/accounts/$WAL "{\"openingDate\":\"$AGO40\",\"openingBalance\":5000}" >/dev/null
req POST /api/accounts '{"name":"x","kind":"CARD","defaultSpend":true,"closingDay":1,"paymentDay":1}' | j 'o.error.message'
bal

echo "== AT-084 expense from default wallet (no extra reward), from card (+10); income to default income account"
req POST /api/purchases "{\"amount\":800,\"date\":\"$TODAY\",\"name\":\"ランチ\"}" | j '[o.reward, o.paymentReward, o.settled]'
req POST /api/purchases "{\"amount\":3000,\"date\":\"$AGO40\",\"name\":\"本\",\"accountId\":\"$CARD\"}" | j '[o.reward, o.paymentReward]'
P3=$(req POST /api/purchases "{\"amount\":1200,\"date\":\"$TODAY\",\"name\":\"雑貨\"}" | j 'o.id')
req POST /api/incomes "{\"kind\":\"EXTRA\",\"amount\":10000,\"date\":\"$TODAY\",\"name\":\"お祝い\"}" | j 'o.reward'
bal

echo "== RS-04 move an expense to Suica later (+10 the first time), back again gives nothing"
req PATCH /api/purchases/$P3 "{\"accountId\":\"$IC\"}" | j '[o.paymentReward, o.resolution]'
req PATCH /api/purchases/$P3 "{\"accountId\":\"$WAL\"}" | j 'o.paymentReward'
req PATCH /api/purchases/$P3 "{\"accountId\":\"$IC\"}" | j 'o.paymentReward'
req PATCH /api/purchases/$P3 '{"name":"x"}' | j 'o.error.message'

echo "== AT-085 transfers move balances, not game currencies; edit and cancel"
G0=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
T1=$(req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$WAL\",\"amount\":10000,\"memo\":\"ATM\"}" | j 'o.id')
req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$IC\",\"amount\":3000}" | j 'o.reward'
req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$BANK\",\"amount\":3000}" | j 'o.error.message'
G1=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
same "$G0" "$G1"
bal
req PATCH /api/transfers/$T1 '{"amount":0}' >/dev/null; bal

echo "== AT-091 transfer to savings account counts as savings management"
req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$SAVE\",\"amount\":20000}" >/dev/null
req POST /api/transfers "{\"fromAccountId\":\"$SAVE\",\"toAccountId\":\"$WAL\",\"amount\":5000}" >/dev/null
req GET /api/state | j 'o.season.managed'
req GET /api/accounts | j 'o.pairs.length'

echo "== AT-086/087 card bill appears on the due date with the billed amount; confirm with a fixed amount"
req GET /api/accounts | j 'o.bills.map(b=>[b.cardName,b.dueDate,b.amount])'
BILL=$(req GET /api/accounts | j 'o.bills[0].id')
req POST /api/card-bills/$BILL/confirm '{"amount":5000}' | j '[o.reward, !!o.transferId]'
req POST /api/card-bills/$BILL/confirm '{"amount":5000}' | j 'o.error.code'
bal

echo "== fixed-cost rent paid at the registered amount: only the balance moves (docs/take-home-and-fixed-costs.md FC-13)"
RENT=$(req POST /api/subscriptions "{\"kind\":\"FIXED\",\"name\":\"家賃\",\"amount\":50000,\"startDate\":\"$TODAY\",\"accountId\":\"$BANK\"}" | j 'o.id')
G2=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
PK=$(req GET /api/purchases/base | j "o.subscriptions.find(s=>s.subscriptionId==='$RENT').periodKey")
req POST /api/purchases "{\"subscriptionId\":\"$RENT\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":50000}" | j '[o.settled, o.resolution]'
G3=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
same "$G2" "$G3"
# 固定費は配当から引くので、テストの残りに影響しないよう消す（支払いの記録は残る）
req DELETE /api/subscriptions/$RENT >/dev/null
echo "== the out-of-budget record API is gone"; curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" "$BASE/api/outside"
bal

echo "== AT-088 reconcile: forgotten ATM (bank -10000, wallet +10000) -> total 0, game unchanged"
B=$(req GET /api/accounts | j 'JSON.stringify(Object.fromEntries(o.items.map(a=>[a.id,a.balance])))')
BB=$(echo "$B" | j "o['$BANK']"); WB=$(echo "$B" | j "o['$WAL']")
req POST /api/adjustments/quote "{\"accounts\":[{\"accountId\":\"$BANK\",\"actual\":$((BB - 10000))},{\"accountId\":\"$WAL\",\"actual\":$((WB + 10000))}]}" | j '[o.total, o.resolution, o.partial]'
G4=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
req POST /api/adjustments "{\"accounts\":[{\"accountId\":\"$BANK\",\"actual\":$((BB - 10000))},{\"accountId\":\"$WAL\",\"actual\":$((WB + 10000))}]}" | j '[o.total, o.resolution]'
G5=$(req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])')
same "$G4" "$G5"
bal

echo "== AT-089 reconcile: wallet is 800 short -> -800 from bond with a fee; card actual is entered as unpaid"
WB=$(req GET /api/accounts | j "o.items.find(a=>a.id==='$WAL').balance")
CB=$(req GET /api/accounts | j "-o.items.find(a=>a.id==='$CARD').balance")
req POST /api/adjustments "{\"accounts\":[{\"accountId\":\"$WAL\",\"actual\":$((WB - 800))},{\"accountId\":\"$CARD\",\"actual\":$CB}]}" | j '[o.total, o.resolution.bond, o.resolution.feeSilver, o.rows.map(r=>[r.name,r.diff])]'
req POST /api/adjustments "{\"accounts\":[{\"accountId\":\"$CARD\",\"actual\":$CB}]}" | j 'o.error.message'
bal

echo "== AT-092 used account cannot be deleted, can be archived; archived cannot be chosen; default cannot be archived"
req DELETE /api/accounts/$IC | j 'o.error.code'
req PATCH /api/accounts/$WAL '{"archived":true}' | j 'o.error.message'
req PATCH /api/accounts/$IC '{"archived":true}' | j 'o.id ? "archived" : o'
req POST /api/purchases "{\"amount\":100,\"date\":\"$TODAY\",\"name\":\"x\",\"accountId\":\"$IC\"}" | j 'o.error.message'
EMPTY=$(req POST /api/accounts '{"name":"空","kind":"CASH"}' | j 'o.id'); req DELETE /api/accounts/$EMPTY | j 'o.id ? "deleted" : o'

echo "== AT-090 extra reward cap is separate (100/day)"
for i in $(seq 1 8); do req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$WAL\",\"amount\":100}" | j 'o.reward'; done | tr '\n' ' '; echo
req GET /api/state | j '[o.silverMine.todayRewarded, o.silverMine.extra]'

echo "== export includes accounts"; curl -sS -b "$JAR" "$BASE/api/export" | j '[o.accounts.length, o.transfers.length, o.cardBills.length, o.outsideRecords === undefined, o.accountAdjustments.length]'
echo "== cleanup"; req POST /api/account '{"password":"password123"}' | j 'o.ok'
