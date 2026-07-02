---
name: sim-capability-map
description: Map of every SIM-action site across the incomingsms workers and where to wire a new cross-cutting distinction (a new gateway host, a new carrier vendor, or a per-SIM capability). Use when adding a system-wide SIM property or asking "does every action handle X". Triggers on "make every action aware of X", "add a SIM-level flag across the system", "new gateway type", "new vendor", "skip step Y for SIMs of type Z", "does the whole system handle".
---

# SIM Capability Map

How SIM operations are wired across the incomingsms workers, and the checklist for
adding a new cross-cutting distinction so no action site is missed.

## The two orthogonal axes

A SIM has two independent properties. Confusing them is the classic bug.

- **`sims.vendor`** = the **carrier account** the line is provisioned on.
  `atomic` / `helix` / `wing_iot` = AT&T, `teltik` = T-Mobile.
  **Carrier-level** operations route on `vendor`: activation, MDN swap, OTA via the
  carrier API, suspend/restore/deactivate/reconnect, billing/carrier bucketing.

- **`sims.gateway_host`** = the **physical gateway** the SIM card is seated in,
  `'skyline'` or `'teltik'`, independent of vendor. **Gateway-level** operations
  route on `gateway_host`: writing the modem IMEI (AT+EGMR), sending SMS over the
  Skyline AT-command transport, Teltik port/network resets.

They usually agree (a teltik-vendor SIM sits in a Teltik gateway) but need not: an
**ATOMIC (AT&T) SIM can be seated in a Teltik gateway**. Carrier ops still go to
ATOMIC; gateway ops must respect that Teltik gateways cannot write IMEI or send
AT-command SMS. See memory `atomic-in-teltik-gateway-hosting`.

**Rule of thumb:** if the operation talks to the carrier's API, gate on `vendor`.
If it talks to the physical gateway (IMEI, AT-command SMS, port reset), gate on
`gateway_host` via the helper below.

## Single source of truth: `src/shared/gateway-host.mjs`

Pure, IO-free, unit-tested (`tests/gateway-host.test.mjs`). Every worker imports it
so host decisions are identical everywhere.

```js
import { gatewaySupports, isTeltikHosted, isSkylineHosted, gatewayHostOf } from '../shared/gateway-host.mjs';

gatewaySupports(sim, 'setImei')    // true only for Skyline-hosted
gatewaySupports(sim, 'skylineSms') // true only for Skyline-hosted
gatewaySupports(sim, 'portReset')  // true only for Teltik-hosted
isTeltikHosted(sim)                // gateway_host === 'teltik' (with vendor fallback)
```

`gatewayHostOf(sim)` prefers the explicit `sim.gateway_host` column and falls back to
`vendor === 'teltik' ? 'teltik' : 'skyline'` for rows written before the column
existed. So any query feeding the helper should `select` `gateway_host` (and `vendor`
as a safety net).

**Adding a new capability** = one line in the `CAPABILITIES` matrix in
`gateway-host.mjs` + a `gatewaySupports(sim, 'newCap')` guard at each site that
performs it. Do not scatter `gateway_host === 'teltik'` string checks; always go
through `gatewaySupports` / `isTeltikHosted`.

## Action-site inventory

Gateway-level sites that were guarded for the Skyline-vs-Teltik split are marked
GUARDED. Carrier-level sites are host-agnostic by design.

| Operation | Level | File(s) | Gate | Notes |
|-----------|-------|---------|------|-------|
| Write IMEI (AT+EGMR) | gateway | `skyline-gateway/index.js` (`/set-imei`, `AT+EGMR`) | host | The physical write. Only Skyline. |
| IMEI change flow | gateway | `mdn-rotator/index.js` `/sim-action` `change_imei` | `gatewaySupports(sim,'setImei')` — GUARDED (409) | Operator "Set/Change IMEI" routes here via dashboard `/api/sim-action`. |
| Fix SIM (atomic) | gateway+carrier | `mdn-rotator/index.js` `fixAtomicSim` | `canSetImei` skips gateway scan + IMEI push — GUARDED | Dashboard `/api/fix-sim` routes here. Carrier inquiry/restore still runs. |
| Retry activation | gateway+carrier | `mdn-rotator/index.js` `retryActivation` | refuses Teltik-hosted — GUARDED | Skyline-only: it registers the pushed IMEI with the carrier. |
| Pool slot fix | gateway | `dashboard/index.js` `handleImeiPoolFixSlot` (`/api/imei-pool/fix-slot`) | keyed by `gateway_id`+`port` | Internal pool-reconcile tool; cannot target a Teltik SIM (null gateway). |
| IMEI heartbeat / blimei sweep | gateway | `mdn-rotator/index.js` (`imei_heartbeat`, `blimei_update`) | DEAD CODE (disabled) | If ever re-enabled, gate on `setImei`. |
| Skyline SMS send | gateway | `skyline-gateway/index.js` `/send-sms`; `dashboard` send-test-sms proxy | `gatewaySupports(sim,'skylineSms')` | Not yet exercised for Teltik-hosted; gate if a path sends via Skyline for them. |
| Teltik port/network reset | gateway (Teltik) | `dashboard/index.js` `ota_refresh` (~L5162); `bad-rental-remediator/vendor.mjs`; `actions.mjs` `execTeltikReset` | Teltik only | "OTA refresh" operator label = Teltik `/v1/reset-port`. |
| Teltik ICCID sync | gateway (Teltik) | `bad-rental-remediator/actions.mjs` `execTeltikSyncIccid`; `shared/teltik-iccid.mjs`; `shared/rotation-playbook.mjs` | Teltik only | Heals swapped physical card. |
| MDN swap / change | carrier | `mdn-rotator/index.js` `rotateSingleSim`; `shared/atomic.ts`, `shared/helix.ts`, `shared/wing-iot.ts`; `teltik-worker/index.js` | `vendor` | Host-agnostic. |
| OTA refresh (carrier) | carrier | `shared/atomic.ts`, `shared/helix.ts`; `ota-status-sync/index.js`; `actions.mjs` `execAtomicOta`/`execHelixOta` | `vendor` | Distinct from Teltik "reset-port". |
| Suspend/restore/deactivate/reconnect | carrier | `shared/atomic.ts`; `sim-status-changer/index.js`; `sim-canceller/index.js`; `actions.mjs` | `vendor` | Host-agnostic. |
| Inbound SMS capture | gateway | `teltik-worker` webhook; `skyline-gateway` inbound | `gateway_host` | See gap below: teltik-worker webhook still filters `vendor=eq.teltik`. |

## Known gaps (not yet wired) for ATOMIC-in-Teltik

These are open. If you extend the distinction, start here:

1. **Inbound SMS capture** — `teltik-worker` webhook + `rotate-sim` lookup filter
   `vendor=eq.teltik`. An ATOMIC-in-Teltik SIM (`vendor='atomic'`) receiving SMS
   through the Teltik gateway is not found, so its SMS/rental capture is dropped.
   Decide whether the webhook keys on `gateway_host='teltik'` (any vendor).
2. **Onboarding/tagging** — how an ATOMIC-in-Teltik SIM first enters `sims` and gets
   `gateway_host='teltik'` set (manual add, CSV import, or Teltik reconcile).
3. **Dashboard "Query" health** — for teltik-hosted SIMs regardless of vendor, use
   Teltik `port-status` + `get-info`-by-MDN (ICCID reverse-lookup returns "MSISDN Not
   Found" for these), not the Skyline/ATOMIC path.
4. **Remediator heals** — the Teltik reset/sync actions are gated to `vendor='teltik'`
   and so are not offered to a stuck ATOMIC-in-Teltik SIM even though a Teltik port
   reset would help it.

## Checklist: adding a new cross-cutting SIM distinction

1. **Schema** — add the column + backfill migration under `supabase/migrations/`.
   Give it a `NOT NULL DEFAULT` and a CHECK constraint. Backfill existing rows.
2. **Helper** — extend `src/shared/gateway-host.mjs` (or add a sibling shared module)
   with a resolver + capability; keep it pure and add unit tests in `tests/`.
3. **Tag every insert path** — every `INSERT`/`UPSERT` into `sims` must set the new
   column: `teltik-worker` (`importTeltikLines`, `applyTeltikActivation`), activation
   flows, CSV import. Reads (`sims?...=eq...`) do NOT need changing.
4. **Guard every gateway-level site** in the inventory table above with the new
   `gatewaySupports(sim, 'cap')` check. Carrier-level sites stay on `vendor`.
5. **Surface it** — add the column to the `/api/sims` select in `dashboard`
   (`handleSims`) so the UI/operator can see and branch on it.
6. **Deploy set** — the workers that read/route on SIM state:
   `mdn-rotator`, `dashboard`, `teltik-worker`, `bad-rental-remediator`,
   `details-finalizer`.
7. **Never use an em dash** anywhere (hard project rule); use commas/colons/parens.
