# Current State

> This is a living document. Update it when things break, get fixed, or change meaningfully.
> Last updated: 2026-04-17 (session 21 — retry activation bug fixes + IMEI pool add fix)

---

## Known Issues / Degraded

- **API Logs tab shows blank for ATOMIC SIMs** — the dashboard "API Logs" section queries `helix_api_logs`; ATOMIC activations log to `carrier_api_logs`. ATOMIC SIM logs are invisible in the dashboard tab. Fix: update the API Logs query to also check `carrier_api_logs` (or unify into one view).
- **SIM 685 still in `error` state** — needs a retry activation (same pattern as SIM 688 which was fixed this session). Run retry from dashboard.

---

## In Progress / Pending Work

### Dashboard Redesign — Now in Production
Gemini UI (zinc/blue palette, light mode, custom confirm/toast dialogs) was unintentionally deployed to prod in session 9, and all related bugs are now fixed. Production dashboard is running the new UI and is stable.

### ATOMIC + Wing IoT Migration — Complete + Helix Quarantined
- **Phase 1 (DB):** Complete — msisdn column added, helix_api_logs renamed to carrier_api_logs with vendor column, backward-compatible view created
- **Phase 2 (Workers):** Complete — all 6 workers deployed with vendor routing. **mdn-rotator daily cron now rotates ATOMIC SIMs** (fixed 2026-04-15 session 16; 50/50 SIMs rotated successfully on first cron tick). Wing IoT rotation not yet wired (no active Wing SIMs to rotate; only 1 Wing SIM in error state). `index.ts` (485-line partial port) is NOT production-ready — do not switch entry point.
- **Phase 3 (Dashboard):** Complete — vendor filter, badges, OTA/Retry disabled for wing_iot, ATOMIC query modal
- **Helix Quarantine (2026-04-15):** `HELIX_ENABLED=false` pushed to 7 workers (mdn-rotator, bulk-activator, sim-canceller, sim-status-changer, ota-status-sync, details-finalizer, dashboard). All Helix code paths are gated behind this flag. To re-enable: `printf "true" | wrangler secret put HELIX_ENABLED` on each worker. Code is preserved, not deleted.
- **Provider-leak bugs fixed:** `sim.vendor || 'helix'` → `'unknown'` in 3 places; billing aggregation renamed `helixDays` → `attDays` for clarity
- **Secrets:** All ATOMIC + Wing IoT + RELAY + HELIX_ENABLED secrets on every worker

### Dashboard UX Consolidation — Complete
- **Done (2026-04-16):** set-status modals merged (D1), bulk Retry shows per-SIM results in modal (D2), vendor tooltips for OTA/Retry buttons (D4), per-SIM detail modal (D3)
- **D3 detail:** Tabbed modal (Details/Status/IMEI/API Logs) opened by clicking SIM ID, Status, or IMEI row buttons. IMEI tab available for any SIM with gateway+port (no sub ID required). Wrapper functions `_sdOta`/`_sdRetry`/`_sdViewLogs` used in action buttons. Deployed 2026-04-16.

### BLIMEI / IMEI Heartbeat — Both Disabled
- Both `imei_heartbeat` and `blimei_update` queue handlers in mdn-rotator are disabled (short-circuit added during gateway instability investigation)
- 0 of 538 active SIMs have graduated; 397 have never been synced; 141 partial (1–2 syncs)
- Cron still enqueues jobs but they are silently acked without action
- **Skipped by user** — re-enable when/if needed by removing the two `message.ack(); continue;` short-circuits in mdn-rotator queue handler

---

## Technical Debt

### 98 Scratch Scripts at Repo Root (untracked)
Files like `_fix_*.js`, `_patch_*.js`, `fix.js`, `repair.ps1`, `rendered*.html`, etc. are accumulated from past dashboard patching attempts. Most are dead code. They are untracked (not in git) and safe to delete once confirmed useless.

**Risk:** One of them may still be a useful reference (e.g., `_check_dash_script.js` is the dashboard syntax checker). Review before bulk-deleting.

**Recommended action:** Move `_check_dash_script.js` to a permanent location (e.g., `scripts/`), delete the rest. Ask user before deleting.

### Dashboard Has No Test Environment Crons
Test environment is defined in `dashboard/wrangler.toml` but only the prod environment runs in real operations. No automated testing exists.

### `phone-number-sync` Worker — Unclear Status
This worker exists in `src/phone-number-sync/` but its purpose is not well-documented beyond syncing phone numbers. Verify it's still needed and what it does before any changes.

### README.md Is Outdated
Lists 5 of 12 workers and has stale environment variable names. Not critical but misleading for anyone reading the repo.

---

## Recent Significant Changes (reverse-chronological)

| Date | Change | Worker(s) |
|------|--------|-----------|
| 2026-04-17 | retryActivation: now inserts MDN into `sim_numbers` + sets `activated_at` on success; gateway scan falls back to DB slot if scan fails; `slot_not_found` response now includes `error` field (was showing "unknown" in UI). `handleSimAction` now forwards `imei_strategy` to mdn-rotator. IMEI pool add: removed Helix eligibility gate entirely (was blocking all adds). `check-imei` endpoint returns `eligible:true` on Helix token failure. SIM 688 backfilled manually. | mdn-rotator, dashboard |
| 2026-04-16 | Retry Activation: IMEI strategy choice added — `showImeiStrategyChoice()` modal before every retry (per-SIM, bulk, detail modal). Backend `retryActivation()` accepts `imei_strategy: 'same'|'new'`. `'same'` reuses `sims.imei`; `'new'` retires old pool entry + allocates fresh one. Clear error thrown if `'same'` chosen but no IMEI on record (no silent fallback). Guide section updated to ATOMIC/Wing IoT wording. | mdn-rotator, dashboard |
| 2026-04-16 | Activation address randomized — `src/shared/address-pool.js` with 25 addresses across 23 states; `pickRandomAddress()` called once per activation in `activateViaAtomic`, `hxActivate` (bulk-activator), `hxActivate`, `retryActivateViaAtomic` (mdn-rotator). Old `HX_ADDRESS1/CITY/STATE/ZIP` env vars no longer used in activation paths. | bulk-activator, mdn-rotator |
| 2026-04-16 | Dashboard: port display normalized client-side — `normalizePortDisplay()` converts old letter-format ports ("13C") to dot-notation ("13.03") in SIM table, detail modal, and IMEI tab. DB data unchanged. | dashboard |
| 2026-04-16 | Dashboard: D3 per-SIM detail modal — tabbed modal (Details/Status/IMEI/API Logs) opened by SIM ID, Status, IMEI row buttons. IMEI tab requires only gateway+port (not sub ID). `_sdOpenImei()` closes detail modal before opening IMEI dialog to avoid z-index conflict. | dashboard |
| 2026-04-16 | Dashboard: fix Query button blocked by `HELIX_ENABLED` gate — moved guard from top of `queryHelix()` into Helix-only branch so ATOMIC and Wing IoT queries work when Helix is disabled | dashboard |
| 2026-04-15 | **Helix Quarantine (session 16):** Full audit + quarantine of all Helix code behind `HELIX_ENABLED=false` flag on 7 workers. mdn-rotator daily cron fixed to rotate ATOMIC SIMs (50/50 success on first prod tick). 4 provider-leak bugs fixed (vendor defaults, billing aggregation). Dashboard: Helix UI elements hidden/disabled when flag off, 3 backend routes return 503, queryHelix functions gated. | mdn-rotator, bulk-activator, sim-canceller, sim-status-changer, ota-status-sync, details-finalizer, dashboard |
| 2026-04-15 | Dashboard: shift-click range selection on SIM checkboxes (sims page) | dashboard |
| 2026-04-15 | mdn-rotator: ATOMIC manual rotation path added — `rotateSpecificSim` now branches on vendor; new `rotateAtomicSim` calls swapMSISDN + fallback inquiry + DB/webhook writes. Daily queue (rotateSingleSim) still silently skips ATOMIC — not yet migrated. | mdn-rotator |
| 2026-04-15 | Dashboard: gateway "Export Table" button — scans selected gateway via skyline-gateway `/port-info?all_slots=1` and downloads CSV (port/slot/iccid/imei/number/operator/signal/sim_status/state). Caught 522 escaping bug mid-session (regex char class `\n\r` became literal newlines) — fix: `\\n\\r` in source. Surfaced by `_check_frontend_js.js`. | dashboard |
| 2026-04-15 | Dashboard: `/api/delete-sim` route + per-row Del button; child-row cleanup (sim_numbers, inbound_sms, reseller_sims, sim_status_history) + nullify system_errors.sim_id | dashboard |
| 2026-04-15 | Dashboard: `/api/relay-test` route + new API Tester tab; presets for ATOMIC/Wing IoT/Teltik/Helix + custom | dashboard |
| 2026-04-15 | Dashboard: `/api/atomic-query` route + separate ATOMIC option in bulk Query modal (was merged into Helix). Auto-routes by vendor in `querySimCarrier`. ATOMIC credentials (ATOMIC_USERNAME/TOKEN/PIN) pushed to dashboard worker + added to `.dev.vars`. | dashboard |
| 2026-04-15 | Dashboard: `RELAY_URL` + `RELAY_KEY` secrets pushed (previously missing, causing 522 on any dashboard-side external API call). Full relay + ATOMIC + Wing IoT creds now in `.dev.vars`. | dashboard |
| 2026-04-15 | Data: 625 Helix SIMs bulk-updated to `status='canceled'` via PostgREST PATCH (no migration, one-off data op) | — |
| 2026-04-15 | Rule hardcoded: EVERY edit to `src/dashboard/index.js` must go through the `patch-dashboard` skill. Written into `agent/BOOTSTRAP.md` Rule 1 and `agent/constraints.md §1` with no-exceptions list and mandatory two-check workflow. Incident reference: freehand patch of gateway-export shipped invalid regex to prod; only the frontend JS check (part of the skill) would have caught it before deploy. | — |
| 2026-04-14 | ATOMIC + Wing IoT Phase 2+3: deployed 6 workers with vendor routing; dashboard updated with vendor filter (atomic/wing_iot/helix/teltik), carrier_api_logs query, vendor badges, OTA/Retry disabled for wing_iot | bulk-activator, mdn-rotator, ota-status-sync, sim-status-changer, sim-canceller, details-finalizer, dashboard |
| 2026-04-14 | ATOMIC + Wing IoT Phase 1: new shared modules (atomic.ts, wing-iot.ts), vendor routing in 6 workers, DB migration (carrier_api_logs + vendor column), new API skills | bulk-activator, mdn-rotator, ota-status-sync, sim-status-changer, sim-canceller, details-finalizer |
| 2026-03-27 | Billing: vendor-split billing — Teltik SIMs billed per 48h block at 2× daily_rate; Helix SIMs billed per calendar day at daily_rate; both preview and CSV download updated; buildCSV uses per-row rate | dashboard |
| 2026-03-25 | Teltik webhook: 48h guard stamped on change-number initiation (before polling); fallback to get-phone-number if polling fails; online_until = midnightNYAfterInterval(last_mdn_rotated_at, interval_hours) in all 3 code paths; carrier field (T-Mobile/att) added to all number.online payloads; webhook handler fixed for Teltik push format (destination/origin/message/timestamp) + array payload support | teltik-worker, reseller-sync, dashboard |
| 2026-03-25 | Teltik vendor integration: new `teltik-worker` (import/webhook/rotate/setup-webhook), DB migration adds vendor/carrier/rotation_interval_hours to sims, mdn-rotator filters to helix-only + vendor guard in rotateSpecificSim, reseller-sync vendor-aware online_until + interval-based backstop skip, dashboard vendor column/filter/Import button | teltik-worker (new), mdn-rotator, reseller-sync, dashboard, DB migration |
| 2026-03-24 | Dashboard: fixed two prod bugs from prior session — missing fetch URLs in queryHelix/queryHelixBulk (bare backtick issue) and \n→newline in dbLines.join (template literal escape bug); rewrote _check_frontend_js.js to use Node vm.runInContext to accurately simulate template evaluation | dashboard |
| 2026-03-24 | patch-dashboard skill updated: added frontend JS check step (vm-based), documented correct BT='\\\\'+'\`' escaping pattern, added explicit --env flag warning | — |
| 2026-03-24 | IP relay: VPS at 74.208.37.8, Node.js relay service on relay.zmawsolutions.com (HTTPS/TLS); helix.ts `relayFetch()` routes all 5 Helix API calls through relay; RELAY_URL + RELAY_KEY secrets pushed + deployed to 6 workers | bulk-activator, details-finalizer, mdn-rotator, ota-status-sync, sim-canceller, sim-status-changer |
| 2026-03-23 | Dashboard: Gemini UI redesign (zinc/blue palette, expanded sidebar w/ labels, Inter font, mobile responsive); light/dark mode toggle (CSS vars + localStorage); all 26 confirm()→showConfirm() + 14 alert()→showToast() | dashboard |
| 2026-03-23 | Dashboard: deployed to **test only** — production not yet updated this session | dashboard |
| 2026-03-20 | Dashboard UX: SIMs default filter → Active only; SMS page limit 50→500; all modals close on Escape/backdrop click | dashboard |
| 2026-03-20 | Dashboard: "Not rotated today" + "No SMS in 12h" quick filters on SIMs view (client-side) | dashboard |
| 2026-03-20 | Dashboard: Lock/Unlock/Switch SIM buttons per slot in Gateway port-detail popup | dashboard |
| 2026-03-20 | Dashboard: Retry button on failed Helix API log entries in SIM logs popup; maps step→action (mdn_change→rotate, ota_refresh→ota_refresh, else→fix) | dashboard |
| 2026-03-17 | Gateway-ID path encoding + port-based SIM lookup for 512-2: /gw/<id> path segment, findSimIdByGatewayPort fallback, /sync-gateway-slots endpoint, Sync Slots dashboard button | sms-ingest, mdn-rotator, dashboard |
| 2026-03-16 | OTA BLIMEI source-of-truth strategy: `hxChangeImei` flags `_alreadyAssigned`; fixSim forces new pool IMEI on stale Helix cache; fixSim OTA step updates `sims.imei` from live BLIMEI | mdn-rotator |
| 2026-03-16 | `blimei_update` queue job: OTA refresh → DB imei update → gateway set, 1 per message; `/trigger-blimei-sweep` endpoint queues all 535 active SIMs | mdn-rotator, dashboard |
| 2026-03-16 | `/imei-gateway-sync` fix: `sims.imei` updated from OTA BLIMEI before gateway set attempt, so heartbeat retries use correct IMEI even if gateway is down | mdn-rotator |
| 2026-03-15 | IMEI heartbeat system: `gateway_imei_synced_at`, `gateway_imei_sync_count`, DB trigger on suspend/cancel, periodic re-sync, 3-consecutive graduation | mdn-rotator, DB |
| 2026-03-15 | System-wide IMEI gateway sweep: `/imei-gateway-sync` endpoint, 295/295 active SIMs synced (BLIMEI = gateway IMEI) | mdn-rotator, dashboard |
| 2026-03-15 | fix-sim: reuse existing eligible IMEI before allocating new; retryUntilFulfilled treats "not needed/already assigned" as success | mdn-rotator |
| 2026-03-15 | Rotation guard rail: daily IMEI re-sync on every rotation to break DLC suspension cycle | mdn-rotator |
| 2026-03-15 | Suspended SIM sweep: all 7 suspended SIMs restored (fix-sim via `/imei-sweep`) | mdn-rotator |
| 2026-03-14 | MDN rotator: all-day cron, client-only filter, 5xx skip, subscriber-must-be-active → fix-sim | mdn-rotator |
| 2026-03-13 | Agent OS built: `agent/` directory with 7 docs + 3 skills (patch-dashboard, sim-triage, session-close) + user SOP | — |
| 2026-03-13 | `op=save` added after IMEI set — persists IMEI changes across gateway reboots | skyline-gateway |
| 2026-03-11 | Reseller sync: remove verification_status filter; backfill all sim_numbers to verified | reseller-sync |
| 2026-03-11 | Dashboard: Force re-send option in Reseller Sync | dashboard |
| 2026-03-01 | RLS enabled on all public Supabase tables | DB migration |
| 2026-02-25 | SMS verification removed; verified: true hardcoded in all number.online senders | mdn-rotator, reseller-sync, dashboard |
| 2026-02-19 | QBO tables created; quickbooks worker deployed | quickbooks, DB migration |
| 2026-02-19 | Billing: switch to QBO CSV export format with service date | quickbooks |

---

## Teltik Production Notes

- **Push webhook format**: `{ destination, origin, message, timestamp, port, gateway_id, nickname }` — NOT `{ to, from, message, time_stamp }` (that's the all-sms polling format). Handler accepts both.
- **First rotation (2026-03-25)**: cron fired at 21:10 UTC, numbers changed in Teltik but DB not updated due to polling format mismatch. DB manually patched: SIM 629 → +17754018206, SIM 630 → +19187209741, last_mdn_rotated_at set to ~21:57 UTC.
- **Next Teltik rotation due**: ~2026-03-27 21:57 UTC (48h after manual patch). Cron will handle automatically.
- **48h guard**: `last_mdn_rotated_at` is now stamped immediately on `change-number` API success, before polling completes — prevents double-rotation even if polling fails.

---

## Architecture Validation

These items were verified to be working correctly as of their last check:

- MDN rotation cron (all-day, every 20 min): ✅
- Dedup guard in `rotateSingleSim` (re-reads DB before rotating): ✅
- `op=save` after IMEI set: ✅ (added 2026-03-13)
- IMEI heartbeat re-sync (every 20 min, graduated after 3×, reset on suspend/cancel): ✅ (added 2026-03-15)
- OTA BLIMEI = `sims.imei` = gateway IMEI strategy: ✅ (sweep in progress 2026-03-16)
- `hxChangeImei` `_alreadyAssigned` flag + fixSim force-new-pool-IMEI: ✅ (deployed 2026-03-16)
- sms-ingest AT&T upgrade message → auto IMEI change: ✅
- Reseller webhook dedup (date-based, failed doesn't block): ✅
- OTA error handling (both errorMessage + rejected[].message): ✅
- RLS bypass via service_role key: ✅
- Port format normalization (dot-notation): ✅

---

## Open Questions

_None currently tracked._
