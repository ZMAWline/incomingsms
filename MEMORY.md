# MEMORY.md - Project Context for AI Sessions

## Project Overview
**Incoming SMS** is a Cloudflare Workers application for SIM card management, SMS routing, and reseller operations. It uses Supabase as the database and integrates with the Helix communications API for carrier operations.

## Architecture
- **Runtime**: Cloudflare Workers (JavaScript, no framework)
- **Database**: Supabase (PostgreSQL) via REST API with service role key
- **API Integration**: Helix API for SIM operations (activate, cancel, resume, OTA refresh, IMEI change, MDN rotation)
- **Frontend**: Single HTML page returned by `getHTML()` in `src/dashboard/index.js` using TailwindCSS CDN

## Workers (in `src/`)
| Worker | Purpose |
|--------|---------|
| `dashboard` | Main dashboard UI + API backend (single `index.js`, ~5000 lines) |
| `mdn-rotator` | Nightly phone number rotation at 05:00 UTC, error summary at 07:00 UTC |
| `bulk-activator` | Bulk SIM activation operations |
| `details-finalizer` | Finalizes SIM card details after activation |
| `reseller-sync` | Syncs data with reseller systems |
| `sim-canceller` | Cancels SIM cards via Helix API |
| `sim-status-changer` | Changes SIM status (cancel/resume) |
| `sms-ingest` | Main worker for receiving/processing incoming SMS |
| `skyline-gateway` | Gateway for skyline device operations (IMEI changes) |
| `phone-number-sync` | Syncs phone numbers from Helix |
| `quickbooks` | QuickBooks Online integration for billing/invoicing |

## Key Database Tables
- `sims` — SIM card records (iccid, status, port, gateway_id, mobility_subscription_id, last_activation_error, last_mdn_rotated_at)
- `sim_numbers` — Phone number history (e164, valid_from, valid_to, verification_status)
- `gateways` — Physical gateway devices (code, name, total_ports, slots_per_port)
- `resellers` — Reseller accounts
- `reseller_sims` — Many-to-many SIM↔reseller with `active` flag
- `reseller_webhooks` — Webhook URLs per reseller
- `messages` — Incoming SMS messages
- `helix_api_logs` — API call logs to Helix
- `webhook_deliveries` — Webhook delivery tracking with deduplication
- `system_errors` — Centralized error tracking with resolution workflow (migration 006)
- `imei_pool` — IMEI inventory: statuses are `available` (stock), `in_use` (assigned to slot), `retired` (carrier rejected). Linked to `sims` via `sim_id` and to gateways via `gateway_id`+`port`.

## Gateways & IMEI Architecture
- **Gateway 64-1**: 64 ports × 1 SIM slot per port = **64 SIM slots**
- **Gateway 512-1**: 64 ports × 8 SIM slots per port = **512 SIM slots** (8 SIMs rotate every 8 seconds on each port — only 1 active at a time per cellular module)
- **Total slots**: 576. At any given time, the number of `in_use` IMEIs should match the number of slots.
- **Available IMEIs**: Stock IMEIs not yet assigned, ready for future assignment when a carrier rejects a current IMEI.
- **Retired IMEIs**: Carrier-rejected IMEIs that must never be reused.
- The `gateways.slots_per_port` column tracks how many SIM slots each port has.

## Dashboard Tabs
1. **Dashboard** — Stats overview (total SIMs, active, provisioning, messages)
2. **SIMs** — Full SIM table with filters, sorting, pagination, bulk actions, 30-min client cache
3. **Messages** — Incoming SMS messages log
4. **Workers** — Run workers manually (MDN Rotator, Bulk Activator, etc.)
5. **Gateway** — Gateway device management
6. **IMEI Pool** — IMEI inventory (stats: Slots, In Use, Available, Retired, Total). Retire/Restore actions.
7. **Errors** — System error tracking with resolution workflow (View, Resolve, bulk resolve)
8. **Billing** — QuickBooks invoicing and customer mappings

## What Works (DO NOT BREAK)
- SIM table with filtering by status, reseller, search
- Bulk actions (OTA Refresh, Rotate MDN, Fix SIM, Cancel, Resume, Unassign Reseller) on SIMs
- Webhook delivery for `number.online` events to resellers
- MDN rotation (nightly cron + manual trigger)
- Error logging to `system_errors` table from workers and dashboard
- Error page with resolution tracking (View, Resolve, bulk resolve)
- Pagination system across all tables
- Sorting system across all tables
- QuickBooks invoice generation and customer mappings
- IMEI pool with paginated fetch (all 1576+ IMEIs), retire/restore actions
- SIM data 30-minute client-side cache with force-reload

## Common Pitfalls
1. **Template literals in `getHTML()`**: The entire frontend is inside a JS template literal (backtick string). Inner template literals must use `\`...\`` and variables use `\${...}`. Do NOT use unescaped backticks or `${...}` inside `getHTML()`. For dynamically built strings, use string concatenation (`+`) instead.
2. **Supabase 1000-row limit**: `PGRST_MAX_ROWS` defaults to 1000 server-side. `limit=` URL params and `Range` headers **cannot override this**. To fetch >1000 rows, you MUST paginate in batches using Range header offsets (`0-999`, `1000-1999`, ...). See `handleImeiPoolGet` for the pattern.
3. **Checkbox classes**: SIM tab checkboxes use class `sim-cb`, Error tab uses `error-cb`. Mixing them breaks bulk actions.
4. **N+1 queries**: The SIM loading previously had N+1 query problems. The `handleSims()` backend function batches queries. Don't add per-SIM queries.
5. **Service bindings**: Workers communicate via Cloudflare service bindings (e.g., `env.MDN_ROTATOR.fetch()`). These are configured in `wrangler.toml`.
6. **Supabase REST API**: All DB access is via REST, not SQL client. Use `supabaseGet()` helper or direct `fetch()` with service role key. The `supabaseGet()` helper does NOT set Range headers, so it's limited to 1000 rows.
7. **File size**: `src/dashboard/index.js` is very large (~270KB). Be careful with search/replace operations — always verify exact content matches.
8. **IMEI statuses**: Only 3 valid statuses: `available`, `in_use`, `retired`. The `blocked` status was removed (migration 007).

## Environment Variables (in `.dev.vars`)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — Database access
- `HX_API_BASE`, `HX_USERNAME`, `HX_PASSWORD` — Helix API credentials
- `ADMIN_RUN_SECRET` — Secret for manual worker triggers
- `CANCEL_SECRET` — Secret for SIM cancellation
- `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD` — Dashboard basic auth
- `SLACK_WEBHOOK_URL` — Error notifications to Slack
- `SKYLINE_SECRET` — Secret for Skyline gateway API
- `QBO_*` — QuickBooks credentials

## Migrations Applied
- **006_system_errors**: `system_errors` table for centralized error tracking with resolution workflow
- **007_imei_pool_cleanup**: Removed `blocked` status from `imei_pool` check constraint

## Recent Changes (Feb 2026)
- **Error page redesign**: Queries `system_errors` table + legacy `last_activation_error`. Shows Source, ICCID, Error, Severity, Status, Time columns. Has View/Resolve/OTA buttons per row.
- **SIM caching**: 30-minute client-side cache (`lastSimsFetchedAt`). Refresh button and filter changes force-reload via `loadSims(true)`.
- **Unassign reseller**: `/api/unassign-reseller` endpoint. Per-row and bulk Unassign buttons in SIM table. Sets `reseller_sims.active = false`.
- **System error logging**: Worker runs and SIM actions log failures to `system_errors` table via `logSystemError()`.
- **IMEI pool overhaul**: Paginated fetch (handles >1000 IMEIs). Stats show Slots/In Use/Available/Retired/Total. Blocked status merged into retired. Gateway/Port columns added to table. Retire works on both available and in_use. Restore button for retired IMEIs.
- **Gateway 512-1 fix**: `slots_per_port` corrected from 1 → 8 (64 ports × 8 slots = 512).
- **Gateway tab all_slots**: `loadPortStatus` now passes `all_slots=1` to Skyline API so the 512-1 gateway shows all 512 SIM slots instead of only 64 active ones.
- **IMEI cleanup**: Retired 37 orphaned `in_use` IMEIs that had no `gateway_id` (legacy entries from before gateway import).

## Skyline Gateway Integration
- The dashboard proxies to the `skyline-gateway` worker via `handleSkylineProxy` (routes under `/api/skyline/*`).
- The proxy automatically injects `SKYLINE_SECRET` into requests.
- Key endpoints: `port-info` (GET, returns port/slot status), `switch-sim` (POST), `change-imei` (POST), `send-sms` (POST).
- **`all_slots=1`** param on `port-info` returns all SIM slots per port (critical for multi-slot gateways like 512-1). Without it, only the active slot per port is returned.
