#!/usr/bin/env bash
# 支払い方法とカードの未払いのスモークテスト（docs/payment-method-sync.md §9）。
# 使い方: BASE=http://localhost:3100 PSQL="psql -h localhost -p 5433 -U tirelire tirelire" bash scripts/smoke-payments.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3100}
PSQL=${PSQL:-docker compose exec -T db psql -U tirelire}
JAR=$(mktemp)
EMAIL="pay$(date +%s)@example.com"
req() { # method path [json]
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" -H "content-type: application/json" -H "origin: $BASE" -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" ${3:+-d "$3"}
  echo
}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})" "${@:2}"; }
TODAY=$(TZ=Asia/Tokyo date +%F)
# 締め日を今日にする（今日の利用は次の引き落としに入る）
DAY=$((10#$(TZ=Asia/Tokyo date +%d)))

req POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"timezone\":\"Asia/Tokyo\"}" >/dev/null
req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000}' >/dev/null

echo "== cash exists from the start, cannot be deleted"
CASH=$(req GET /api/payment-methods | j 'o.items.find(m=>m.kind==="CASH").id')
req GET /api/payment-methods | j '[o.items.map(m=>[m.name,m.kind]), o.reward]'
req DELETE /api/payment-methods/$CASH | j 'o.error.message'

echo "== card: closing today, paid next month on the 27th"
CARD=$(req POST /api/payment-methods "{\"name\":\"テストカード\",\"kind\":\"CARD\",\"closingDay\":$DAY,\"paymentDay\":27,\"paymentMonths\":1}" | j 'o.id')
req POST /api/payment-methods '{"name":"カード","kind":"CARD"}' | j 'o.error.message'
OTHER=$(req POST /api/payment-methods '{"name":"交通系IC","kind":"OTHER"}' | j 'o.id')

echo "== E7 starts at 0, checked by default"; req GET /api/adjustments/estimate | j '[o.items.E7, o.checks.E7, o.cards]'
EST0=$(req GET /api/adjustments/estimate | j 'o.estimated')

echo "== AT-083/061: card purchase settles like cash; reward 50 + 10"
A=$(req POST /api/purchases "{\"amount\":3000,\"date\":\"$TODAY\",\"name\":\"本\",\"paymentMethodId\":\"$CARD\"}")
echo "$A" | j '[o.reward, o.paymentReward, o.settled, o.payment]'
B=$(req POST /api/purchases "{\"amount\":3000,\"date\":\"$TODAY\",\"name\":\"本（未記入）\"}")
echo "$B" | j '[o.reward, o.paymentReward, o.settled, o.payment]'
BID=$(echo "$B" | j 'o.id')

echo "== E7 = 3000 and the estimate rises by it compared with the cash purchase"
req GET /api/adjustments/estimate | j '[o.items.E7, o.cards.map(c=>[c.name,c.amount,c.next])]'

echo "== unfilled list has the second purchase; fill it later with cash -> +10"
req GET /api/purchases/unfilled | j '[o.items.map(p=>p.name), o.reward.remaining]'
req PATCH /api/purchases/$BID "{\"paymentMethodId\":\"$CASH\"}" | j '[o.paymentReward, o.resolution]'
echo "== AT-088/091: change again gives nothing and moves E7, cannot unset"
req PATCH /api/purchases/$BID "{\"paymentMethodId\":\"$CARD\"}" | j 'o.paymentReward'
req GET /api/adjustments/estimate | j 'o.items.E7'
req PATCH /api/purchases/$BID '{"paymentMethodId":null}' | j 'o.error.message'
req PATCH /api/purchases/$BID '{"name":"x"}' | j 'o.error.message'
echo "== AT-089: cancel removes it from E7; canceled purchase cannot take a method"
req PATCH /api/purchases/$BID '{"amount":0}' | j 'o.resolution.amount'
req GET /api/adjustments/estimate | j 'o.items.E7'
req PATCH /api/purchases/$BID "{\"paymentMethodId\":\"$OTHER\"}" | j 'o.error.message'

echo "== AT-084: a purchase 75 days ago is already paid (not in E7)"
LAST=$(TZ=Asia/Tokyo date -d "$TODAY -75 days" +%F)
req POST /api/purchases "{\"amount\":500,\"date\":\"$LAST\",\"name\":\"先月\",\"paymentMethodId\":\"$CARD\"}" | j '[o.reward, o.paymentReward]'
req GET /api/adjustments/estimate | j 'o.items.E7'

echo "== AT-092: subscription with a card fills the row and gives the reward"
SUB=$(req POST /api/subscriptions "{\"name\":\"音楽\",\"amount\":980,\"cycle\":\"MONTHLY\",\"startDate\":\"$TODAY\",\"paymentMethodId\":\"$CARD\"}" | j 'o.id')
req GET /api/purchases/base | j 'o.subscriptions.map(s=>[s.name,s.paymentMethodId===process.argv[1]])' "$CARD"
ROW=$(req GET /api/purchases/base | j 'JSON.stringify(o.subscriptions[0])')
PK=$(echo "$ROW" | j 'o.periodKey')
req POST /api/purchases "{\"subscriptionId\":\"$SUB\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":980}" | j '[o.paymentReward]'
req PATCH /api/subscriptions/$SUB '{"endDate":null}' | j 'o.id ? "kept" : o'
req GET /api/subscriptions | j 'o.items[0].paymentMethodId === process.argv[1]' "$CARD"

echo "== in-use card cannot be deleted, can be archived; archived cannot be chosen"
req DELETE /api/payment-methods/$CARD | j 'o.error.code'
req PATCH /api/payment-methods/$CARD '{"archived":true}' | j 'o.id ? "archived" : o'
req POST /api/purchases "{\"amount\":100,\"date\":\"$TODAY\",\"name\":\"x\",\"paymentMethodId\":\"$CARD\"}" | j 'o.error.message'
req GET /api/adjustments/estimate | j '[o.items.E7, o.cards.length]'

echo "== AT-093: old checks without E7 still count E7"
req PUT /api/settings/estimate-checks '{"checks":{"E1":true,"E2":true,"E3a":true,"E3b":true,"E4a":true,"E4b":true,"E5":false}}' | j 'o.checks.E7'

echo "== AT-090: a purchase from a previous season counts in E7 but gives no reward"
SID=$(req GET /api/state | j 'o.season.id')
P=$(req POST /api/purchases "{\"amount\":700,\"date\":\"$TODAY\",\"name\":\"前のシーズン\"}" | j 'o.id')
$PSQL -qtAc "UPDATE \"Purchase\" SET \"seasonId\" = NULL WHERE id = '$P'" >/dev/null
req PATCH /api/payment-methods/$CARD '{"archived":false}' >/dev/null
req PATCH /api/purchases/$P "{\"paymentMethodId\":\"$CARD\"}" | j 'o.paymentReward'
req GET /api/adjustments/estimate | j 'o.items.E7'

echo "== AT-089: payment reward cap is separate (100/day); record cap stays at 300"
for i in $(seq 1 10); do req POST /api/purchases "{\"amount\":100,\"date\":\"$TODAY\",\"name\":\"飴$i\",\"paymentMethodId\":\"$OTHER\"}" | j '[o.reward, o.paymentReward].join("+")'; done | tr '\n' ' '; echo
req GET /api/state | j '[o.silverMine.todayRewarded, o.silverMine.payment]'

echo "== cleanup"; req POST /api/account '{"password":"password123"}' | j 'o.ok'
