# Sims Table Redesign — Design & Staged Plan

**Date:** 2026-07-17
**Status:** Stage 1 implemented on branch `redesign/sims-table-v2`, deployed to TEST only (`dashboard-test.zalmen-531.workers.dev`). Prod untouched.
**Motivation:** The Sims tab is a "tool display", not an operational data-management surface. Correcting a single row (e.g. SIM #639's vendor/status after the Teltik import clobber) requires scattered buttons and modals; the list loads the entire fleet client-side (5,344 rows via a 1000-row PostgREST page loop + SMS-count RPC chunks) on every 30-min cache expiry; search/filter is client-side only; vendor (service provider) has **no correction flow at all**; there is no visible audit trail.

---

## 1. Research summary (what good admin grids do)

Full brief distilled from Airtable / Retool / Supabase table editor / Linear patterns + data-grid UX literature (Pencil&Paper, NN/g, Citus pagination):

| Pattern | Verdict for us |
|---|---|
| Server-side filter/sort/paginate, total count always visible | **Adopt** — the core fix |
| Offset pagination with page numbers | **Adopt** (keyset only if fleet passes ~50k) |
| Sticky header + density toggle | **Adopt** — pure CSS + localStorage |
| Side-panel record editor with audit trail inside | **Adopt** — replaces "scattered modals" as the record home |
| Selection model with explicit scope + bulk bar | **Keep existing**, extend later with batch endpoints |
| Command palette (Cmd+K) | **Adopt** — cheap in vanilla JS, keyboard-first ops |
| Saved views (named filter+sort sets) | **Adopt** — localStorage first, DB table only if views must be shared |
| Optimistic update + compare-and-set writes | **Adopt for corrections** — stale edits fail loudly (SIM #639 lesson) |
| Undo-toast for reversible ops, type-to-confirm only for irreversible | **Adopt** for delete |
| Row virtualization, spreadsheet-grade inline editing | **Skip** — pagination caps DOM size; accident-prone for ops data |
| Infinite scroll, filters that don't round-trip to URL | **Avoid** (URL round-trip already exists — keep) |

## 2. Current architecture (verified)

- **Frontend:** single-file SPA `src/dashboard/public/index.html` (~13.4k lines, vanilla JS + Tailwind CDN). Sims tab: full client-side dataset in `tableState.sims.data`, client-side search/sort/filter/pagination, URL-serialized filter state, column-visibility gear, bulk bar with sequential per-SIM loops, detail **modal** with Details/Status/IMEI/Logs/Billing sub-tabs.
- **Backend:** `src/dashboard/index.js` (CRLF, API-only worker). `GET /api/sims` fetches **all** rows (`supabaseGetAllArray`, fixed `order=id.desc`, only `status`/`reseller_id`/`hide_cancelled` honored, reseller filter applied in JS post-fetch) + `get_sms_counts_24h` RPC chunks. No pagination, no server search, no vendor-edit endpoint. Audit: `sim_status_history` (status transitions, written mostly by DB-side/cancel sync), `system_errors`, `carrier_api_logs`, `webhook_deliveries`.
- **Data:** 5,344 sims (teltik/tmobile/host=teltik 4,112; atomic 337, wing_iot 270, helix 625 — all skyline-hosted). `sims.gateway_host` already models HOST vs `sims.vendor` = SERVICE PROVIDER (decision-log 2026-07-17).

## 3. Design

### 3.1 Server-side query engine — `GET /api/sims/query`
New endpoint (old `/api/sims` kept untouched for compatibility):

- Params: `page`, `page_size` (25/50/100/250, max 500), `sort` (whitelisted column), `dir`, `q` (searches ICCID / MSISDN / numeric id — server-side ilike/or), `status` (csv, multi), `vendor` (csv), `gateway_host` (csv), `gateway_id` (csv), `reseller_id` (csv, server-side via `reseller_sims!inner`), `activated_from/to`, `preset` (server-mapped: `no_reseller`, `any_error`, `auto_paused`, `not_rotated_today`, `not_notified`, `stuck_provisioning`).
- Returns `{rows, total, page, page_size}`; `total` from PostgREST `Prefer: count=exact` `Content-Range`.
- SMS 24h counts via existing RPC, but only for the **current page** (≤500 ids, one call) instead of the whole fleet.
- Why offset not keyset: fleet is 5k rows, operators need "page N of M" + jump; offset depth is trivial at this size.

### 3.2 Record drawer (side panel) — the home of a SIM
Existing detail modal restyled as a right-hand drawer (content and sub-tab logic reused), extended with:

- **Header:** ID, ICCID, status badge, vendor badge + **host badge** (`gateway_host`) — the vendor≠host distinction is now visible on every record (SIM #639 class of confusion).
- **New "Edit" sub-tab — guarded field correction** via new `POST /api/update-sim`:
  - Whitelisted fields only: `vendor`, `carrier`, `gateway_host`, `status_reason`, `gateway_id`, `port`, `slot`, `msisdn`, `rotation_interval_hours`.
  - **Compare-and-set:** client sends `prior` values; server PATCHes with `&field=eq.<prior>` filters — if the row changed underneath, 0 rows match → 409, no silent clobber.
  - Every change writes a row per field to **`sim_edit_log`** (new table: sim_id, field, old/new value, changed_by, changed_at).
  - Vendor changes require an explicit confirm naming both values ("atomic → teltik").
- **New "History" sub-tab** via new `GET /api/sim-history?sim_id=`: merged timeline of `sim_status_history` + `sim_edit_log` + recent `system_errors` + recent `number.online` deliveries — "who/what touched this SIM, when".

### 3.3 Table UX
- Server mode: filters/search/sort/page drive `/api/sims/query`; total count always shown ("312 matching · page 2/7"). Debounced search (350ms). URL round-trip preserved.
- **Saved views:** named snapshots of the existing URL-serialized filter state, in `localStorage`; chips row above the table. (DB-backed sharing = later stage, same JSON shape.)
- **Density toggle** (comfortable/compact) + sticky header — CSS + localStorage.
- **Command palette (Ctrl/Cmd-K):** tab navigation, focus search, apply preset/saved view, run bulk action on current selection.
- **Safer deletes:** bulk delete requires typing the row count; single delete keeps confirm + shows ICCID.

### 3.4 What deliberately did NOT change
- All existing action endpoints/flows (rotate, cancel, suspend, restore, activate, OTA, IMEI, reseller assign) — proven, and the redesign must not destabilize them.
- Bulk loops stay sequential client-side for now (batch endpoints = Stage 3; the bulk bar UX is unchanged).
- `/api/sims` (legacy full fetch) still exists — other consumers and instant rollback path.

## 4. Tradeoffs / decisions

| Decision | Alternative rejected | Why |
|---|---|---|
| Upgrade tab in place, reuse modals/bulk machinery | Greenfield "Sims v2" tab | Halves risk & diff; existing bulk/action code is battle-tested |
| Offset pagination | Keyset | 5k rows; operators want page jumps; keyset kills "page 7 of 40" |
| CAS via PostgREST eq-filters on prior values | `updated_at` version column | No schema change on `sims`, per-field precision, works today |
| `sim_edit_log` new table | Overload `sim_status_history` | That table is status-transition-shaped; billing logic reads it (`findCancelTimestamp`) — do not pollute |
| localStorage saved views | DB table | Single-operator dashboard today; same JSON migrates later |
| Drawer = restyled existing modal | New component | Reuses 5 sub-tabs of working logic |
| Page-scoped SMS counts | Fleet-wide RPC chunks | 1 RPC call/page vs 11/load |

## 5. Test environment (what was done this session)

1. `dashboard-test` synced to current `main` (baseline) before any redesign code.
2. **Discovered `dashboard-test` was pointed at the PROD Supabase** — unacceptable once test carries write flows. Repointed `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (test env secrets) to the `incomingsms-test` project (`lwapudjjlwkskijefxdz`).
3. Test project schema rebuilt to prod parity for the sims domain (sims incl. `gateway_host`, gateways, sim_numbers, reseller_sims, resellers, sim_status_history, system_errors, webhook_deliveries, rotation_audit, inbound_sms, + new `sim_edit_log`; `get_sms_counts_24h` RPC; RLS on).
4. Seeded **synthetic** fleet matching prod distribution (5,344 sims, no real customer data). Test worker authenticates with the test project's anon key + permissive RLS policies (service-role key not available on this host; synthetic data, test only).
5. Fresh test-only Basic-auth credential set on `dashboard-test`.

## 6. Staged rollout plan

- **Stage 1 (this branch, test only):** everything in §3. Verify on test, operator review.
- **Stage 2 (prod rollout):** apply `supabase/migrations/20260717_sim_edit_log.sql` to prod project; merge branch to main; deploy `--env=""`. Legacy `/api/sims` stays until Messages-tab-style consumers confirmed unaffected.
- **Stage 3:** batch bulk endpoints (`POST /api/sim-action-batch`) to replace sequential client loops; server-side `no_sms_12h` preset (needs an SMS-counts join or materialized count); DB-backed shared saved views if a second operator appears.
- **Stage 4 (optional):** keyset pagination if fleet ≥ ~50k; facet counts (per-status/vendor counts for filter chips); `hosted_on` proper hosting model per decision-log.

## 7. Rollback

Test env only. To abandon: redeploy `main` with `--env test`, repoint test secrets back to prod project if the old read-only behavior is wanted (values: prod project URL + service key from Supabase dashboard), delete branch.
