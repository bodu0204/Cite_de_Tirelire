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
echo "== start season";  req POST /api/season '{"goalAmount":20000,"monthlyIncome":60000,"preset":"balanced"}'
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
echo "== lowering the budget below S + C is rejected"; req PATCH /api/settings '{"monthlyIncome":30000}' | j 'o.error && [o.error.code, o.error.details.overruns.length]'
echo "== subscription over budget only warns"; SUB2=$(req POST /api/subscriptions "{\"name\":\"高いサブスク\",\"amount\":30000,\"startDate\":\"2020-01-01\"}"); echo "$SUB2" | j '[!!o.id, o.warning]'
req DELETE /api/subscriptions/$(echo "$SUB2" | j 'o.id') >/dev/null
echo "== bond mining rate"; req PATCH /api/settings '{"bondMiningRate":30}'; req GET /api/state | j '[o.user.bondMiningRate, o.mine.bond]'
req PATCH /api/settings '{"bondMiningRate":35}'
PSQL=${PSQL:-docker compose exec -T db psql -U tirelire}
echo "== savings management is a transfer to a savings account (docs/money-accounts.md H7)"
BANK=$(req POST /api/accounts "{\"name\":\"口座A\",\"kind\":\"BANK\",\"openingBalance\":100000}" | j 'o.id')
SAVE=$(req POST /api/accounts "{\"name\":\"貯金口座\",\"kind\":\"BANK\",\"isSavings\":true}" | j 'o.id')
echo "== same idempotency key twice (transfer)"; K=$(uuidgen); req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$SAVE\",\"amount\":5000,\"date\":\"$TODAY\"}" $K; req POST /api/transfers "{\"fromAccountId\":\"$BANK\",\"toAccountId\":\"$SAVE\",\"amount\":5000,\"date\":\"$TODAY\"}" $K
echo "== savings transfer does not change savings amount / tech"; req GET /api/state | j '[o.season.savings, o.season.managed, o.tech.level]'
echo "== old savings management is closed"; req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":1000,\"date\":\"$TODAY\"}" | j 'o.error && o.error.code'
echo "== daily cap: 4th record gives 0"; req POST /api/purchases "{\"amount\":300,\"date\":\"$TODAY\",\"name\":\"コーヒー\"}"
echo "== g2s with 0 gold fails"; req POST /api/exchange '{"kind":"gold_to_silver","amount":10}'
echo "== silver->fund is rejected (silver is for repairs and fees)";  req POST /api/exchange '{"kind":"to_resource","currency":"silver","resource":"wood","amount":20}' | j 'o.error && o.error.code'
echo "== no-spend today: confirms unspent dividend into bond / fund"; req POST /api/records/no-spend | j '[o.reward, o.confirmed]'
req GET /api/state | j '[o.currencies.bond, o.mine.uncollected, o.mine.confirmedAt !== null, o.city.treasury]'
echo "== seed 5000 gold, gold->fund adds to savings amount (city spent)"
$PSQL -qtAc "UPDATE \"Season\" SET gold = gold + 5000 WHERE id = (SELECT s.id FROM \"Season\" s JOIN \"User\" u ON u.id = s.\"userId\" WHERE u.email = '$EMAIL' AND s.status <> 'COMPLETED')" >/dev/null
req POST /api/exchange '{"kind":"to_resource","currency":"gold","resource":"stone","amount":2000}'
req GET /api/state | j '[o.currencies.gold, o.season.citySpent, o.season.savings, o.season.rate, o.tech.level, o.wishSavings]'
echo "== gold->bond is 1:1, counted once in savings"; req POST /api/exchange '{"kind":"gold_to_bond","amount":500}'
req GET /api/state | j '[o.currencies.gold, o.currencies.bond, o.season.citySpent, o.season.savings, o.dev.interestPerDay, o.dev.reserveLevel]'
echo "== name and decorate a building with silver (REC-06)"
$PSQL -qtAc "UPDATE \"Season\" SET silver = silver + 1000 WHERE id = (SELECT s.id FROM \"Season\" s JOIN \"User\" u ON u.id = s.\"userId\" WHERE u.email = '$EMAIL' AND s.status <> 'COMPLETED')" >/dev/null
B1=$(req GET /api/state | j 'o.city.buildings.find(b=>b.line==="housing").id')
req POST /api/city/name "{\"buildingId\":\"$B1\",\"name\":\"ひだまり荘\"}" | j '[o.name, o.silver]'
req POST /api/city/decor "{\"buildingId\":\"$B1\",\"decor\":\"fountain\"}" | j '[o.decor, o.silver]'
req GET /api/state | j "[o.currencies.silver, ...(b=>[b.name, b.decor])(o.city.buildings.find(b=>b.id===\"$B1\"))]"
echo "== roads cannot be named; too long names are rejected"; RD=$(req GET /api/state | j 'o.city.buildings.find(b=>b.line==="road").id')
req POST /api/city/name "{\"buildingId\":\"$RD\",\"name\":\"道\"}" | j 'o.error && o.error.code'
req POST /api/city/name "{\"buildingId\":\"$B1\",\"name\":\"とても長い名前をつけようとしてみる\"}" | j 'o.error && o.error.code'
echo "== silver->bond is not allowed"; req POST /api/exchange '{"kind":"to_bond","currency":"silver","amount":10}'
echo "== custom->bond needs balance"; req POST /api/exchange "{\"kind\":\"to_bond\",\"currency\":\"custom\",\"currencyId\":\"$CUR\",\"amount\":100000}"
echo "== silver exchange to fund is rejected, bond untouched"; req POST /api/exchange '{"kind":"to_resource","currency":"silver","resource":"wood","amount":100000}'
echo "== wish contribution counts as wish savings"; req POST /api/wishes/$W/contribute '{"amount":500}'
req GET /api/state | j '[o.wishSavings, o.season.savings]'
echo "== wish purchase before fully saved is rejected"; req POST /api/purchases "{\"wishItemId\":\"$W\",\"date\":\"$TODAY\",\"amount\":8000}" | j 'o.error && o.error.code'

echo "== income base: unrecorded periods with base M (take-home income)"; req GET /api/incomes/base | j '[o.income, o.current, o.periods.map(p=>[p.key,p.base,p.current])]'
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
echo "== choose the currency to pay with (docs/bond-and-custom-currency.md 6.3): 食費コイン 1000 + gold 1000 from an extra income"
req POST /api/incomes "{\"kind\":\"EXTRA\",\"amount\":2000,\"date\":\"$TODAY\",\"name\":\"おこづかい\",\"allocation\":[{\"currency\":\"CUSTOM\",\"currencyId\":\"$CUR\",\"amount\":1000,\"when\":\"now\",\"how\":\"lump\"},{\"currency\":\"GOLD\",\"amount\":1000,\"when\":\"now\",\"how\":\"lump\"}]}" | j '!!o.id'
echo "== default order pays with the custom currency first; sources list what can be chosen"; req POST /api/purchases/quote "{\"amount\":300,\"date\":\"$TODAY\",\"categoryId\":\"$CAT\"}" | j '[o.sources.map(s=>s.currency), o.payment.custom.reduce((a,c)=>a+c.amount,0), o.payment.gold + o.payment.draw]'
echo "== choosing gold keeps the custom currency"; req POST /api/purchases/quote "{\"amount\":300,\"date\":\"$TODAY\",\"categoryId\":\"$CAT\",\"payWith\":[{\"currency\":\"GOLD\"}]}" | j '[o.payment.custom.length, o.payment.gold + o.payment.draw, o.payment.bond]'
echo "== combined: custom 100 + gold 200"; req POST /api/purchases "{\"amount\":300,\"date\":\"$TODAY\",\"name\":\"おやつ\",\"categoryId\":\"$CAT\",\"payWith\":[{\"currency\":\"CUSTOM\",\"currencyId\":\"$CUR\",\"amount\":100},{\"currency\":\"GOLD\",\"amount\":200}]}" | j '[o.payment.custom.reduce((a,c)=>a+c.amount,0), o.payment.gold + o.payment.draw, o.payment.bond]'
echo "== only the chosen currency is used; the shortfall is paid with bonds (custom 900 left, amount 1500)"; req POST /api/purchases/quote "{\"amount\":1500,\"date\":\"$TODAY\",\"categoryId\":\"$CAT\",\"payWith\":[{\"currency\":\"CUSTOM\",\"currencyId\":\"$CUR\"}]}" | j '[o.payment.custom.reduce((a,c)=>a+c.amount,0) >= 900, o.payment.gold, o.payment.draw + o.payment.bond > 0]'
echo "== sources are listed before an amount is entered"; req POST /api/purchases/quote "{\"date\":\"$TODAY\",\"categoryId\":\"$CAT\"}" | j '[o.settleable, o.sources.map(s=>s.currency), o.after]'
echo "== more than the balance / more than the amount is rejected"; req POST /api/purchases/quote "{\"amount\":300,\"date\":\"$TODAY\",\"categoryId\":\"$CAT\",\"payWith\":[{\"currency\":\"CUSTOM\",\"currencyId\":\"$CUR\",\"amount\":999999}]}" | j 'o.error && o.error.code'
req POST /api/purchases/quote "{\"amount\":300,\"date\":\"$TODAY\",\"categoryId\":\"$CAT\",\"payWith\":[{\"currency\":\"CUSTOM\",\"currencyId\":\"$CUR\",\"amount\":200},{\"currency\":\"GOLD\",\"amount\":200}]}" | j 'o.error && o.error.code'
echo "== expense base: subscription rows and wishes"; req GET /api/purchases/base | j '[o.subscriptions.map(s=>[s.name,s.periodKey,s.amount]), o.wishes.map(w=>[w.name,w.price,w.reserved])]'
SUBID=$(req GET /api/purchases/base | j 'o.subscriptions[0].subscriptionId'); SUBPK=$(req GET /api/purchases/base | j 'o.subscriptions[0].periodKey')
echo "== subscription paid 800 (registered 1000) -> +200 surplus"; P2=$(req POST /api/purchases "{\"subscriptionId\":\"$SUBID\",\"periodKey\":\"$SUBPK\",\"date\":\"$TODAY\",\"amount\":800}"); echo "$P2" | j '[o.resolution.amount, o.resolution.bond]'
echo "== same subscription period twice is rejected"; req POST /api/purchases "{\"subscriptionId\":\"$SUBID\",\"periodKey\":\"$SUBPK\",\"date\":\"$TODAY\",\"amount\":800}" | j 'o.error.code'
echo "== edit purchase amount up (shortfall from bond + fee), then cancel"; req PATCH /api/purchases/$PID '{"amount":1500}' | j '[o.resolution.amount, o.resolution.bond, o.resolution.feeSilver, o.resolution.feeBond]'
req PATCH /api/purchases/$PID '{"amount":0}' | j '[o.resolution.amount, o.resolution.bond]'
req PATCH /api/purchases/$PID '{"date":"2020-01-01"}' | j 'o.error.message'
req DELETE /api/purchases/$PID | head -c 80; echo
echo "== reconcile (docs/money-accounts.md §9): wallet is 1000 short -> total -1000 from bond"
WAL=$(req GET /api/accounts | j 'o.items.find(a=>a.kind==="CASH").id'); WB=$(req GET /api/accounts | j 'o.items.find(a=>a.kind==="CASH").balance')
req POST /api/adjustments/quote "{\"accounts\":[{\"accountId\":\"$WAL\",\"actual\":$((WB - 1000))}]}" | j '[o.total, o.resolution.bond, o.resolution.feeSilver, o.partial]'
req POST /api/adjustments "{\"accounts\":[{\"accountId\":\"$WAL\",\"actual\":$((WB - 1000))}]}" | j '[o.total, o.resolution.amount]'
req GET /api/accounts | j 'o.items.find(a=>a.kind==="CASH").balance'
echo "== income day 25: next payday onward"; req PATCH /api/settings '{"incomeDay":25}'; req GET /api/state | j '[o.user.incomeDay, o.income]'
echo "== timelapse locked"; SID=$(req GET /api/state | j 'o.season.id'); req GET /api/seasons/$SID/timelapse
echo "== reserve facilities: bond of 0.5M raises the reserve level; the facility is built on the next 10-minute tick (RSV-03)"
$PSQL -qtAc "UPDATE \"Season\" SET bond = bond + 40000 WHERE id = '$SID'" >/dev/null
req GET /api/state | j '[o.dev.reserveLevel, o.city.buildings.filter(b=>b.special==="reserve").map(b=>[b.tier, b.x, b.y])]'
echo "== reach goal (savings amount >= goal)"; req GET /api/state | j '[o.season.status, o.season.rate, o.season.savings, o.tech.level]'
echo "== complete";      req POST /api/season/complete
echo "== timelapse";     req GET /api/seasons/$SID/timelapse | j '[o.season.number, !!o.start, !!o.final, o.events.length, o.events.map(e=>e.type).filter((v,i,a)=>a.indexOf(v)===i).join(",")]'
echo "== new season keeps history, resets bond and custom balances"; req POST /api/season '{"goalAmount":50000}'; req GET /api/state | j '[o.season.number, o.season.savings, o.currencies, o.tech.level, o.hasArchive]'
req GET /api/purchases | j 'o.items.length'
echo "== timelapse fireworks are bought with the current season's silver (REC-06)"
$PSQL -qtAc "UPDATE \"Season\" SET silver = silver + 500 WHERE id = (SELECT s.id FROM \"Season\" s JOIN \"User\" u ON u.id = s.\"userId\" WHERE u.email = '$EMAIL' AND s.status <> 'COMPLETED')" >/dev/null
req POST /api/seasons/$SID/timelapse/fx '{"fx":"fireworks"}' | j '[o.fx, o.silver]'
req POST /api/seasons/$SID/timelapse/fx '{"fx":"fireworks"}' | j '[o.fx, o.silver]'
req GET /api/seasons/$SID/timelapse | j 'o.season.fx'
echo "== export";        curl -sS -b "$JAR" "$BASE/api/export" | head -c 120; echo
echo "== cross-origin rejected"; curl -sS -b "$JAR" -X POST "$BASE/api/mine/collect" -H "origin: https://evil.example" -H "content-type: application/json" -d '{}'; echo
echo "== delete account"; req POST /api/account '{"password":"password123"}'
req GET /api/state
