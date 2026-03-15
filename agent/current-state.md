# Current State

> This is a living document. Update it when things break, get fixed, or change meaningfully.
> Last updated: 2026-03-14 (session 3)

---

## Known Issues / Degraded

_None currently tracked. Add here when something breaks in production._

---

## In Progress / Pending Work

### QuickBooks Integration — Needs Secrets
- Worker deployed: ✅
- Tables created: ✅ (`qbo_customer_map`, `qbo_invoices`)
- Dashboard billing tab: ✅
- **Remaining:** Set secrets `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` in the quickbooks worker to enable OAuth flow. Redirect URI already configured: `https://dashboard.zalmen-531.workers.dev/api/qbo/callback`.

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
- sms-ingest AT&T upgrade message → auto IMEI change: ✅
- Reseller webhook dedup (date-based, failed doesn't block): ✅
- OTA error handling (both errorMessage + rejected[].message): ✅
- RLS bypass via service_role key: ✅
- Port format normalization (dot-notation): ✅

---

## Open Questions

_None currently tracked._
