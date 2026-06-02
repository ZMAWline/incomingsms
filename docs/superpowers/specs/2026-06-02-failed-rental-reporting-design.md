# INC-3 — Bad-rental reporting & remediation workflow (design, revised)

Status: **proposal, awaiting board approval**
Author: IncomingSMS CEO
Date: 2026-06-02 (rev 2)
Related: INC-2 (rental billing capture, in production), reseller-portal-resend (2026-05-25)

## Scope correction (2026-06-02)

Earlier draft proposed *us-detecting* dead rentals and pushing to the reseller. Per operator clarification:

- **Do not chase the historical 54 rentals.** That invoice is closed; the reseller accepts it.
- **Do not reopen INC-2.** Legacy billing math and the INC-2 capture stay untouched.
- The actual ask: a **future-facing reporting channel** — the **reseller reports a bad rental/number to us** quickly during the rental period, so we can **fix/reset/remediate while it still matters**, instead of finding out during the next reconciliation.
- This is operational hygiene, not invoice dispute infrastructure.

Everything below is rewritten against that scope.

## 1. Goal & success criteria

When a rented number isn't working for the reseller, they should be able to **tell us in seconds** and **see what we did about it** before the rental period ends. Success looks like:

- Reseller has a single endpoint to POST "this rental is bad" with the rental id and a short reason.
- We acknowledge immediately, queue a triage action, and post back a status (`received → in_triage → remediated{action} | unable_to_reproduce | replaced | refund_pending`).
- Operator (Zalmen) sees a single "Bad Rental Reports" queue in the dashboard, with one-click remediation buttons that reuse existing tools (`/rotate-sim?force=true`, port reset, suspend).
- The number of bad rentals that survive into the next reconciliation drops to ~0 — not because we hunt them, but because the reseller tells us first.

Non-goals: automatic credits, automatic invoice adjustments, automatic suspension. Operator decisions, recorded as evidence.

## 2. Intake contract (reseller → us)

**Endpoint:** `POST /api/v1/rentals/report-bad` on the **reseller-portal** worker (existing auth surface, same key the reseller already holds).

**Body (one report per request):**
```json
{
  "rental_id": 123456,                 // OUR rentals.id, optional but preferred
  "reseller_rental_id": "trustotp-xyz",// THEIR id; used if rental_id not given
  "e164": "+15551234567",              // required if neither id is given
  "reason_code": "no_sms_received",    // enum, see below
  "reason_note": "3 send attempts, no SMS in 30 min", // optional, free text, <500 chars
  "attempts": 3,                       // optional: their send-attempt count
  "first_attempt_at": "2026-06-02T17:00:00Z",  // optional
  "client_request_id": "<uuid>"        // optional, for their idempotency
}
```

**reason_code enum (v1):**
- `no_sms_received` — most common: rental minted, no SMS arrived.
- `wrong_number` — receiving SMS for a different account/service.
- `delayed_sms` — SMS arrives too late to be useful.
- `other` — free-text required in `reason_note`.

**Identification rule:** at least one of `rental_id`, `reseller_rental_id`, `e164` is required. Resolution order: `rental_id` → `reseller_rental_id` (lookup in `rentals`) → most recent active rental for `e164` belonging to that reseller. Ambiguous/missing → `400` with a clear error code.

**Response (200):**
```json
{
  "report_id": 4521,
  "rental_id": 123456,
  "e164": "+15551234567",
  "status": "received",
  "queued_at": "2026-06-02T17:32:01Z",
  "expected_first_action_within_minutes": 60
}
```

**Errors:** standard `4xx` with `{error_code, message}`. `409` on duplicate active report for the same `rental_id` within the last 24h — return the existing `report_id` (idempotent for the reseller's retries).

## 3. Status feedback (us → reseller)

Two channels, both off the same source of truth:

### 3.1 Pull (Phase 1)
`GET /api/v1/rentals/reports?status=open|all&since=...` returns the reseller's own reports with current status. Same auth.

`GET /api/v1/rentals/reports/{report_id}` for a single report.

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

## 6. Auth, security, abuse controls

- **Auth:** existing reseller portal API key (`portal.incoming-sms.com` middleware). Per-reseller scope enforced at query — a reseller can only read/write their own reports.
- **Rate limit:** 60 reports/min/reseller, 1000/day. Plenty of headroom for a real outage; tight enough to flag a runaway client.
- **Anti-abuse:** the `uq_rental_reports_open` index makes "report the same rental 100x" a no-op (returns the existing `report_id`). A reseller cannot use the endpoint to flood the queue against arbitrary numbers — they can only report rentals they own.
- **Audit:** every status transition writes a `rental_report_events` row, including reseller-initiated reports (`actor='reseller'`). Full chain of custody.
- **No PII** beyond MDN — already shared in the existing webhook stream.

## 7. Dashboard tab — "Bad Rental Reports"

Patched into `src/dashboard/index.js` via the **patch-dashboard** skill (required for any dashboard change).

- Default view: open reports (status `received` or `in_triage`), reseller column, e164, reason, age, action buttons.
- Filter by reseller, status, age.
- Row-expand shows the event log and links to the underlying rental, SIM, and any remediation attempt rows.
- Operator-only; uses the existing dashboard auth.

Test-environment first: deploy via `--env test` (verify domain bindings — known footgun, see memory `wrangler-test-env-inherits-custom-domain`).

## 8. Tie-back to billing — *how this prevents future discrepancies*

This is the connective tissue, not a re-opening of INC-2:

- Today, a bad rental is silently billed and surfaces weeks later as a reconciliation delta.
- With this flow, a bad rental gets a **timestamped report + remediation record during the period**. Three downstream consequences (all gated, none automatic in v1):
  1. **Operator can offer a same-period credit** if the remediation didn't help — decided per case, recorded as a note on the rental.
  2. **Reconciliation has evidence**: at month-end, the rental_reports table is the single source of truth for "rentals the reseller flagged." No more back-and-forth on whether they reported it.
  3. **Pattern detection (later):** clusters of reports on the same SIM/carrier/route surface inventory or vendor problems faster than they would from billing alone.

Phase 1 builds the **evidence channel**. Auto-credit policy is a separate, later proposal.

## 9. Phasing

**Phase 1 (this proposal, asks approval):** intake endpoint, `rental_reports` + `rental_report_events` tables, status pull endpoints, dashboard tab, manual remediation only. **No customer-facing automation. No invoice changes.** Test-env first.

**Phase 2 (separate approval):** outbound webhook for status transitions to the reseller (partner sign-off required on payload + URL).

**Phase 3 (separate approval, billing review):** auto-credit policy for rentals whose reports closed `remediated` after >Xh, or `unable_to_reproduce` with operator concurrence.

## 10. Exact implementation steps & files (Phase 1)

1. **Migration** — `supabase/migrations/2026XXXX_rental_reports.sql` (schema above).
2. **Worker** — `src/reseller-portal/index.js`:
   - `POST /api/v1/rentals/report-bad` — intake handler (validate, resolve rental, insert, idempotency on open report).
   - `GET  /api/v1/rentals/reports[?status=&since=]` — list.
   - `GET  /api/v1/rentals/reports/{id}` — detail.
3. **Dashboard** — `src/dashboard/index.js` via **patch-dashboard** skill:
   - "Bad Rental Reports" tab with the columns + actions described in §7.
   - Action buttons call existing endpoints, write a `rental_report_events` row, update status.
4. **Operator notifier (optional, tiny)** — `src/details-finalizer/index.js`: include `open_rental_reports` count in the nightly rotation review. Same channel operators already read.
5. **Docs** — `agent/decision-log.md` entry on the SLA target, why operator-only in v1, and the explicit non-goal of auto-credits.

Nothing in `src/sms-ingest/`, no change to `rentals`/`reseller_rental_rates`/`webhook_deliveries`, no change to billing math, no flag flips, no production deploy until §11 verification passes.

## 11. Verification plan

1. Apply migration to **dashboard-test** Supabase project only.
2. Deploy `reseller-portal` and `dashboard` with `--env test` (verify custom domain bindings post-deploy).
3. **Synthetic intake test:** post a fake report against a known test-env rental; confirm the row inserts, the dashboard surfaces it, and idempotency holds on retry.
4. **Operator dry-run:** click each remediation action against a test-env SIM; confirm the action runs, the report status flips, and `rental_report_events` records correct evidence.
5. **Auth fuzz:** verify a reseller cannot read another reseller's reports (RLS + handler check both).
6. **Rate-limit smoke:** burst 100 requests; confirm the limiter trips and returns `429` with a clean error.
7. Operator review of the dashboard tab on at least one day of synthetic traffic.

Only after all six pass: production deploy of Phase 1, endpoint live but **not announced** to the reseller until the operator does a hand-off.

## 12. Risks & non-goals

- **Non-goal:** automatic credits, automatic invoice adjustments, automatic SIM actions. Operator-in-the-loop for every remediation.
- **Non-goal:** changing INC-2 billing math, the legacy engine, the rentals schema, or anything in `sms-ingest`.
- **Risk — noisy reports:** reseller could over-report. Mitigation: idempotent dedup per open rental, daily rate limit, and operator can mark `unable_to_reproduce` to close the loop without action.
- **Risk — slow operator response harms the SLA promise:** mitigation in v1 is that the SLA is advisory, exposed in the response, and not contractual. Phase 3 could tighten this.
- **Risk — Phase 2 webhook misfire** spamming the reseller: gated behind separate approval and per-reseller opt-in.

## 13. Approval requested

Approval to proceed **with Phase 1 only**:

1. Migration for `rental_reports` + `rental_report_events`.
2. Intake `POST /api/v1/rentals/report-bad` and read endpoints on `reseller-portal`.
3. "Bad Rental Reports" tab on the dashboard (operator-only), patched via the `patch-dashboard` skill.
4. Nightly open-reports count in the rotation review.
5. Full verification on `--env test` before any production deploy.
6. **No outbound webhook, no auto-credits, no invoice changes** — those are Phase 2 and Phase 3, separately approved.
