# Project Map

## Worker Registry

| Worker | Purpose | Trigger | Key Bindings |
|--------|---------|---------|--------------|
| `sms-ingest` | Receive SMS from SkyLine gateway, store in DB, trigger IMEI change on AT&T "upgrade" messages | HTTP POST (gateway push) | MDN_ROTATOR service binding |
| `bulk-activator` | Activate SIM cards via Helix API | Queue consumer (`sim-activation-queue`) + HTTP `/activate` | — |
| `details-finalizer` | Poll Helix for provisioning SIMs; promote to active when MDN returned | Cron `*/5 * * * *` | SKYLINE_GATEWAY service binding |
| `mdn-rotator` | Daily MDN rotation, fix-sim flow, manual SIM actions | Cron `0,20,40 4-15 * * *` + `0 16 * * *` + Queue + HTTP | TOKEN_CACHE KV, mdn-rotation-queue, fix-sim-queue, SKYLINE_GATEWAY |
| `ota-status-sync` | Sync OTA fulfillment status from Helix | Cron `0 0,12 * * *` | TOKEN_CACHE KV |
| `reseller-sync` | Backstop: re-send `number.online` webhooks that failed during rotation | Cron `0 15 * * *` (10 AM EST) + HTTP `/run` | — |
| `skyline-gateway` | Relay worker: abstracts SkyLine device HTTP API via Supabase bridge | HTTP (service binding only) | — |
| `dashboard` | SPA frontend + API layer for all manual operations | HTTP | All 9 service bindings (see below) |
| `sim-canceller` | Cancel a SIM via Helix | HTTP (service binding) | — |
| `sim-status-changer` | Suspend / restore a SIM via Helix | HTTP (service binding) | — |
| `phone-number-sync` | Sync phone numbers (utility worker) | HTTP | — |
| `quickbooks` | QBO OAuth 2.0, customer mapping, invoice generation | HTTP | QBO_TOKENS KV |
| `teltik-worker` | T-Mobile SIM management via Teltik API: import lines, receive SMS webhooks, rotate MDNs every 48h | Cron `10,40 * * * *` + HTTP `/import` `/webhook` `/rotate` `/setup-webhook` | — |

## Dashboard Service Bindings (all 10)

```
SIM_CANCELLER      → sim-canceller
BULK_ACTIVATOR     → bulk-activator
DETAILS_FINALIZER  → details-finalizer
MDN_ROTATOR        → mdn-rotator
PHONE_NUMBER_SYNC  → phone-number-sync
RESELLER_SYNC      → reseller-sync
SIM_STATUS_CHANGER → sim-status-changer
SKYLINE_GATEWAY    → skyline-gateway
QUICKBOOKS         → quickbooks
TELTIK_WORKER      → teltik-worker
```

## Queue Inventory

| Queue | Producer | Consumer | Batch / Retries |
|-------|---------|---------|----------------|
| `sim-activation-queue` | dashboard / bulk-activator HTTP | bulk-activator | 5 / 2 |
| `mdn-rotation-queue` | mdn-rotator cron | mdn-rotator | 10 / 2 |
| `fix-sim-queue` | mdn-rotator `/fix-sim` | mdn-rotator | 1 / 2 |

## KV Namespaces

| Binding | ID | Used By |
|---------|----|---------|
| `TOKEN_CACHE` | `edaf2c8828b14badb3037600635f8a7f` | mdn-rotator, ota-status-sync (shared) |
| `QBO_TOKENS` | `49d0ca1276af457d80907876b2c53775` | quickbooks |

## External Services

| Service | Purpose | Auth |
|---------|---------|------|
| Helix AT&T SOLO API | SIM activation, MDN rotation, subscriber details, OTA | OAuth2 bearer token (cached in TOKEN_CACHE KV) |
| SkyLine Gateway (hardware) | Set/read IMEI, send SMS, port status | HTTP Basic via Supabase bridge |
| Supabase | Database (PostgREST) + Edge Function bridge | Service role key secret |
| QuickBooks Online | Invoice generation | OAuth 2.0, tokens in QBO_TOKENS KV |
| Reseller webhooks | `number.online` event delivery | URL in `resellers.webhook_url` |

## SkyLine Gateway Bridge Architecture

```
Worker → SKYLINE_GATEWAY service binding
       → skyline-gateway worker
       → POST to Supabase Edge Function (bridge)   [auth: x-bridge-secret]
       → bridge fetches gateway at 54.254.97.139:63826
       → returns JSON response
```

**Why the bridge exists:** Cloudflare Workers cannot reach Cloudflare-proxied IPs (error 1003/521 — internal routing loop). The Supabase Edge Function runs on Deno Deploy which has no such restriction.

## Gateways in DB

| id | code | ports | host | notes |
|----|------|-------|------|-------|
| 1 | `64-1` | 64 | via bridge | "Main Gateway" |
| 3 | `512-1` | 512 | via bridge | "512 Port Gateway" |

Port format stored in DB: dot-notation zero-padded — `"13.03"` (not `"13C"` or `"13.3"`). `normalizePortSlot()` in skyline-gateway handles conversion.

## Key Database Tables

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `sims` | One row per SIM | id, iccid, imei, status, gateway_id, port, mobility_subscription_id, att_ban, activated_at, last_mdn_rotated_at, last_notified_at, last_activation_error, last_rotation_error |
| `sim_numbers` | Phone number history per SIM | sim_id, number, iccid, verification_status (always `verified`) |
| `resellers` | Reseller accounts | id, name, webhook_url |
| `gateways` | Physical gateway config | id, code, host, api_port, username, password, slots_per_port |
| `imei_pool` | IMEI inventory | imei, sim_id, gateway_id, port, slot, status (`available`/`in_use`/`retired`/`blocked`) |
| `webhook_deliveries` | Dedup + delivery log for number.online | sim_id, iccid, number, event_date, status (`delivered`/`failed`) |
| `helix_api_logs` | All Helix API call logs | sim_id, action, request/response JSON, timestamp |
| `system_errors` | System-level error log | — |
| `qbo_customer_map` | Reseller → QBO customer mapping | reseller_id, qbo_customer_id, daily_rate |
| `qbo_invoices` | Generated invoices | qbo_customer_map_id, week_start, week_end, sim_count, total, status |

**DB constraints:** RLS enabled on all public tables (service_role bypasses automatically). `imei_pool.status` enum: `available`, `in_use`, `retired`, `blocked`. Unique index `idx_sims_unique_gateway_port` on `sims(gateway_id, port)`.

## Main Data Flows

### SMS Ingest
```
Gateway hardware → POST /  (sms-ingest)
  → parse recv-sms payload
  → store in sms_messages table
  → if AT&T "upgrade" message: trigger mdn-rotator auto-IMEI-change
    → update sims.gateway_id + port (evict conflicts first)
    → ctx.waitUntil(trigger)
```

### MDN Rotation (daily)
```
Cron fires → mdn-rotator
  → query active SIMs needing rotation (not rotated today)
  → enqueue to mdn-rotation-queue (10 at a time)
  → queue consumer: for each SIM:
    → re-check last_mdn_rotated_at (dedup guard)
    → hxMdnChange() → Helix API
    → OTA refresh
    → insert new number in sim_numbers
    → update sims.last_mdn_rotated_at
    → send number.online webhook to reseller (if configured)
    → update sims.last_notified_at
  → reseller-sync cron at 15:00 UTC: re-send any that failed
```

### SIM Activation
```
Dashboard or CSV → POST to bulk-activator or sim-activation-queue
  → bulk-activator queue consumer (5 at a time):
    → hxActivate() → Helix API
    → update sims.status = provisioning
  → details-finalizer cron (*/5):
    → for each provisioning SIM with sub_id:
      → hxSubscriberDetails()
      → syncSimFromHelixDetails(isFinalization=true)
      → if MDN returned → status = active
```

## Shared Module Summary (`src/shared/`)

| File | Exports |
|------|---------|
| `helix.ts` | `getCachedToken`, `hxMdnChange`, `hxSubscriberDetails`, `hxOtaRefresh`, `hxChangeSubscriberStatus`, `logHelixApiCall` |
| `subscriber-sync.js` | `syncSimFromHelixDetails(env, simRow, detailsResponse, {isFinalization})` |
| `supabase.ts` | `supabaseGet`, `supabaseSelect`, `supabaseInsert`, `supabasePatch` |
| `utils.ts` | `sleep`, `normalizeToE164`, `generateMessageIdAsync`, `retryWithBackoff` |
| `types.ts` | `Env` interface (all secrets + bindings) |
