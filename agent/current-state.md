# Current State

> This is a living document. Update it when things break, get fixed, or change meaningfully.
> Last updated: 2026-03-24 (session 9)

---

## Known Issues / Degraded

_None currently tracked. Add here when something breaks in production._

---

## In Progress / Pending Work

### Dashboard Redesign — Test Only, Not in Production
Gemini UI (zinc/blue palette, light mode, custom confirm/toast dialogs) is deployed to `dashboard-test`. Production dashboard (`dashboard`) has not been updated this session. Deploy to prod when confirmed stable on test.

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
