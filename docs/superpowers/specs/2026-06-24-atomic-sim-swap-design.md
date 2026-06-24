# ATOMIC SIM Swap (change ICCID, keep everything else)

Date: 2026-06-24
Status: Approved (design), pending implementation

## Goal

Let an operator swap the physical SIM card behind an active **AT&T / ATOMIC**
line: change the **ICCID** while keeping the same phone number (MSISDN), BAN,
reseller, gateway slot, rental, and message history. Expose it as a SIM action
in the dashboard, and document the underlying ATOMIC `swapSIM` call in the
`atomic-api` skill.

## Background / carrier behavior

ATOMIC `swapSIM` takes the line's current `MSISDN`, a `zipCode`, and the
`newSim` (new ICCID). The carrier keeps the same MSISDN/BAN and moves the line
to the new ICCID; the **old ICCID is auto-detached** at the carrier. The IMEI is
the gateway modem in the slot, not the SIM, so it does **not** change. Net
effect on our side: **only the ICCID changes.**

Request shape (from operator):

```json
{
  "wholeSaleApi": {
    "session": { "userName": "...", "token": "...", "pin": "..." },
    "wholeSaleRequest": {
      "requestType": "swapSIM",
      "MSISDN": "3322408354",
      "zipCode": "98104",
      "newSim": "356719117453485"
    }
  }
}
```

## Data-model decision: in-place ICCID update (Approach A)

The new ICCID is a raw card number the operator types in (no pre-existing DB
row); the new card goes into the **same gateway slot** as the old one.

Because the MSISDN, gateway slot, IMEI, reseller, rental, and active
`sim_numbers` row all stay the same, we keep the **same `sims` row** and only
change `iccid`. All history (messages, rentals, reseller link, phone number,
billing) stays attached by construction. Billing continuity is preserved (same
`sim_id` / `sim_number_id` / `rentals` row — no new number lifetime, no new
rental, no bad-rental risk).

We do **not** create a second `sims` row or repoint any foreign keys. The old
ICCID is preserved in the audit trail (`carrier_api_logs` + a
`sims.status_reason` note + a `sim_status_history` entry), not as a separate
"cancelled" row.

Rejected alternative (Approach B: new row + cancel old + move all FKs): much
riskier given the rental / bad-rental machinery keyed on `sim_id` /
`sim_number_id`; any missed reference means under-billing or a dangling rental.
Not justified when the number didn't change.

## Components

### 1. `atomic-api` skill (`.claude/skills/atomic-api/SKILL.md`)

- Add `swapSIM` to the operations table (new operation row).
- Add a full request example (operator payload, placeholder creds matching the
  existing examples).
- Add a "SIM Swap Sequence" note: MSISDN stays, ICCID changes, old ICCID
  auto-detaches (no separate `deactivateSubscriber` needed); update address
  first only if the ZIP on file is wrong.
- Add a migration-notes row if it clarifies the Helix→ATOMIC mapping.

### 2. Backend route — `POST /api/atomic-swap-sim` → `handleAtomicSwapSim()`

In `src/dashboard/index.js`, modeled on `handleAtomicQuery()`.

Input: `{ sim_id, new_iccid, zip_code? }`

Flow:
1. Load the SIM:
   `sims?select=id,iccid,msisdn,vendor,status,activation_zip,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.<sim_id>`.
2. Guards (reject with 400 + clear message):
   - SIM exists.
   - `vendor === 'atomic'`.
   - `status !== 'canceled'`.
   - Has an MSISDN (from `sims.msisdn`, fallback active `sim_numbers.e164`
     reduced to 10 digits).
   - `new_iccid` is a real ICCID: matches `^89\d{17,19}$` (same detection the
     rest of the dashboard uses in `handleAtomicQuery`), differs from the current
     ICCID, and is not already owned by another `sims` row (pre-check to avoid a
     raw Postgres unique-violation). The full ICCID is what we send as `newSim`
     and what we store in `sims.iccid`.
   - Resolve `zipCode = zip_code || sims.activation_zip`; if neither, reject
     ("ZIP required for swapSIM").
3. Verify ATOMIC creds present (`ATOMIC_USERNAME/TOKEN/PIN`), else 500 with the
   same message style as `handleAtomicQuery`.
4. Build the `swapSIM` request and call via `relayFetch` to
   `ATOMIC_API_URL || https://solutionsatt-atomic.telgoo5.com:22712`.
5. `logCarrierApiCall(env, {...})` with the full request/response, `vendor:
   'atomic'`, the **old** ICCID, and an `error` summary when not `00`.
6. Success = `wholeSaleApi.wholeSaleResponse.statusCode === '00'`.
   - **On success only:** `PATCH sims?id=eq.<sim_id>` setting `iccid =
     new_iccid` and `status_reason = 'ICCID swapped from <old> on <ISO>'`;
     append a `sim_status_history` row (old_status = new_status = current
     status, reason = swap note) if the table schema permits.
   - **On failure:** change nothing in the DB; return `{ ok:false, error }`.
7. Return `{ ok, old_iccid, new_iccid, response }`.

Wire the route next to the other `/api/...` routes (near `handleAtomicQuery`'s
registration).

### 3. Frontend — Swap SIM modal (`src/dashboard/public/index.html`)

- Entry point in the **SIM detail modal** (`openSimDetail`), consistent with the
  IMEI-change flow. A "Swap SIM" button is shown only for **active ATOMIC**
  SIMs and calls `showSwapSimModal(simId)`.
- Modal contents:
  - Read-only: current ICCID, number (MSISDN), reseller.
  - Editable ZIP, pre-filled from `activation_zip`.
  - **New ICCID** text input (client-side validated `^89\d{17,18}$`).
  - A clear warning that this performs a **live carrier change**.
- Submit → `POST /api/atomic-swap-sim` with `{ sim_id, new_iccid, zip_code }`.
  Show a toast with the result; on success close the modal and refresh the SIM
  list / detail.
- No bulk swap (each swap needs a distinct new ICCID).

## Error handling & safety

- The carrier response is the gate: the DB only changes on `statusCode === '00'`.
- Client and server both validate ICCID format + uniqueness.
- Every attempt (success or failure) is recorded in `carrier_api_logs`.
- Guards prevent swapping non-ATOMIC, canceled, or MSISDN-less SIMs.

## Verification

- `node --input-type=module --check` on `src/dashboard/index.js`.
- Frontend `<script>` block syntax check on `public/index.html`.
- Manual: operator runs one real swap on an ATOMIC SIM after deploy. No live
  swap is fired automatically during development.

## Resolved questions

- The sample `"newSim": "356719117453485"` was a **dummy** value. The `newSim`
  field carries a real, regular ICCID (`89…`, 19-21 digits). Client and server
  validate with `^89\d{17,19}$`; the full ICCID is both sent as `newSim` and
  stored in `sims.iccid`.

## Out of scope

- Bulk swapping.
- Non-ATOMIC vendors (Helix/Teltik/Wing IoT).
- Creating/cancelling separate SIM rows (Approach B).
- Changing the IMEI or moving gateway slots.

## Files touched

- `.claude/skills/atomic-api/SKILL.md` — document `swapSIM`.
- `src/dashboard/index.js` — `handleAtomicSwapSim()` + route registration.
- `src/dashboard/public/index.html` — `showSwapSimModal()` + detail-modal entry.
