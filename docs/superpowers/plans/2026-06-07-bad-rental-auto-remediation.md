# Plan — Automated Bad-Rental Review & Remediation (INC-16)

**Status:** Draft v4 (planning only — no code).
**Author:** IncomingSMS CEO, 2026-06-08.
**Approval gate:** Operator (Zalmen) sign-off via Paperclip `request_confirmation` before any implementation child issues open.

**v4 changes vs prior:**
- Added §A Carrier capability matrix (researched from existing skills + code).
- Added §B Standardised IMEI correctness check (Wing IoT → router IMEI; Atomic/Helix → phone IMEI).
- **Removed** the DB-sync-only auto-resolve path. Every terminal `remediated` now requires SMS verification (§C).
- Defined §C SMS verification protocol via dashboard send-SMS / SKYLINE_GATEWAY `/send-sms`, polling `inbound_sms` with retry/escalation.
- Locked "notify reseller" to two operations only: resend `number.online` webhook + mark report status to terminal (no freeform reseller-facing message).
- Wing W7 (mode wrong): retry dialable PUT then verify via GET + SMS check before resolving.
- Cancelled/deactivated SIMs (S1/A4/H4/W4/T6): verify no active reseller rental before closing duplicate; if still rented → escalate as `vendor_cancelled_active_rental`.
- Escalation batching is now by `(vendor, failure_type)` per tick.
- Added operator-lock / manual-work state (`auto_remediation_state='operator_locked'`).
- Exact clean-recheck criteria defined in §C.4.
- Teltik 10-digit MDN enforced at API client boundary (§A.4).

---

## §A. Carrier capability matrix — what each vendor actually exposes

Researched from: `.claude/skills/atomic-api/SKILL.md`, `.claude/skills/wing-iot/SKILL.md`, `.claude/skills/helix-api/SKILL.md`, `.claude/skills/teltik-api/SKILL.md`, `src/mdn-rotator/index.{js,ts}`, `src/dashboard/index.js`.

### §A.1. Atomic (AT&T ATOMIC, ezbiz account)

Single POST endpoint `https://solutionsatt-atomic.telgoo5.com:22712` with `requestType`:

| Capability | `requestType` | Inputs | Notes / use in remediation |
|---|---|---|---|
| Read SIM/MDN state | `subsriberInquiry` | `MSISDN` and/or `sim` (ICCID) | Returns `attStatus`, `BAN`, plan, `BLIMEI` / `NWIMEI`, address, SOC codes. Always safe; used as evidence before and after any fix. |
| OTA refresh | `resendOtaProfile` | `MSISDN` + `sim` | Idempotent; no state change. Auto-allowed. |
| Restore from suspend | `restoreSubscriber` | `MSISDN`, `reasonCode='CR'` | Auto-allowed under §D safety table only when prior `attStatus ∈ {suspended}` and `fixAtomicSim`-style flow applies. |
| Reconnect from cancel | `reconnectSubscriber` | `MSISDN`, `reasonCode=''` | Auto-allowed only when (a) cancellation evidence shows it happened by mistake or by suspension cycle AND (b) S1-cancel-with-active-rental check (§E.1) passes AND operator hasn't locked it. |
| Suspend / Deactivate / Swap MSISDN / Update Subscriber Info | `suspendSubscriber` / `deactivateSubscriber` / `swapMSISDN` / `UpdateSubscriberInfo` | various | **Forbidden for auto.** Operator-only. |
| Carrier-side IMEI change | n/a — endpoint not exposed | — | ATOMIC does **not** expose an IMEI change endpoint. IMEI correctness is enforced **gateway-side** only (existing `fixAtomicSim` allocates a fresh IMEI then sets it on the gateway). Inquiry returns `BLIMEI`/`NWIMEI` — used as evidence for DB/gateway alignment, not as a target to write. |

### §A.2. Wing IoT (AT&T IoT / Wing Tel, SUBNINE Basic Auth)

REST on `https://restapi19.att.com/rws/api/api/v1/devices/{iccid}`:

| Capability | Method | Body / params | Notes |
|---|---|---|---|
| Read device state | `GET /api/v1/devices/{iccid}` | — | Returns `status`, `communicationPlan`, MDN, `customer`. Authoritative. |
| Restore dialable mode (PUT) | `PUT /api/v1/devices/{iccid}` | `{ "communicationPlan": "Wing Tel Inc - NON ABIR SMS MO/MT US" }` | Sets line to dialable. Used in W7 ("mode wrong" — expected dialable, currently non-dialable). |
| Set non-dialable (rotation only) | `PUT /api/v1/devices/{iccid}` | `{ "communicationPlan": "Wing Tel Inc - ABIR 25Mbps SMS MO/MT US" }` | **NOT a bad-rental remediation action.** Only used inside rotation flow. Remediator never PUTs the ABIR plan. |
| Activation (new) | `PUT /api/v1/devices/{iccid}` | `{ "communicationPlan": "...", "status": "Activated" }` | **Operator-only** for bad-rental scope. Worker does not activate. |
| OTA refresh equivalent | n/a | — | Wing does **not** expose an OTA refresh endpoint. The only "fix" is: GET → if dialable plan wrong, PUT dialable plan → GET verify → SMS verify (§C). |
| Status change (suspend/cancel) | n/a in this account | — | Wing IoT skill describes only activation + plan swap. Suspension/cancellation handled by AT&T side; we only observe via GET. |
| IMEI | not via Wing API | — | IMEI lives gateway-side only; vendor doesn't validate it. |

### §A.3. Helix (T-Mobile via SOLO Mobility, OAuth Bearer)

Wider surface than the other vendors. The remediator uses a deliberately narrow subset:

| Capability | Endpoint | Use in remediation |
|---|---|---|
| Get subscriber details | 4.7 (`GET`) | Evidence. Returns `attBan`, `subscriberNumber`, `iccid`, IMEI, status. |
| OTA refresh | 4.11 (`PATCH`) `{ban, subscriberNumber, iccid}` | Idempotent. Auto-allowed. |
| Status change | 4.6 (`PATCH`) | Remediator only allowed `Unsuspend` (reasonCode CR/35) and `Resume On Cancel` (reasonCode BBL/20). **Suspend** and **Cancel** are forbidden for auto. |
| Check IMEI eligibility | 4.1 | Used before any IMEI change. |
| Change IMEI | 4.8 | Auto-allowed **only** as part of the gated repair flow §F.3: cancel→resume is forbidden; existing `fixSim` does cancel→resume→IMEI change inside rotation, which is rotation-domain. For the remediator we **do not** call Change IMEI; if IMEI mismatch is the root cause, escalate to operator (the existing rotation/repair flow owns it). |
| Change ICCID / Change Plan / Update CTN/MDN / Cancel / Reset VM PIN | 4.9 / 4.10 / 4.16 / 4.6-Cancel / 4.12 | **Forbidden for auto.** |

### §A.4. Teltik (gateway-side; T-Mobile-style lines through SkyLine)

REST on `https://api.smsgateway.xyz`; auth = `apikey` query param:

| Capability | Endpoint | Use in remediation |
|---|---|---|
| Get MDN for ICCID | `GET /v1/get-phone-number/?iccid=...` | Evidence + confirms ICCID known to Teltik. |
| Get line info for MDN | `GET /v1/get-info?mdn=10digit` | Returns ICCID, gateway_id, port. |
| Port status | `GET /v1/port-status?mdn=10digit` | Evidence (online/offline/registered). |
| Reset port | `GET /v1/reset-port?mdn=10digit` | Idempotent (treats duplicate as 409 = already in flight). Auto-allowed for T4/T5. |
| Reset network | `GET /v1/reset-network?mdn=10digit` | Lower-impact retry; allowed as a softer alternative before `/reset-port` in some branches (TBD per situation in §F.4). |
| Send wake-up SMS | `GET /v1/send-wake-up-message?mdn=10digit` | NOT used as the SMS-verification path (that path uses SKYLINE_GATEWAY `/send-sms` per §C). Wake-up is a Teltik-internal signal. |
| Change number / SIM swap / Forward URL change / Send freeform SMS | `/v1/change-number/` / `/v1/sim-swap/` / `POST /v1/forward-url` / `POST /v1/send-message` | **Forbidden for auto** in the remediator. |

**MDN format rule at API boundary:** every Teltik client call that takes an MDN must strip `+1` and pass 10 digits. The boundary function `teltik.mdn10(e164)` is the only place E.164→10-digit conversion happens; classifier code never hand-strips digits. Tests assert no caller passes an E.164 to Teltik.

### §A.5. SkyLine gateway (gateway / port health + send-SMS)

- `POST /send-sms` (via `SKYLINE_GATEWAY` service binding + `SKYLINE_SECRET`) — used for §C SMS verification.
- `GET /port-status` — used for S5 gateway-port-offline detection.
- IMEI on a port is read from gateway via existing SkyLine helpers (see `src/dashboard/index.js` lines 2452–2470 + 3131–3151).

---

## §B. IMEI correctness check (cross-vendor invariant)

Per operator: each SIM must have an IMEI matching its product type.

- `vendor='wing_iot'` → IMEI must be a **router IMEI** (`device_type='router'` from the IMEI pool).
- `vendor='atomic'` or `vendor='helix'` (phone SIMs) → IMEI must be a **phone IMEI** (`device_type='phone'`).

Where the IMEI lives:
- Gateway-side: SkyLine port reports current `imei` per slot.
- DB-side: `sims.imei` (canonical for our records).
- Vendor-side: Atomic inquiry returns `BLIMEI`/`NWIMEI`. Helix subscriber details return IMEI. Wing IoT does not store IMEI carrier-side.

Check (`checkImeiCorrectness(sim)`):
1. Resolve expected `device_type` from `sims.vendor`.
2. Lookup IMEI pool row for `sims.imei`; assert its `device_type` matches.
3. If gateway port reports a different IMEI than `sims.imei` → record `imei_drift_gateway`.
4. For Atomic/Helix, compare `sims.imei` to vendor-reported IMEI; record `imei_drift_vendor`.

Outcomes:
- All match → ✅, no action.
- Mismatch only in `device_type` (e.g. phone IMEI on a Wing SIM) → escalate operator with `imei_wrong_type` (worker does **not** auto-fix; existing rotation/repair flow owns IMEI rewrites).
- Mismatch between DB and gateway, but both match expected type → record evidence and escalate; do not auto-fix.
- Mismatch between DB and vendor-reported (Atomic/Helix) → record evidence; if all other signals are clean **and** the vendor IMEI is correct type, do a DB-only sync of `sims.imei` to vendor truth (no vendor write, no gateway write). Then still require SMS verification (§C) before resolving.

Forbidden for auto: changing IMEI on the gateway, calling Helix 4.8, allocating new IMEIs.

---

## §C. SMS verification — mandatory before every `remediated` close

Every situation whose `auto_resolve_when` predicate fires must pass §C before the worker writes a terminal `remediated`. There is **no DB-sync-only resolve path** anymore.

### §C.1. Send

1. Mint a unique payload: `body = "IncomingSMS test " + report_id + " " + sim_id + " " + nonce8` (≤ 160 chars; `nonce8` = 8 hex chars from a worker-side counter, not Math.random so it's resumable in workflow journals — uses the report id and attempt number salt).
2. Send via dashboard's send-SMS path (`SKYLINE_GATEWAY` `/send-sms`) targeted at the SIM's current MDN.
3. Record `verify_send_attempt` row in `rental_report_remediation_attempts` with `evidence = { nonce, body, send_request_id }`.

### §C.2. Send-side retry policy

- If send returns 5xx, network error, or SkyLine rejects (non-2xx): wait **60 seconds**, retry.
- Max **3 send attempts** in total.
- All 3 fail → escalate to operator with `verify_send_failed`; do **not** mark the report fixed.

### §C.3. Receive poll

After a successful send:
- Poll `inbound_sms` for any row where `to_number = sim.current_mdn_e164` (or 10-digit equivalent depending on storage convention) AND `body` contains `nonce8` AND `received_at > send_attempted_at`.
- Polling cadence: every 10s for up to 5 minutes (30 polls). The remediator yields between polls; per-tick budget already accommodates this (§G).
- On match: record `verify_received` evidence with the inbound_sms row id.
- On timeout (no match in 5 minutes): record `verify_receive_timeout`; escalate to operator. Do **not** mark fixed.

### §C.4. Clean-recheck criteria — what "fixed" means

The worker only writes `status='remediated'` when **all** of the following are true in the same tick:

1. Vendor read (Atomic inquiry / Wing GET / Helix details / Teltik port-status) reports the SIM in its expected healthy state for its vendor.
2. The applied auto-action (or no-op for "vendor already healthy" cases) completed without vendor error.
3. `webhook_deliveries` shows a delivered `number.online` for the SIM, either pre-existing or written within this tick by `reseller-sync /resend-online`.
4. `inbound_sms` shows the §C.1 nonce SMS received from the SIM's current MDN within the §C.3 window.
5. (Optional, situation-specific) for Teltik T4/T5: `/port-status` reports the port `online`/`registered` after reset.

Any condition false → outcome `no_change` or `failed`, attempt counted, escalation per §6 (renumbered below to §G).

### §C.5. Operator escalation triggers from §C

- `verify_send_failed` after 3 attempts (60s gap each).
- `verify_receive_timeout` after a successful send.
- Any inconsistency between vendor-read (1) and SMS-receive (4) (e.g. vendor says active but SMS never arrives) → escalate as `vendor_active_no_sms`.

---

## §D. Notify-reseller — exactly two operations, nothing else

When the worker decides a report is `remediated` or `duplicate`, the only reseller-facing effects are:

1. **Resend `number.online` webhook** for the SIM (via `reseller-sync /resend-online`) — idempotent and already dedup'd by `sendWebhookWithDeduplication`.
2. **Update the report status** via the existing dashboard write path (`/api/bad-rentals/:id/update`) so the reseller sees status changed in their view.

No freeform message, no email, no SMS to the reseller, no portal banner, no new payload field. Anything beyond these two is operator-only.

---

## §E. Pre-close guard for cancelled/deactivated SIMs

Applies to: S1 (already cancelled), A4 (Atomic deactivated), H4 (Helix cancelled), W4 (Wing inactive/suspended), T6 (Teltik suspended/cancelled). Before closing as `duplicate`:

1. Query `rental_reports` and the source rental table for any rental that:
   - References this SIM (by `sim_id`) OR this `reseller_rental_id`, AND
   - Has not been ended/cancelled/expired in the reseller's system.
2. If an active rental exists → **do not** close as duplicate. Classify as `vendor_cancelled_active_rental`, escalate to operator with full evidence bundle. This is its own escalation type for batching (§H).
3. If no active rental → close as `duplicate` with note "SIM cancelled at <ts>; no active reseller rental remained".

§C SMS verification does **not** apply to `duplicate` closures (we are not asserting the SIM works — we are asserting it's no longer in service AND no reseller is currently renting it).

---

## §F. Vendor playbooks (revised)

All situations are subject to: §B IMEI check, §E cancel guard, §C SMS verification before any `remediated` close.

### §F.1. Atomic (AT&T ATOMIC) — situations A1–A10

| # | Situation | Detection | Auto action | Retry / cooldown / cap | Resolve when | If still bad |
|---|---|---|---|---|---|---|
| A1 | Vendor active, DB active, webhook delivered, reseller still reports bad | inquiry `attStatus=Active`; webhook delivered; recent reseller report | OTA refresh (`resendOtaProfile`) | 1 try, 24h cooldown | §C.4 1–4 all pass | operator |
| A2 | Vendor active, DB stale | inquiry Active; `sims.status≠active` | DB UPSERT to vendor truth | 1 idempotent | §C.4 1–4 all pass (DB sync is not sufficient on its own) | operator |
| A3 | Vendor suspended | inquiry `Suspended` | `restoreSubscriber` (reasonCode CR) | 1 try, 24h cooldown | inquiry returns Active AND §C.4 1–4 pass | operator |
| A4 | Vendor deactivated/cancelled | inquiry `Cancelled`/`Deactivated` | §E pre-close guard; if no active rental → close `duplicate`; otherwise escalate `vendor_cancelled_active_rental` | 0 fix attempts | §E.3 | escalate per §E |
| A5 | ICCID not found at vendor | inquiry `not-found` | none | 0 | n/a | escalate `vendor_iccid_not_found` |
| A6 | Vendor active, webhook missing | inquiry Active; no delivered webhook for latest `number.online` | `reseller-sync /resend-online` (force, salted id) | 2 tries, 1h cooldown | delivered row appears AND §C.4 1–4 pass | operator after 2nd fail |
| A7 | Vendor active, IMEI drift (vendor IMEI ≠ DB IMEI but both correct type) | inquiry returns BLIMEI/NWIMEI; differs from `sims.imei` | DB UPSERT `sims.imei` to vendor IMEI | 1 idempotent | §C.4 1–4 pass (with §B re-check clean) | operator |
| A8 | Vendor active, IMEI wrong type (phone SIM has router IMEI etc.) | §B check fails on `device_type` | none — operator-only | 0 | n/a | escalate `imei_wrong_type` |
| A9 | Vendor active, MDN differs DB vs vendor | inquiry MDN ≠ `sims.current_mdn_e164` | DB UPSERT to vendor MDN | 1 idempotent | §C.4 1–4 pass (verify SMS at vendor MDN) | operator |
| A10 | Unable to reproduce | inquiry Active; webhook delivered; §C SMS verifies OK; no recent reseller failure signal | classify-only | 3 ticks @ 2h | n/a — terminal goes to `unable_to_reproduce` on 3rd | terminal after 3 |

### §F.2. Wing IoT — W1–W9

| # | Situation | Detection | Auto action | Retry / cooldown / cap | Resolve when | If still bad |
|---|---|---|---|---|---|---|
| W1 | Vendor active dialable, DB stale | GET Activated + dialable plan; `sims.status≠active` | DB UPSERT | 1 idempotent | §C.4 1–4 pass | operator |
| W2 | Vendor active, webhook missing | Activated + dialable; no delivered webhook | resend_online | 2 tries, 1h cooldown | delivered + §C.4 1–4 pass | operator |
| W3 | Vendor active dialable, reseller still bad | Activated + dialable + recent report | (no OTA exists for Wing) — `resend_online` + §C SMS | 1 try, 24h cooldown | §C.4 1–4 pass | operator |
| W4 | Vendor inactive/suspended | GET `status≠Activated` | none vendor-side | 0 | n/a | escalate; §E if cancellation suspected |
| W5 | ICCID not found | GET 404 | none | 0 | n/a | escalate `vendor_iccid_not_found` |
| W6 | DB MDN differs from vendor MDN | GET MDN ≠ DB MDN | DB UPSERT | 1 idempotent | §C.4 1–4 pass (verify SMS at vendor MDN) | operator |
| W7 | Mode wrong — expected dialable, currently non-dialable (ABIR) | GET `communicationPlan = "ABIR 25Mbps"` while rental expects dialable | PUT `NON ABIR SMS MO/MT US` (dialable plan) | 1 try, 24h cooldown | GET shows NON ABIR plan + dialable MDN AND §C.4 1–4 all pass | operator (do not mark fixed without GET-verify + SMS-verify per §C) |
| W8 | IMEI wrong type (phone IMEI on Wing SIM) | §B check | none — operator-only | 0 | n/a | escalate `imei_wrong_type` |
| W9 | Unable to reproduce | all clean + §C SMS verifies | classify-only | 3 ticks @ 2h | n/a | `unable_to_reproduce` after 3 |

### §F.3. Helix (T-Mobile via SOLO) — H1–H9

| # | Situation | Detection | Auto action | Retry / cooldown / cap | Resolve when | If still bad |
|---|---|---|---|---|---|---|
| H1 | Active, DB stale | 4.7 details Active; DB ≠ active | DB UPSERT | 1 idempotent | §C.4 1–4 pass | operator |
| H2 | Active, webhook missing | Active; no delivered | resend_online | 2 tries, 1h cooldown | delivered + §C.4 1–4 pass | operator |
| H3 | Active, reseller still bad | Active + delivered + recent report | OTA refresh (4.11) | 1 try, 24h cooldown | §C.4 1–4 pass | operator |
| H4 | Suspended | 4.7 state `Suspended` | 4.6 `Unsuspend` (reasonCode CR/35) | 1 try, 24h cooldown | 4.7 Active AND §C.4 1–4 pass | operator |
| H5 | Cancelled | 4.7 state `Cancelled` | §E pre-close guard; if active rental → escalate `vendor_cancelled_active_rental`; else close `duplicate`. Worker does **not** call Resume On Cancel automatically (operator domain — too easy to revive a SIM the reseller already moved on from). | 0 auto-fix | §E | per §E |
| H6 | ICCID not in Helix | 4.7 returns not-found | none | 0 | n/a | escalate |
| H7 | DB MDN differs from Helix MDN | mismatch | DB UPSERT | 1 idempotent | §C.4 1–4 pass | operator |
| H8 | IMEI wrong / drift | §B check fails (type or drift) | none — operator-only (4.8 Change IMEI is forbidden for auto) | 0 | n/a | escalate `imei_wrong_type` or `imei_drift_vendor` |
| H9 | Unable to reproduce | all clean + §C SMS verifies | classify-only | 3 ticks @ 2h | n/a | `unable_to_reproduce` after 3 |

### §F.4. Teltik — T1–T11

| # | Situation | Detection | Auto action | Retry / cooldown / cap | Resolve when | If still bad |
|---|---|---|---|---|---|---|
| T1 | Active, DB stale | `/get-phone-number` + `/port-status` healthy; DB ≠ active | DB UPSERT | 1 idempotent | §C.4 1–4 pass | operator |
| T2 | Active, webhook missing | healthy; no delivered | resend_online | 2 tries, 1h cooldown | delivered + §C.4 1–4 pass | operator |
| T3 | Active, reseller still bad | healthy + delivered + recent report | `/reset-network` then re-check; if still bad → `/reset-port` | 1 try each, 24h cooldown | port online + §C.4 1–4 pass | operator |
| T4 | Port stuck pending > 6h | `/port-status` state pending/in-progress > 6h | `/reset-port` (10-digit MDN; 409 = success) | 1 try, 24h cooldown | port flips to active + §C.4 1–4 pass | operator |
| T5 | Port offline | `/port-status` offline | `/reset-port` | 1 try, 24h cooldown | port online + §C.4 1–4 pass | operator |
| T6 | Teltik suspended/cancelled | `/get-info` returns terminal | §E pre-close guard | 0 fix | §E | per §E |
| T7 | ICCID/MDN not in Teltik | not-found | none | 0 | n/a | escalate |
| T8 | DB MDN differs from Teltik MDN | mismatch | DB UPSERT to Teltik truth | 1 idempotent | §C.4 1–4 pass | operator |
| T9 | Forward URL missing/wrong | `/forward-url` GET returns absent/wrong | none — operator-only (URL change is config) | 0 | n/a | escalate `teltik_forward_url_misconfigured` |
| T10 | IMEI check fails | §B | none — operator-only | 0 | n/a | escalate |
| T11 | Unable to reproduce | all clean + §C SMS verifies | classify-only | 3 ticks @ 2h | n/a | `unable_to_reproduce` after 3 |

### §F.5. Other / unknown vendor — falls to S6 (insufficient evidence).

---

## §G. Scheduler, idempotency, attempt caps

(Unchanged from v2 except for cooldown/budget bumps to fit §C polling.)

- Cron `0 */2 * * *`. Per-tick budget 60s (was 25s — raised to accommodate §C SMS poll up to 5 min only when needed; the poll runs in a Durable Object–style continuation rather than blocking the cron tick. For Workers Cron, the 5-minute poll runs via `setTimeout`/queued `waitUntil` chained off the initial tick; if Workers cron's hard limit prevents that, the worker schedules a single follow-up via a 1-min cron checking the `verify_pending` table — design decision deferred to INC-16a).
- Concurrency cap: 5 reports in flight per tick.
- `auto_remediation_state` machine:
  - `queued` → `in_progress` → terminal close OR `escalated` OR `verify_pending` OR `paused`/`operator_locked`.
  - **`operator_locked`** is new: set by the dashboard "Take over" action. Worker skips locked reports entirely.
- Kill-switch KV `bad_rental_remediator_enabled=false` halts the worker before any vendor write call.
- Per-report row lock CAS on `auto_remediation_state='in_progress'`.

Cooldown table (revised):

| Action | Max attempts | Cooldown | Idempotency key |
|---|---|---|---|
| `db_sync_upsert` | 1 | n/a | `(sim_id)` |
| `resend_online` | 2 | 1h | `(report_id, sim_id, attempt_no)` salted into message_id |
| `atomic_ota` (`resendOtaProfile`) | 1 | 24h | vendor request_id |
| `atomic_restore` (`restoreSubscriber CR`) | 1 | 24h | (MSISDN) idempotent at vendor |
| `wing_put_dialable` | 1 | 24h | (ICCID) |
| `helix_ota` (4.11) | 1 | 24h | vendor request_id |
| `helix_unsuspend` (4.6 CR) | 1 | 24h | vendor request_id |
| `teltik_reset_network` | 1 | 24h | (MDN10) |
| `teltik_reset_port` | 1 | 24h | (MDN10) — 409 = success |
| `verify_send_sms` (§C) | 3 | 60s between sends | (report_id, attempt_no, nonce) |
| `classify_only` | 3 ticks | 2h | (report_id, mode) |

---

## §H. Safety gates & escalation

### §H.1. Auto-allowed actions
Reading vendor state; DB UPSERT to vendor truth; `resend_online`; OTA refresh (Atomic/Helix); `restoreSubscriber` (Atomic, with §C verify); `unsuspend` (Helix 4.6 CR, with §C verify); Wing PUT dialable plan; Teltik `/reset-network`, `/reset-port`; close `duplicate` per §E; `unable_to_reproduce` after exhausted classify-only ticks; §C `verify_send_sms`.

### §H.2. Always operator-only
Rotation / MDN swap / SIM swap / replacement / cancel / deactivate; Wing mode change to non-dialable; Helix `Cancel`, `Resume On Cancel`, `Change IMEI`, `Change ICCID`, `Change Plan`, `Update CTN/MDN`; Atomic `swapMSISDN`, `suspendSubscriber`, `deactivateSubscriber`; Teltik SIM swap / forward URL change / `/change-number`; any reseller-facing message beyond §D's two operations; any IMEI write on gateway or vendor side.

### §H.3. Operator escalation (Paperclip)
- Channel: Paperclip child issue per `(vendor, failure_type, tick)` batch (so 12 H4-suspended Helix SIMs in one tick = one child issue with 12 line items, not 12 issues).
- Failure types used in batching: `verify_send_failed`, `verify_receive_timeout`, `vendor_active_no_sms`, `vendor_iccid_not_found`, `imei_wrong_type`, `imei_drift_vendor`, `vendor_cancelled_active_rental`, `wing_w7_dialable_retry_failed`, `helix_unsuspend_failed`, `atomic_restore_failed`, `teltik_reset_failed`, `teltik_forward_url_misconfigured`, `unable_to_reproduce_recommendation`, plus a fallback `generic`.
- Body fields per line item: `report_id`, `reseller_rental_id`, current MDN, vendor, situation id, attempts table (action / outcome / vendor request_id), latest vendor state, latest webhook delivery state, §C verify-state (sent? received?), suggested next operator action.
- No secrets. ICCID is allowed in operator-facing escalations because operators see it in the dashboard already; never in reseller-facing surfaces.

### §H.4. Vendor batched ticket (still toggle-gated, default off)
Same template as v2 §8d. Trigger: ≥5 SIMs in same vendor account with terminal-suspended/barred situation in 24h, AND per-carrier operator toggle = on. Until toggle on, those SIMs only go to §H.3 batch.

---

## §I. Audit trail & dashboard surfacing

- Every tick writes one `rental_report_remediation_attempts` row per attempted action (including `verify_send_sms` and `verify_received` evidence rows).
- Every tick writes one `rental_report_events` row with `event_type='auto_remediation'`, payload `{mode, action, attempt_no, outcome, evidence_summary}`. No secrets.
- Terminal close writes status update via existing dashboard write path so the timeline matches manual closures.
- Dashboard additions (in INC-16e):
  - "Auto attempts: N (last: <action> <outcome>)" sub-row on the Bad Rentals list.
  - "Take over" button → sets `auto_remediation_state='operator_locked'` and reassigns ownership to the operator.
  - "Resume auto" button → clears the lock.
  - Guide-tab HTML decision tree (§K).

---

## §J. Data model additions

```sql
create table if not exists rental_report_remediation_attempts (
  id               bigserial primary key,
  report_id        bigint not null references rental_reports(id) on delete cascade,
  attempt_no       int    not null,
  mode             text   not null,                   -- 'A1'..'T11' | 'S1'..'S6' | 'verify_send' | 'verify_received'
  action           text   not null,                   -- enum from §G table
  attempted_at     timestamptz not null default now(),
  outcome          text   not null,                   -- 'success'|'failed'|'no_change'|'skipped_cooldown'|'verify_pending'
  evidence         jsonb,                             -- vendor request ids, webhook ids, nonces (NO secrets)
  error_message    text,
  next_review_at   timestamptz
);
create index if not exists rrra_report_idx
  on rental_report_remediation_attempts (report_id, attempted_at desc);
create index if not exists rrra_next_review_idx
  on rental_report_remediation_attempts (next_review_at)
  where next_review_at is not null;

alter table rental_reports
  add column if not exists auto_remediation_state text,   -- 'queued'|'in_progress'|'verify_pending'|'paused'|'operator_locked'|'escalated'|'done'
  add column if not exists last_auto_attempt_at timestamptz,
  add column if not exists escalation_reason text,
  add column if not exists verify_pending_nonce text,
  add column if not exists verify_pending_sent_at timestamptz;
```

No change to `rental_reports.status` enum or `remediation_action` enum.

---

## §K. Operator decision tree (vendor-aware, SMS-verify-everywhere)

```
                  ┌───────────────────────────┐
                  │  2h cron tick             │
                  └────────────┬──────────────┘
                               ▼
        Fetch open reports (status received|in_triage,
        auto_remediation_state NOT IN paused|operator_locked|verify_pending)
                               │
                               ▼
                §intake: resolve id, gather evidence, decide vendor
                               │
                               ▼
                §B IMEI correctness check
                  ├─ wrong type ──► escalate imei_wrong_type
                  └─ ok ──┐
                          ▼
                §E cancel-guard (if vendor reports cancelled/deactivated)
                  ├─ active rental remains ──► escalate vendor_cancelled_active_rental
                  └─ no active rental ──► close duplicate
                          │ (cancel-guard didn't fire)
                          ▼
                §4 shared situations S1–S6
                          │ (none fired)
                          ▼
                Branch on sims.vendor:
                ├ atomic   → §F.1 (A1..A10)
                ├ wing_iot → §F.2 (W1..W9)
                ├ helix    → §F.3 (H1..H9)
                ├ teltik   → §F.4 (T1..T11)
                └ other    → S6 (insufficient evidence)
                          │
                          ▼
                Apply auto_action per situation (if cooldown allows)
                          │
                          ▼
                Re-query vendor → §C.4 conditions 1, 2, 3 satisfied?
                          ├─ no  ──► record outcome, escalate per situation
                          └─ yes ──┐
                                   ▼
                §C.1 send unique SMS
                  ├─ send fail ──► §C.2 retry up to 3×60s
                  │                  └─ all fail ──► escalate verify_send_failed
                  └─ send ok ──┐
                               ▼
                set verify_pending; schedule §C.3 poll
                               │
                               ▼
                §C.3 inbound_sms match within 5 min?
                  ├─ no  ──► escalate verify_receive_timeout
                  └─ yes ──► §D notify-reseller (resend webhook + status update)
                                                       ──► remediated
```

Renders in dashboard Guide tab — no new tab.

---

## §L. Tests & verification

Pre-merge:
- Classifier fixture per situation (S1–S6, A1–A10, W1–W9, H1–H9, T1–T11).
- Property test: classifier outputs never include forbidden actions from §H.2.
- §C send/poll fixtures (success, send-fail-then-success, send-fail-3x, receive-timeout, receive-match).
- §E cancel-guard fixtures: cancelled+no-rental, cancelled+active-rental.
- §B IMEI correctness fixtures per `(vendor, device_type)` combination.
- Teltik MDN boundary test: any classifier path that hits Teltik passes 10-digit, never E.164.
- Idempotency: 3 ticks → exact attempt counts, no duplicate webhook resends, no duplicate `verify_send` rows.

Pre-deploy:
- `node _check_relay.js`.
- Offline dry-run replay of last 200 operator-closed reports through the classifier. Compare classifier terminal disposition vs operator's actual terminal disposition; bar ≥90% agreement (open question 4 — operator may revise).
- §C SMS verification dry-run on a small set of known-good live SIMs in a paused mode before flipping the kill-switch on.

Post-deploy (continuous):
- Daily summary (open question 1) listing: open count, auto-resolved, verify-pending, escalated by failure-type, forbidden-action attempts (must be 0).
- Alarm: forbidden-action count > 0 → KV kill-switch off, P0 child issue.

---

## §M. Open questions for operator (must be answered before go-live)

1. Daily summary destination — `agent/current-state.md` (existing convention) vs daily Paperclip child issue?
2. §H.3 escalation grouping — recommend per-tick per-`(vendor, failure_type)` batch (now the default in this plan). Confirm?
3. Vendor-contact toggle granularity (§H.4) — per-carrier (recommended) vs global vs per-carrier-and-situation?
4. Dry-run accuracy bar (§L) — ≥90% on last 200 operator-closed reports? Higher? Different sample?
5. §C poll wall-clock budget — 5 minutes per SIM. If a single tick processes 100 reports, total bounded by concurrency cap (5) × 5 min = ≤ 25 minutes of poll wall-clock per tick. Confirm this is acceptable, or shrink poll window.

---

## §N. Out of scope

Rotation cadence changes; cancel/swap/replacement; freeform reseller messaging; reintroducing verification gates; auto IMEI rewrites; new reseller-facing identifier surfaces; activation of new SIMs; Wing mode swap to non-dialable from the remediator.

---

## §O. If approved — implementation child issues (sequenced)

1. **INC-16a** — DB migration, worker scaffold (`bad-rental-remediator`), §intake (§3-style), shared situations S1–S6, §E cancel-guard, kill-switch KV, `operator_locked` state, dashboard "Take over"/"Resume auto" buttons. No vendor calls yet.
2. **INC-16b** — Classifier (§F.1–F.4), §B IMEI check, §G cooldown engine, forbidden-action property test. Pure logic; no external calls.
3. **INC-16c** — §C SMS verification subsystem (send via SKYLINE_GATEWAY `/send-sms`, poll `inbound_sms`, `verify_pending` state, 3×60s retry, 5-min poll). Wire it as the universal pre-resolve gate.
4. **INC-16d** — Wire safe vendor actions: `db_sync_upsert`, `resend_online`, `close_duplicate`, classify_only. Live for S1–S6, A2/A6/A7/A9, W1/W2/W6, H1/H2/H7, T1/T2/T8 — but every `remediated` still gates through §C from INC-16c.
5. **INC-16e** — Wire vendor restore/refresh actions: Atomic `resendOtaProfile`, `restoreSubscriber`; Wing `PUT dialable`; Helix 4.11 `OTA`, 4.6 `Unsuspend`; Teltik `/reset-network`, `/reset-port`. Per-action KV emergency disable.
6. **INC-16f** — §H.3 batched operator escalation issues; §H.4 toggle-gated vendor-batch ticket (defaults off).
7. **INC-16g** — Dashboard surfacing (Auto-attempts sub-row, Guide-tab decision tree HTML, escalation viewer).

1–5 are the operational core, shipped in sequence (each PR ≤ 1 day). 6 and 7 ship in parallel after 5.
