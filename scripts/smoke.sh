#!/usr/bin/env bash
# APIのスモークテスト。使い方: BASE=http://localhost:3100 bash scripts/smoke.sh
set -euo pipefail
BASE=${BASE:-http://localhost:3100}
JAR=$(mktemp)
EMAIL="smoke$(date +%s)@example.com"
req() { # method path [json] [idempotency-key]
  local key=${4:-$(uuidgen)}
  curl -sS -b "$JAR" -c "$JAR" -X "$1" "$BASE$2" -H "content-type: application/json" -H "origin: $BASE" -H "idempotency-key: $key" ${3:+-d "$3"}
  echo
}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
TODAY=$(TZ=Asia/Tokyo date +%F)

echo "== signup";        req POST /api/auth/signup "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"timezone\":\"Asia/Tokyo\"}"
echo "== state (no season)"; req GET /api/state | j 'o.season'
echo "== start season";  req POST /api/season '{"goalAmount":20000,"monthlyBudget":60000,"preset":"balanced"}'
echo "== state";         req GET /api/state | j '[o.season.status, o.currencies, o.tech.level, o.dev.level, o.city.buildings.length, o.mine.ratePerMinute.toFixed(3)]'
echo "== subscription";  req POST /api/subscriptions "{\"name\":\"動画配信\",\"amount\":1000,\"cycle\":\"MONTHLY\",\"startDate\":\"2020-01-01\"}"
echo "== wish";          W=$(req POST /api/wishes '{"name":"ヘッドホン","price":8000,"priority":1}' | j 'o.id'); echo $W
echo "== quote shows bond + fee before recording"; req POST /api/purchases/quote "{\"amount\":1200,\"date\":\"$TODAY\"}" | j '[o.settleable, o.payment, o.after]'
echo "== purchase (bond covers the shortfall, gold never negative)"; P=$(req POST /api/purchases "{\"amount\":1200,\"date\":\"$TODAY\",\"name\":\"ランチ\",\"category\":\"食費\"}"); echo $P
PID=$(echo "$P" | j 'o.id')
req GET /api/state | j '[o.currencies.gold, o.currencies.silver, o.currencies.bond, o.mine.bond]'
echo "== edit purchase amount down (no extra reward, +200 surplus goes to bond)"; req PATCH /api/purchases/$PID '{"amount":1000}'
req GET /api/state | j '[o.currencies.gold, o.currencies.silver, o.currencies.bond]'
echo "== categories"; req GET /api/categories | j 'o.items.map(c=>c.name)'
CAT=$(req GET /api/categories | j 'o.items[0].id')
echo "== custom currency over budget is rejected (60000 - 1000 sub)"; req POST /api/currencies "{\"name\":\"食費コイン\",\"icon\":\"🍙\",\"categoryIds\":[\"$CAT\"],\"rules\":[{\"kind\":\"weekly\",\"every\":1,\"weekdays\":[1],\"amount\":12000}]}"
echo "== preview";       req POST /api/currencies/preview "{\"name\":\"食費コイン\",\"icon\":\"🍙\",\"categoryIds\":[\"$CAT\"],\"rules\":[{\"kind\":\"weekly\",\"every\":1,\"weekdays\":[1],\"amount\":7000},{\"kind\":\"minute\",\"monthlyAmount\":3100}]}" | j '[o.next.map(n=>n.date), o.months, o.overruns]'
echo "== create custom currency"; CUR=$(req POST /api/currencies "{\"name\":\"食費コイン\",\"icon\":\"🍙\",\"categoryIds\":[\"$CAT\"],\"rules\":[{\"kind\":\"weekly\",\"every\":1,\"weekdays\":[1],\"amount\":7000},{\"kind\":\"minute\",\"monthlyAmount\":3100}],\"remainder\":\"TO_BOND\",\"remainderDays\":3}" | j 'o.id'); echo $CUR
req GET /api/state | j '[o.mine.breakdown, o.currencies.custom]'
echo "== bad icon rejected"; req POST /api/currencies "{\"name\":\"x\",\"icon\":\"ab\",\"categoryIds\":[\"$CAT\"],\"rules\":[{\"kind\":\"minute\",\"monthlyAmount\":100}]}"
echo "== lowering the budget below S + C is rejected"; req PATCH /api/settings '{"monthlyBudget":30000}' | j 'o.error && [o.error.code, o.error.details.overruns.length]'
echo "== subscription over budget only warns"; SUB2=$(req POST /api/subscriptions "{\"name\":\"高いサブスク\",\"amount\":30000,\"startDate\":\"2020-01-01\"}"); echo "$SUB2" | j '[!!o.id, o.warning]'
req DELETE /api/subscriptions/$(echo "$SUB2" | j 'o.id') >/dev/null
echo "== bond mining rate"; req PATCH /api/settings '{"bondMiningRate":30}'; req GET /api/state | j '[o.user.bondMiningRate, o.mine.bond]'
req PATCH /api/settings '{"bondMiningRate":35}'
PSQL=${PSQL:-docker compose exec -T db psql -U tirelire}
echo "== same idempotency key twice (savings management)"; K=$(uuidgen); req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":5000,\"date\":\"$TODAY\"}" $K; req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":5000,\"date\":\"$TODAY\"}" $K
echo "== savings management does not change savings amount / tech"; req GET /api/state | j '[o.season.savings, o.season.managed, o.tech.level]'
echo "== savings management: 3 per day"; req POST /api/savings "{\"kind\":\"WITHDRAW\",\"amount\":1000,\"date\":\"$TODAY\"}" >/dev/null; req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":1000,\"date\":\"$TODAY\"}" >/dev/null
req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":1000,\"date\":\"$TODAY\"}" | j 'o.error && o.error.code'
req GET /api/savings | j '[o.today, o.limit]'
echo "== daily cap: 4th record gives 0"; req POST /api/purchases "{\"amount\":300,\"date\":\"$TODAY\",\"name\":\"コーヒー\"}"
echo "== g2s with 0 gold fails"; req POST /api/exchange '{"kind":"gold_to_silver","amount":10}'
echo "== silver->wood (no savings)";  req POST /api/exchange '{"kind":"to_resource","currency":"silver","resource":"wood","amount":20}'
echo "== seed 5000 gold, gold->stone adds to savings amount (city spent)"
$PSQL -qtAc "UPDATE \"Season\" SET gold = gold + 5000 WHERE id = (SELECT s.id FROM \"Season\" s JOIN \"User\" u ON u.id = s.\"userId\" WHERE u.email = '$EMAIL' AND s.status <> 'COMPLETED')" >/dev/null
req POST /api/exchange '{"kind":"to_resource","currency":"gold","resource":"stone","amount":2000}'
req GET /api/state | j '[o.currencies.gold, o.season.citySpent, o.season.savings, o.season.rate, o.tech.level, o.wishSavings]'
echo "== gold->bond is 1:1, counted once in savings"; req POST /api/exchange '{"kind":"gold_to_bond","amount":500}'
req GET /api/state | j '[o.currencies.gold, o.currencies.bond, o.season.citySpent, o.season.savings, o.dev.bondMultiplier]'
echo "== silver->bond is not allowed"; req POST /api/exchange '{"kind":"to_bond","currency":"silver","amount":10}'
echo "== custom->bond needs balance"; req POST /api/exchange "{\"kind\":\"to_bond\",\"currency\":\"custom\",\"currencyId\":\"$CUR\",\"amount\":100000}"
echo "== silver shortage: resource exchange fails, bond untouched"; req POST /api/exchange '{"kind":"to_resource","currency":"silver","resource":"wood","amount":100000}'
echo "== wish contribution counts as wish savings"; req POST /api/wishes/$W/contribute '{"amount":500}'
req GET /api/state | j '[o.wishSavings, o.season.savings]'

echo "== income base: unrecorded periods with base B"; req GET /api/incomes/base | j '[o.budget, o.current, o.periods.map(p=>[p.key,p.base,p.current])]'
MK=$(req GET /api/incomes/base | j 'o.current')
echo "== quote monthly +3000 (ratio preset)"; req POST /api/incomes/quote "{\"kind\":\"MONTHLY\",\"monthKey\":\"$MK\",\"amount\":63000}" | j '[o.diff, o.preset, o.rows]'
echo "== record monthly +3000"; INC=$(req POST /api/incomes "{\"kind\":\"MONTHLY\",\"monthKey\":\"$MK\",\"amount\":63000}"); echo "$INC" | j '[o.diff, o.reward]'
INCID=$(echo "$INC" | j 'o.id')
echo "== same period twice is rejected"; req POST /api/incomes "{\"kind\":\"MONTHLY\",\"monthKey\":\"$MK\",\"amount\":60000}" | j 'o.error.code'
echo "== edit monthly income down to 59000 (cancel windows, then remaining mining)"; req POST /api/records/quote-edit "{\"refType\":\"income\",\"id\":\"$INCID\",\"amount\":59000}" | j '[o.diff, o.canceled, o.cutMining, o.shortfall]'
req PATCH /api/incomes/$INCID '{"amount":59000}' | j 'o.resolution && [o.resolution.amount, o.resolution.bond]'
echo "== only amount can be edited"; req PATCH /api/incomes/$INCID '{"name":"x"}' | j 'o.error.message'
echo "== extra income: default is immediate saving (bond -> auto exchange)"; req POST /api/incomes/quote '{"kind":"EXTRA","amount":20000}' | j '[o.preset, o.rows, o.saving.bond, o.saving.resourced]'
req POST /api/incomes "{\"kind\":\"EXTRA\",\"amount\":20000,\"date\":\"$TODAY\",\"name\":\"ボーナス\"}" | j '[o.saved.length, o.saved[0].bond, o.reward]'
req GET /api/state | j '[o.currencies.bond, o.season.savings, o.season.rate, o.season.status, o.tech.level]'
echo "== extra income scheduled to gold on a future date"; FUT=$(TZ=Asia/Tokyo date -d "+3 day" +%F)
req POST /api/incomes "{\"kind\":\"EXTRA\",\"amount\":900,\"date\":\"$TODAY\",\"name\":\"返金\",\"allocation\":[{\"currency\":\"GOLD\",\"amount\":900,\"when\":\"dates\",\"dates\":[\"$FUT\"],\"how\":\"lump\"}]}" | j 'o.id'
req GET /api/incomes | j 'o.items.map(i=>[i.kind,i.name,i.amount,i.pending.length,i.resolutions.length])'
echo "== expense base: subscription rows and wishes"; req GET /api/purchases/base | j '[o.subscriptions.map(s=>[s.name,s.periodKey,s.amount]), o.wishes.map(w=>[w.name,w.price,w.reserved])]'
SUBID=$(req GET /api/purchases/base | j 'o.subscriptions[0].subscriptionId'); SUBPK=$(req GET /api/purchases/base | j 'o.subscriptions[0].periodKey')
echo "== subscription paid 800 (registered 1000) -> +200 surplus"; P2=$(req POST /api/purchases "{\"subscriptionId\":\"$SUBID\",\"periodKey\":\"$SUBPK\",\"date\":\"$TODAY\",\"amount\":800}"); echo "$P2" | j '[o.resolution.amount, o.resolution.bond]'
echo "== same subscription period twice is rejected"; req POST /api/purchases "{\"subscriptionId\":\"$SUBID\",\"periodKey\":\"$SUBPK\",\"date\":\"$TODAY\",\"amount\":800}" | j 'o.error.code'
echo "== edit purchase amount up (shortfall from bond + fee), then cancel"; req PATCH /api/purchases/$PID '{"amount":1500}' | j '[o.resolution.amount, o.resolution.bond, o.resolution.feeSilver, o.resolution.feeBond]'
req PATCH /api/purchases/$PID '{"amount":0}' | j '[o.resolution.amount, o.resolution.bond]'
req PATCH /api/purchases/$PID '{"date":"2020-01-01"}' | j 'o.error.message'
req DELETE /api/purchases/$PID | head -c 80; echo
echo "== estimate (checks default: E5 off)"; req GET /api/adjustments/estimate | j '[o.items, o.checks, o.estimated]'
EST=$(req GET /api/adjustments/estimate | j 'o.estimated')
echo "== save checks (E5 on) and they persist"; req PUT /api/settings/estimate-checks '{"checks":{"E1":true,"E2":true,"E3a":true,"E3b":true,"E4a":true,"E4b":true,"E5":true}}' | j 'o.checks.E5'
req GET /api/adjustments/estimate | j 'o.checks.E5'
EST=$(req GET /api/adjustments/estimate | j 'o.estimated')
echo "== adjustment quote/record: actual = estimate - 1000"; req POST /api/adjustments/quote "{\"actual\":$((EST - 1000))}" | j '[o.diff, o.resolution.bond, o.resolution.feeSilver]'
req POST /api/adjustments "{\"actual\":$((EST - 1000))}" | j '[o.diff, o.resolution.amount]'
echo "== income day 25: next payday onward"; req PATCH /api/settings '{"incomeDay":25}'; req GET /api/state | j '[o.user.incomeDay, o.income]'
echo "== manual build";  req POST /api/city '{"type":"build","line":"housing","x":4,"y":3}'
echo "== rush";          JOB=$(req GET /api/state | j 'o.city.jobs.find(j=>!j.auto)?.id'); req POST /api/city "{\"type\":\"rush\",\"jobId\":\"$JOB\"}"
echo "== zone + policy"; req POST /api/city '{"type":"zone","x":5,"y":6,"zone":"residential"}'; req POST /api/city '{"type":"policy","preset":"housing"}'
echo "== timelapse locked"; SID=$(req GET /api/state | j 'o.season.id'); req GET /api/seasons/$SID/timelapse
echo "== reach goal (savings amount >= goal)"; req GET /api/state | j '[o.season.status, o.season.rate, o.season.savings, o.tech.level]'
echo "== complete";      req POST /api/season/complete
echo "== build after complete fails"; req POST /api/city '{"type":"build","line":"housing","x":3,"y":6}'
echo "== timelapse";     req GET /api/seasons/$SID/timelapse | j '[o.season.number, !!o.start, !!o.final, o.events.length, o.events.map(e=>e.type).filter((v,i,a)=>a.indexOf(v)===i).join(",")]'
echo "== new season keeps history, resets bond and custom balances"; req POST /api/season '{"goalAmount":50000}'; req GET /api/state | j '[o.season.number, o.season.savings, o.currencies, o.tech.level, o.hasArchive]'
req GET /api/purchases | j 'o.items.length'
echo "== export";        curl -sS -b "$JAR" "$BASE/api/export" | head -c 120; echo
echo "== cross-origin rejected"; curl -sS -b "$JAR" -X POST "$BASE/api/mine/collect" -H "origin: https://evil.example" -H "content-type: application/json" -d '{}'; echo
echo "== delete account"; req POST /api/account '{"password":"password123"}'
req GET /api/state
