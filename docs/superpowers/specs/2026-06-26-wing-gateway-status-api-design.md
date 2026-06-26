# WING Gateway Status API — Design

Date: 2026-06-26
Status: Approved design (pending spec review)

## Purpose

Give the external partner WING a single read-only API endpoint to check the
**live Skyline gateway state** of one or more SIMs by ICCID. The numeric Skyline
state code is converted to a human-readable string (e.g. `State 3 = Registered
(ready)`) so WING does not need a code chart.

This is the *gateway* state (the on-prem Skyline device's per-port registration
state), not the carrier-side activation status. The existing `/api/wing-check`
route returns carrier (AT&T/Wing IoT) status and is unrelated to this work.

## Endpoint

`GET /api/gateway-status` on the `dashboard` Cloudflare Worker
(`src/dashboard/index.js`).

### Request

- Single: `GET /api/gateway-status?iccid=8901...`
- Batch:  `GET /api/gateway-status?iccids=8901...,8901...` (comma-separated)
- If both `iccid` and `iccids` are present, they are merged and de-duplicated.
- Cap: **100 ICCIDs per request**. Over the cap returns `400` with
  `{ "error": "too many iccids (max 100)" }`.
- Empty/missing ICCID input returns `400` with `{ "error": "iccid or iccids required" }`.

### Auth

- New secret env var: `GATEWAY_STATUS_API_KEY`.
- Caller authenticates with header `X-Api-Key: <key>` (also accept `?key=<key>`
  for browser/curl convenience).
- The route is intercepted at the **top of `fetch()`**, before the operator
  Basic-auth gate (lines 19-25 of `src/dashboard/index.js`), and performs its own
  key check. Operator dashboard credentials are never shared with WING.
- Key comparison is constant-time (length check + per-char XOR accumulation) to
  avoid timing leaks.
- Missing/incorrect key returns `401` with `{ "error": "unauthorized" }`.
- If `GATEWAY_STATUS_API_KEY` is not configured in the environment, the endpoint
  returns `503` with `{ "error": "gateway-status endpoint not configured" }`
  (fail closed — never serve data without a configured key).

## Data Flow

1. Parse and de-duplicate the requested ICCIDs from the query string.
2. Query Supabase `sims` for those ICCIDs:
   `sims?iccid=in.(...)&select=id,iccid,gateway_id,sim_numbers(e164)&sim_numbers.valid_to=is.null`
3. Group the found ICCIDs by `gateway_id` (skip rows with null `gateway_id`).
4. For each **distinct** `gateway_id`, call the `SKYLINE_GATEWAY` service binding
   `/port-info?gateway_id=<id>&secret=<SKYLINE_SECRET>` **once** (a live device
   read). From the returned `ports[]` array, build an
   `iccid -> { st, imei, signal, operator }` map.
   - `/port-info` already returns per-port `st`, `iccid`, `imei`, `signal`
     (`sig`), and `operator` (`opr`). We match on `iccid`.
5. Assemble one result object per **requested** ICCID (preserving request order),
   then return the array.

Reusing `/port-info` means at most one live gateway call per distinct gateway,
regardless of how many ICCIDs are requested.

## Response

Top level:

```json
{ "ok": true, "count": 2, "results": [ /* one object per requested iccid */ ] }
```

Per-ICCID result object (fields always present; null when not applicable):

```json
{
  "iccid": "8901...",
  "found": true,
  "state_code": 3,
  "state_label": "Registered (ready)",
  "gateway_state": "State 3 = Registered (ready)",
  "number": "+1...",
  "operator": "AT&T",
  "signal": 22,
  "imei": "356938...",
  "message": null
}
```

Field notes:

- `gateway_state` is the human string: `"State <code> = <label>"`.
- `state_code` / `state_label` are the same data split out, for programmatic use.
- `imei` is the **gateway-reported** IMEI from the live device read
  (`/port-info` `imei`), NOT the value stored in our DB.
- `number` is the active `e164` from `sim_numbers` (`valid_to IS NULL`).
- `operator` and `signal` come from the live gateway read.
- No `registered` boolean is included (per operator decision — the
  `gateway_state` string is the source of truth).

## Skyline State Code -> Label Map

Authoritative mapping from the SkyLine-API reference. Full labels are used
verbatim (no shortening).

| Code | Label |
|------|-------|
| 0  | No SIM card |
| 1  | Idle SIM card |
| 2  | Registering |
| 3  | Registered (ready) |
| 4  | Call connected |
| 5  | No balance / alarm |
| 6  | Registration failed |
| 7  | SIM locked by device |
| 8  | SIM locked by operator |
| 9  | SIM card error |
| 11 | Card detected |
| 12 | User locked |
| 13 | Port inter-calling |
| 14 | Inter-calling holding |
| 15 | Access Mobile Network |
| 16 | Module response timeout |

Any code not in this table (including `10`) maps to label `"Unknown"`, i.e.
`gateway_state = "State <n> = Unknown"`, with `state_code` set to the raw number.

The map lives as a module-level constant in `src/dashboard/index.js` with a
small helper, e.g. `formatGatewayState(st)` returning
`{ state_code, state_label, gateway_state }`.

## Edge Cases

Each ICCID is handled independently; one bad ICCID never fails the whole request.
The per-ICCID `message` field explains non-normal cases.

| Situation | Result fields |
|-----------|---------------|
| ICCID not in `sims` | `found: false`, all state/number/imei fields null, `message: "not found in system"` |
| In system, `gateway_id` null (not slotted) | `found: true`, state fields null, `number` populated if available, `message: "not assigned to a gateway"` |
| In a gateway, but ICCID absent from the live `/port-info` read (removed/swapped) | `found: true`, state fields null, `message: "not present in gateway"` |
| Gateway/bridge unreachable (the `/port-info` call fails or returns `ok:false`) | Affected ICCIDs get state fields null, `message: "gateway unreachable"`; ICCIDs on other reachable gateways still return normally |

The top-level call still returns `200` with `ok: true` in all of the above; the
detail is per-ICCID. Hard `4xx`/`5xx` are reserved for auth, malformed input,
over-cap, and total handler failure.

## Implementation Notes

- New handler `handleGatewayStatus(request, env)` builds its own CORS + JSON
  headers (it runs before the shared `corsHeaders` is constructed).
- Route interception goes at the very top of `fetch()`, immediately after
  `const url = new URL(request.url);` and before the Basic-auth block.
- Handle `OPTIONS` preflight for this path (return CORS headers) before the
  key check, so browser-based callers work.
- Follow the `patch-dashboard` skill workflow when editing `src/dashboard/index.js`.
- The change is backend-only (no `public/index.html` / frontend edits).

## Deployment

- Set the secret: `GATEWAY_STATUS_API_KEY` on the `dashboard` worker
  (and `dashboard-test` for staging).
- Deploy: `wrangler deploy` from `src/dashboard/`.
- Deliverable to WING: the endpoint URL, the API key, and a sample curl, e.g.

  ```
  curl "https://<dashboard-host>/api/gateway-status?iccids=8901AAA,8901BBB" \
    -H "X-Api-Key: <key>"
  ```

## Out of Scope (YAGNI)

- Cached/snapshot serving (live read only for now).
- Per-partner key management via `reseller_api_keys` (single shared key for WING).
- Carrier-side (AT&T/Wing IoT) activation status (that's `/api/wing-check`).
- Any frontend/dashboard UI for this endpoint.
