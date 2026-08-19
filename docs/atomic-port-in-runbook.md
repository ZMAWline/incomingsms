# ATOMIC / AT&T Port-In — Safety & Run Sheet

**Task:** t_e11befc1 (safety finding) → t_184b6f38 (mapping implemented)
**Status:** Carrier field mapping implemented using the Atomic Wholesale `portinRequest` operation. Live test is still GATED on explicit Zalmen approval for a specific MDN — this doc does not authorize a live submission.

---

## 1. Carrier field mapping — history and current state

Source: **AT&T ATOMIC API: Critical Reference Guide (EB) 03.27** (`.claude/skills/atomic-api/references/`) plus the `atomic-wholesale-api` skill.

Earlier finding (still true): the `Activate` request (`requestType: "Activate"`) contains exactly one port-related field, `portMdn`, and no fields for losing-carrier account/PIN/name/address. Submitting `portMdn` alone against `Activate` activates a **new number**, not a real port — that risk is why port-in was blocked entirely in commit `43da35c`.

**What changed:** the Atomic Wholesale API skill confirms `portinRequest` is a *separate* operation from `Activate`, with a documented field set that covers exactly what AT&T requires to authorize a port:

- `subscriber.*` — new account holder taking the line (firstName, lastName, streetNumber, streetType, streetDirection, streetName, zipCode)
- `old_service_provider.*` — losing-carrier account holder (billingAccountNumber, billingAccountPassword, firstName, lastName) — **no address block**
- Top-level: `MSISDN`, `sim`, `eSim`, `BAN`, `imei`, `planCode`, `partnerTransactionId`

`subscriber` and `old_service_provider` are independent — their names may legitimately differ. What must match the losing carrier's own records exactly is `old_service_provider` (account number, password, first/last name).

Implemented in `src/shared/activation-bulk.mjs` (`buildAtomicPortInRequest`) and wired into the live request path in `src/bulk-activator/index.js` (`activateViaAtomicPortIn`), which the queue consumer (`activateViaAtomic`) now routes to whenever any port field is present, instead of the previous hard refusal.

**Still unconfirmed by the carrier** (not invented, not blocking): endpoint/method/response shape beyond what's already used for `Activate`/`subsriberInquiry`, `portinRequest`/`portinStatus`/`portinCancel`/`portinUpdate` status enum and meanings, real plan-code list (`planCode` reuses the existing `EBNOVOICE` constant used for every other Atomic request in this repo as the least-speculative choice, not a new guess), and whether `BAN` should be sent blank on this operation (mirrors `Activate` precedent, flagged in code for live-test review).

---

## 2. Safety guards — current state

1. **App-layer validation** (`src/shared/activation-bulk.mjs`, `validateActivationSim`): a `port_in = true` row requires `port_mdn`, `port_account_number`, `port_pin`, `port_first_name`, `port_last_name`, `port_street_number`, `port_street_name`, `port_zip`, `port_old_first_name`, `port_old_last_name`, and `vendor = atomic` — any missing field is a row-level error. Shared by CSV `/run`, JSON `/activate`, and the dashboard validator (`src/dashboard/public/index.html`).
2. **Queue consumer guard** (`activateViaAtomicPortIn`): re-checks the same required fields before building the carrier request and throws (refusing the submission) rather than falling back to `Activate`. Covers messages already queued before validation changes reach production.
3. **New-number path is unaffected**: blank `port_mdn`/`port_account_number`/`port_pin` routes to the existing `Activate` flow with `portMdn: ''`, unchanged.
4. **Regression tests** (`tests/activation-bulk.test.mjs`): assert the outgoing `portinRequest` body actually contains `subscriber.*` and `old_service_provider.*` — these fail if the mapping is ever dropped or only partially wired.

`port_pin` is sent only inside the actual carrier request body — there is no separate debug/context field that duplicates it. The carrier request itself (PIN included) is recorded in `carrier_api_logs.request_body`, the same as every other Atomic call's `session.pin`; this is an existing system-wide pattern, not something new to port-in.

---

## 3. One-Number Run Sheet (present BEFORE any live test)

```
PORT-IN RUN SHEET — ONE NUMBER ONLY
────────────────────────────────────────────────────────
Target MDN to port:        <MDN — 10 digits, Zalmen-supplied>
Target SIM / ICCID:        <19-20 digit ICCID — a SPARE, never a production line>
Target IMEI:               <15 digit IMEI>
Reseller context:          reseller_id = <id>  (or operator-only / no reseller)
Losing carrier account #:  <must match losing carrier's records exactly>
Losing carrier PIN:        <must match losing carrier's records exactly>
Losing carrier acct name:  <first/last name on the losing-carrier account>
New subscriber name/addr:  <first/last/street/zip for the new account holder>

Submit path:               POST /api/activate?secret=...   (bulk-activator worker)
                            body: { sims: [{ iccid, imei, reseller_id, vendor:"atomic",
                                    port_in:true, port_mdn, port_account_number, port_pin,
                                    port_first_name, port_last_name, port_street_number,
                                    port_street_name, port_zip, port_old_first_name,
                                    port_old_last_name }] }
Carrier endpoint:          https://solutionsatt-atomic.telgoo5.com:22712  (requestType "portinRequest")
────────────────────────────────────────────────────────
EXPECTED RESULT (mapping implemented, not yet live-tested):
  → App validator accepts a complete row and the queue consumer submits a
    portinRequest carrying subscriber + old_service_provider fields.
  → SIM is recorded with status='provisioning' (not 'active') until the port
    is confirmed — a real port is accepted asynchronously by the losing
    carrier, unlike Activate.
```

---

## 4. Approval gate (business rule — MUST hold)

- ❌ No live carrier mutation has been performed as part of implementing this mapping. No `POST /api/activate`, no `portinRequest`, no port-in has been submitted.
- ✅ Live test may proceed ONLY after **explicit Zalmen approval of the specific MDN** in §3.
- ✅ Test is **one explicit number only** (never a batch).

---

## 5. Post-test verification (after approved test only)

1. Read carrier response from `carrier_api_logs` (status, `wholeSaleResponse.statusCode`, `Result.MSISDN`, `Result.BAN`).
2. Confirm the port with `subsriberInquiry` (`requestType: "subsriberInquiry"`, MSISDN = target MDN) — verify `attStatus` and that the MDN matches the requested port, NOT a freshly assigned new number.
3. Never expose `port_pin` / account credentials in any output or log excerpt shared outside `carrier_api_logs`.
4. Follow-up (not yet implemented): there is no automatic reconciliation loop that moves a ported SIM from `status='provisioning'` to `'active'` once the carrier confirms — `details-finalizer`'s ATOMIC path currently only recovers SIMs stuck after a `swapMSISDN` 5xx, not port-in confirmations. Until that's added, a ported SIM's status must be confirmed and updated manually via `subsriberInquiry`.
