# INC-3 — Bad-rental reporting & remediation workflow (design, revised rev 3)

Status: **proposal, awaiting board approval (rev 3 — extends existing reseller portal)**
Author: IncomingSMS CEO
Date: 2026-06-02 (rev 3)
Related: INC-2 (rental billing capture, in production), reseller-portal-resend (2026-05-25, the live reseller portal this proposal extends)

## Scope corrections so far

- **Rev 2 (earlier today):** flipped direction from *us-detecting* dead rentals to *reseller-reporting* a bad rental. Don't chase the closed 54 / $195. Don't reopen INC-2.
- **Rev 3 (earlier):** **build on the existing reseller portal** (`src/reseller-portal/index.js`, deployed at `portal.incoming-sms.com`) rather than inventing a new `/api/v1/...` surface. Reuse its auth, rate-limit table, SIMs tab, modal pattern, and HTML/JS shell.
- **Rev 4 (now):** **the reseller's `rentalId` is the primary external identifier**, not our internal `sim_id`. Board flagged that resellers operate against the `rentalId` we capture in `rentals.reseller_rental_id` (the value they echoed back on `number.online`). Plan now accepts four identifiers — `reseller_rental_id` (primary), our `rental_id`, our `sim_id`, or `e164` (last-resort) — all resolved against the same `rentals` row. Portal UI button still operates per-SIM (the row already knows the SIM), so internally it just hits the same handler with `sim_id`.

## Existing reseller portal — what we already have (so we don't reinvent it)

From `src/reseller-portal/index.js` (1287 lines, in production):

- **Auth:** API key (`rsk_*` Bearer) **and** session cookie (`rp_session` / `rps_*`) — both resolve to a `reseller_id` via `getCredFromRequest()`/session middleware.
- **Rate-limiting:** `reseller_actions_log` table + `checkRateLimit(env, resellerId, action, simId)` helper. Adding a new action is one entry in `checkRateLimit()`.
- **Routes (relevant):**
  - `GET /api/sims` — reseller's SIMs list.
  - `GET /api/sims/:simId/lifetime` — current/most-recent lifetime, MDN, billing breakdown.
  - `GET /api/sims/:simId/online-history` — history of `number.online` events.
  - `POST /api/sims/:simId/resend-online` — already-present operator-style action initiated by the reseller, rate-limited (`portal_resend`).
  - `POST /api/sims/resync-all` — bulk equivalent.
- **UI:** SPA-ish HTML in `portalHtml()` with tabs (`SIMs`, `Invoices`, `API Access`), SIM-row buttons, a generic modal helper, a confirm dialog (`rp-confirm-*`), `jsonResp()` envelope.
- **Upstream:** internal `RESELLER_SYNC` worker binding for actions that affect external state (used by `/resend-online`).

The bad-rental flow **already has 80% of its surface area built**. The remaining 20% is one new SIM-row action + one new operator/admin worker doing the actual remediation, plus the small report-history table.

## 1. Goal & success criteria

When a rented number isn't working for the reseller, they should be able to **tell us in seconds from the SIM row in the existing portal** and **see what we did about it** before the rental period ends.

- Reseller clicks "Report bad" on a SIM row (next to the existing "Resend" button) → reason modal → submitted.
- We acknowledge immediately, write a report row, and the operator gets a queue entry in the dashboard.
- The reseller's portal SIM row shows the current report status inline (no separate dashboard for them).
- Operator triages from the IncomingSMS dashboard "Bad Rental Reports" tab using existing remediation tools.

Non-goals: no automatic credits, no automatic SIM rotation, no invoice changes. Same as rev 2.

## Architecture diff vs rev 2

| Concern              | Rev 2 (standalone)                  | Rev 3 (extends portal)                                |
|---------------------|-------------------------------------|-------------------------------------------------------|
| Intake URL          | `POST /api/v1/rentals/report-bad`   | `POST /api/sims/:simId/report-bad` (matches existing) |
| Auth                | New API-key middleware              | Reuse `getCredFromRequest()` + session                |
| Rate limit          | New limiter                         | Reuse `reseller_actions_log` w/ action `portal_report_bad` |
| Identification      | rental_id / reseller_rental_id / e164 | `simId` from URL (already keyed in portal UI)        |
| Reseller UI         | None (API-only)                     | New "Report bad" button on existing SIMs tab + modal  |
| Status visibility for reseller | New `GET /api/v1/rentals/reports` | `GET /api/sims/:simId/report-status` + inline badge on SIM row |
| Operator dashboard  | New tab                              | New tab (unchanged from rev 2)                        |
| New DB tables       | `rental_reports` + `rental_report_events` | Same                                              |

## 1. Goal & success criteria

When a rented number isn't working for the reseller, they should be able to **tell us in seconds** and **see what we did about it** before the rental period ends. Success looks like:

- Reseller has a single endpoint to POST "this rental is bad" with the rental id and a short reason.
- We acknowledge immediately, queue a triage action, and post back a status (`received → in_triage → remediated{action} | unable_to_reproduce | replaced | refund_pending`).
- Operator (Zalmen) sees a single "Bad Rental Reports" queue in the dashboard, with one-click remediation buttons that reuse existing tools (`/rotate-sim?force=true`, port reset, suspend).
- The number of bad rentals that survive into the next reconciliation drops to ~0 — not because we hunt them, but because the reseller tells us first.

Non-goals: automatic credits, automatic invoice adjustments, automatic suspension. Operator decisions, recorded as evidence.

## 2. Intake contract (reseller → us)

### What identifier does the reseller send?

The reseller's natural reference is **their own `rentalId`**, which they echoed to us on `number.online` and we stored as `rentals.reseller_rental_id`. That is the **primary, recommended external identifier**. Our internal `sim_id` is also sent on every `number.online` (`data.sim_id` in `src/details-finalizer/index.js` and `src/teltik-worker/index.js`), so it is accepted as a fallback for callers who hold it.

**Recommended identifier order for the reseller:**
1. `reseller_rental_id` (their `rentalId`) — primary, what they track in their own system.
2. `rental_id` — our `rentals.id`, returned in our `/api/sims/reports` responses and useful for follow-ups.
3. `sim_id` — our `sims.id`, what the portal UI uses internally (already on every `number.online`).
4. `e164` — last-resort if no id is available; resolves to the most recent active rental for the reseller on that MDN.

### Two endpoint shapes (both supported, same backend handler)

**(a) Rental-keyed, body-driven — primary for API/programmatic callers:**
```
POST /api/rentals/report-bad
```
Body:
```json
{
  "reseller_rental_id": "trustotp-xyz",   // PRIMARY: the rentalId we echoed back from their number.online response
  "rental_id": 123456,                    // alt: our rentals.id
  "sim_id": 4242,                         // alt: our sims.id (data.sim_id on number.online)
  "e164": "+15551234567",                 // alt: last-resort lookup
  "reason_code": "no_sms_received",       // enum, default "no_sms_received"
  "reason_note": "3 send attempts, no SMS in 30 min", // free text, <500 chars
  "attempts": 3,
  "first_attempt_at": "2026-06-02T17:00:00Z",
  "client_request_id": "<uuid>"
}
```
At least one of `reseller_rental_id` / `rental_id` / `sim_id` / `e164` is required. Resolution order matches the list above. Ambiguous (`e164` matches >1 active rental) → `400` with the candidate `rental_id`s in the response so the caller can disambiguate.

**(b) SIM-keyed, URL-driven — used by the existing portal UI:**
```
POST /api/sims/:simId/report-bad
```
Same body schema minus the identifier fields. The portal's "Report bad" button already knows the SIM from the row, so this shape avoids a redundant id in the body. Internally calls the same `handleReportBad(rental, reason)` after resolving `:simId` to its current active rental.

**reason_code enum (v1):**
- `no_sms_received` — most common: rental minted, no SMS arrived.
- `wrong_number` — receiving SMS for a different account/service.
- `delayed_sms` — SMS arrives too late to be useful.
- `other` — free-text required in `reason_note`.

**Response (200, same `jsonResp` envelope the portal already uses) — echoes back all identifiers we resolved, so the caller can correlate against whichever one they hold:**
```json
{
  "report_id": 4521,
  "rental_id": 123456,
  "reseller_rental_id": "trustotp-xyz",
  "sim_id": 4242,
  "sim_number_id": 9876,
  "e164": "+15551234567",
  "status": "received",
  "queued_at": "2026-06-02T17:32:01Z",
  "expected_first_action_within_minutes": 60,
  "rate_limit": { "retry_after": 0 }
}
```

**Errors:** standard `4xx` returned via `jsonResp({error, ...}, status)` (the helper the portal already uses). `409` on a duplicate active report for the same `sim_number_id` within the last 24h — return the existing `report_id` (idempotent for retries).

## 3. Status feedback (reseller-side)

### 3.1 Inline in the existing portal — primary surface
On the SIMs tab, the existing SIM row gets a small status badge when there's an open report:
- ⏳ `Reported · in triage`
- ✅ `Resolved · rotated 12m ago`
- ❌ `Unable to reproduce` (last 24h only)

Driven by a new field returned in the existing `GET /api/sims` payload (`open_report` object, null when none).

### 3.2 Per-SIM status endpoint
`GET /api/sims/:simId/report-status` → most recent report for the current lifetime + last 5 historical. Powers the SIM-detail modal.

### 3.3 Pull-all (lightweight, for API consumers)
`GET /api/sims/reports?status=open|all&since=...` returns the reseller's own reports. Documented on the existing **API Access** tab.

### 3.2 Push (Phase 2, separate approval — partner sign-off required)
Optional outbound webhook on status transitions to a URL the reseller registers. Same delivery pipeline as `webhook_deliveries` (event_type `rental.report.status`). Defaults off; enabled per-reseller in `qbo_customer_map`.

### Status lifecycle
```
received
   ↓ (operator picks up)
in_triage
   ↓                              ↓                              ↓
remediated{action}        unable_to_reproduce            duplicate
   action ∈ {rotated, port_reset, sim_replaced, mdn_swapped, other}
```

Each transition writes a `rental_report_events` row with `actor` (operator id or `system`), `note`, `evidence` (e.g., remediation_attempts.id, new sim_number_id). Reseller sees the latest status; not the operator's internal notes.

## 4. Triage & remediation flow (internal)

1. Intake handler validates payload, resolves the rental, inserts `rental_reports` row with status `received`, returns `200`.
2. Same handler **also** enqueues an `operator_inbox` notification (no automatic remediation in v1 — operator must approve every action).
3. Operator opens the "Bad Rental Reports" dashboard tab → sees the new row at the top.
4. One-click actions reuse existing endpoints (no new remediation primitives):
   - **Rotate** → `POST /rotate-sim?sim_id=&force=true`
   - **Port reset** → existing Teltik/Skyline port reset action per vendor
   - **Replace SIM** → mark current sim_number for retirement; assign next from pool (existing pool-refill flow)
   - **Mark unable to reproduce** → close report with that status + note
   - **Mark duplicate** → link to an existing report
5. Each action writes to the report's event log and updates status. The remediation itself uses the existing tools — no new code paths there, just wiring.

**SLA target (advisory, not contractual in v1):** first action within 60 minutes during business hours, 8 hours overnight. Exposed as `expected_first_action_within_minutes` in the intake response so the reseller has a number to quote.

## 5. Data model

One small migration (`supabase/migrations/2026XXXX_rental_reports.sql`):

```sql
CREATE TABLE rental_reports (
  id BIGSERIAL PRIMARY KEY,
  reseller_id BIGINT NOT NULL REFERENCES resellers(id) ON DELETE CASCADE,
  rental_id  BIGINT NULL REFERENCES rentals(id) ON DELETE SET NULL,
  sim_id     BIGINT NULL REFERENCES sims(id)    ON DELETE SET NULL,
  e164       TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('no_sms_received','wrong_number','delayed_sms','other')),
  reason_note TEXT NULL,
  attempts INT NULL,
  first_attempt_at TIMESTAMPTZ NULL,
  client_request_id TEXT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','in_triage','remediated','unable_to_reproduce','duplicate')),
  remediation_action TEXT NULL
    CHECK (remediation_action IN ('rotated','port_reset','sim_replaced','mdn_swapped','other') OR remediation_action IS NULL),
  duplicate_of BIGINT NULL REFERENCES rental_reports(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  triaged_at TIMESTAMPTZ NULL,
  closed_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rental_reports_open  ON rental_reports (reseller_id, status) WHERE status IN ('received','in_triage');
CREATE INDEX idx_rental_reports_rental ON rental_reports (rental_id);
CREATE INDEX idx_rental_reports_e164   ON rental_reports (e164);

-- Idempotency: one open report per rental per reseller at a time.
CREATE UNIQUE INDEX uq_rental_reports_open
  ON rental_reports (reseller_id, rental_id)
  WHERE status IN ('received','in_triage') AND rental_id IS NOT NULL;

CREATE TABLE rental_report_events (
  id BIGSERIAL PRIMARY KEY,
  report_id BIGINT NOT NULL REFERENCES rental_reports(id) ON DELETE CASCADE,
  from_status TEXT NULL,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,   -- 'reseller' | 'operator:<id>' | 'system'
  note        TEXT NULL,
  evidence    JSONB NULL,      -- e.g. {"remediation_attempt_id": 123}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Both tables get RLS enabled. No new columns on existing tables; INC-2 schema untouched.

## 6. Auth, security, abuse controls (reuse what's already there)

- **Auth:** the existing portal's `getCredFromRequest()` (API key `rsk_*` or session cookie `rps_*`). Reseller scoping is already enforced — the `:simId` URL handler must verify the SIM belongs to the authenticated reseller (same `ownResp` check pattern used by `handleResendOnline`, `handleSimLifetime`).
- **Rate limit:** one new action name in `checkRateLimit()`:
  ```js
  if (action === 'portal_report_bad') {
    if (simId != null) {
      const perSim = await countActionsSince(env, resellerId, 'portal_report_bad', 3600, simId);
      if (perSim >= 1) return { allowed: false, retryAfter: 3600, reason: 'This SIM was reported within the last hour' };
    }
    const perDay = await countActionsSince(env, resellerId, 'portal_report_bad', 86400);
    if (perDay >= 200) return { allowed: false, retryAfter: 86400, reason: 'Per-reseller daily cap (200) reached' };
    return { allowed: true };
  }
  ```
  Logged via the same `logAction(env, resellerId, 'portal_report_bad', simId)` helper.
- **Anti-abuse:** `uq_rental_reports_open` index + the per-SIM 1h cooldown means flooding the same SIM is a no-op (returns the existing `report_id`).
- **Audit:** every status transition writes a `rental_report_events` row (`actor='reseller'` for intake, `actor='operator:<id>'` for triage actions). Same audit pattern as existing portal actions.

## 7. Reseller portal UI changes (the minimal delta)

`src/reseller-portal/index.js` only — no separate UI worker. Touch points:

1. **SIMs tab — new row action.** Add a "Report bad" button next to the existing "Resend" button in the SIM row template. Click → opens a modal (reuse the existing modal helper) with reason dropdown + note textarea + Submit.
2. **SIMs tab — status badge.** After submit, the row shows the badge described in §3.1. The badge state comes from a new `open_report` field appended to each SIM row in `handleSims()`.
3. **SIM detail modal — report history.** When the existing `handleSimLifetime` modal opens, a new section lists the most recent reports for the lifetime (calling `GET /api/sims/:simId/report-status`).
4. **API Access tab — docs.** A new section documents `POST /api/sims/:simId/report-bad` and `GET /api/sims/:simId/report-status` next to the existing rental-list API docs.
5. **No new tab needed** on the reseller side. The reseller's mental model stays "go to my SIMs and act on a row." This is the recommendation; happy to add a separate "Reports" tab later if usage data shows the inline view is insufficient.

## 8. Operator dashboard tab — "Bad Rental Reports"

(Unchanged from rev 2 — this is the IncomingSMS-side dashboard, not the reseller portal.) Patched into `src/dashboard/index.js` via the **patch-dashboard** skill (required for any dashboard change).

- Default view: open reports (status `received` or `in_triage`), reseller column, e164, reason, age, action buttons.
- Filter by reseller, status, age.
- Row-expand shows the event log and links to the underlying rental, SIM, and any remediation attempt rows.
- Operator-only; uses the existing dashboard auth.

Test-environment first: deploy via `--env test` (verify domain bindings — known footgun, see memory `wrangler-test-env-inherits-custom-domain`).

## 9. Tie-back to billing — *how this prevents future discrepancies*

This is the connective tissue, not a re-opening of INC-2:

- Today, a bad rental is silently billed and surfaces weeks later as a reconciliation delta.
- With this flow, a bad rental gets a **timestamped report + remediation record during the period**. Three downstream consequences (all gated, none automatic in v1):
  1. **Operator can offer a same-period credit** if the remediation didn't help — decided per case, recorded as a note on the rental.
  2. **Reconciliation has evidence**: at month-end, the rental_reports table is the single source of truth for "rentals the reseller flagged." No more back-and-forth on whether they reported it.
  3. **Pattern detection (later):** clusters of reports on the same SIM/carrier/route surface inventory or vendor problems faster than they would from billing alone.

Phase 1 builds the **evidence channel**. Auto-credit policy is a separate, later proposal.

## 10. Phasing

**Phase 1 (this proposal, asks approval):** intake endpoint, `rental_reports` + `rental_report_events` tables, status pull endpoints, dashboard tab, manual remediation only. **No customer-facing automation. No invoice changes.** Test-env first.

**Phase 2 (separate approval):** outbound webhook for status transitions to the reseller (partner sign-off required on payload + URL).

**Phase 3 (separate approval, billing review):** auto-credit policy for rentals whose reports closed `remediated` after >Xh, or `unable_to_reproduce` with operator concurrence.

## 11. Exact implementation steps & files (Phase 1, rev 4)

1. **Migration** — `supabase/migrations/2026XXXX_rental_reports.sql` (schema in §5 above). No changes to existing tables.
2. **Reseller portal worker** — `src/reseller-portal/index.js` (extend, don't fork):
   - Add `resolveRentalForReport(env, resellerId, body)` — single resolver that takes any of `reseller_rental_id` / `rental_id` / `sim_id` / `e164` and returns `{ rental_id, sim_id, sim_number_id, e164 }` or `{ error, candidates }`. Resolution order matches §2.
   - Add `handleReportBadByRental(auth, env, request)` — primary handler. Reads JSON body, calls `resolveRentalForReport`, verifies the rental belongs to the authenticated reseller, runs `checkRateLimit('portal_report_bad', sim_id)`, inserts into `rental_reports`, logs to `reseller_actions_log`, returns `jsonResp` (echoing all identifiers).
   - Add `handleReportBadBySim(simId, auth, env, request)` — thin wrapper used by the portal UI: resolves `:simId` → current active rental, then delegates to the same insertion code path.
   - Add `handleReportStatus(simId, auth, env)` — most recent reports + events for the SIM.
   - Add `handleReportsList(auth, env, url)` — all reports for the reseller, filterable by status/since.
   - Extend `handleSims()` to attach an `open_report` field per row (one extra query, grouped by `sim_id`).
   - Route table additions (in `fetch()` near the existing sims routes):
     ```js
     if (url.pathname === '/api/rentals/report-bad' && request.method === 'POST') return handleReportBadByRental(auth, env, request);
     if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/report-bad$/)) && request.method === 'POST') return handleReportBadBySim(m[1], auth, env, request);
     if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/report-status$/))) return handleReportStatus(m[1], auth, env);
     if (url.pathname === '/api/sims/reports') return handleReportsList(auth, env, url);
     ```
   - Extend `checkRateLimit()` with the `portal_report_bad` branch (code shown in §6).
   - Extend `portalHtml()`: "Report bad" button in the SIM row template, modal markup (reuse `rp-confirm-*` helpers), status badge slot, and the small JS handler to POST and refresh the row.
   - Extend the **API Access** tab HTML with the two new endpoint snippets.
3. **Operator dashboard** — `src/dashboard/index.js` via **patch-dashboard** skill (unchanged from rev 2):
   - "Bad Rental Reports" tab with the columns + actions described in §8.
   - Row-action buttons call existing remediation tools (rotate, port reset, replace), write a `rental_report_events` row, update report status.
4. **Operator notifier (small)** — `src/details-finalizer/index.js`: include `open_rental_reports` count in the nightly rotation review.
5. **Docs** — `agent/decision-log.md` entry on the SLA target, why operator-only in v1, and the explicit non-goal of auto-credits.

Nothing in `src/sms-ingest/`, no change to `rentals`/`reseller_rental_rates`/`webhook_deliveries`, no change to billing math, no flag flips, no production deploy until §12 verification passes.

## 12. Verification plan

1. Apply migration to **dashboard-test** Supabase project only.
2. Deploy `reseller-portal` and `dashboard` with `--env test` (verify custom domain bindings post-deploy).
3. **Synthetic intake test:** post a fake report against a known test-env rental; confirm the row inserts, the dashboard surfaces it, and idempotency holds on retry.
4. **Operator dry-run:** click each remediation action against a test-env SIM; confirm the action runs, the report status flips, and `rental_report_events` records correct evidence.
5. **Auth fuzz:** verify a reseller cannot read another reseller's reports (RLS + handler check both).
6. **Rate-limit smoke:** burst 100 requests; confirm the limiter trips and returns `429` with a clean error.
7. Operator review of the dashboard tab on at least one day of synthetic traffic.

Only after all six pass: production deploy of Phase 1, endpoint live but **not announced** to the reseller until the operator does a hand-off.

## 13. Risks & non-goals

- **Non-goal:** automatic credits, automatic invoice adjustments, automatic SIM actions. Operator-in-the-loop for every remediation.
- **Non-goal:** changing INC-2 billing math, the legacy engine, the rentals schema, or anything in `sms-ingest`.
- **Risk — noisy reports:** reseller could over-report. Mitigation: idempotent dedup per open rental, daily rate limit, and operator can mark `unable_to_reproduce` to close the loop without action.
- **Risk — slow operator response harms the SLA promise:** mitigation in v1 is that the SLA is advisory, exposed in the response, and not contractual. Phase 3 could tighten this.
- **Risk — Phase 2 webhook misfire** spamming the reseller: gated behind separate approval and per-reseller opt-in.

## 14. Approval requested (rev 4)

Approval to proceed **with Phase 1 only**, scoped to the existing reseller portal:

1. Migration for `rental_reports` + `rental_report_events`.
2. New routes on the existing `reseller-portal` worker:
   - `POST /api/rentals/report-bad` — **primary**, body-keyed. Accepts `reseller_rental_id` (recommended), `rental_id`, `sim_id`, or `e164`.
   - `POST /api/sims/:simId/report-bad` — convenience route used by the portal UI's "Report bad" button.
   - `GET  /api/sims/:simId/report-status` — per-SIM report history.
   - `GET  /api/sims/reports` — list of all reports for the reseller.
   - Extending `GET /api/sims` to attach `open_report` per row.
3. UI additions inside the **existing** portal SPA: "Report bad" button + reason modal on the SIMs tab, status badge, SIM-detail modal history section, API Access tab docs. No new tab, no new worker.
4. "Bad Rental Reports" tab on the **operator** dashboard (unchanged from rev 2), via the `patch-dashboard` skill.
5. Nightly open-reports count in the rotation review.
6. Full verification on `--env test` before any production deploy.
7. **No outbound webhook, no auto-credits, no invoice changes** — those are Phase 2 and Phase 3, separately approved.
