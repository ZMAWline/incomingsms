# Reseller Portal — Self-Serve `number.online` Resend & Visibility

**Date:** 2026-05-25
**Status:** Approved design — ready for implementation plan
**Primary user:** Maxim / TrustOTP (largest reseller; sessions 58–59 context)
**Workers touched:** `reseller-portal`, `reseller-sync`
**Schema touched:** `webhook_deliveries` (+1 column), `reseller_actions_log` (new, small)

---

## 1. Background

Session 59 (2026-05-23) confirmed that Maxim has zero recourse when our `number.online` pipeline silently under-delivers. The PR-B incident on 2026-05-20 caused a one-night gap (92 vs ~750 expected Teltik rotations) that he could only spot via his own revenue drop. From his side, the only signal is the absence of `number.online` webhooks — and the only fix today is to message us and wait.

This spec gives him recovery primitives without exposing vendor rotation internals or letting him incur vendor cost.

## 2. Goal

Enable a reseller, authenticated against the existing reseller portal, to:

1. Re-fire `number.online` for a single SIM he owns ("Resend").
2. Re-fire `number.online` for **every currently-active** SIM he owns ("Resync all").
3. See the history of `number.online` deliveries we've sent for a given SIM.
4. Download a CSV of his currently-active rentals.

## 3. Non-goals

- No manual MDN rotation. A "resend" never calls Teltik/ATT/Helix/ATOMIC; no new MSISDN is allocated and no vendor billing event occurs.
- No aggregate operator-style dashboard (no "last night you rotated N of M", no vendor-failure breakdowns, no cron health panel). His view stays scoped to his own webhook deliveries.
- No replay of any other webhook event type (`number.offline`, lifecycle, etc.).
- No changes to the existing programmatic API for active rentals (`GET /api/sims?active=true`) — that contract stays stable; only additive endpoints are introduced.

## 4. User stories

**4.1 — "I think I missed one rental."**
Maxim opens the portal, finds the SIM (he knows the MDN or rental ID), clicks "Resend" on its row, and within ~5 seconds sees the delivery result (HTTP 200 from his endpoint, parsed `rentalId` echoed back).

**4.2 — "My system desynced overnight, I don't know which rentals I'm missing."**
Maxim clicks "Resync all" at the top of the SIMs tab. A modal warns him that this will re-emit `number.online` for all N of his currently-active rentals. He confirms. A progress summary appears: `5 succeeded, 0 failed` (small reseller) or backgrounded with a "watch this tab" link (larger reseller). Subsequent clicks within 10 minutes are rejected.

**4.3 — "Did you ever actually send me rental X for this MDN?"**
Maxim clicks the SIM row to open the lifetime modal (existing UX). A new section "Number.online history" shows the last 20 `number.online` deliveries we've sent for that SIM: timestamp, MDN at the time, HTTP status, parsed `rentalId` from his response.

**4.4 — "Give me a snapshot for my own records."**
Maxim clicks "Download CSV" in the SIMs tab. He gets a CSV of the currently rendered active-SIMs table — exactly the columns he sees on screen.

## 5. Architecture

### 5.1 Existing components reused

- **`reseller-portal` worker** (`src/reseller-portal/index.js`) — owns auth (PBKDF2 password + HMAC session cookie + `rsk_*` API key) and reseller-scoped queries. All new UI and API routes live here.
- **`reseller-sync` worker** (`src/reseller-sync/index.js`) — already owns the outbound `number.online` dispatch pipeline (`dispatchEvent`), reseller webhook config lookup, and `webhook_deliveries` insertion. All new send-side logic extends this worker.
- **`webhook_deliveries` table** — existing audit trail for outbound webhooks. Already queried by the operator dashboard.
- **`reseller_sims` table** — existing reseller-to-SIM ownership map, with `last_rental_id` updated by the existing dispatch path on each successful `number.online`.

### 5.2 New service binding

Add `RESELLER_SYNC` service binding to `src/reseller-portal/wrangler.toml` (both prod env and `[env.test]`). The portal never calls reseller-sync over public HTTP — only via the binding. This keeps the new resend endpoints unreachable from the public internet.

### 5.3 New endpoints — `reseller-portal` (public, authenticated)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/sims/:simId/resend-online` | Re-fire `number.online` for one SIM. |
| `POST` | `/api/sims/resync-all` | Re-fire `number.online` for all the caller's active SIMs. |
| `GET`  | `/api/sims/:simId/online-history` | Last 20 `number.online` deliveries for one SIM. |

All three require `authenticate()` → `{resellerId}`. All three re-verify the SIM (or all SIMs returned) belong to that reseller before any further action. All three return JSON.

### 5.4 New endpoints — `reseller-sync` (service-binding only, never public)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/resend-online` | Body `{simId, resellerId, source}`. Re-emits `number.online` once. Returns `{ok, http_status, rental_id, response_excerpt}`. |
| `POST` | `/resync-reseller` | Body `{resellerId, source}`. Iterates this reseller's active SIMs with bounded concurrency (5 parallel), invokes the same per-SIM resend path for each. Returns `{queued, succeeded, failed, results: [...]}`. |

Both reject unless invoked via the service binding. Concrete enforcement: caller (`reseller-portal`) attaches a fixed header `X-Internal-Caller: reseller-portal` and reseller-sync rejects if absent. Defense in depth, not the primary trust boundary — the binding itself is the boundary.

### 5.5 Resend semantics (single source of truth)

A "resend" for SIM `S` owned by reseller `R`:

1. Look up SIM's current `msisdn` and `iccid` from `sims`.
2. Look up reseller's webhook config (URL, auth, etc.) from existing reseller config tables.
3. Build the `number.online` payload identically to what the rotation pipeline builds today (same field names, same structure — reuse the existing builder helper).
4. POST to the reseller's endpoint via the existing `dispatchEvent` path (relayFetch-wrapped per `agent/constraints.md §11`).
5. Insert a row into `webhook_deliveries` with `event_type='number.online'`, `source='portal_resend'` (single-SIM) or `source='portal_resync'` (bulk), `sim_id=S`, `reseller_id=R`, `payload`, `response_status`, `response_body` (truncated).
6. If the reseller's response includes a `rentalId`, update `reseller_sims.last_rental_id` to that value — exactly as the regular dispatch path does. The reseller's system owns the rentalId namespace; we just record whatever they return.

This means a resend is functionally indistinguishable from a regular rotation-driven `number.online` from his side, except that no MSISDN changed.

### 5.6 Rate limits

Stored in a new table `reseller_actions_log` (or — TBD during implementation if simpler — a small KV namespace). Schema:

```sql
create table reseller_actions_log (
  id            bigserial primary key,
  reseller_id   bigint not null,
  action        text not null,       -- 'portal_resend' | 'portal_resync'
  sim_id        bigint,              -- nullable; null for bulk
  created_at    timestamptz not null default now()
);
create index on reseller_actions_log (reseller_id, action, created_at desc);
create index on reseller_actions_log (reseller_id, sim_id, created_at desc) where sim_id is not null;
```

Limits (enforced server-side in `reseller-portal` before invoking reseller-sync):

| Action | Limit |
|--------|-------|
| Bulk `resync-all` | **1 per reseller per 10 minutes.** |
| Per-SIM `resend-online` | **1 per SIM per 5 minutes** AND **100 per reseller per rolling hour.** |

On violation: HTTP 429 with `{error, retry_after_seconds}`. UI shows a friendly message.

The per-SIM + per-reseller cap exists so the bulk limit cannot be trivially bypassed by a scripted loop of per-SIM calls.

### 5.7 Visibility — `number.online` history per SIM

`GET /api/sims/:simId/online-history` reads `webhook_deliveries` where:

- `event_type = 'number.online'`
- `sim_id = :simId`
- joined/filtered against `reseller_sims` to confirm the caller owns this SIM

Returns up to 20 rows ordered `created_at desc`, each shaped as:

```json
{
  "delivered_at": "2026-05-23T05:14:00Z",
  "msisdn_at_send": "+15551234567",
  "http_status": 200,
  "rental_id": "abc123",
  "source": "cron" | "portal_resend" | "portal_resync",
  "delivered": true
}
```

`delivered: true` iff `http_status` is 2xx **AND** a `rentalId` was parsed from the response body — matching the existing operator-side definition (see `src/reseller-sync/index.js:394`).

### 5.8 CSV export

Pure client-side: a new "Download CSV" button in the SIMs tab serializes the in-memory `allSims` array (post-filter) into CSV and triggers a download via `Blob` + `URL.createObjectURL`. No new endpoint needed.

Columns: `Rental ID, MDN, Status, Start (UTC), Expires (UTC), ICCID, Carrier`.

## 6. UI changes (all in `portalHtml()` inside `reseller-portal/index.js`)

1. **SIMs tab — top bar:** add two buttons next to the existing filter input:
   - "Download CSV" (instant)
   - "Resync all" (opens confirmation modal showing active count; disabled if rate-limited, with countdown text)
2. **SIMs tab — table row:** add a trailing actions cell with a "Resend" button. Per-row resend opens a small modal with current MDN + iccid + "Confirm resend" CTA + the UI-copy note about rental ID handling.
3. **Lifetime modal:** insert a new section "Number.online history" listing the rows from `/api/sims/:simId/online-history`. Empty-state copy if the SIM has no deliveries yet.
4. **Toasts/inline feedback:** show resend results inline rather than `alert()` — per the user's standing instruction (memory `feedback_no_native_dialogs.md`). No native dialogs anywhere.

## 7. Schema changes

### 7.1 `webhook_deliveries` — add `source` column

```sql
alter table webhook_deliveries
  add column if not exists source text not null default 'cron';
-- valid values: 'cron', 'pipeline', 'portal_resend', 'portal_resync'
create index if not exists webhook_deliveries_source_idx
  on webhook_deliveries (source, created_at desc);
```

Existing rows get `'cron'` by default — acceptable because pre-migration, every `number.online` came from the rotation pipeline. This loses no audit fidelity going backward and gives clean partitioning going forward.

### 7.2 `reseller_actions_log` — new

Schema as shown in §5.6 above.

## 8. Error handling

- **Reseller-sync unreachable (service binding error):** return HTTP 502 to the portal client with a user-readable "Resend pipeline temporarily unavailable" message; log to console for operator.
- **Reseller's endpoint returns 5xx or non-JSON:** still log the `webhook_deliveries` row with the response body excerpt; surface `http_status` and `delivered: false` in the UI so Maxim sees that we tried and his side failed.
- **SIM not owned / not active:** 404 from the portal endpoint, do not call reseller-sync.
- **Rate-limited:** 429 from the portal endpoint, do not call reseller-sync, do not write to `reseller_actions_log` (a rejected request shouldn't count toward the limit).

## 9. Security

- No new public endpoints exposed in reseller-sync — all new send-side endpoints are service-binding-only.
- All ownership checks happen in reseller-portal against the authenticated `resellerId`. Client cannot pass a `resellerId`.
- Rate limits enforced server-side and cannot be bypassed via direct API call (the per-SIM and per-reseller caps both apply).
- Per `agent/constraints.md §11`: any reseller-side webhook POST must go through `relayFetch(env, url, init)` — the existing `dispatchEvent` already does this, and we are reusing that path verbatim.

## 10. Testing

Manual:
1. Log into portal as a non-Maxim test reseller; verify all three new buttons appear.
2. Click "Resend" on a SIM owned by that reseller → confirm new `webhook_deliveries` row with `source='portal_resend'` and a delivery to the configured webhook URL.
3. Click "Resend" twice within 5 minutes → second should 429.
4. Click "Resync all" → verify N rows in `webhook_deliveries` with `source='portal_resync'`, all within the bounded concurrency timing.
5. Click "Resync all" within 10 minutes → 429.
6. Attempt cross-reseller SIM access: in a logged-in session for reseller A, `curl POST /api/sims/<simId-owned-by-B>/resend-online` → 404.
7. Inspect lifetime modal — confirm `number.online history` shows past cron + new portal-resend rows distinguishable by the `source` column.

Verification before completion (per `superpowers:verification-before-completion`):
- Run `npm run check:db-constraints` after the migration — required per memory `feedback_verify_db_constraints.md`.
- Run `node _check_relay.js` to confirm no bare `fetch()` introduced in the resend path.
- `node --input-type=module --check < src/dashboard/index.js` and `node _check_frontend_js.js` — only relevant if the dashboard ALSO changes; this spec touches `reseller-portal` not `dashboard`, so the `patch-dashboard` skill is not in scope. But run both anyway as a safety net.

## 11. Deployment plan

1. Apply migrations via `mcp__supabase__apply_migration` (one migration: `reseller_portal_resend`).
2. Deploy `reseller-sync` first (new endpoints become callable but no one yet calls them).
3. Deploy `reseller-portal` second (UI + new endpoints come online; service binding to reseller-sync activates).
4. Sanity-check by hitting `/api/sims/<id>/resend-online` against a test SIM owned by a low-volume reseller before mentioning to Maxim.

## 12. Open questions / risks

- **TrustOTP idempotency:** session 59 confirmed his side accepted every `number.online` cleanly. A bulk resync should not cause issues, but if he ever bills per `number.online` event rather than per rentalId, a resync of 1300+ rentals could look like a billable event to his system. **Mitigation:** the "Resync all" confirmation modal must be explicit about how many events will be sent and warn that the impact on his own internal accounting is his responsibility.
- **Backpressure on his endpoint:** at 5-parallel concurrency × 1300 SIMs, the resync completes in ~roughly minutes. If his endpoint is slow, we could pile up. **Mitigation:** the existing `dispatchEvent` already has timeouts; bulk-resync results will surface any per-rental failures in the returned summary.
- **Bulk-resync runtime vs. CF Worker wall-clock:** A single fetch from the portal may exceed CPU/wall limits for a >1000-SIM reseller. **Mitigation:** if the active-SIM count exceeds a threshold (say 200), `resync-reseller` should `ctx.waitUntil()` the work and return immediately with a `job_id`. Implementation plan to decide threshold + whether to add a tiny status endpoint.

These are flagged for the implementation plan to resolve — not blockers for design approval.
