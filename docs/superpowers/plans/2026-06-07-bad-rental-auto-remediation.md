# Plan — Automated Bad-Rental Review & Remediation (INC-16)

**Status:** Draft v2 (planning only — no code).
**Author:** IncomingSMS CEO, 2026-06-07.
**Approval gate:** Operator (Zalmen) sign-off via Paperclip `request_confirmation` before any implementation child issues are opened.

v2 changes vs v1: dropped the "shadow week" framing as the dominant structure. Plan is now a complete operational design intended to be live once approved, organized as **intake flow → per-vendor playbooks → per-branch decisions**. A pre-go-live dry-run verification step remains, but it is one step, not the spine of the plan.

---

## 1. Goal & invariants

Every 2 hours, an automated worker reviews every open bad-rental report, attempts the safest applicable fix, and either resolves the report on strong evidence or escalates with a complete evidence bundle.

Invariants (carried from prior decisions — these constrain every branch below):

1. **Reseller-facing identifiers are locked**: only `reseller_rental_id` or current MDN (e164) are accepted. Never SIM ID, ICCID, internal rental ID, or stale/original MDN.
2. **`verified:true` is hardcoded** — automation must not reintroduce verification gates.
3. **Rotation is sacred** — automation must not touch `last_mdn_rotated_at`, must not trigger rotation, must not call `mdn-rotator`.
4. **No destructive actions** ever automatic: no SIM cancel/deactivate, no SIM replacement, no MDN swap, no rotation, no reseller-facing message beyond the existing `number.online` webhook.
5. **All external calls via `relayFetch`** — no direct origin hits.
6. **Single-job-per-worker** — this ships as a new worker `bad-rental-remediator`, never bolted onto an existing one.
7. **No secrets in comments, logs, or escalation bundles.**

---

## 2. Existing assets the worker will reuse (do not rebuild)

| Asset | Where | Used for |
|---|---|---|
| `rental_reports`, `rental_report_events`, `rental_report_rejections` | Supabase | Source of truth for reports + audit |
| `resolveRentalForReport` | `src/shared/report-bad-resolver.js` | Maps reseller identifier → internal rental/SIM |
| `/api/bad-rentals/*` | dashboard worker | Operator UI (read-only from worker side) |
| `reseller-sync /resend-online` | service binding | Re-fires `number.online` webhook (idempotent, dedup'd) |
| `sims`, `sim_numbers`, `webhook_deliveries` | Supabase | Fresh evidence sources |
| Carrier APIs | atomic-api, wing-iot, helix-api, teltik-api skills | Authoritative vendor state |
| SkyLine port-status | SkyLine-API skill | Gateway-side health |

Existing report state machine (locked):

```
received → in_triage → remediated         (terminal)
                    → unable_to_reproduce (terminal)
                    → duplicate           (terminal)
```

`remediation_action ∈ { rotated, port_reset, sim_replaced, mdn_swapped, other }`.

The worker writes only inside this contract.

---

## 3. Intake flow — what happens the moment a report arrives in scope

This is the universal pipeline every report passes through before vendor-specific logic kicks in. It is the same for every carrier.

```
Step 0  Report appears (status received or in_triage, not paused, not in cooldown).
Step 1  Resolve identifier → internal rental + SIM
        Input: reseller_rental_id OR current e164 (only these two are accepted).
        Output: { sim_id, iccid, current_mdn_e164, vendor, reseller_rental_id, sim.status, last_mdn_rotated_at }.
        Failure: classify as mode J (insufficient evidence), record attempt, exit.

Step 2  Gather DB evidence (single Supabase round-trip)
        - sims row (status, vendor, iccid, current_mdn_e164, replaced_by_sim_id, cancelled_at)
        - newest sim_numbers row for this rental
        - latest webhook_deliveries row for this SIM's most recent number.online
        - any other open rental_reports for the same reseller_rental_id within 24h
        - rental_report_remediation_attempts history for this report (attempt_no, last action, cooldowns)

Step 3  Decide current vendor/carrier
        - sims.vendor is authoritative (atomic | wing_iot | helix | teltik | other).
        - If sims.vendor is missing/unknown: classify as mode J, escalate.

Step 4  Decide current rental identity
        - reseller_rental_id from the report (locked, never changes).
        - current MDN = sims.current_mdn_e164 (this can change over rental lifetime).
        - If the report's submitted MDN differs from sims.current_mdn_e164: do NOT treat that as a mismatch error;
          the resolver already accepts the rental's current MDN. Just log both for the evidence bundle.

Step 5  Branch to vendor playbook (§5)
        The chosen playbook owns: querying the vendor, classifying into a situation, picking the action,
        applying retry/cooldown rules, deciding terminal disposition, and producing the evidence bundle.

Step 6  Record outcome
        - Always write one rental_report_remediation_attempts row (even classify-only).
        - Always write one rental_report_events row (event_type='auto_remediation').
        - On terminal disposition: update rental_reports.status + remediation_action via the same path
          /api/bad-rentals/:id/update uses, so the dashboard timeline stays consistent.

Step 7  Schedule next review
        - Set rental_reports.next_review_at based on cooldown (§7).
        - If escalation criteria met (§8), open or update the escalation Paperclip child issue.
```

Step 1's "first thing checked" is identifier resolution. Step 2's "what evidence" is the five sources above. Step 3 picks the playbook. The vendor playbook in §5 owns everything from "did we contact the vendor" onward.

---

## 4. Shared situations (vendor-agnostic — checked before vendor playbook)

These are evaluated immediately after intake §3 step 4. They short-circuit before the worker contacts any vendor.

| # | Situation | Detection (DB only) | Auto action | Terminal? |
|---|---|---|---|---|
| S1 | **Already cancelled** | `sims.status` ∈ (`cancelled`,`deactivated`,`retired`) and `sims.cancelled_at` ≤ report.created_at | Close `duplicate`, note "SIM cancelled at <ts>" | yes |
| S2 | **Already replaced** | `sims.replaced_by_sim_id` set, OR a newer `sims` row for same `reseller_rental_id` | Close `duplicate` pointing at current SIM | yes |
| S3 | **Duplicate report** | Another open report for same `reseller_rental_id` exists within 24h, equal or newer evidence | Close `duplicate` of canonical report | yes |
| S4 | **Contract rejection already recorded** | Row exists in `rental_report_rejections` for this report | No action; system already rejected | yes |
| S5 | **Gateway port offline** | SkyLine port-status: IMEI present, port `offline` | No auto-fix; escalate to operator (gateway power is operator domain) | escalate |
| S6 | **Insufficient evidence** | Resolver fails OR no vendor inferable OR no DB row found | Classify-only this tick; retry up to 3 ticks; then escalate `unable_to_reproduce` | escalate after 3 ticks |

If none of S1–S6 fires, intake hands off to the vendor playbook.

---

## 5. Vendor playbooks

Each playbook has the same shape: situations → action → retry/cooldown/cap → evidence required to auto-resolve → escalation rules → vendor-contact rules.

The "situations" set is intentionally similar across vendors so operators only need to memorize the shape once.

### 5a. Atomic (AT&T ATOMIC API)

**Read action:** `subscriber inquiry` by ICCID (authoritative SIM/MDN state).
**Idempotent write actions allowed:** OTA refresh.
**Forbidden actions (operator-only):** restore from suspend, deactivate, MDN swap, status changes.

| # | Situation | Detection signal | Auto action | Retry / cooldown / cap | Evidence to auto-resolve | If still bad → notify |
|---|---|---|---|---|---|---|
| A1 | Vendor reports **active**, our DB says active, webhook delivered | inquiry: active; `webhook_deliveries.status=delivered`; reseller still reports bad | None vendor-side. Resend `number.online` (idempotent, via reseller-sync) | 2 attempts, 1h cooldown | new delivered webhook row appears within 30s of attempt | operator after 2nd fail |
| A2 | Vendor reports **active**, our DB stale | inquiry: active; `sims.status` ≠ active | Sync `sims` row (UPSERT) | 1 attempt (idempotent) | DB row matches vendor | resolve `remediated` action=`other` same tick |
| A3 | Vendor reports **suspended / barred / quota** | inquiry: status in suspended/barred/restricted | None vendor-side; classify, hold for batch | 0 attempts | n/a | escalate operator; if ≥5 same-account in 24h, queue for §8b batch ticket (vendor contact stays off by default) |
| A4 | Vendor reports **deactivated / cancelled** | inquiry: cancelled / terminated | Mark our DB cancelled (sync only, no vendor call) | 1 attempt | DB matches vendor | close `duplicate` of cancellation |
| A5 | **ICCID not found** at vendor | inquiry returns not-found | None automatic — possible data drift | 0 attempts | n/a | escalate operator with full ICCID + sim_id |
| A6 | Vendor active **but webhook never delivered** | inquiry: active; no `webhook_deliveries` row with `status=delivered` for the latest `number.online` event | `reseller-sync /resend-online` (force:true, salted message_id) | 2 attempts, 1h cooldown | new delivered row within 30s | operator after 2nd fail |
| A7 | Vendor active, webhook delivered, **reseller still reports bad** | A1 conditions + reseller reported within last 2h | OTA refresh via atomic-api (idempotent, vendor `request_id` recorded) | 1 attempt, 24h cooldown | OTA returns success AND next reseller check is clean | operator with OTA request_id + vendor response |
| A8 | Vendor active but **current DB MDN differs from vendor MDN** | inquiry MDN ≠ `sims.current_mdn_e164` | Update `sims.current_mdn_e164` to vendor truth (sync only) + record divergence in evidence | 1 attempt (idempotent) | DB matches vendor | resolve `remediated` action=`other` |
| A9 | **Unable to reproduce** (everything looks fine, no failure signal anywhere) | inquiry active, webhook delivered, no recent reseller report after report time | Classify-only | 3 ticks, 2h apart | n/a | escalate `unable_to_reproduce` after 3rd tick |

Vendor contact (Atomic support): off by default. Only enabled via per-carrier operator toggle and only for A3 batch (≥5 same-account suspended/barred in 24h). Message bundle template in §8b. Never sends reseller name, reseller_rental_id, or internal sim_id.

### 5b. Wing IoT (AT&T IoT, Wing Tel)

**Read action:** device status by ICCID.
**Idempotent write actions allowed:** OTA refresh, MDN-mode change is **operator-only** (changes between dialable/non-dialable affect billing).
**Forbidden actions (operator-only):** MDN-mode change, deactivation, plan change.

| # | Situation | Detection | Auto action | Retry/cooldown/cap | Evidence to auto-resolve | If still bad → notify |
|---|---|---|---|---|---|---|
| W1 | Vendor active, DB stale | device active; `sims.status` ≠ active | DB UPSERT | 1 idempotent attempt | DB matches | resolve `remediated`/`other` |
| W2 | Vendor active, webhook missing | active; no delivered webhook | resend_online | 2 attempts, 1h cooldown | delivered row appears | operator after 2nd fail |
| W3 | Vendor active, webhook delivered, reseller still bad | active + delivered + recent report | wing-iot refresh | 1 attempt, 24h cooldown | refresh OK + clean recheck | operator |
| W4 | Vendor inactive/suspended | device suspended/quota | none vendor-side | 0 | n/a | escalate operator; queue for batch if ≥5 in 24h |
| W5 | ICCID not found | not-found | none | 0 | n/a | escalate operator |
| W6 | Vendor active, MDN differs from DB | device MDN ≠ DB MDN | DB UPSERT to vendor truth | 1 idempotent | DB matches | resolve `remediated`/`other` |
| W7 | Wing reports device active but mode wrong (e.g. non-dialable when expected dialable) | mode mismatch with rental contract | none — operator-only | 0 | n/a | escalate operator with mode evidence |
| W8 | Unable to reproduce | all clean, no recent reseller failure signal | classify-only | 3 ticks @ 2h | n/a | escalate `unable_to_reproduce` |

Vendor contact: off by default. Toggle-gated batch ticket for W4 only.

### 5c. T-Mobile via Helix (activation API)

**Read action:** subscriber state by ICCID.
**Idempotent write actions allowed:** OTA refresh.
**Forbidden actions:** activation/deactivation/status changes — operator-only. Helix is primarily activation-side; ongoing state lives in Teltik (see 5d) for SMS lines.

| # | Situation | Detection | Auto action | Retry/cooldown/cap | Evidence to auto-resolve | If still bad → notify |
|---|---|---|---|---|---|---|
| H1 | Helix says subscriber active, DB stale | active; DB ≠ active | DB UPSERT | 1 idempotent | DB matches | resolve `remediated`/`other` |
| H2 | Helix says active, webhook missing | active; no delivered webhook | resend_online | 2 attempts, 1h cooldown | delivered row appears | operator |
| H3 | Helix says active, webhook delivered, reseller still bad | active + delivered + recent report | helix OTA refresh | 1 attempt, 24h cooldown | OTA success + clean recheck | operator |
| H4 | Helix says inactive/suspended | suspended/cancelled | none vendor-side | 0 | n/a | escalate operator; batch if ≥5 |
| H5 | ICCID not found in Helix | not-found | none | 0 | n/a | escalate operator |
| H6 | DB MDN differs from Helix MDN | mismatch | DB UPSERT to vendor truth | 1 idempotent | DB matches | resolve `remediated`/`other` |
| H7 | Activation stuck mid-flow | Helix status in pending/provisioning state for >6h | none — operator-only (activation finalisation) | 0 | n/a | escalate operator with Helix request id |
| H8 | Unable to reproduce | all clean | classify-only | 3 ticks @ 2h | n/a | escalate `unable_to_reproduce` |

Vendor contact: off by default.

### 5d. Teltik (T-Mobile SMS gateway)

**Read action:** line status by ICCID/MDN, port status, last SMS receive.
**Idempotent write actions allowed:** `/reset-port`, `/port-status`, OTA-style refresh.
**Forbidden actions:** SIM swap, line cancel, forward URL change — operator-only.

| # | Situation | Detection | Auto action | Retry/cooldown/cap | Evidence to auto-resolve | If still bad → notify |
|---|---|---|---|---|---|---|
| T1 | Teltik active, DB stale | active; DB ≠ active | DB UPSERT | 1 idempotent | DB matches | resolve `remediated`/`other` |
| T2 | Teltik active, webhook missing | active; no delivered webhook | resend_online | 2 attempts, 1h cooldown | delivered row appears | operator |
| T3 | Teltik active, webhook delivered, reseller still bad | active + delivered + recent report | OTA refresh + port-status check | 1 attempt, 24h cooldown | refresh OK + port reports healthy + clean recheck | operator |
| T4 | Teltik port **stuck pending** > 6h | port-status: state in pending/in-progress > 6h | `/reset-port` (10-digit MDN, idempotent; 409 = already in flight = treat as success) | 1 attempt, 24h cooldown | port-status flips to active within 30 min OR next reseller check clean | operator with reset request id |
| T5 | Teltik port offline / not responding | port-status: offline | `/reset-port` | 1 attempt, 24h cooldown | port-status flips to active | operator |
| T6 | Teltik says inactive/suspended | suspended/cancelled | none vendor-side | 0 | n/a | escalate operator; batch if ≥5 in 24h |
| T7 | ICCID/MDN not found in Teltik | not-found | none | 0 | n/a | escalate operator |
| T8 | DB MDN differs from Teltik MDN | mismatch | DB UPSERT to vendor truth | 1 idempotent | DB matches | resolve `remediated`/`other` |
| T9 | Forward URL missing/wrong | port-status returns no forward URL or wrong URL | none — operator-only (URL change is config) | 0 | n/a | escalate operator with current URL |
| T10 | Unable to reproduce | all clean | classify-only | 3 ticks @ 2h | n/a | escalate `unable_to_reproduce` |

Vendor contact: off by default.

### 5e. Other / unknown vendor

If `sims.vendor` is null or not in the set above: classify as S6 (insufficient evidence), escalate to operator after 3 ticks with full DB dump for that SIM. Worker never invents a vendor.

---

## 6. Per-branch decision rules (the contract every situation must satisfy)

Every row in the vendor tables above is bound to the same five-field contract. Implementation must enforce this at the type level (classifier returns a discriminated union; one branch per situation).

```
Situation := {
  id: 'A1' | 'A2' | ... | 'T10' | 'S1' | ... | 'S6',
  auto_action: 'none' | 'resend_online' | 'db_sync_upsert' | 'atomic_ota'
              | 'wing_iot_refresh' | 'helix_ota' | 'teltik_ota' | 'teltik_reset_port'
              | 'close_duplicate' | 'classify_only',
  retry: { max_attempts: int, cooldown_minutes: int },
  auto_resolve_when: <predicate over evidence>,    // exactly what must be true to mark terminal
  on_failure: 'operator_escalate' | 'vendor_batch_queue' | 'classify_again',
  evidence_bundle: <list of fields the escalation includes>
}
```

Terminal mappings (these are the only terminal outcomes the worker may write):

- `remediated` + `remediation_action='other'` — used for db_sync_upsert and OTA-refresh-succeeded paths.
- `remediated` + `remediation_action='port_reset'` — used only for teltik_reset_port success.
- `duplicate` — used for S1/S2/S3 and A4 (already cancelled at vendor).
- `unable_to_reproduce` — used only after the configured classify-only ticks exhaust.

`remediation_action` values `rotated`, `sim_replaced`, `mdn_swapped` are **never** written by the worker (those are operator-only actions reported via existing dashboard endpoints).

---

## 7. Idempotency, cooldowns, attempt caps

| Auto action | Max attempts | Cooldown | Idempotency key | Notes |
|---|---|---|---|---|
| `db_sync_upsert` | 1 | n/a | `(sim_id)` natural | UPSERT on sims by sim_id; safe to re-run |
| `resend_online` | 2 | 1h | `(report_id, sim_id, attempt_no)` salted into webhook message_id | `sendWebhookWithDeduplication` already dedupes on receiver side |
| `atomic_ota` | 1 | 24h | vendor request_id recorded | Atomic OTA returns same request_id if called twice within window |
| `wing_iot_refresh` | 1 | 24h | vendor request_id | idempotent by ICCID |
| `helix_ota` | 1 | 24h | vendor request_id | idempotent by ICCID |
| `teltik_ota` | 1 | 24h | vendor request_id | idempotent by ICCID |
| `teltik_reset_port` | 1 | 24h | Teltik treats duplicate as 409 (success) | 10-digit MDN, not E.164 |
| `close_duplicate` | 1 | n/a | terminal | one-shot |
| `classify_only` | 3 ticks | 2h | per `(report_id, mode)` | exhausts to `unable_to_reproduce` |

Worker concurrency:

- Cron: `0 */2 * * *`.
- Per tick: process up to 100 reports; concurrency cap of 5 in flight via `relayFetch` batching (mirrors `reseller-sync`).
- Per-report row lock via `auto_remediation_state='in_progress'` CAS before any work; reset to prior state on exit. Operator dashboard edits during a tick cannot collide.
- 25s wall-clock budget; remaining reports carry to next tick via `next_review_at` cursor.
- Kill-switch KV `bad_rental_remediator_enabled=false` halts the worker before any vendor call.

---

## 8. Safety gates & escalation

### 8a. What can run fully automatic

- Reading vendor state (always allowed).
- DB sync UPSERT (always allowed).
- `resend_online` webhook (always allowed; reseller-side dedup'd).
- OTA refresh (Atomic / Wing IoT / Helix / Teltik) — allowed once per 24h per SIM, idempotent.
- Teltik `/reset-port` — allowed once per 24h per port, idempotent.
- Close as `duplicate` for S1/S2/S3/A4 — allowed.
- Mark `unable_to_reproduce` after exhausted classify-only ticks — allowed.

### 8b. What requires operator approval (always)

- Rotation / MDN swap / SIM swap / replacement / cancel — never auto.
- Wing IoT MDN-mode change (dialable ↔ non-dialable).
- Helix activation finalisation / state changes.
- Teltik forward URL / SIM swap / cancel.
- Any reseller-facing message beyond the webhook resend.
- Any vendor support ticket / batch contact.

### 8c. Operator escalation — Paperclip child issue

Triggered by any `on_failure: 'operator_escalate'`. Worker opens one issue per tick that batches the day's escalations (recommendation pending operator answer to open question 2 in §11).

Body fields (no secrets):

```
Report: <rental_reports.id> (reseller_rental_id <…>, current MDN <…>)
Vendor: <atomic|wing_iot|helix|teltik|other>
Situation: <A1|A7|T4|…> — <human description>
Auto attempts:
  - attempt 1 at <ts>: action=<…> outcome=<…> evidence=<vendor request_id|webhook delivery id|…>
  - attempt 2 at <ts>: …
Latest vendor state: <suspended|active|barred|not_found|…>
Latest webhook state: <delivered <ts> | none >
Suggested next operator action: <"rotate by hand"|"open carrier ticket"|"replace SIM"|"check gateway power"|…>
```

### 8d. Vendor contact (batched ticket)

Default off per carrier. Operator must flip a per-carrier toggle in the dashboard (admin panel) before the worker is allowed to open any vendor-directed ticket.

Trigger condition (when toggle is on):
- ≥5 SIMs in the same vendor account hit `*4` situations (A3/W4/H4/T6) within 24h.

Message template (vendor-side, never includes reseller-facing identifiers):

```
Subject: <Vendor> activation issue — batch of <N> SIMs (account <X>)
Body:
  Account: <X>
  N affected SIMs: <count>
  Representative ICCIDs: <iccid1>, <iccid2>, <iccid3>   (vendor-side identifiers only)
  Current vendor-reported state: <suspended/barred/…>
  Last known active: <date>
  Reference: bad-rental batch <UUID>
  Request: please review activation/state for the listed ICCIDs.
```

No reseller name, no `reseller_rental_id`, no internal `sim_id`, no MDN, no contact information beyond the operator's standard support channel.

---

## 9. Audit trail

Every tick, for every report touched:

1. One row in `rental_report_remediation_attempts`:
   - `report_id`, `attempt_no`, `mode` (A1/W3/T4/S1/…), `action`, `outcome` (`success`/`failed`/`no_change`/`skipped_cooldown`), `evidence` jsonb (vendor request_id, webhook delivery id, port-status snapshot — never secrets), `error_message`, `next_review_at`.
2. One row in `rental_report_events` with `event_type='auto_remediation'`, payload matching attempt evidence.
3. On terminal close, the existing `/api/bad-rentals/:id/update` write path is invoked (server-side, not via HTTP) so the dashboard timeline reflects auto closures with the same row shape as manual closures.

Daily summary appended to `agent/current-state.md` by the worker (or filed as a Paperclip issue — see open question 1 in §11).

---

## 10. Data model additions

Single new table + three additive columns on `rental_reports`. Migration file: `migrations/2026-06-07_bad_rental_remediation_attempts.sql`. Apply via `mcp__supabase__apply_migration` per [constraints.md].

```sql
create table if not exists rental_report_remediation_attempts (
  id               bigserial primary key,
  report_id        bigint not null references rental_reports(id) on delete cascade,
  attempt_no       int    not null,
  mode             text   not null,             -- 'A1'..'T10' | 'S1'..'S6'
  action           text   not null,             -- enum from §6 auto_action set
  attempted_at     timestamptz not null default now(),
  outcome          text   not null,             -- 'success'|'failed'|'no_change'|'skipped_cooldown'
  evidence         jsonb,
  error_message    text,
  next_review_at   timestamptz
);
create index if not exists rrra_report_idx
  on rental_report_remediation_attempts (report_id, attempted_at desc);
create index if not exists rrra_next_review_idx
  on rental_report_remediation_attempts (next_review_at)
  where next_review_at is not null;

alter table rental_reports
  add column if not exists auto_remediation_state text,    -- 'queued'|'in_progress'|'paused'|'escalated'|'done'
  add column if not exists last_auto_attempt_at timestamptz,
  add column if not exists escalation_reason text;
```

No change to `rental_reports.status` enum or `remediation_action` enum. No change to the resolver contract. No change to existing dashboard endpoints (a new endpoint `POST /api/bad-rentals/:id/pause-auto` is added in the dashboard worker, but that is a small additive surface, not a contract change).

---

## 11. Open questions for operator (must be answered before go-live)

1. **Daily summary destination** — append to `agent/current-state.md` (existing convention) or open one Paperclip child issue per day?
2. **Operator escalation grouping** — one child issue per escalated report, or one batch issue per tick listing all escalations? (Recommendation: one batch issue per tick.)
3. **Vendor contact toggle granularity** — global, per-carrier, or per-carrier-and-situation? (Recommendation: per-carrier.)
4. **Pre-go-live dry-run threshold** — what classifier accuracy bar must be met before the worker is allowed to take any vendor write action? (Recommendation: ≥90% agreement on terminal classification against the last 200 operator-closed reports, computed offline before deploy.)

---

## 12. Operator decision tree (full, vendor-aware)

```
                 ┌─────────────────────┐
                 │  2h cron tick       │
                 └──────────┬──────────┘
                            ▼
        ┌────────────────────────────────────────┐
        │ Fetch open reports (received|in_triage)│
        │ not paused, not in cooldown             │
        └──────────────────┬─────────────────────┘
                           ▼
        ┌─────────────────────────────────┐
        │ Intake (§3)                     │
        │  resolve identifier             │
        │  pull DB evidence               │
        │  decide vendor                  │
        └──────────┬──────────────────────┘
                   ▼
        ┌─────────────────────────────────┐
        │ Shared situations (§4)          │
        │ S1 already cancelled?           │ → close duplicate
        │ S2 already replaced?            │ → close duplicate
        │ S3 duplicate report?            │ → close duplicate
        │ S4 contract rejected?           │ → no action
        │ S5 gateway port offline?        │ → escalate operator
        │ S6 insufficient evidence?       │ → 3 ticks then unable_to_reproduce
        └──────────┬──────────────────────┘
                   ▼ none fired
        ┌─────────────────────────────────┐
        │ Branch on sims.vendor           │
        └──┬───────────┬───────────┬───────┬───────┐
           ▼           ▼           ▼       ▼       ▼
        atomic     wing_iot      helix   teltik  other
         (5a)       (5b)         (5c)    (5d)    (5e=S6)
           │           │           │       │
           ▼           ▼           ▼       ▼
        situation classifier (A1..A9 / W1..W8 / H1..H8 / T1..T10)
           │
           ▼
        ┌────────────────────────────────────────────────────┐
        │ Per-branch contract (§6):                          │
        │   pick auto_action, retry, cooldown, cap           │
        │   apply auto_action if allowed and not in cooldown │
        │   re-query evidence                                │
        │   does evidence satisfy auto_resolve_when?         │
        └──────────────┬────────────────────────┬────────────┘
                       │ YES                    │ NO
                       ▼                        ▼
              close terminal           on_failure rule:
              (remediated / dup /         operator_escalate (§8c)
               unable_to_reproduce)       vendor_batch_queue (§8d, toggle-gated)
                                          classify_again (next tick)
                       │                        │
                       └──────────┬─────────────┘
                                  ▼
                       record attempt + event,
                       set next_review_at
```

An HTML rendering of this tree ships in the dashboard's existing **Guide** tab so the operator can click any node and jump to the situation row in §5. No new dashboard tab.

---

## 13. Tests & verification

Pre-merge (contract tests — must pass before any deploy):

- Classifier: one fixture per situation across §4 + §5 (≈35 fixtures). Exact-match assertion on (situation_id, auto_action, retry, on_failure).
- Forbidden-action guard: a property test that runs the full classifier across a generated state space and asserts `auto_action ∉ {rotation, swap, cancel, replace, reseller_message_non_webhook}`. Construction-time invariant.
- Idempotency: same report through 3 ticks → exactly the configured attempt count; no duplicate webhook sends; no duplicate event rows.
- Cooldown clock: simulated clock advance honors per-action cooldowns.
- Resolver contract: only accepts `reseller_rental_id` or current MDN. Rejecting SIM ID / ICCID / stale MDN remains tested.

Pre-deploy:

- `node _check_relay.js` per [constraints.md].
- **Offline dry-run** (not a phase — a single verification step): replay the last 200 operator-closed reports through the classifier with `AUTO_REMEDIATOR_DRY_RUN=1`. Compare classifier terminal disposition vs operator's actual terminal disposition. Bar: ≥90% agreement on `remediated`/`duplicate`/`unable_to_reproduce` (recommendation; operator confirms in open question 4). Result attached to the deploy PR.

Post-deploy (continuous):

- Worker writes a one-line tick summary to `agent/current-state.md` (or daily Paperclip child issue per open question 1): open count, auto-resolved count, escalations count, forbidden-action attempts (must be 0).
- Alarm: if forbidden-action count > 0, KV kill-switch flips to false, P0 Paperclip child issue opened, the worker halts before next tick.

---

## 14. Out of scope (do NOT design for)

- Rotation cadence changes.
- Any revenue-affecting vendor operation (cancels, billing changes, plan changes).
- New reseller-facing UI beyond existing portal resend.
- New identifier surfaces for resellers.
- Reintroducing verification gates.
- Auto-replacement of SIMs.
- Sending reseller messages outside the existing `number.online` webhook.

---

## 15. If approved — implementation child issues

Plan is designed to ship as a single coherent system. After approval, open these child issues (all `adapterType: claude_local`, sequenced):

1. **INC-16a — DB migration + worker scaffold + intake (§3) + shared situations (§4).**
   Includes kill-switch KV, cron, row-lock CAS, `next_review_at` cursor, audit-row writes. No vendor calls yet.
2. **INC-16b — Vendor classifiers (§5a–5e) + per-branch contract (§6) + forbidden-action guard.**
   Pure logic + full unit-test coverage. No external calls.
3. **INC-16c — Wire shared actions: `db_sync_upsert`, `resend_online`, `close_duplicate`, `classify_only`.**
   Live for S1/S2/S3, A1/A2/A6/A8, W1/W2/W6, H1/H2/H6, T1/T2/T8 — every read+DB+webhook situation, no vendor write yet. Run the §13 offline dry-run before this PR merges.
4. **INC-16d — Wire vendor OTA refreshes + Teltik `/reset-port`.**
   Live for A7, W3, H3, T3, T4, T5. Per-carrier KV toggle for emergency-disable.
5. **INC-16e — Dashboard surfacing (Bad Rentals list "Auto attempts" sub-row, "Pause auto-remediation" button, Guide-tab HTML decision tree).**
6. **INC-16f — Vendor batch escalation (§8d).** Toggle defaults to off per carrier.

Issues 1–4 are the operational core and ship in close sequence. Issues 5–6 are additive and can ship in parallel after 4.
