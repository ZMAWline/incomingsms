# INC-3 — Failed-rental reporting/reset workflow (design)

Status: **proposal, awaiting board approval**
Author: IncomingSMS CEO
Date: 2026-06-02
Related: INC-2 (rental billing capture, just enabled), reseller-portal-resend (2026-05-25)

## 1. Problem & business framing

Reseller (TrustOTP/Maxim) reconciliation for the recent period:

- Their total: **$11,326**, our total: **$11,521**, delta **$195**.
- Maxim's read: most of the remaining delta is **rentals/numbers that never worked** — rentals they paid for but received zero SMS on.
- They counted **54 rentals in the period that never received any SMS**.
- They want a way to **find these fast and reset the port / line** so they're not paying for dead inventory.
- They proposed three shapes: outbound webhook from us, a queryable endpoint, or a reset endpoint they call. Suggested trigger: **3–5 send intents with no SMS received**.

Reconciliation math sanity-check: 54 rentals × ~$1.10–$1.60 (AT&T/T-Mobile flat rental rate) ≈ **$59–$86**. That alone does not close the $195 delta — but it explains a *meaningful slice* and gives them an operational fix path. The rest of the delta still needs the standard rental-by-rental diff (already in progress against the INC-2 capture). So this workstream is **partial reconciliation + operational hygiene**, not a closer of the whole delta.

Why this matters now: per-rental flat-rate billing (INC-2) means a dead rental is a **full unit of billable revenue we cannot defend** if the reseller has evidence it never carried traffic. We need to surface dead inventory before they do.

## 2. Definition of "non-working rental"

A rental row in `rentals` (the INC-2 capture table) with all of:

| Field | Source | Definition |
|---|---|---|
| `rental_id` | `rentals.id` | INC-2 row, one per `(reseller_id, sim_number_id)` lifetime |
| `e164` | `rentals.e164` | The MDN the reseller paid for |
| `minted_at` | `rentals.minted_at` | When we acknowledged the rental |
| `sms_count` | derived from `sms_messages` joined on `sim_number_id` (or e164 fallback) | Inbound SMS received on this number lifetime |
| `first_sms_at` | derived | min(received_at) over the lifetime |
| `age_minutes` | now − minted_at | |

Candidate flag: `sms_count = 0 AND age_minutes >= GRACE_MIN`.

Two phases of "non-working" we will distinguish in output:

- **`suspect`** — `sms_count = 0` and `age_minutes ∈ [GRACE_MIN, CONFIRM_MIN)`. May still recover; surface for monitoring only.
- **`confirmed_dead`** — `sms_count = 0` and `age_minutes ≥ CONFIRM_MIN`. Eligible for credit/reset.

Default thresholds (proposed, board-tunable as data, not code):

- `GRACE_MIN = 60` (1h) — covers gateway/route bring-up latency.
- `CONFIRM_MIN = 360` (6h) — a SIM that received zero SMS in 6 hours on an active OTP route is dead inventory by any reasonable read. Reseller asked for "3–5 send intents"; we don't see their intents, so we proxy on elapsed time on an active rental.

Both thresholds are stored in `qbo_customer_map` or a new tiny `reseller_settings` row, not constants — so per-reseller tuning doesn't ship code.

### False-positive guardrails

1. **Exclude rentals whose `sim_numbers` row is no longer current** (already rotated): the new lifetime gets a new rental row, the old one is correctly "done", not "dead".
2. **Exclude rentals on SIMs the reseller has already returned/cancelled** (assignment ended).
3. **Exclude SIMs in `rotation_failed`, `barred`, or operator-known stuck cohorts** — surface separately so they don't pollute the dead list; we already know about those.
4. **Exclude rentals minted in the last `GRACE_MIN`** unconditionally.
5. **Cap per-call result size** at e.g. 500 to avoid runaway lists.

## 3. API/webhook design — three shapes the reseller proposed

### Option A — outbound webhook (us → them) — **recommended**

Push the same way `number.online` already works for SMS notifications. New event type `rental.suspect` and `rental.dead` (two-stage notify) posted to a per-reseller URL.

Payload:
```
{
  "event": "rental.dead",
  "rental_id": 123456,
  "reseller_rental_id": "trustotp-xyz",     // when known
  "e164": "+1...",
  "carrier": "att",
  "minted_at": "2026-06-01T18:22:00Z",
  "age_minutes": 367,
  "sms_count": 0,
  "incomingsms_status": "active" | "rotation_failed" | "barred"
}
```

Pros:
- Same shape they already integrate (`number.online` webhooks).
- Push = they react in seconds, not on a poll interval.
- Idempotent: keyed on `(event, rental_id)`; we won't re-fire `rental.dead` for the same rental.

Cons:
- We have to track delivery (extend `webhook_deliveries` with the new event_type).
- New customer-facing surface — needs partner sign-off before live.

### Option B — queryable endpoint (they pull) — **recommended as Phase 1**

`GET /api/resellers/{id}/non-working-rentals?status=dead&since=...` returning a JSON list. Reads cheaper, lower partner-integration risk than a webhook, lives behind the same auth they already use (reseller portal API key).

Pros:
- **No customer-facing push behavior to approve.** Same auth boundary as the existing portal — internal scope.
- Lets us validate the detection logic against real data with zero coupling to their system.
- Trivially also drives the dashboard view (Phase 1.5).

Cons:
- Pull cadence is theirs; "instant" depends on how often they poll.

### Option C — reset endpoint we call — **defer**

`POST /api/resellers/{id}/rentals/{rental_id}/reset` would mark the rental as dead, issue a credit, and either rotate the SIM or hand back the slot. This is **billing-affecting** and **operates on production inventory**. It should not be in v1.

Phase-3 candidate if A+B prove the detection is accurate. Until then, the operator (Zalmen) handles resets manually using existing port-reset / `/rotate-sim?force=true` tools, informed by Option B's list.

### Recommended sequencing

1. **Phase 1 (this week):** Option B — read-only endpoint + dashboard tab + nightly counts in the rotation review. **No customer-facing behavior, can ship without partner approval.**
2. **Phase 2:** Option A — outbound webhook to TrustOTP for `rental.dead`. Requires partner sign-off on payload + URL.
3. **Phase 3 (later, separate approval):** Option C — reset action. Requires legal/billing review; touches credits.

## 4. Auth, security, rate limits

- Endpoint lives on the existing **reseller-portal** worker (already auth'd by reseller API key, already deployed at `portal.incoming-sms.com`).
- Per-reseller scope enforced at query time — a reseller can only see their own rentals (same pattern as the resend endpoint).
- Rate limit: 60 req/min/reseller via Cloudflare worker bindings; the list is small and cheap to compute.
- No PII beyond MDN + rental id (data they already have).
- Outbound webhook (Phase 2): HMAC-signed payload, retry with backoff, recorded in `webhook_deliveries` with new `event_type = 'rental.dead'`. Same delivery semantics as today.

## 5. Detection logic — implementation sketch

Single PostgREST view + RPC, called by both the dashboard and the new endpoint:

```sql
CREATE OR REPLACE VIEW rental_health AS
SELECT
  r.id              AS rental_id,
  r.reseller_id,
  r.sim_id,
  r.sim_number_id,
  r.e164,
  r.carrier,
  r.minted_at,
  r.reseller_rental_id,
  COALESCE(m.sms_count, 0)             AS sms_count,
  m.first_sms_at,
  EXTRACT(EPOCH FROM (now() - r.minted_at))/60 AS age_minutes,
  s.status                              AS sim_status,
  sn.is_current                         AS lifetime_is_current
FROM rentals r
JOIN sims s            ON s.id = r.sim_id
JOIN sim_numbers sn    ON sn.id = r.sim_number_id
LEFT JOIN LATERAL (
  SELECT COUNT(*)::bigint AS sms_count, MIN(received_at) AS first_sms_at
  FROM sms_messages
  WHERE sim_number_id = r.sim_number_id     -- preferred join
) m ON true;
```

(Exact column names verified against `sms_messages` before code; `sim_number_id` may need to be derived via e164+sim_id if not denormalized.)

Then a thin RPC `get_non_working_rentals(p_reseller_id, p_status, p_since)` applies the thresholds and the false-positive guardrails from §2.

## 6. Dashboard / test-environment visibility

New tab on the dashboard: **"Dead Inventory"** (gated to operator role).

- Default view: confirmed dead rentals for the last 7 days, by reseller.
- Columns: rental_id, reseller_rental_id, e164, carrier, age, sim_status, last action (rotate / reset / credit).
- Row actions (operator only): "rotate now" (uses existing `/rotate-sim?force=true`), "mark resolved" (writes a note to a new `rental_notes` row — does NOT mutate the rental itself).
- All UI changes go through the `patch-dashboard` skill (hard rule).

Test environment first: `--env test` deploy of reseller-portal exposes the endpoint at the test domain; dashboard-test reads the same view. We will **not** wire the production endpoint until operator + reseller have validated the list against the 54-rental period.

## 7. Tie-back to the $195 / 54-rental reconciliation

- Re-run the 54-rental list through the new view as the **first verification of detection accuracy**: any rental the reseller flagged as dead should appear `confirmed_dead` (or have a defensible reason it doesn't — e.g., rotated since, status changed).
- Counted slice: 54 dead × per-carrier rate from `reseller_rental_rates` → expected $ impact. Compare to $195. The residual (≈$110–$135) likely lives in the same reconciliation buckets we're already chasing in the INC-2 forward-only window: rotation-timing edge cases, late notifications, and rentals minted on one side but not the other.
- Outcome of this exercise becomes evidence in the next reseller bill discussion; it is **not** a basis for auto-credits in this phase.

## 8. Exact implementation steps & files

Phase 1 (read-only, the only phase this proposal asks approval for):

1. **Schema (Supabase migration)** — `supabase/migrations/2026XXXX_rental_health.sql`:
   - View `rental_health` (above).
   - RPC `get_non_working_rentals(p_reseller_id bigint, p_status text, p_since timestamptz)`.
   - Tiny `reseller_settings` row OR two new columns on `qbo_customer_map` for `dead_grace_min`, `dead_confirm_min` (default 60 / 360).
2. **Worker** — `src/reseller-portal/index.js`:
   - New route `GET /api/v1/non-working-rentals?status=dead|suspect|all&since=...`.
   - Auth via existing reseller API key middleware.
   - Calls the RPC, returns JSON.
3. **Dashboard** — `src/dashboard/index.js` (via `patch-dashboard` skill):
   - New "Dead Inventory" tab with the columns above.
   - Hits the same RPC (via existing PostgREST bridge), not the reseller-portal worker — operator view is internal.
4. **Rotation review tie-in** — `src/details-finalizer/index.js`:
   - Add a `dead_inventory_today` count to the nightly report (this closes the rotation-review under-counting blind spot for this specific failure mode — a dead rental is not the same as a rotation failure, but the operator should see both).
5. **Docs** — `agent/decision-log.md` entry on thresholds & why they're data not code; `agent/project-map.md` updates for the new view/RPC.

Phase 2 (outbound webhook) — **separate approval**, scope-locked here:
- Extend `webhook_deliveries.event_type` enum.
- New scheduled cron in details-finalizer that diffs `rental_health` against an `outbound_dead_notifications` table and fires the webhook once per `(reseller_id, rental_id)`.
- Partner sign-off on payload + URL.

Phase 3 (reset endpoint) — **separate approval, billing review required**, scope-locked here.

## 9. Verification plan

Before any production deploy:

1. Apply migration to **dashboard-test** Supabase project (test env), backfill `rental_health` view.
2. Deploy `reseller-portal` and `dashboard` with `--env test` (verify domain bindings — known footgun, see memory).
3. **Run the 54-rental list** through the test endpoint. Expected: ≥ 90% of the reseller's 54 show as `confirmed_dead` with `sms_count = 0` for the rental window. Investigate any miss before going further.
4. Cross-check against `sms_messages`: spot-check 5 rentals manually with a direct PostgREST query to make sure the LEFT JOIN math is right.
5. Operator review of the dashboard tab on at least 2 days of data.
6. Only then: production deploy of Phase 1, with the endpoint live but **not yet shared with the reseller** until §7 step 1 results are accepted.

## 10. Risks & non-goals

- **Non-goal:** automatic credits, automatic rotation, automatic suspension of dead rentals. All three are the operator's call.
- **Non-goal:** changing INC-2 billing math or invoicing behavior.
- **Risk — false positives:** a working SIM that just had no OTP traffic in 6h would look "dead." Mitigation: thresholds are tunable, and Phase 1 is read-only — the worst case is a noisy list, not a customer impact. Phase 2 webhook will only fire on `confirmed_dead`, never `suspect`.
- **Risk — webhook to reseller (Phase 2)** triggers their automation to reset/credit. Requires explicit partner approval; gated separately.
- **Risk — `sms_messages` schema assumption:** the join on `sim_number_id` needs verification; if absent, fall back to `(sim_id, e164, received_at BETWEEN minted_at AND lifetime_ended_at)`. Caught in step 4 of verification.

## 11. Approval requested

Approval to proceed **with Phase 1 only**:

1. Migration for the view, RPC, and threshold storage (no data movement, no billing-touching).
2. Read-only `GET /api/v1/non-working-rentals` route on `reseller-portal` (auth'd, internal scope until reseller is told).
3. "Dead Inventory" tab on the dashboard (operator-only).
4. Nightly count in the rotation review.
5. Verification against the 54-rental list in test before any prod deploy.

Phase 2 (outbound webhook to TrustOTP) and Phase 3 (reset endpoint) are explicitly **not** in this approval — separate proposals will follow if Phase 1 results justify them.
