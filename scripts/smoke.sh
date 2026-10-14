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
echo "== purchase";      P=$(req POST /api/purchases "{\"amount\":1200,\"date\":\"$TODAY\",\"name\":\"ランチ\"}"); echo $P
PID=$(echo "$P" | j 'o.id')
echo "== edit purchase (no extra reward)"; req PATCH /api/purchases/$PID '{"amount":1000}'
echo "== same idempotency key twice"; K=$(uuidgen); req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":5000,\"date\":\"$TODAY\"}" $K; req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":5000,\"date\":\"$TODAY\"}" $K
echo "== savings 10000 -> tech 3"; req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":10000,\"date\":\"$TODAY\"}"
echo "== state";         req GET /api/state | j '[o.season.net, o.season.rate, o.tech.level, o.currencies, o.silverMine, o.city.buildings.filter(b=>b.special).map(b=>b.special)]'
echo "== daily cap: 4th record gives 0"; req POST /api/purchases "{\"amount\":300,\"date\":\"$TODAY\",\"name\":\"コーヒー\"}"
echo "== g2s with 0 gold fails"; req POST /api/exchange '{"kind":"gold_to_silver","amount":10}'
echo "== silver->wood";  req POST /api/exchange '{"kind":"to_resource","currency":"silver","resource":"wood","amount":20}'
echo "== manual build";  req POST /api/city '{"type":"build","line":"housing","x":4,"y":3}'
echo "== rush";          JOB=$(req GET /api/state | j 'o.city.jobs.find(j=>!j.auto)?.id'); req POST /api/city "{\"type\":\"rush\",\"jobId\":\"$JOB\"}"
echo "== zone + policy"; req POST /api/city '{"type":"zone","x":5,"y":6,"zone":"residential"}'; req POST /api/city '{"type":"policy","preset":"housing"}'
echo "== timelapse locked"; SID=$(req GET /api/state | j 'o.season.id'); req GET /api/seasons/$SID/timelapse
echo "== reach goal";    req POST /api/savings "{\"kind\":\"DEPOSIT\",\"amount\":5000,\"date\":\"$TODAY\"}"
req GET /api/state | j '[o.season.status, o.season.rate, o.tech.level]'
echo "== complete";      req POST /api/season/complete
echo "== build after complete fails"; req POST /api/city '{"type":"build","line":"housing","x":3,"y":6}'
echo "== timelapse";     req GET /api/seasons/$SID/timelapse | j '[o.season.number, !!o.start, !!o.final, o.events.length, o.events.map(e=>e.type).filter((v,i,a)=>a.indexOf(v)===i).join(",")]'
echo "== new season keeps history"; req POST /api/season '{"goalAmount":50000}'; req GET /api/state | j '[o.season.number, o.season.net, o.currencies, o.tech.level, o.hasArchive]'
req GET /api/purchases | j 'o.items.length'
echo "== export";        curl -sS -b "$JAR" "$BASE/api/export" | head -c 120; echo
echo "== cross-origin rejected"; curl -sS -b "$JAR" -X POST "$BASE/api/mine/collect" -H "origin: https://evil.example" -H "content-type: application/json" -d '{}'; echo
echo "== delete account"; req POST /api/account '{"password":"password123"}'
req GET /api/state
