# Agent API

Written for an AI agent that operates the SIM fleet.

## Purpose

Every action you take on a SIM goes through this API. Do not call Teltik,
ATOMIC, Helix, or Wing directly, even when you hold credentials for them and
the carrier call looks simpler.

The reason is state, not policy. A carrier call made outside this API changes
the carrier and nothing else: the `sims` row still says `active` after you
suspended the line, `sim_numbers` still holds the old MDN after you rotated it,
and no row lands in `carrier_api_logs` for anyone to find later. The fleet's
database then disagrees with reality, and the workers that act on that database
— the rotation cron, the details finalizer, the port-in poller, the bad-rental
remediator — act on the wrong picture.

Each endpoint below runs the same handler a human operator's click runs, so the
database side effects are identical whoever made the call.

## Base URLs

| Environment | URL |
|---|---|
| TEST | `https://dashboard-test.zalmen-531.workers.dev` |
| PROD | `https://dashboard.zalmen-531.workers.dev` |

TEST talks to the `incomingsms-test` Supabase project and to test worker
bindings. It does not hold carrier secrets, so carrier routes there answer with
a configuration error rather than reaching a carrier — useful for checking
shapes and permissions, useless for checking carrier behaviour.

## Authentication

Send your key in either header. They are equivalent; pick one and keep to it.

```
Authorization: Bearer zmaw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X-Api-Key: zmaw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

A key is `zmaw_<env>_<32 base62 characters>`, where `env` is `test` or `live`.
The env segment is checked, so a TEST key sent to PROD fails on format and
never reaches a lookup.

The key is stored as a SHA-256 hash and cannot be recovered. If you lose it, an
admin creates a new one and revokes the old one.

## Errors

Every response is JSON. Authentication and authorization failures use a fixed
shape:

```json
{ "ok": false, "error": "unauthorized", "message": "Not authenticated" }
```

```json
{
  "ok": false,
  "error": "forbidden",
  "required_role": "admin",
  "role": "operator",
  "message": "Your role (operator) is not permitted to perform this action"
}
```

| Status | Meaning | What to do |
|---|---|---|
| 400 | Your request body is wrong | Fix the body. Retrying unchanged will not help. |
| 401 | Key missing, malformed, revoked, or disabled | Stop and escalate. Do not retry. |
| 403 | The key's role is not allowed here | Stop. `required_role` tells you what it would take. Do not retry. |
| 404 | The SIM or record does not exist | Check the identifier. |
| 409 | Conflicts with existing state | Read the message; the state is not what you assumed. |
| 500 | Handler or carrier failure | Safe to retry once, after a pause. Then escalate. |
| 502 | A dependency (Supabase, a worker) failed | Retry once, then escalate. |

Handler-level failures do not always use `error: 'forbidden'`-style codes. Most
carrier routes answer `{ "ok": false, "error": "<what went wrong>" }` with the
detail nested under `detail`. Treat `ok: false` as failure regardless of the
HTTP status: several carrier APIs return HTTP 200 with a failure in the body,
and the handlers preserve that distinction rather than flattening it.

## The role fence

Your key carries a role from the same three the portal gives people:
`viewer`, `operator`, `admin`. The agent key is **operator**. One matrix
(`requiredRole()` in `src/shared/portal-auth.mjs`) decides every request, so an
operator key is refused exactly where an operator human is refused.

The matrix is path-first, not method-first: a route is treated as mutating
because of where it lives, not because you sent a POST. Anything not on the
explicit read list needs operator or above. This is deliberate — a new route is
closed by default.

**Allowed to operator** — every endpoint documented below.

**Blocked to operator.** These return 403 with `required_role: "admin"`. Do not
retry them; ask a human.

| Path | Why |
|---|---|
| `/api/users`, `/api/invites` | Managing who can log in. |
| `/api/keys`, `/api/keys/revoke` | Managing credentials. Also closed to API keys of *any* role, including admin: a leaked key must not mint its own replacement. |
| `/api/billing/*` (writes), `/api/billing-ledger` (writes), `/api/bill-audit/*` (writes) | Money. Readable by any signed-in role, mutable only by admins. |
| `/api/qbo*`, `/api/plan-rates` (writes), `/api/reseller-rates` (writes) | Money. |
| `/api/reseller-keys`, `/api/reseller-credentials` | Third-party credentials. |

Reading billing data is allowed; changing it is not.

## Audit

Every request you make lands in `dashboard_audit_log`, attributed to
`apikey:<your key name>`. The actor is taken from your key, never from the
request body — some handlers accept a `body.actor` field for display in their
own tables, and you may set it, but it does not change who the audit says you
are. Assume everything you do is attributable and reviewable.

---

# Endpoints

Unless stated otherwise: `Content-Type: application/json`, and the SIM is
identified by `sim_id` (the integer `sims.id`), not by ICCID.

## Reads

### GET /api/sims

Lists SIMs with their gateway, current number, reseller and 24-hour SMS counts.
This is how you find the fleet.

| Query param | Type | Notes |
|---|---|---|
| `id` | int | Single SIM by `sims.id`. |
| `iccid` | string | Single SIM by ICCID. |
| `status` | string | `active`, `provisioning`, `suspended`, `canceled`, `error`. |
| `reseller_id` | int | Filter to one reseller. |
| `hide_cancelled` | `true`/`false` | Defaults to `true`. |

Carrier side: nothing. Database: nothing written.

```json
{
  "sims": [
    {
      "id": 5345,
      "iccid": "89012804332468992577",
      "imei": "356938035643809",
      "msisdn": "3855869698",
      "status": "active",
      "vendor": "atomic",
      "gateway_host": "teltik",
      "port": "1.01",
      "port_in_pending": false,
      "atomic_portin_status_code": "CO",
      "gateways": { "code": "GW1", "name": "Gateway 1" },
      "sim_numbers": [{ "e164": "+13855869698", "verification_status": "verified" }],
      "reseller_sims": [{ "reseller_id": 4, "resellers": { "name": "Acme" } }],
      "sms_24h": 12,
      "last_received": "2026-09-10T15:22:04Z"
    }
  ]
}
```

```bash
curl -s -H "Authorization: Bearer $AGENT_API_KEY" \
  "$BASE_URL/api/sims?status=active"
```

`gateway_host` is the field that matters for the hosting job: `teltik` means
the SIM sits in Teltik's hardware, `skyline` means our own gateway.

### GET /api/errors and GET /api/error-logs

Open entries from `system_errors`, newest first. `/api/errors` is the summary
the dashboard's Errors tab reads; `/api/error-logs` is the raw log. Use these
to find out what already failed before you act.

### GET /api/hosting-port-status/jobs

Recent durable hosting-port sweeps from `hosting_port_status_jobs`, newest
first. Accepts `?limit=`. Use it to see whether a sweep is already running
before you start another.

### GET /api/audit-log

What has been done, by whom. Operator and above.

| Query param | Type | Notes |
|---|---|---|
| `limit` | int | 1–1000, default 200. |
| `actor` | string | Substring match, e.g. `apikey:agent`. |
| `path` | string | Substring match, e.g. `/api/sim-action`. |
| `since` | ISO 8601 | Rows at or after this instant. |

```json
{
  "ok": true,
  "count": 1,
  "rows": [
    {
      "id": 10,
      "ts": "2026-09-10T16:09:25.024677+00:00",
      "actor": "apikey:agent-test",
      "actor_type": "api_key",
      "role": "operator",
      "method": "POST",
      "path": "/api/sim-action",
      "sim_id": "5345",
      "iccid": null,
      "mdn": null,
      "action": "ota_refresh",
      "status": 200,
      "ok": true,
      "duration_ms": 85
    }
  ]
}
```

Read this before a remediation run. It is how you find out you already tried
something an hour ago.

## Carrier queries — read-only, but they spend quota

These change nothing. They still cost carrier rate limit, so treat them as
actions you budget, not as free lookups.

### POST /api/atomic-query

ATOMIC (AT&T) subscriber inquiry.

| Field | Type | Required | Notes |
|---|---|---|---|
| `identifier` | string | yes | ICCID (starts `89`, 19–20 digits) or MSISDN. The handler decides which by shape. |

Carrier side: `subsriberInquiry` against the ATOMIC wholesale API. Read-only.
Database: a row in `carrier_api_logs`. Nothing on `sims`.

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"89012804332468992577"}' \
  "$BASE_URL/api/atomic-query"
```

### POST /api/teltik-query

Teltik ICCID lookup.

| Field | Type | Required |
|---|---|---|
| `iccid` | string | yes |

Carrier side: Teltik `/v1/get-phone-number`. Read-only. Database:
`carrier_api_logs`.

Note the limit: `/v1/get-phone-number` only covers Teltik's own T-Mobile SIMs
and answers `404 Invalid ICCID` for AT&T SIMs sitting in Teltik hardware, which
is most of the fleet. For those, use `/api/teltik-host-check`.

### POST /api/teltik-host-check

Whether a Teltik-hosted line's port is up. This is the endpoint for the hosting
job, and the one to reach for when `teltik-query` returns a 404.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sim_id` | int | one of | Preferred. |
| `iccid` | string | one of | Used to resolve `sim_id` when that is absent. |
| `mdn` | string | no | Overrides the resolved MDN. Rarely correct — see below. |
| `vendor`, `gateway_host` | string | no | Skip a DB lookup if you already know them. |

Carrier side: Teltik `/v1/all-lines` and `/v1/get-info`. Read-only. Database:
`carrier_api_logs`, plus a row in `hosting_port_status_checks`.

**The MDN trap.** Teltik keeps the *first* MDN it saw for a line. Our rotations
do not sync back to Teltik, so our current MDN is usually not the key Teltik
answers to, and querying with it returns `404 Incorrect Phone Number` — a
wrong-key error that reads exactly like a dead line. The handler resolves the
Teltik-known MDN for you from inbound SMS payloads and `/v1/all-lines`. Let it.
Only pass `mdn` if you have a specific reason, and never pass our DB MDN.

### POST /api/wing-check

Wing IoT device status by ICCID. Body: `{ "iccid": "..." }`. Read-only;
`carrier_api_logs`.

Wing IoT is cancelled as a product line and all SIMs are Teltik-hosted, so this
is a diagnostic for legacy rows, not part of normal work.

### POST /api/helix-query

Helix (T-Mobile) subscriber lookup. Body:
`{ "mobility_subscription_id": "..." }`. Returns HTTP 503 with
`{"error":"helix_disabled"}` unless `HELIX_ENABLED` is `true` on the worker.
Read-only; `carrier_api_logs`.

## SIM actions

### POST /api/sim-action

The general per-SIM action route. One SIM per call.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sim_id` | int | yes | |
| `action` | enum | yes | See the table below. |
| `force` | bool | no | `rotate` only. Bypasses the once-a-day dedup guard. |
| `new_imei` | string | no | `change_imei`. 15 digits. |
| `auto_imei` | bool | no | `change_imei`. Take the next IMEI from the pool. |
| `imei_strategy` | string | no | `retry_activation`. `same` reuses the failed IMEI, `new` retires it and allocates another. |
| `gateway_id`, `port` | | no | `fix`, when the SIM's slot is not already known. |

| `action` | What happens at the carrier | What is written |
|---|---|---|
| `rotate` | New MDN. Teltik SIMs go through `teltik-worker`; others through `mdn-rotator`. | `sims.msisdn`, `sims.last_mdn_rotated_at`, a new `sim_numbers` row with the old one closed off, `carrier_api_logs`. |
| `ota_refresh` | Teltik SIMs: a Teltik `/v1/reset-port` — an operator label, on the wire a gateway port reset, not a carrier OTA. Others: an OTA refresh via `mdn-rotator`. | `carrier_api_logs`; `system_errors` on failure. |
| `cancel` | Deactivates the subscriber. | `sims.status = 'canceled'`, reseller assignment released. |
| `resume` | Reconnects a suspended subscriber. | `sims.status = 'active'`. |
| `fix` | The repair sequence: change IMEI, then OTA, cancel and resume. | `sims.imei`, `imei_pool`, `carrier_api_logs`. |
| `retry_activation` | Re-runs a failed activation. | `sims.status`, `sims.last_activation_error`, `activation_jobs`. |
| `change_imei` | Sets a new IMEI on the gateway and the carrier. | `sims.imei`, `imei_pool`. |
| `portin_status` | ATOMIC `portinStatus`. Read-only at the carrier. ATOMIC SIMs only. | `sims.atomic_portin_status_code`, `atomic_portin_description`, `atomic_portin_checked_at`. |

```json
{
  "ok": true,
  "action": "ota_refresh",
  "sim_id": 5345,
  "iccid": "89012804332468992577",
  "mdn": "9297213581",
  "mdn_source": "teltik_inbound_sms",
  "vendor": "teltik",
  "http_status": 200,
  "detail": { "success": true, "message": "Port reset initiated" }
}
```

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"sim_id":5345,"action":"ota_refresh"}' \
  "$BASE_URL/api/sim-action"
```

A completed port-in reports `Result.reasonCode = "CO"`. Status code `948` is
overloaded and means different things depending on the description text — match
on the description, not the number.

### POST /api/atomic-sub-action

ATOMIC subscriber lifecycle, one SIM per call. ATOMIC SIMs only; anything else
is a 400.

| Field | Type | Required | Values |
|---|---|---|---|
| `sim_id` | int | yes | |
| `op` | enum | yes | `suspend`, `restore`, `deactivate`, `reconnect` |

| `op` | ATOMIC request | Reason code | Resulting `sims.status` |
|---|---|---|---|
| `suspend` | `suspendSubscriber` | `NPG` | `suspended` |
| `restore` | `restoreSubscriber` | `CR` | `active` |
| `deactivate` | `deactivateSubscriber` | `DD` | `canceled` |
| `reconnect` | `reconnectSubscriber` | — | `active` |

Database: `sims.status`, `carrier_api_logs`.

### POST /api/atomic-swap-sim

Moves a line onto a different physical SIM card. ATOMIC only.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sim_id` | int | yes | |
| `new_iccid` | string | yes | Must be a valid ICCID and differ from the current one. |
| `zip_code` | string | no | Falls back to `sims.activation_zip`. Required if none is on file. |

Refused when the SIM is `canceled` or still `provisioning`, and when the new
ICCID already belongs to another SIM (409).

Carrier side: ATOMIC `swapSIM`. Database: `sims.iccid`, `carrier_api_logs`.

### POST /api/atomic-swap-imei

Changes the IMEI the carrier associates with the line. ATOMIC only.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sim_id` | int | yes | |
| `imei` | string | yes | Exactly 15 digits. |
| `zip_code` | string | no | Falls back to `sims.activation_zip`. |

Carrier side: ATOMIC `swapImei`. Database: `sims.imei`, `carrier_api_logs`.

This is the remedy for a line AT&T has blocked over device eligibility. It is
not the remedy for a line that is merely offline — try a port reset first.

### POST /api/suspend and POST /api/restore

Bulk status change through the `sim-status-changer` worker.

| Field | Type | Required |
|---|---|---|
| `sim_ids` | int[] | yes |

Carrier side: suspend or restore per SIM, at whichever carrier owns it.
Database: `sims.status`, `carrier_api_logs`.

### POST /api/activate

Bulk activation through the `bulk-activator` worker. Expensive and hard to
undo; do not call it as part of routine remediation.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sims` | object[] | yes | Each needs at least `iccid`. Port-in rows carry the port-in fields as well. |
| `vendor` | string | no | Defaults to `atomic`. |
| `reseller_id` | int | no | Applied to every row in the batch. |

Database: `sims`, `activation_jobs`, `activation_runs`, `carrier_api_logs`.

### POST /api/fix-sim

The repair sequence for one or more SIMs. Teltik SIMs are healed in-dashboard
via a get-info-by-MDN lookup, which fixes the common stale-ICCID case after
somebody physically swapped the card. Everything else is forwarded to
`mdn-rotator` for the change-IMEI, OTA, cancel and resume cycle.

| Field | Type | Required |
|---|---|---|
| `sim_ids` | int[] | yes |

Database: `sims.iccid`, `sims.imei`, `imei_pool`, `carrier_api_logs`.

### POST /api/hosting-port-status/run

Runs the Teltik hosting port-status check across many SIMs.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sim_ids` | int[] | no | Check exactly these. Runs synchronously. |
| `async` | bool | no | With no `sim_ids`, enqueues a durable full-fleet sweep and returns `202` immediately. |
| `max_sims` | int | no | 1–500, default 200. |
| `offset` | int | no | For paging a synchronous sweep. |
| `source` | enum | no | `manual_sweep` (default) or `manual_bulk`. |

Prefer `{"async": true}` for a full sweep: the server drains it batch by batch
on a one-minute tick and it survives anything happening to your session. It
dedupes against a sweep already queued or running, so calling it twice is not
two sweeps. Poll `GET /api/hosting-port-status/jobs` for progress.

Database: `hosting_port_status_checks`, `hosting_port_status_jobs`,
`carrier_api_logs`.

### POST /api/send-test-sms

Sends one SMS out of a gateway port. Use it to prove a line is genuinely
carrying traffic after a repair.

| Field | Type | Required |
|---|---|---|
| `gateway_id` | int | yes |
| `port` | string | yes |
| `to_number` | string | yes |
| `message` | string | yes |

All four are required; the handler 400s otherwise. Carrier side: a real,
billable SMS through the SkyLine gateway. Database: `skyline_api_logs`.

---

# Recommended workflow: keep every Teltik-hosted SIM online

## 1. Get the list

```bash
curl -s -H "Authorization: Bearer $AGENT_API_KEY" \
  "$BASE_URL/api/sims?status=active" \
  | jq '[.sims[] | select(.gateway_host == "teltik")]'
```

`gateway_host == "teltik"` is the fleet you are responsible for. SIMs with
`gateway_host == "skyline"` sit in our own hardware and are somebody else's
problem.

## 2. Find out what is already known

Before checking anything at a carrier:

- `GET /api/hosting-port-status/jobs` — is a sweep already running? If so, wait
  for it rather than starting a second source of truth.
- `GET /api/audit-log?actor=apikey:<your key>&since=<24h ago>` — what did you
  already try? A SIM you reset an hour ago does not need resetting again.
- `GET /api/errors` — what already failed, and why?

## 3. Check status

For a whole fleet, one call:

```bash
curl -s -X POST -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' -d '{"async":true}' \
  "$BASE_URL/api/hosting-port-status/run"
```

For a handful of SIMs, `POST /api/teltik-host-check` per SIM is faster and
gives you the detail immediately.

## 4. Remediate, in this order

Stop as soon as the line comes back. Each step is more disruptive and more
expensive than the one before it.

1. **Query first.** `POST /api/teltik-host-check`. A `404 Incorrect Phone
   Number` is a wrong-key error, not a dead line — the handler resolves the
   Teltik-known MDN, so if you still get it, the line is genuinely absent from
   Teltik's inventory. That is an escalation, not a remediation: the line is not
   ours to reset.
2. **Port reset.** `POST /api/sim-action` with `{"action":"ota_refresh"}`.
   This is the fix for the great majority of offline Teltik lines. Give it two
   to three minutes, then re-check with `teltik-host-check`. One reset per SIM
   per pass; if it did not work the first time it will not work the fifth.
3. **Fix the SIM.** `POST /api/fix-sim` with the SIM's id. For a Teltik line
   this heals a stale ICCID after a physical card swap, which is the second
   most common cause.
4. **IMEI swap.** `POST /api/atomic-swap-imei` with a fresh 15-digit IMEI.
   Only when the carrier query says the line is blocked on device eligibility.
   An IMEI swap on a line that is offline for some other reason burns an IMEI
   from the pool and fixes nothing.
5. **Escalate.** Leave the SIM alone and report it. Escalate when: the line is
   not in Teltik's inventory at all; a reset has failed twice across separate
   passes; the carrier returns an error you have no documented remedy for; or
   anything at all needs an admin-only route.

## Idempotency and rate

- **These calls are not idempotent.** A second `rotate` allocates a second new
  number. A second `activate` can create a second subscriber. Read the current
  state before you act, and treat a timeout as "unknown", not as "failed" —
  check the resulting state before retrying.
- **Do not hammer carrier APIs.** One check per SIM per pass. Leave at least
  five minutes between passes over the same SIM. A sweep across the fleet
  already paces itself at roughly ten SIMs a minute; do not run your own loop
  alongside it.
- **The PROD port-in poller already polls.** Any SIM with
  `status = 'provisioning'` and `port_in_pending = true` is being polled at the
  carrier every five minutes by the details finalizer. Do not add your own
  `portin_status` polling to those SIMs — read
  `sims.atomic_portin_status_code` instead, which the poller keeps current.
  This poller runs in PROD only; in TEST it is silent, so a provisioning SIM
  there will never progress on its own.
- **Back off on 500 and 502.** One retry after a pause, then escalate. Never
  retry a 400, 401, or 403 — the request is wrong, the credential is wrong, or
  the action is not yours to take, and none of those improve with repetition.
- **Batch where a batch route exists.** `/api/suspend`, `/api/restore` and
  `/api/fix-sim` take arrays. Ten SIMs in one call is one carrier conversation;
  ten calls is ten.

---

## For admins: managing keys

Key management is admin-only *and* closed to API keys of every role, so it can
only be done by a signed-in person, from the dashboard's Users tab or directly:

```bash
# List (never returns hashes)
curl -s -b cookies.txt "$BASE_URL/api/keys"

# Create — the plaintext key is in the response, once, and never again
curl -s -X POST -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"agent-prod","role":"operator"}' "$BASE_URL/api/keys"

# Revoke — takes effect on the next request
curl -s -X POST -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"agent-prod"}' "$BASE_URL/api/keys/revoke"
```

Give an agent the lowest role that lets it do its job. For the hosting job,
that is `operator`.
