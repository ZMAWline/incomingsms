# Decision Log

Each entry: **what was decided**, **why**, **consequence / what not to undo**.

---

## 2026-03-13 — `op=save` after IMEI set on gateway

**Decision:** `handleSetImei` in skyline-gateway now calls `op=save` immediately after a successful `op=set`.

**Why:** IMEI changes are stored in RAM only. After a device reboot, all changes revert and AT&T suspends the line. This was causing repeated suspensions.

**Consequence:** Do not remove the save call. The gateway UI "System Settings → Save and Reboot → Save" was the only previous fix — this automates it.

---

## 2026-03-11 — All `sim_numbers` rows backfilled to `verified`; reseller-sync no longer filters by verification_status

**Decision:** All existing `pending` sim_numbers rows set to `verified`. reseller-sync query removed `verification_status` filter.

**Why:** Verification was removed 2026-02-25 but the reseller-sync query still filtered on it, causing some SIMs to be silently skipped.

**Consequence:** `verification_status` column still exists but is always `verified`. Do not add logic that branches on its value.

---

## 2026-03-01 — RLS enabled on all public tables

**Decision:** Applied RLS to all Supabase public tables.

**Why:** Security hardening.

**Consequence:** Workers use `service_role` key, which bypasses RLS automatically — no code changes needed. If a new worker ever uses the anon key, it will hit RLS denials.

---

## 2026-02-25 — SMS verification removed

**Decision:** Removed SMS-based phone number verification. All `number.online` senders hardcode `verified: true`.

**Why:** Verification was causing false negatives and was not providing real value.

**Consequence:** Do not add back verification gates. Any `sim_numbers` insert should set `verification_status = 'verified'` directly.

---

## 2026-02-19 — QBO tables added; quickbooks worker deployed

**Decision:** Added `qbo_customer_map` and `qbo_invoices` tables. Deployed `quickbooks` worker.

**Why:** Automated billing against resellers via QuickBooks Online.

**Consequence:** Worker is deployed. OAuth flow requires QBO credentials (QBO_CLIENT_ID, QBO_CLIENT_SECRET) to be set as secrets. Redirect URI: `https://dashboard.zalmen-531.workers.dev/api/qbo/callback`.

---

## ~2026-02 — Queue-based fix-sim, not direct service binding call

**Decision:** `fix-sim` operations go through `fix-sim-queue` (max_batch_size=1) rather than being called directly via service binding.

**Why:** The fix-sim flow (allocate IMEI → set gateway → subscriber_details → OTA → Cancel → Resume → hxChangeImei → DB update) takes much longer than the 30-second service-binding timeout. Putting it in a queue gives it up to the queue's execution timeout and allows retries.

**Consequence:** Fix-sim returns immediately; results appear in Helix API Logs. Do not try to make this synchronous.

---

## ~2026-02 — Supabase bridge via Edge Function for gateway communication

**Decision:** The skyline-gateway worker does not call the physical gateway directly. It POSTs to a Supabase Edge Function that relays the request.

**Why:** Cloudflare Workers cannot reach Cloudflare-proxied IPs (error 1003 on direct IP, error 521 on proxied domain). This is an internal routing loop in Cloudflare's infrastructure with no workaround on the CF side.

**Consequence:** Supabase Edge Function must remain deployed. Auth is via `x-bridge-secret` header. If the bridge goes down, all gateway operations fail with 502. Required secrets: `SKYLINE_SECRET` (skyline-gateway worker auth) and `SKYLINE_BRIDGE_SECRET` (bridge auth).

---

## ~2026-01 — Date-based dedup for `number.online` webhooks

**Decision:** Dedup key for `number.online` is `(simId, iccid, number, YYYY-MM-DD UTC)`. Only `delivered` records block re-sends; `failed` records do not.

**Why:** Prevents triple-sending on the same day (mdn-rotator + dashboard + reseller-sync all send to the same reseller). `failed` records are not blocking so a transient failure doesn't permanently suppress delivery.

**Consequence:** If a SIM has a delivered record for today, reseller-sync will skip it. Use `force=true` param on `/run` to bypass dedup. The dashboard "Skip dedup" checkbox does this.

---

## 2026-03-14 — MDN rotation cron runs all day

**Decision:** Cron changed from `"0,20,40 4-15 * * *"` + `"0 16 * * *"` to `"0,20,40 * * * *"` (every 20 min, all 24 hours). Hour gate removed from `scheduled()` handler.

**Why:** Some SIMs get Helix 5xx errors and are skipped each run. With a limited window (4–16 UTC) there was no guarantee all SIMs would get rotated by noon. Running all day means every skipped SIM gets another attempt 20 minutes later until it succeeds.

**Consequence:** `queueSimsForRotation` already filters by `last_mdn_rotated_at >= NY midnight`, so runs after all SIMs are done are fast no-ops. Safe to run 24/7. The `getNYMidnightISO()` dedup guard handles the DST boundary correctly at runtime — the cron itself no longer needs to be DST-aware.

---

## ~2025-12 — No Supabase CLI auth

**Decision:** All DB operations from workers use the PostgREST API with service_role key, not the Supabase CLI. Migrations are applied via MCP tool.

**Why:** No CLI login token configured in the project. MCP tool works without it.

**Consequence:** `supabase db push` and similar CLI commands will fail. Use `mcp__supabase__apply_migration` instead.

---

## ~2025-12 — `sms-ingest` updates `sims.gateway_id/port` before triggering IMEI change

**Decision:** When the sms-ingest worker receives an AT&T "upgrade your device" message, it calls `updateSimPortAndGateway` BEFORE triggering the auto-IMEI-change in mdn-rotator. Port conflict resolution evicts any other SIM claiming the same `(gateway_id, port)` first.

**Why:** The IMEI change flow needs accurate port location to set the IMEI on the right gateway slot. Port conflict resolution prevents two SIMs claiming the same physical slot.

**Consequence:** Do not reorder these steps. The conflict eviction must happen before the IMEI set.
