#!/usr/bin/env bash
# 手取り月収と固定費のスモークテスト（docs/take-home-and-fixed-costs.md §13、AT-108〜122）。
# 使い方: BASE=http://localhost:3100 bash scripts/smoke-fixed-costs.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3100}
JAR=$(mktemp)
EMAIL="fixed$(date +%s)@example.com"
req() { # method path [json]
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" -H "content-type: application/json" -H "origin: $BASE" -H "idempotency-key: $(cat /proc/sys/kernel/random/uuid)" ${3:+-d "$3"}
  echo
}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})" "${@:2}"; }
bal() { req GET /api/accounts | j 'Object.fromEntries(o.items.map(a=>[a.name,a.balance]))'; }
game() { req GET /api/state | j 'JSON.stringify([o.currencies.gold,o.currencies.bond,o.season.savings])'; }
# ゲームの通貨が動いていないか（放置中の配当で数G増えることはあるので、差が 5 以内なら同じとみなす）
same() { node -e "const a=JSON.parse(process.argv[1]),b=JSON.parse(process.argv[2]);console.log('game unchanged:', a.every((v,i)=>Math.abs(v-b[i])<=5)?'yes':'no '+a+' / '+b)" "$1" "$2"; }
parks() { req GET /api/state | j "o.city.buildings.filter(b=>b.special==='park').length"; }
money() { req GET /api/state | j 'JSON.stringify([o.budget, o.mine.breakdown, o.mine.bond.cap, o.dev.base])'; }
TODAY=$(TZ=Asia/Tokyo date +%F)
AGO40=$(TZ=Asia/Tokyo date -d "$TODAY -40 days" +%F)
DAY=$((10#$(TZ=Asia/Tokyo date +%d)))

req POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"timezone\":\"Asia/Tokyo\"}" >/dev/null
BANK=$(req POST /api/accounts "{\"name\":\"口座A\",\"kind\":\"BANK\",\"openingBalance\":300000,\"defaultIncome\":true}" | j 'o.id')
SAVE=$(req POST /api/accounts "{\"name\":\"口座B\",\"kind\":\"BANK\",\"isSavings\":true}" | j 'o.id')

echo "== AT-122 start screen draft: income only -> free budget = income; fixed costs lower the free budget, not the bond cap"
req GET "/api/season/draft?income=180000&incomeDay=$DAY" | j '[o.income, o.fixed, o.budget, o.bondCap]'
# 家賃：支払日は今日（今日から行が出る）。光熱費：支払日なし（期間の初めから並ぶ）。登録は前からあったことにする
RENT=$(req POST /api/subscriptions "{\"kind\":\"FIXED\",\"name\":\"家賃\",\"amount\":80000,\"startDate\":\"$AGO40\",\"payDay\":$DAY,\"accountId\":\"$BANK\"}" | j 'o.id')
POWER=$(req POST /api/subscriptions "{\"kind\":\"FIXED\",\"name\":\"光熱費\",\"amount\":40000,\"startDate\":\"$AGO40\",\"accountId\":\"$BANK\"}" | j 'o.id')
req GET "/api/season/draft?income=180000&incomeDay=$DAY" | j '[o.income, o.fixed, o.budget, o.bondCap, o.prorated <= 60000]'
echo "-- remaining budget is capped by the free budget (60,000), not the income"
req POST /api/season "{\"goalAmount\":500000,\"monthlyIncome\":180000,\"incomeDay\":$DAY,\"remainingBudget\":60001}" | j 'o.error.message'
req POST /api/season "{\"goalAmount\":500000,\"monthlyIncome\":180000,\"incomeDay\":$DAY,\"existingSavings\":600000}" | j '!!o.seasonId'

echo "== AT-108 income 180,000 - fixed 120,000 = free 60,000; sub 6,000 -> net 54,000; bond cap 540,000; base 180,000; carried reserve 540,000"
SUB=$(req POST /api/subscriptions "{\"name\":\"動画配信\",\"amount\":6000,\"startDate\":\"$AGO40\"}" | j 'o.id')
money
req GET /api/state | j '[o.season.carried.reserve, o.season.carried.savings, o.dev.reserveLevel, o.mine.subscriptionsMonthly]'

echo "== AT-115 fixed costs build no park; the subscription builds one"
parks

echo "== AT-110 adding a fixed cost lowers the dividend from now; bond cap, base and carried reserve stay"
EXTRA=$(req POST /api/subscriptions "{\"kind\":\"FIXED\",\"name\":\"保険\",\"amount\":12000,\"startDate\":\"$TODAY\",\"payDay\":$DAY,\"accountId\":\"$BANK\"}" | j 'o.id')
money
req GET /api/state | j '[o.season.carried.reserve, o.season.carried.savings]'

echo "== AT-113 payment rows: fixed costs first; the pay-day row is dated today; rows of the unpaid count show in accounts (AT-121)"
req GET /api/purchases/base | j "o.subscriptions.map(s=>[s.name, s.kind, s.amount, s.date==='$TODAY'])"
req GET /api/accounts | j 'o.unrecorded'
PK=$(req GET /api/purchases/base | j 'o.currentPeriod')

echo "== AT-112 paying at the registered amount moves only the balance (+50S); higher -> -diff from bond with a fee; lower -> +diff to bond"
G0=$(game)
req POST /api/purchases "{\"subscriptionId\":\"$RENT\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":80000}" | j '[o.reward, o.settled, o.resolution]'
same "$G0" "$(game)"
req POST /api/purchases "{\"subscriptionId\":\"$RENT\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":80000}" | j 'o.error.code'
req POST /api/purchases "{\"subscriptionId\":\"$POWER\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":41500}" | j '[o.settled, o.resolution.amount, o.resolution.bond, o.resolution.feeSilver]'
req POST /api/purchases "{\"subscriptionId\":\"$EXTRA\",\"periodKey\":\"$PK\",\"date\":\"$TODAY\",\"amount\":10800}" | j '[o.settled, o.resolution.amount, o.resolution.bond]'
req GET /api/purchases | j 'o.items.map(p=>[p.name, p.isFixedCost, p.isSubscription])'
bal

echo "== AT-114 skip this payment: the row goes away, nothing moves; undo brings it back"
G1=$(game)
req POST /api/subscriptions/$SUB/skip "{\"periodKey\":\"$PK\"}" | j 'o.skipped'
req GET /api/purchases/base | j 'o.subscriptions.length'
req GET /api/accounts | j 'o.unrecorded'
same "$G1" "$(game)"
req POST /api/subscriptions/$SUB/skip "{\"periodKey\":\"$PK\",\"undo\":true}" | j 'o.skipped'
req GET /api/purchases/base | j 'o.subscriptions.map(s=>s.name)'
echo "-- a paid period cannot be skipped"
req POST /api/subscriptions/$RENT/skip "{\"periodKey\":\"$PK\"}" | j 'o.error.code'

echo "== AT-121 reconcile preview warns about unrecorded payments (still allowed)"
BB=$(req GET /api/accounts | j "o.items.find(a=>a.id==='$BANK').balance")
req POST /api/adjustments/quote "{\"accounts\":[{\"accountId\":\"$BANK\",\"actual\":$BB}]}" | j '[o.total, o.unrecorded]'

echo "== AT-115 subscription -> fixed cost: the park goes; dividend and bond cap stay, the free budget shrinks; back again builds the park"
req PATCH /api/subscriptions/$SUB '{"kind":"FIXED"}' >/dev/null
parks; money
req PATCH /api/subscriptions/$SUB '{"kind":"SUBSCRIPTION"}' >/dev/null
parks

echo "== AT-116 fixed costs above the income are saved with a warning; free budget and dividend become 0"
BIG=$(req POST /api/subscriptions "{\"kind\":\"FIXED\",\"name\":\"ローン\",\"amount\":200000,\"startDate\":\"$TODAY\"}" | j 'JSON.stringify([o.id, o.warning])')
echo "$BIG" | j 'o[1]'
req GET /api/state | j '[o.budget.free, o.mine.breakdown.net, o.mine.bond.cap]'
req DELETE /api/subscriptions/$(echo "$BIG" | j 'o[0]') >/dev/null
echo "-- lowering the income below fixed + subs is rejected"
req PATCH /api/settings '{"monthlyIncome":130000}' | j 'o.error && [o.error.code, o.error.details.overruns.length > 0]'
echo "-- raising the income moves the bond cap; the base stays (decided at season start)"
req PATCH /api/settings '{"monthlyIncome":200000}' | j 'o.ok'
req GET /api/state | j '[o.budget, o.mine.bond.cap, o.dev.base]'
req PATCH /api/settings '{"monthlyIncome":180000}' | j 'o.ok'

echo "== AT-117 the monthly income row starts at the take-home income; saving it adds the whole amount to the account, no extra dividend"
req GET /api/incomes/base | j '[o.income, o.periods.map(p=>p.base)]'
CAT=$(req POST /api/categories '{"name":"食費"}' | j 'o.id')
req POST /api/currencies "{\"name\":\"食費コイン\",\"icon\":\"🍙\",\"categoryIds\":[\"$CAT\"],\"rules\":[{\"kind\":\"minute\",\"monthlyAmount\":21000}]}" | j '!!o.id'
echo "-- +10,000 over the base: the ratio preset divides by the free budget (48,000 after 保険): 10000 * 21000 / 48000 = 4375"
req POST /api/incomes/quote "{\"kind\":\"MONTHLY\",\"monthKey\":\"$PK\",\"amount\":190000}" | j '[o.diff, o.rows.map(r=>[r.currency, r.amount])]'
G2=$(game)
B0=$(req GET /api/accounts | j "o.items.find(a=>a.id==='$BANK').balance")
req POST /api/incomes "{\"kind\":\"MONTHLY\",\"monthKey\":\"$PK\",\"amount\":180000}" | j '[o.reward, o.resolution ?? null]'
B1=$(req GET /api/accounts | j "o.items.find(a=>a.id==='$BANK').balance")
echo "bank +$((B1 - B0))"

echo "== AT-118 moving money to the savings account does not move game currencies"
G3=$(game)
req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$SAVE\",\"amount\":30000}" | j 'o.reward'
same "$G3" "$(game)"

echo "== AT-119 income, fixed-cost payments and transfers alone keep the balances right: 300000 + 180000 - 80000 - 41500 - 10800 - 30000 = 317700"
bal

echo "== AT-120 the out-of-budget record API is gone; export has no such records"
curl -sS -o /dev/null -w '%{http_code}\n' -b "$JAR" "$BASE/api/outside"
curl -sS -b "$JAR" "$BASE/api/export" | j '[o.monthlyIncome, o.outsideRecords === undefined, o.subscriptions.map(s=>[s.name, s.kind, s.payDay])]'

echo "== cleanup"; req POST /api/account '{"password":"password123"}' | j 'o.ok'
