#!/usr/bin/env bash
#
# One curl per Agent API endpoint. See docs/agent-api.md for what each does to
# the carrier and to the database.
#
#   export AGENT_API_KEY="$(cat /root/.config/incomingsms/agent-api-key.test)"
#   export BASE_URL=https://dashboard-test.zalmen-531.workers.dev
#   ./docs/agent-api-examples.sh reads
#
# Nothing runs unless you name a group, because most of these groups reach a
# real carrier and cost real money.

set -euo pipefail

: "${AGENT_API_KEY:?set AGENT_API_KEY}"
: "${BASE_URL:?set BASE_URL, e.g. https://dashboard-test.zalmen-531.workers.dev}"

# Replace these with a SIM you actually mean to touch.
SIM_ID="${SIM_ID:-5345}"
ICCID="${ICCID:-89012804332468992577}"

api() {                     # api <METHOD> <PATH> [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  echo "--- $method $path ${body:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer $AGENT_API_KEY" \
      -H 'Content-Type: application/json' \
      -d "$body" -w '\n[%{http_code}]\n'
  else
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer $AGENT_API_KEY" -w '\n[%{http_code}]\n'
  fi
}

reads() {
  api GET "/api/sims?status=active"
  api GET "/api/sims?id=$SIM_ID"
  api GET "/api/sims?iccid=$ICCID"
  api GET "/api/errors"
  api GET "/api/error-logs?limit=20"
  api GET "/api/hosting-port-status/jobs?limit=5"
  api GET "/api/audit-log?limit=20&actor=apikey:"
}

# Read-only at the carrier, but each one spends carrier rate limit.
queries() {
  api POST "/api/atomic-query"     "{\"identifier\":\"$ICCID\"}"
  api POST "/api/teltik-query"     "{\"iccid\":\"$ICCID\"}"
  api POST "/api/teltik-host-check" "{\"sim_id\":$SIM_ID}"
  api POST "/api/wing-check"       "{\"iccid\":\"$ICCID\"}"
  api POST "/api/helix-query"      '{"mobility_subscription_id":"REPLACE_ME"}'
  api POST "/api/sim-action"       "{\"sim_id\":$SIM_ID,\"action\":\"portin_status\"}"
}

# These change the carrier and the database. Read docs/agent-api.md first.
actions() {
  api POST "/api/sim-action"       "{\"sim_id\":$SIM_ID,\"action\":\"ota_refresh\"}"
  api POST "/api/sim-action"       "{\"sim_id\":$SIM_ID,\"action\":\"rotate\",\"force\":false}"
  api POST "/api/sim-action"       "{\"sim_id\":$SIM_ID,\"action\":\"change_imei\",\"auto_imei\":true}"
  api POST "/api/atomic-sub-action" "{\"sim_id\":$SIM_ID,\"op\":\"suspend\"}"
  api POST "/api/atomic-sub-action" "{\"sim_id\":$SIM_ID,\"op\":\"restore\"}"
  api POST "/api/atomic-swap-sim"  "{\"sim_id\":$SIM_ID,\"new_iccid\":\"REPLACE_ME\"}"
  api POST "/api/atomic-swap-imei" "{\"sim_id\":$SIM_ID,\"imei\":\"356938035643809\"}"
  api POST "/api/suspend"          "{\"sim_ids\":[$SIM_ID]}"
  api POST "/api/restore"          "{\"sim_ids\":[$SIM_ID]}"
  api POST "/api/fix-sim"          "{\"sim_ids\":[$SIM_ID]}"
  api POST "/api/send-test-sms"    '{"gateway_id":1,"port":"1.01","to_number":"5555555555","message":"test"}'
}

# Bulk activation. Expensive, hard to undo, and not part of routine work.
activate() {
  api POST "/api/activate" "{\"sims\":[{\"iccid\":\"$ICCID\"}],\"vendor\":\"atomic\"}"
}

sweep() {
  api POST "/api/hosting-port-status/run" '{"async":true}'
  api POST "/api/hosting-port-status/run" "{\"sim_ids\":[$SIM_ID]}"
  api GET  "/api/hosting-port-status/jobs?limit=5"
}

# Expected to fail with 403 for an operator key. Here so you can confirm the
# fence is up, and see what its refusal looks like.
blocked() {
  api GET  "/api/keys"
  api POST "/api/keys"       '{"name":"nope","role":"admin"}'
  api GET  "/api/users"
  api POST "/api/plan-rates" '{}'
}

case "${1:-}" in
  reads|queries|actions|activate|sweep|blocked) "$1" ;;
  *)
    echo "usage: $0 {reads|queries|actions|activate|sweep|blocked}" >&2
    echo "  reads     no carrier traffic, safe" >&2
    echo "  queries   read-only at the carrier, spends quota" >&2
    echo "  actions   CHANGES the carrier and the database" >&2
    echo "  activate  bulk activation, expensive and hard to undo" >&2
    echo "  sweep     fleet-wide Teltik port-status check" >&2
    echo "  blocked   403s an operator key should get" >&2
    exit 64 ;;
esac
