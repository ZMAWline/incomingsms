# Current State

> This is a living document. Update it when things break, get fixed, or change meaningfully.
> Last updated: 2026-04-24 (session 34 — rotation redesign: RPC claim, NY-day rule, DB-driven polling, 3-strikes cap fix)

---

## Known Issues / Degraded

- **MDN rotation runs DB-driven, every 5 min NY 0–5** — cron `*/5 4-11 * * *` UTC, `scheduled()` calls `processRotationBatch(env, {limit: 60, concurrency: 3})` inline after the NY-hour gate. No CF Queue on the rotation hot path. Bindings for `mdn-rotation-queue` still present in `wrangler.toml` but unused — remove after one full healthy overnight run.
- **38 ATOMIC SIMs marked `status='rotation_failed'` (2026-04-24)** — all return `swapMSISDN statusCode=915 "sim/MSISDN is Inactive"` because AT&T has them in SOC `DSABR2,ZZNOILD2,NIRMAPEX,APEXBLOCK,APEX128` (data-suspend/barred). AT&T is also silently reassigning MDNs on them outside our system. No MDN-rotation attempts are made for these — `queueSimsForRotation`/`processRotationBatch` filter on `status='active'`. Needs external escalation to ATOMIC (email draft in session notes).
- **Wing IoT `sim_numbers` / `number.online` sync lag (2026-04-24)** — 117 Wing IoT SIMs had their rotation PATCH rolled back for a full day (constraint bug), so their `sims.msisdn` + `sim_numbers` + `last_notified_at` drifted from AT&T's actual MDN. Dashboard Query per-SIM syncs the DB; `reseller-sync` daily 15:00 UTC cron fires the webhook. Bulk ATOMIC/Wing Query across the fleet will close most of the remaining drift.
- **API Logs tab shows blank for ATOMIC SIMs** — the dashboard "API Logs" section queries `helix_api_logs`; ATOMIC activations log to `carrier_api_logs`. ATOMIC SIM logs are invisible in the dashboard tab. Fix: update the API Logs query to also check `carrier_api_logs` (or unify into one view).
- **SIM 991 wrong vendor account** — ATOMIC subsriberInquiry returns "SIM does not belong to this vendor". ICCID is not under the `ezbiz` ATOMIC account. Cannot be fixed by restore; needs investigation with Wing Alpha (dan@wingalpha.com) to determine correct account or whether SIM should be removed.
- **Wing IoT SIMs 632, 781, 1019, 1108, 1109 have no gateway/port** — rotation will fail at `callSkylineSetImei` step. These are floating SIMs not physically inserted into any gateway. Rotation will error on first attempt; they'll hit rotation_failed after 3 failures unless assigned to a gateway slot first.
- **SIM 685 still in `error` state** — needs a retry activation. Run retry from dashboard.
- **Wing IoT `number.online` webhook NOT sent on activation** — bulk-activator does not call `sendNumberOnlineWebhook` after activation. Resellers won't be notified until the first rotation cron or daily reseller-sync sweep. Fix: add webhook call to bulk-activator after MDN is synced (OR update bulk-activator to set status='provisioning' so details-finalizer handles it — now that details-finalizer has the Wing IoT branch). **NOTE:** the new details-finalizer Wing IoT runner already handles post-activation (`msisdn IS NULL` + `status=provisioning`) and sends the webhook, so this may already be fixed — verify on next activation.
- **Wing IoT retry activation may still fail with "already active"** — 914 handling is ATOMIC-only. Wing IoT already-active case is not explicitly handled (Wing IoT returns HTTP error codes, not status codes in body, so it would throw and surface in the error log normally).
- **Teltik bulk query needs hard-refresh verification** — code is deployed and correct but user saw all 50 SIMs route to helix (likely stale browser cache). Next session: confirm bulk query routes teltik vendor correctly after hard refresh (Ctrl+Shift+R).

---

## In Progress / Pending Work

### CF Queue removal for mdn-rotation-queue (deferred to tomorrow)
Session 34's DB-driven polling replaced CF Queues on the rotation hot path, but the `mdn-rotation-queue` producer + consumer bindings are still defined in `src/mdn-rotator/wrangler.toml` and the consumer branch in `async queue(batch, env)` (lines ~896–1002) is still present. Producer side (`queueSimsForRotation`) is dead code — nothing calls it after step 4 of the redesign. Pending: verify one full overnight run (~04:00–10:00 UTC = NY 0-5) drains the fleet, then delete the bindings + consumer branch in a small PR. Keep `fix-sim-queue` bindings — that queue is low-volume and works fine.

### ATOMIC DSABR2-barred cluster (38 SIMs)
All marked `status='rotation_failed'`. AT&T side: SOC `DSABR2,ZZNOILD2,NIRMAPEX,APEXBLOCK,APEX128` blocks `swapMSISDN` (statusCode 915 "sim/MSISDN is Inactive"). AT&T is silently reassigning MDNs on these SIMs outside our control. Escalation email drafted in chat; needs to be sent to ATOMIC support. Until resolved, these SIMs won't rotate and their DB MDN will drift — dashboard Query can sync DB to AT&T's current value.

### sms-ingest worker not deployed (commit b6a3a90)
Commit `b6a3a90` (Case A identity-first + webhook relayFetch) is local/pushed but **not deployed** — the dashboard billing fixes shipped today, but the sms-ingest change was bundled with pre-existing relay-webhook work and held for explicit confirmation. Safe to deploy anytime: `cd src/sms-ingest && npx wrangler deploy --env=""`. Dormant until deployed (Case A has zero traffic; webhooks still deliver via bare fetch instead of relay).

### Dashboard Redesign — Now in Production
Gemini UI (zinc/blue palette, light mode, custom confirm/toast dialogs) was unintentionally deployed to prod in session 9, and all related bugs are now fixed. Production dashboard is running the new UI and is stable.

### MDN Rotation Redesign — Deployed (cron paused pending manual resume)
**Goal:** continuous drain, Wing IoT async, force-rotate with warning, cancellable bulk runs.
- **mdn-rotator** (`24044be4`): `rotateWingIotSim` now sets `status='provisioning'` + `rotation_status='mdn_pending'` after plan swap and returns immediately (no MDN poll). `syncWingIotPendingMdns` removed. `rotateSpecificSim` accepts `force` param. Queue `max_batch_size` bumped to 25. Cron paused (was causing duplicate rotations earlier today).
- **details-finalizer** (`3312d5a7`): `runWingIotFinalizer` runs every 5 min alongside the Helix runner. Picks up Wing IoT SIMs in `status='provisioning'` (both activation and post-rotation), GETs MDN from AT&T, closes/opens `sim_numbers`, sets status=active, sends `number.online` webhook. Skips if returned MDN still matches `sim.msisdn` (old MDN propagating). Secrets added: WING_IOT_USERNAME, WING_IOT_API_KEY.
- **teltik-worker** (`223bdf7e`): extracted per-SIM rotation into `rotateOneTeltikSim(env, sim, {force})`. New `/rotate-sim?iccid=X&force=true` endpoint for manual single-SIM rotate.
- **dashboard** (`24eea641`): rotate confirmation dialogs now show ⚠️ force-rotate warning; bulk run shows a Cancel button (`sim-action-cancel`); `handleSimAction` looks up vendor and routes teltik rotations to TELTIK_WORKER via service binding, all others to MDN_ROTATOR.
- **948 handler added (2026-04-22):** ATOMIC swapMSISDN returning "Subscriber Must Be Active" now patches `sims.status='suspended'` in DB + queues fix-sim (was: only queued fix-sim, status stayed active).

**To resume rotation cron:** edit `src/mdn-rotator/wrangler.toml` line 10 → `crons = ["0,20,40 * * * *"]`, then `cd src/mdn-rotator && npx wrangler deploy --env=""`. First rotation after resume should hit midnight NY (04:00 UTC).

### ATOMIC + Wing IoT Migration — Complete + Helix Quarantined
- **Phase 1 (DB):** Complete — msisdn column added, helix_api_logs renamed to carrier_api_logs with vendor column, backward-compatible view created
- **Phase 2 (Workers):** Complete — all 6 workers deployed with vendor routing. **mdn-rotator daily cron now rotates ATOMIC SIMs** (fixed 2026-04-15 session 16; 50/50 SIMs rotated successfully on first cron tick). **Wing IoT rotation wired 2026-04-21** — `rotateWingIotSim` added to mdn-rotator (plan swap: dialable → non-dialable → dialable). `index.ts` (485-line partial port) is NOT production-ready — do not switch entry point. **Note:** 5 Wing IoT SIMs (632, 781, 1019, 1108, 1109) have no gateway/port — rotation will fail until assigned to a gateway slot.
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
| 2026-04-24 | **Rotation system redesign, session 34 — 9 parts shipped.** (1) DB migration: `check_rotation_status` now allows `mdn_pending`; `sims_status_check` now allows `rotation_failed`; new `rotation_source` ('auto'\|'manual') and `rotation_eligible` (bool, default true) columns. (2) Atomic `claim_rotation_slot(sim_id, force)` RPC — NY-calendar-day rule for ≤24h vendors, 48h rolling for teltik; enforces `rotation_eligible`. (3) NY-time gate `isInsideRotationWindowNY()` narrows scheduled to NY 0–5 hours; cron tightened to UTC `*/5 4-11 * * *` — DB-polling replaces CF Queue. (4) New `processRotationBatch(env, {limit, concurrency})` + `runWithConcurrency` helper (60/tick × 3 parallel) called via `ctx.waitUntil` from `scheduled()` and from `/run`. (5) Vendor cutover: every rotation path (atomic, wing_iot, helix, teltik) calls RPC first. (6) `increment_rotation_fail` 3-strikes cap now actually flips `status='rotation_failed'` (constraint fix). 38 stuck ATOMIC SIMs swept to rotation_failed. (7) `sweep_stuck_rotations` pg_cron every 15 min flips `rotation_status='rotating'` older than 30 min to failed. (8) `scripts/check_db_constraints.mjs` drift guard + `npm run predeploy` hook. (9) Dashboard: Last Notified cell opens webhook deliveries modal; `bulkSimAction` uses line-by-line modal; per-row Auto:On/Off pill + bulk Pause/Resume Auto-Rotate + `/api/set-rotation-eligible`. CF Queue producer/consumer bindings still present but unused. | mdn-rotator, teltik-worker, dashboard, DB |
| 2026-04-24 | **Billing fix: paginate reseller_sims (Supabase caps at 1000 regardless of &limit), rotation-aligned Teltik blocks, SMS-Usage RPC status filter.** Net recovery ~$760/cycle for TrustOTP alone. New `supabaseGetAllArray()` helper (offset+limit loop, pageSize=1000) used by both billing handlers. Teltik now bills one block per MDN rotation: block = `[valid_from, min(next_rotation, valid_from + rotation_interval_hours))`; block assigned to the cycle containing its `valid_from` EST date so a 48h window is never split across two invoices. Usage RPC: `mtd`/`trend` CTEs join `sims` raw (no status filter) since billing is retroactive; only `active_sim_count` and `wing_per_sim` keep the status filter. Commits `3c2babc` (billing) + new migration `20260423_sms_usage_billing_aligned.sql`. | dashboard, DB |
| 2026-04-24 | **sms-ingest (COMMITTED, NOT DEPLOYED):** Case A (Skyline recv-sms JSON) now resolves `sim_id` via `gateway_id + port` before falling back to MDN lookup — MDN lookups drift during rotation windows. Case A has had zero traffic in 30 days, so dormant hardening. Same commit includes pre-existing work: `postWebhookWithRetry` now routes via `relayFetch()` (closes the last bare `fetch()` to external endpoints). Commit `b6a3a90`. Deploy with `cd src/sms-ingest && npx wrangler deploy --env=""` when ready. | sms-ingest |
| 2026-04-23 | **SMS Usage analytics tab added to dashboard.** New sidebar tab between Billing and Guide. Shows MTD inbound SMS per vendor, Wing pool utilization (used/153,750), soft-target marker (25/SIM × N), 30-day trend chart (Chart.js CDN), top/bottom 10 Wing SIMs, est cost under $0.01/SMS overage. Backed by new Supabase RPC `get_sms_usage_summary(p_cycle_start, p_today, p_trend_days)` returning one JSONB blob. Worker route `/api/sms-usage` edge-caches 60s; frontend polls 120s while visible. Wing billing cycle = **5th to 4th of month** (confirmed with user) — soft-coded as `BILLING_CYCLE_ANCHOR_DAY = 5` near `handleSmsUsage` in `src/dashboard/index.js`. Commits `d3b0407` + `ee461f0`. | dashboard, DB |
| 2026-04-23 | Rotation cron resumed after session 30 redesign. Added activation-date skip: `queueSimsForRotation` filters out SIMs where `activated_at >= today NY midnight`, and `rotateSingleSim`'s dedup guard does the same check on both stale queue data and fresh DB read. Freshly activated SIMs no longer rotate same-day. | mdn-rotator |
| 2026-04-23 | details-finalizer Wing IoT runner now backfills `activated_at = NOW()` when the column is null on the SIM being finalized. Never overrides an existing value — preserves real activation timestamps. | details-finalizer |
| 2026-04-22 | **MDN rotation redesign (session 30):** Wing IoT plan swap now sets `status=provisioning` + `rotation_status=mdn_pending` and returns; details-finalizer's new `runWingIotFinalizer` (every 5 min) picks up provisioning Wing IoT SIMs, fetches new MDN, closes/opens sim_numbers, fires webhook. `syncWingIotPendingMdns` removed from mdn-rotator. | mdn-rotator, details-finalizer |
| 2026-04-22 | Dashboard rotate: ⚠️ force-rotate confirmation warning; Cancel button added to sim-action-modal for bulk runs (stops future iterations, in-flight SIM completes). Force param threaded through /api/sim-action → mdn-rotator's rotateSpecificSim (bypasses daily dedup when force=true). Teltik rotate now routes to TELTIK_WORKER service binding instead of mdn-rotator (new /rotate-sim endpoint on teltik-worker, extracted per-SIM rotateOneTeltikSim). | dashboard, mdn-rotator, teltik-worker |
| 2026-04-22 | mdn-rotator queue `max_batch_size` 10 → 25 (continuous drain between cron ticks). | mdn-rotator |
| 2026-04-22 | ATOMIC swapMSISDN 948 handler: when description matches "Subscriber Must Be Active", DB is patched to `status='suspended'` before queuing fix-sim (reflects AT&T reality). | mdn-rotator |
| 2026-04-22 | **Incident: 93 Wing IoT SIMs rotated 4× today.** Promise.all within batch + max_concurrency=5 created TOCTOU race on the dedup guard — parallel workers all read `last_mdn_rotated_at IS NULL` before any wrote. Reverted to serial batch processing + max_concurrency=1. All affected SIMs bulk-UPDATE'd with `last_mdn_rotated_at=NOW()` to prevent further duplicates today. | mdn-rotator, DB |
| 2026-04-21 | Wing IoT MDN sync architecture: activation now stores `status=provisioning` immediately (no blocking poll); `syncWingIotPendingMdns()` added to mdn-rotator — runs on every cron tick, finds wing_iot SIMs with `msisdn IS NULL`, GETs MDN from AT&T, writes `sim_numbers` + `sims.msisdn`, sends `number.online` webhook. Also added `/sync-wing-iot-mdns` HTTP endpoint for manual trigger. Already-activated check in queue consumer now also skips `status=provisioning`. Wing IoT rotation MDN poll increased from 5s to 4×60s with change-detection (throws if MDN never changes). **REPLACED 2026-04-22 — see session 30 above.** | bulk-activator, mdn-rotator |
| 2026-04-21 | Dashboard: bulk Modify IMEI now opens `sim-action-modal` showing per-SIM results live (was: single toast at end). Shows `SIM #ID: OK — IMEI <imei>` or `FAILED — <reason>` per SIM, running count, final summary. | dashboard |
| 2026-04-21 | Teltik rotation DB write bugs fixed: `msisdn` added to polling MDN field list (Teltik API uses this field, not `mdn`); fallback to `get-phone-number` now retries 3× with 15s delays instead of single call; DB writes (`sim_numbers` close + insert) now throw on non-ok response instead of silently discarding errors. | teltik-worker |
| 2026-04-21 | Rotation fail count made atomic via Supabase RPC — replaced JS read-modify-write with `increment_rotation_fail(p_sim_id, p_error, p_today_start)` RPC that does `SET rotation_fail_count = rotation_fail_count + 1` atomically; sets `status='rotation_failed'` when count reaches 3; resets count on first failure after midnight NY. Fixes race condition where concurrent queue messages all read stale count and wrote same incremented value. | mdn-rotator, DB |
| 2026-04-21 | ATOMIC fix-sim path added — `fixAtomicSim` in mdn-rotator: (1) retire old IMEI pool entries, allocate new IMEI, set on gateway; (2) ATOMIC subsriberInquiry to sync MDN; (3) if attStatus=Suspended, call restoreSubscriber (reasonCode=CR) and set sims.status=active. `fixSim` dispatches to this new path for vendor=atomic SIMs. `fixSim` HTTP + queue handlers now tolerate Helix token failure (non-fatal). | mdn-rotator |
| 2026-04-21 | Wing IoT daily rotation wired — `rotateWingIotSim` added to mdn-rotator: GET current MDN, PUT non-dialable plan, 2s sleep, PUT dialable plan, 5s sleep, GET new MDN, update sim_numbers + sims.msisdn, fire sendNumberOnlineWebhook. All steps log to carrier_api_logs (vendor=wing_iot). Daily cron filter now includes wing_iot SIMs. Manual `/rotate?iccid=` path also routes wing_iot correctly. | mdn-rotator |
| 2026-04-20 | Wing IoT post-activation MDN query delayed 60s (MSISDN takes ~1 min to propagate). Applied to `activateViaWingIot` (bulk-activator) and `retryActivateViaWingIot` (mdn-rotator). Dashboard stats (Total SIMs, Messages 24h) now use PostgREST `count=exact` instead of fetching all rows (was capped at 1000). QB billing CSV: column header `Qty` → `Item Quantity`. | bulk-activator, mdn-rotator, dashboard |
| 2026-04-20 | **Wing IoT activation root-cause fix:** Wing API is case-sensitive — status must be `"ACTIVATED"` (uppercase), not `"Activated"`. Also added missing `Accept: application/json` header. Applied to both `activateViaWingIot` (bulk-activator) and `retryActivateViaWingIot` (mdn-rotator). Also fixed bulk-activator's post-activation GET to read `msisdn` field (not `mdn`). Dashboard: enabled Retry Activation button for wing_iot SIMs (previously disabled — mdn-rotator retryActivation already supports wing_iot, just need button). Awaiting prod verification. | bulk-activator, mdn-rotator, dashboard |
| 2026-04-17 | ATOMIC swapMSISDN zip fix: added `activation_zip` to `sims` table; bulk-activator stores zip on activation; mdn-rotator (both batch + single path) reads `sim.activation_zip` instead of hardcoded `HX_ZIP`; dashboard ATOMIC query always overwrites `activation_zip` from inquiry `address.zipCode`; backfilled 147 existing SIMs from `carrier_api_logs`. | bulk-activator, mdn-rotator, dashboard, DB |
| 2026-04-17 | Gateway page: "Lock Failed" bulk-locks all st=6 (Reg Failed) ports; "Unlock Locked" bulk-unlocks all st=7/8/12 ports. Both iterate window.portData and POST to skyline/lock or skyline/unlock per port. | dashboard |
| 2026-04-17 | mdn-rotator change_imei: ATOMIC SIMs no longer blocked by missing mobility_subscription_id. Helix eligibility check + hxChangeImei now gated behind isHelixSim (vendor==='helix'). ATOMIC just updates gateway + IMEI pool + DB. | mdn-rotator |
| 2026-04-17 | mdn-rotator change_imei: fixed 409 on imei_pool_unique_in_use_slot — added second retire step keyed on (gateway_id, port) to evict stale slot occupants from previous SIMs before assigning new IMEI. | mdn-rotator |
| 2026-04-17 | Teltik MDN sync: GET /sync-mdns on teltik-worker checks all active Teltik SIMs against /v1/get-phone-number/, fixes sim_numbers on mismatch. Root cause documented: rotation stamps last_mdn_rotated_at before polling; if polling+fallback both fail, sim_numbers stays stale. | teltik-worker |
| 2026-04-17 | Dashboard: Teltik (T-Mobile) option in Carrier Query modal — /api/teltik-query backend, single-SIM ICCID lookup, DB auto-sync banner, bulk query support. Bulk routing needs verification (hard refresh required after deploy). | dashboard |
| 2026-04-17 | Manually fixed SIM 983 MDN: DB had +14232935084, Teltik API returned 8144182808 (+18144182808). Closed stale sim_numbers row, inserted correct MDN. | — |
| 2026-04-17 | Query bulk action: selecting multiple SIMs runs carrier query on each sequentially, shows per-SIM status in sim-action-modal. Single SIM still opens interactive modal. | dashboard |
| 2026-04-17 | DB sync on active carrier query: ATOMIC (attStatus=Active) and Wing IoT (status=ACTIVATED) now update sims.status, sims.activated_at, and sim_numbers MDN automatically after a successful query. Works for both single-SIM modal and bulk query. Fixes: ATOMIC uses `msisdn` (lowercase) not `MSISDN`; Wing IoT uses `ACTIVATED` not `ACTIVE`, MDN field is `msisdn` not `mdn`, passes `dateActivated`. | dashboard |
| 2026-04-17 | mdn-rotator: ATOMIC 914 ("sim already active with another MSISDN") during retry activation now runs a subsriberInquiry, syncs DB (status/MDN/activated_at), releases unused IMEI pool entry, and returns ok:true instead of throwing. | mdn-rotator |
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
