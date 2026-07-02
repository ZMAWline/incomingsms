# Gateway-Host Awareness (Skyline vs Teltik) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach every action in the system to distinguish where a SIM physically lives (a Skyline gateway vs a Teltik gateway), independent of its carrier `vendor`, so gateway-only steps (IMEI write, AT-command SMS) are skipped for Teltik-hosted SIMs instead of failing.

**Architecture:** Add one explicit column `sims.gateway_host` ('skyline' | 'teltik'). All gateway-capability decisions route through a single shared pure module `src/shared/gateway-host.mjs` (matching the existing `teltik-iccid.mjs` / `rotation-baseline.mjs` pattern) that exposes `gatewayHostOf(sim)`, `isTeltikHosted(sim)`, and a capability matrix `gatewaySupports(sim, capability)`. Each worker imports the helper and guards its gateway-only operations. Carrier-level operations (MDN swap, OTA via the carrier API, suspend/restore) are **not** touched — they already route on `vendor` and work regardless of host.

**Tech Stack:** Cloudflare Workers (ES modules), Supabase/Postgres, `node --test` for unit tests. Shared logic lives in `src/shared/*.mjs` as pure, IO-free functions.

**Key domain fact:** Today `vendor='atomic'` implicitly means Skyline-hosted (333/339 atomic SIMs have a gateway/port). The new ATOMIC-in-Teltik SIMs are `vendor='atomic'` with **no** Skyline gateway/port — they receive SMS through the Teltik gateway webhook. IMEI writes (`AT+EGMR` via the Skyline gateway) are physically impossible for them, so those steps must be skipped, not attempted.

---

## Scope

This plan covers **Tier 1**: the data model, the shared capability helper, tagging future Teltik inserts, and guarding every live gateway-only operation (IMEI write paths in `mdn-rotator` and `dashboard`, plus `bad-rental-remediator` awareness). It also builds the requested **meta-skill** (`sim-capability-map`).

**Tier 2** (inbound-SMS capture for ATOMIC-in-Teltik SIMs, the operator onboarding/tagging UI, and Teltik-aware dashboard "Query" health) is deliberately deferred to a follow-on plan — see the final section. Those items need their own brainstorm because they depend on how ATOMIC-in-Teltik SIMs first enter the `sims` table, which is not yet defined (operator is still testing a single line).

## File Structure

| File | Responsibility | Create/Modify |
|------|----------------|---------------|
| `supabase/migrations/20260702_sims_gateway_host.sql` | Add + backfill `sims.gateway_host` | Create |
| `src/shared/gateway-host.mjs` | Single source of truth: host resolution + capability matrix | Create |
| `tests/gateway-host.test.mjs` | Unit tests for the helper | Create |
| `src/teltik-worker/index.js` | Tag new Teltik SIM inserts with `gateway_host='teltik'` | Modify (~line 272) |
| `src/mdn-rotator/index.js` | Skip IMEI/gateway steps for Teltik-hosted SIMs (3 sites) | Modify |
| `src/dashboard/index.js` | Guard manual IMEI push for Teltik-hosted SIMs | Modify (~line 3808) |
| `src/bad-rental-remediator/actions.mjs` | Skip Skyline-only heals for Teltik-hosted SIMs | Modify |
| `.claude/skills/sim-capability-map/SKILL.md` | Meta-skill documenting every SIM-action site | Create |

---

## Task 1: Database migration — add `sims.gateway_host`

**Files:**
- Create: `supabase/migrations/20260702_sims_gateway_host.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260702_sims_gateway_host.sql`:

```sql
-- gateway_host: the physical gateway a SIM lives in, independent of carrier vendor.
--   'skyline' = our multi-port Skyline gateways. Support AT+EGMR IMEI writes and
--               AT-command SMS send. gateway_id/port are populated.
--   'teltik'  = Teltik-hosted gateway. Inbound SMS (webhook) + port reset ONLY.
--               NO IMEI write, NO AT-command SMS. gateway_id/port are null.
-- This splits apart the two things vendor used to conflate: carrier account
-- (atomic/helix/wing_iot/teltik) vs physical host. An ATOMIC (AT&T) SIM can now
-- live in EITHER a Skyline OR a Teltik gateway.
alter table public.sims
  add column if not exists gateway_host text not null default 'skyline';

alter table public.sims
  drop constraint if exists sims_gateway_host_check;
alter table public.sims
  add constraint sims_gateway_host_check check (gateway_host in ('skyline','teltik'));

-- Backfill: every teltik-vendor SIM is Teltik-hosted. Everything else keeps the
-- 'skyline' default (matches today's assumption that non-teltik => Skyline).
update public.sims set gateway_host = 'teltik' where vendor = 'teltik';

create index if not exists idx_sims_gateway_host on public.sims (gateway_host);
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (name: `sims_gateway_host`, the SQL above), OR `supabase db push` if using the CLI.

- [ ] **Step 3: Verify the column + backfill**

Run this query (via Supabase MCP `execute_sql`):

```sql
select gateway_host, count(*) n,
       count(*) filter (where vendor='teltik') teltik_vendor,
       count(*) filter (where gateway_id is not null) with_gateway
from public.sims group by gateway_host order by n desc;
```

Expected: a `teltik` row with `n = teltik_vendor` (~3625, all with_gateway=0), and a `skyline` row containing all atomic/helix/wing_iot SIMs.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260702_sims_gateway_host.sql
git commit -m "feat: add sims.gateway_host to split physical host from carrier vendor"
```

---

## Task 2: Shared capability helper `gateway-host.mjs`

**Files:**
- Create: `src/shared/gateway-host.mjs`
- Test: `tests/gateway-host.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/gateway-host.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKYLINE, TELTIK,
  gatewayHostOf, isTeltikHosted, isSkylineHosted, gatewaySupports,
} from '../src/shared/gateway-host.mjs';

test('explicit gateway_host wins', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'teltik', vendor: 'atomic' }), TELTIK);
  assert.equal(gatewayHostOf({ gateway_host: 'skyline', vendor: 'teltik' }), SKYLINE);
});

test('falls back to vendor when column absent (teltik vendor => teltik host)', () => {
  assert.equal(gatewayHostOf({ vendor: 'teltik' }), TELTIK);
});

test('falls back to skyline for non-teltik vendors when column absent', () => {
  assert.equal(gatewayHostOf({ vendor: 'atomic' }), SKYLINE);
  assert.equal(gatewayHostOf({ vendor: 'helix' }), SKYLINE);
  assert.equal(gatewayHostOf({}), SKYLINE);
});

test('unknown gateway_host value falls back to derivation, never crashes', () => {
  assert.equal(gatewayHostOf({ gateway_host: 'garbage', vendor: 'teltik' }), TELTIK);
});

test('isTeltikHosted / isSkylineHosted', () => {
  assert.equal(isTeltikHosted({ gateway_host: 'teltik' }), true);
  assert.equal(isTeltikHosted({ vendor: 'atomic', gateway_host: 'skyline' }), false);
  assert.equal(isSkylineHosted({ vendor: 'atomic' }), true);
});

test('capability matrix: skyline supports IMEI write, teltik does not', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'setImei'), true);
  assert.equal(gatewaySupports({ gateway_host: 'teltik' }, 'setImei'), false);
  // ATOMIC SIM hosted in Teltik: no IMEI write.
  assert.equal(gatewaySupports({ vendor: 'atomic', gateway_host: 'teltik' }, 'setImei'), false);
});

test('capability matrix: skyline supports AT-command SMS, teltik does not', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'skylineSms'), true);
  assert.equal(gatewaySupports({ gateway_host: 'teltik' }, 'skylineSms'), false);
});

test('capability matrix: unknown capability is false, not throw', () => {
  assert.equal(gatewaySupports({ gateway_host: 'skyline' }, 'nonexistent'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/gateway-host.test.mjs`
Expected: FAIL — `Cannot find module '../src/shared/gateway-host.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/gateway-host.mjs`:

```js
// =========================================================
// Shared gateway-host resolution + capability matrix.
//
// A SIM's `vendor` says which CARRIER ACCOUNT it belongs to (atomic/helix/
// wing_iot = AT&T, teltik = T-Mobile). It does NOT say where the SIM
// physically lives. An ATOMIC (AT&T) SIM can be hosted in either one of our
// Skyline gateways OR in a Teltik gateway. Physical host determines which
// GATEWAY-LEVEL operations are possible:
//
//   Skyline gateway -> AT+EGMR IMEI writes + AT-command SMS send. Has gateway_id/port.
//   Teltik gateway  -> inbound SMS (webhook) + port reset ONLY. No IMEI write,
//                      no AT-command SMS. gateway_id/port are null.
//
// Carrier-level operations (MDN swap, OTA via the carrier API, suspend/restore)
// are NOT gated here — they route on `vendor` and work regardless of host.
//
// Pure functions only, no IO — unit-tested directly (tests/gateway-host.test.mjs).
// =========================================================

export const SKYLINE = 'skyline';
export const TELTIK = 'teltik';

// Resolve a SIM's physical gateway host. The explicit sims.gateway_host column
// wins. For rows written before the column existed (or a corrupt value) fall
// back to a safe derivation: teltik-vendor SIMs have no physical port so they
// are Teltik-hosted; everything else is Skyline-hosted (today's assumption).
export function gatewayHostOf(sim) {
  const explicit = sim && sim.gateway_host;
  if (explicit === SKYLINE || explicit === TELTIK) return explicit;
  return sim && sim.vendor === 'teltik' ? TELTIK : SKYLINE;
}

export function isTeltikHosted(sim) {
  return gatewayHostOf(sim) === TELTIK;
}

export function isSkylineHosted(sim) {
  return gatewayHostOf(sim) === SKYLINE;
}

// Which GATEWAY-LEVEL operations each host physically supports.
const CAPABILITIES = {
  [SKYLINE]: { setImei: true,  skylineSms: true,  portReset: false },
  [TELTIK]:  { setImei: false, skylineSms: false, portReset: true  },
};

// True only when the SIM's host physically supports the named capability.
export function gatewaySupports(sim, capability) {
  const caps = CAPABILITIES[gatewayHostOf(sim)] || {};
  return caps[capability] === true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/gateway-host.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/gateway-host.mjs tests/gateway-host.test.mjs
git commit -m "feat: shared gateway-host resolver + capability matrix"
```

---

## Task 3: Tag new Teltik SIM inserts with `gateway_host='teltik'`

The migration backfills existing rows, but `teltik-worker` inserts new Teltik SIMs on the fly (e.g. when a webhook arrives for an unknown ICCID). Those inserts must set the column so the helper's fallback is never the only thing keeping them correct.

**Files:**
- Modify: `src/teltik-worker/index.js` (the SIM upsert near line 272, whose comment reads "gateway_id/port/slot/imei null — Teltik has no physical gateway")

- [ ] **Step 1: Locate the insert object**

Run: `grep -n "Teltik has no physical gateway" src/teltik-worker/index.js`
Read the surrounding upsert object (the `{ iccid, vendor: 'teltik', ... }` payload).

- [ ] **Step 2: Add `gateway_host: 'teltik'` to the insert payload**

In the insert/upsert object that sets `vendor: 'teltik'`, add the field alongside it:

```js
      vendor: 'teltik',
      gateway_host: 'teltik',
```

- [ ] **Step 3: Verify no other Teltik insert path is missed**

Run: `grep -n "vendor: 'teltik'\|vendor:\"teltik\"" src/teltik-worker/index.js`
Expected: confirm each insert (not read/query) payload includes `gateway_host: 'teltik'`. Rotation inserts into `sim_numbers` do not need it (that table has no host column).

- [ ] **Step 4: Commit**

```bash
git add src/teltik-worker/index.js
git commit -m "feat(teltik): tag new Teltik SIM inserts with gateway_host=teltik"
```

---

## Task 4: Skip IMEI + gateway scan in `fixAtomicSim` for Teltik-hosted SIMs

`fixAtomicSim` (in `mdn-rotator`) auto-discovers a Skyline gateway/port by scanning (`scanGatewaysForIccid`), then allocates an IMEI and pushes it via `callSkylineSetImei`. For a Teltik-hosted ATOMIC SIM the scan finds nothing (throws) and the IMEI write is impossible. Skip both; keep the ATOMIC carrier-side inquiry/restore.

**Files:**
- Modify: `src/mdn-rotator/index.js` — add import at top; guard `fixAtomicSim` (currently ~lines 3021–3073)

- [ ] **Step 1: Add the import**

At the top of `src/mdn-rotator/index.js`, after the existing shared imports (lines 1–3), add:

```js
import { isTeltikHosted, gatewaySupports } from '../shared/gateway-host.mjs';
```

- [ ] **Step 2: Guard the gateway auto-discovery block**

In `fixAtomicSim`, replace the auto-discovery block (currently at ~3037–3048):

```js
  // Auto-discover gateway/port if not set
  if (!sim.gateway_id || !sim.port) {
    console.log(`[FixAtomicSim] SIM ${iccid}: no gateway_id/port — scanning gateways...`);
    const found = await scanGatewaysForIccid(env, iccid);
    if (!found) throw new Error(`SIM ${iccid}: no gateway_id/port and ICCID not found on any gateway`);
    sim.gateway_id = found.gateway_id;
    sim.port = found.port;
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
      gateway_id: sim.gateway_id,
      port: sim.port,
    });
  }
```

with:

```js
  // Teltik-hosted ATOMIC SIMs have no Skyline gateway/port and cannot take an
  // AT+EGMR IMEI write. Skip the gateway scan + IMEI push entirely and do only
  // the carrier-side (ATOMIC) inquiry/restore below.
  const canSetImei = gatewaySupports(sim, 'setImei');

  // Auto-discover gateway/port if not set (Skyline-hosted only)
  if (canSetImei && (!sim.gateway_id || !sim.port)) {
    console.log(`[FixAtomicSim] SIM ${iccid}: no gateway_id/port — scanning gateways...`);
    const found = await scanGatewaysForIccid(env, iccid);
    if (!found) throw new Error(`SIM ${iccid}: no gateway_id/port and ICCID not found on any gateway`);
    sim.gateway_id = found.gateway_id;
    sim.port = found.port;
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
      gateway_id: sim.gateway_id,
      port: sim.port,
    });
  }
```

- [ ] **Step 3: Guard the IMEI allocate + gateway push block**

Replace the IMEI allocation + gateway push + pool-patch block (currently ~3052–3073, from `// Step 1: Retire old pool entries` through the `sims` patch that sets `imei`/`current_imei_pool_id`):

```js
  // Step 1: Retire old pool entries, allocate fresh IMEI
  await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);
  const poolEntry = await allocateImeiFromPool(env, simId);
  const newImei = poolEntry.imei;
  console.log(`[FixAtomicSim] SIM ${iccid}: allocated IMEI ${newImei} (pool entry ${poolEntry.id})`);

  try {
    // Set new IMEI on gateway
    await retryWithBackoff(
      () => callSkylineSetImei(env, sim.gateway_id, sim.port, newImei),
      { attempts: 3, label: `setImei ${iccid}` }
    );
    console.log(`[FixAtomicSim] SIM ${iccid}: IMEI set on gateway`);
    markGatewayImeiSynced(env, simId).catch(() => {});

    // Update pool entry with slot info and SIM record with new IMEI
    await supabasePatch(env, `imei_pool?id=eq.${encodeURIComponent(String(poolEntry.id))}`, {
      gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString(),
    });
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
      imei: newImei, current_imei_pool_id: poolEntry.id,
    });
```

with (note: `poolEntry`/`newImei` become `let` and stay null when skipped; the closing `try {` is preserved):

```js
  // Step 1: IMEI allocation + gateway push — Skyline-hosted only. Teltik-hosted
  // SIMs skip this; their IMEI is fixed by Teltik hardware and unwritable by us.
  let poolEntry = null;
  let newImei = sim.imei || null;

  try {
    if (canSetImei) {
      await retireAllPoolEntriesForSim(env, simId, sim.current_imei_pool_id);
      poolEntry = await allocateImeiFromPool(env, simId);
      newImei = poolEntry.imei;
      console.log(`[FixAtomicSim] SIM ${iccid}: allocated IMEI ${newImei} (pool entry ${poolEntry.id})`);

      // Set new IMEI on gateway
      await retryWithBackoff(
        () => callSkylineSetImei(env, sim.gateway_id, sim.port, newImei),
        { attempts: 3, label: `setImei ${iccid}` }
      );
      console.log(`[FixAtomicSim] SIM ${iccid}: IMEI set on gateway`);
      markGatewayImeiSynced(env, simId).catch(() => {});

      // Update pool entry with slot info and SIM record with new IMEI
      await supabasePatch(env, `imei_pool?id=eq.${encodeURIComponent(String(poolEntry.id))}`, {
        gateway_id: sim.gateway_id, port: sim.port, updated_at: new Date().toISOString(),
      });
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
        imei: newImei, current_imei_pool_id: poolEntry.id,
      });
    } else {
      console.log(`[FixAtomicSim] SIM ${iccid}: Teltik-hosted — skipping IMEI allocate + gateway push`);
    }
```

- [ ] **Step 4: Confirm the rest of the function tolerates a null `poolEntry`**

Read `fixAtomicSim` from the guarded block to its end. The ATOMIC inquiry/restore code that follows must not dereference `poolEntry` unconditionally. If it does (e.g. a rollback `releaseImeiPoolEntry(env, poolEntry.id, ...)`), wrap that call in `if (poolEntry)`. Apply the same `if (poolEntry)` guard the Helix `fixSim` uses at its catch block (see lines 2988–2999 for the exact pattern to copy).

- [ ] **Step 5: Lint / syntax check**

Run: `node --check src/mdn-rotator/index.js`
Expected: no output (valid syntax).

- [ ] **Step 6: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "fix(mdn-rotator): fixAtomicSim skips gateway IMEI steps for Teltik-hosted SIMs"
```

---

## Task 5: Guard the `/change-imei` endpoint for Teltik-hosted SIMs

The manual `/change-imei` endpoint (in `mdn-rotator`, IMEI push at ~line 557) sets an IMEI on the Skyline gateway. A Teltik-hosted SIM has no gateway to write to — return a clear error instead of throwing an opaque gateway failure.

**Files:**
- Modify: `src/mdn-rotator/index.js` — the `/change-imei` handler, before the IMEI eligibility/gateway-push block (~line 531–557). Uses the import added in Task 4.

- [ ] **Step 1: Find where the handler loads the SIM row**

Run: `grep -n "change-imei\|changeImei\|/change-imei" src/mdn-rotator/index.js | head`
Read upward from line 557 to find the variable holding the SIM row (it references `sim.gateway_id`, `sim.port`, `sim.vendor`, `sim.imei`, so a `sim` object is in scope).

- [ ] **Step 2: Add the guard right after the SIM row is loaded**

Immediately after the `sim` row is fetched (and before the `retireAllPoolEntriesForSim` / `callSkylineSetImei` work), insert:

```js
      // Teltik-hosted SIMs cannot take an IMEI write (no Skyline gateway/port).
      if (!gatewaySupports(sim, 'setImei')) {
        return new Response(JSON.stringify({
          ok: false,
          error: `SIM ${sim.iccid} is Teltik-hosted — IMEI writes are not supported (no Skyline gateway).`,
          gateway_host: 'teltik',
        }), { status: 409, headers: { "Content-Type": "application/json" } });
      }
```

Match the exact `sim` variable name and the response header style used by the surrounding handler (some handlers spread `corsHeaders`; copy whatever the neighbouring returns in this handler use).

- [ ] **Step 3: Syntax check**

Run: `node --check src/mdn-rotator/index.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "fix(mdn-rotator): /change-imei returns 409 for Teltik-hosted SIMs"
```

---

## Task 6: Guard retry-activation IMEI push for Teltik-hosted SIMs

The retry-activation path (`mdn-rotator`, ~line 4074) always scans for a gateway slot and pushes an IMEI before calling the vendor activation. For a Teltik-hosted ATOMIC SIM there is no slot; skip the gateway steps and go straight to the ATOMIC activation.

**Files:**
- Modify: `src/mdn-rotator/index.js` — retry-activation function (~lines 4038–4082). Uses the Task 4 import.

- [ ] **Step 1: Read the function boundaries**

Read `src/mdn-rotator/index.js` lines 4030–4095 to see the enclosing function signature and the `sim`, `gatewayId`, `port`, `poolEntry`, `imeiStrategy`, `vendor` variables.

- [ ] **Step 2: Guard the slot-scan + IMEI push**

Wrap the gateway slot discovery (the `if (!found) { ... }` / `else { gatewayId = ... }` block ending ~4054), the `supabasePatch(... { gateway_id, port })` at 4056, and the `callSkylineSetImei` try/catch (4072–4082) so they only run when `gatewaySupports(sim, 'setImei')` is true. Concretely, at the point just before the slot-scan begins, add:

```js
  const canSetImei = gatewaySupports(sim, 'setImei');
```

Then change the IMEI push block (4072–4082) to:

```js
  // Set IMEI on gateway — Skyline-hosted only.
  if (canSetImei) {
    try {
      await callSkylineSetImei(env, gatewayId, port, poolEntry.imei);
      console.log('[RetryActivation] SIM ' + sim.iccid + ': IMEI set on gateway');
    } catch (err) {
      console.error('[RetryActivation] SIM ' + sim.iccid + ': gateway set-IMEI failed: ' + err);
      await releaseImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});
      await supabasePatch(env, 'sims?id=eq.' + encodeURIComponent(String(simId)),
        { last_activation_error: 'Gateway error: ' + err.message });
      throw err;
    }
  } else {
    console.log('[RetryActivation] SIM ' + sim.iccid + ': Teltik-hosted — skipping gateway IMEI push');
  }
```

Also wrap the preceding slot-scan block and the `supabasePatch(... { gateway_id: gatewayId, port })` at 4056 in `if (canSetImei) { ... }` so a Teltik-hosted SIM never scans for or writes a Skyline slot.

- [ ] **Step 3: Syntax check**

Run: `node --check src/mdn-rotator/index.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "fix(mdn-rotator): retry-activation skips gateway IMEI push for Teltik-hosted SIMs"
```

---

## Task 7: Guard the dashboard manual IMEI push

The dashboard's manual IMEI-push handler (`src/dashboard/index.js`, ~line 3808) pushes an IMEI to `skyline-gateway`. Add a backend guard so a Teltik-hosted SIM cannot reach the Skyline push, and hide the control in the UI.

**Files:**
- Modify: `src/dashboard/index.js` (~line 3760–3808 handler)
- The frontend change goes through the `patch-dashboard` skill (frontend now lives in `src/dashboard/public/index.html`).

- [ ] **Step 1: Add the import**

At the top of `src/dashboard/index.js`, alongside the existing `import { isTeltikInvalidIccidResponse, iccidSwapPatch } from '../shared/teltik-iccid.mjs';` (line 5), add:

```js
import { gatewaySupports } from '../shared/gateway-host.mjs';
```

- [ ] **Step 2: Read the handler to find the SIM identifier in scope**

Read `src/dashboard/index.js` lines 3740–3815. Identify the field the handler receives that identifies the SIM (`iccid`, or `gateway_id`+`port`). It already fetches `dbRow` from `imei_pool`; you need the `sims` row's `gateway_host`/`vendor`.

- [ ] **Step 3: Add the guard before the Skyline push**

Immediately before the `if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET)` check (line 3808), fetch the SIM and guard:

```js
    // Block IMEI writes for Teltik-hosted SIMs (no Skyline gateway to write to).
    const hostRes = await supabaseGet(env, `sims?select=iccid,vendor,gateway_host&gateway_id=eq.${encodeURIComponent(String(gateway_id))}&port=eq.${encodeURIComponent(String(port))}&limit=1`);
    const hostRows = await hostRes.json().catch(() => []);
    const hostRow = Array.isArray(hostRows) && hostRows[0] ? hostRows[0] : null;
    if (hostRow && !gatewaySupports(hostRow, 'setImei')) {
      return new Response(JSON.stringify({
        error: `SIM ${hostRow.iccid} is Teltik-hosted — IMEI writes are not supported.`,
        gateway_host: hostRow.gateway_host,
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
```

Use the exact `supabaseGet` helper signature already used in this file (see line 5143 for the pattern). If the handler only has `iccid` in scope, query by `iccid=eq.` instead of `gateway_id`/`port`.

- [ ] **Step 4: Syntax check**

Run: `node --check src/dashboard/index.js`
Expected: no output.

- [ ] **Step 5: Hide the Set-IMEI control for Teltik-hosted SIMs (frontend)**

Invoke the `patch-dashboard` skill. In `src/dashboard/public/index.html`, where SIM rows render per-SIM action buttons, hide/disable the "Set IMEI" (and any gateway-only) control when the SIM's `gateway_host === 'teltik'`. Ensure the SIM list API includes `gateway_host` in its `select=` so the frontend has the field (grep the dashboard SIM-list query for the `sims?select=` and add `gateway_host` if absent).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/index.js src/dashboard/public/index.html
git commit -m "fix(dashboard): block + hide IMEI push for Teltik-hosted SIMs"
```

---

## Task 8: Make `bad-rental-remediator` capability-aware

The remediator can trigger Skyline-only heals (IMEI resync). For a Teltik-hosted SIM those must be no-ops that escalate to human review rather than attempting an impossible gateway write. Teltik-specific actions (reset-port, reset-network, sync-iccid) remain valid for Teltik-hosted SIMs.

**Files:**
- Modify: `src/bad-rental-remediator/actions.mjs`
- Test: `tests/bad-rental-remediator-actions.test.mjs` (existing)

- [ ] **Step 1: Read the action dispatcher**

Read `src/bad-rental-remediator/actions.mjs` around the `executeAction` switch (the agent inventory cites lines 94–101, 220–290). Identify any action that ends in a Skyline gateway IMEI write (the `mdn-rotator` fix path via `execAtomicRestore`/gateway sync).

- [ ] **Step 2: Add the import**

At the top of `src/bad-rental-remediator/actions.mjs`, add:

```js
import { gatewaySupports } from '../shared/gateway-host.mjs';
```

(Confirm the relative path — this file is at `src/bad-rental-remediator/`, so `../shared/gateway-host.mjs` is correct.)

- [ ] **Step 3: Guard any Skyline-IMEI action**

For each action whose executor performs a gateway IMEI write, add at the top of that executor:

```js
  if (!gatewaySupports(ctx.sim, 'setImei')) {
    return { ok: false, skipped: 'teltik_hosted', reason: 'Skyline IMEI write not applicable to Teltik-hosted SIM' };
  }
```

Match the executor's actual context variable name (`ctx.sim`, `ctx.row`, or similar — read the executor signature first). Ensure `ctx` carries `gateway_host`/`vendor`; if the SIM object passed to executors lacks `gateway_host`, add it to the `select=` in the remediator's SIM read (grep `bad-rental-remediator/index.js` for the `sims?select=` that feeds actions).

- [ ] **Step 4: Add a unit test**

In `tests/bad-rental-remediator-actions.test.mjs`, add a test asserting the Skyline-IMEI executor returns `{ ok: false, skipped: 'teltik_hosted' }` when given a `ctx.sim` of `{ gateway_host: 'teltik', vendor: 'atomic' }`. Follow the existing test's mocking style in that file.

- [ ] **Step 5: Run tests**

Run: `node --test tests/bad-rental-remediator-actions.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bad-rental-remediator/actions.mjs tests/bad-rental-remediator-actions.test.mjs
git commit -m "fix(remediator): skip Skyline-only heals for Teltik-hosted SIMs"
```

---

## Task 9: Build the `sim-capability-map` meta-skill

A skill that documents, for the whole system, every place a SIM-action lives and where a new cross-cutting gateway/capability distinction must be wired in — so future changes like this one are mechanical.

**Files:**
- Create: `.claude/skills/sim-capability-map/SKILL.md`

- [ ] **Step 1: Invoke the skill-creator skill**

Invoke `anthropic-skills:skill-creator` (or `superpowers:writing-skills`) to scaffold the skill with correct frontmatter and structure.

- [ ] **Step 2: Write `SKILL.md` with the action-site map**

Create `.claude/skills/sim-capability-map/SKILL.md` with frontmatter:

```markdown
---
name: sim-capability-map
description: Map of every SIM-action site across the incomingsms workers and where to wire a new cross-cutting gateway/carrier/capability distinction. Use when adding a system-wide SIM property (e.g. a new gateway host, a new vendor, a per-SIM capability flag) so no action site is missed. Triggers on "make every action aware of X", "add a SIM-level flag across the system", "new gateway type", "does the whole system handle Y".
---
```

Body must contain, at minimum:

1. **The two orthogonal axes** — `vendor` (carrier account: atomic/helix/wing_iot=AT&T, teltik=T-Mobile) vs `gateway_host` (physical host: skyline/teltik). Rule: route carrier ops on `vendor`, gateway ops on `gateway_host` via `src/shared/gateway-host.mjs`.
2. **The capability matrix** — point to `src/shared/gateway-host.mjs` as the single source of truth; explain adding a capability = one line in `CAPABILITIES` + a guard at each site.
3. **The action-site inventory** (copy the table below into the skill) — every operation, its file(s), and whether it is carrier-level or gateway-level:

| Operation | Level | File(s) | Guard on |
|-----------|-------|---------|----------|
| Set IMEI | gateway | `skyline-gateway/index.js`; `mdn-rotator/index.js` (fixAtomicSim, /change-imei, retry-activation, ImeiGatewaySync); `dashboard/index.js` (manual push ~3808) | `gatewaySupports(sim,'setImei')` |
| AT-command SMS send | gateway | `skyline-gateway/index.js`; `dashboard/index.js` (send-test-sms proxy) | `gatewaySupports(sim,'skylineSms')` |
| Port reset / reset-network | gateway (Teltik) | `dashboard/index.js` (ota_refresh ~5162); `bad-rental-remediator/vendor.mjs` | Teltik-hosted only |
| MDN change / swap | carrier | `mdn-rotator/index.js` (rotateSingleSim); `shared/{helix,atomic,wing-iot}.ts`; `teltik-worker/index.js` | `vendor` |
| OTA refresh | carrier | `shared/{helix,atomic}.ts`; `ota-status-sync/index.js`; `bad-rental-remediator/actions.mjs` | `vendor` |
| Suspend/restore/deactivate/reconnect | carrier | `shared/atomic.ts`; `sim-status-changer/index.js`; `sim-canceller/index.js` | `vendor` |
| ICCID heal | carrier (Teltik) | `shared/teltik-iccid.mjs`; `bad-rental-remediator/actions.mjs`; `rotation-playbook.mjs` | Teltik-vendor |
| Inbound SMS capture | gateway | `teltik-worker` webhook; `skyline-gateway` inbound | `gateway_host` (see Tier 2) |

4. **The checklist for adding a new cross-cutting distinction** — (a) add column + backfill migration; (b) extend `src/shared/gateway-host.mjs` (or a sibling helper); (c) add unit tests; (d) tag every insert path (`teltik-worker`, activation, import); (e) guard every gateway-level site in the table; (f) surface in dashboard `select=` + UI; (g) note the deploy set (`mdn-rotator`, `dashboard`, `teltik-worker`, `bad-rental-remediator`, `details-finalizer`).

- [ ] **Step 3: Verify the skill loads**

Confirm the skill appears in the available-skills list (its `description` should trigger on phrases like "new gateway type"). Sanity-check frontmatter parses (no tabs, valid YAML).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/sim-capability-map/
git commit -m "docs: sim-capability-map skill for wiring cross-cutting SIM distinctions"
```

---

## Task 10: Full-suite regression + deploy

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all existing tests plus `gateway-host.test.mjs` PASS. Investigate any failure before deploying.

- [ ] **Step 2: Deploy the touched workers**

Per [dashboard-deploy-and-dev-run](../../../home/zalmen/.claude/projects/-srv-projects-incomingsms/memory/dashboard-deploy-and-dev-run.md), deploy in this order (all share the same Supabase; the migration is already live from Task 1):

```bash
npx wrangler deploy --config src/mdn-rotator/wrangler.toml
npx wrangler deploy --config src/teltik-worker/wrangler.toml
npx wrangler deploy --config src/bad-rental-remediator/wrangler.toml
npx wrangler deploy --config src/dashboard/wrangler.toml
```

(Adjust to the repo's actual deploy command if different — confirm from an existing wrangler invocation.)

- [ ] **Step 3: Smoke-test with the live test line**

Confirm the ATOMIC-in-Teltik test line (MDN 7738091381, ICCID 89012804332468991579) is tagged `gateway_host='teltik'` (via `execute_sql`), and that a manual `/change-imei` against it returns the 409 guard rather than a gateway error.

---

## Self-Review

- **Spec coverage:** "every action differentiates Skyline vs Teltik host, skip unsupported steps" → Tasks 4–8 guard every live gateway-only site (IMEI in mdn-rotator ×3, dashboard ×1, remediator ×1); carrier ops untouched by design. "skill that knows where every step is implemented" → Task 9. Data model → Tasks 1–3. ✅
- **Deferred (Tier 2), stated explicitly:** inbound-SMS capture for ATOMIC-in-Teltik SIMs (the teltik-worker webhook currently filters `vendor=eq.teltik`, so an ATOMIC-in-Teltik ICCID's inbound SMS is dropped); the onboarding/tagging path that first inserts an ATOMIC-in-Teltik SIM and sets `gateway_host='teltik'`; and Teltik-aware dashboard "Query" health for these SIMs. These are the next plan.
- **Type consistency:** `gatewayHostOf`, `isTeltikHosted`, `isSkylineHosted`, `gatewaySupports(sim, capability)`, constants `SKYLINE`/`TELTIK` used identically across helper, tests, and all guards. Capability keys `'setImei'`/`'skylineSms'` match the matrix. ✅
- **Placeholder scan:** guards that depend on a still-to-be-read variable name (Tasks 5, 7, 8) each carry an explicit "read the handler / match the exact variable name" step rather than inventing one — these are verification steps, not implementation placeholders. All new modules (Tasks 1, 2, 9) are fully specified.

---

## Tier 2 — Follow-on plan (NOT in scope here)

Write a separate plan for these once the operator defines how ATOMIC-in-Teltik SIMs are onboarded:

1. **Inbound-SMS capture.** `teltik-worker`'s webhook and `rotate-sim` lookup filter `vendor=eq.teltik` (e.g. line 68). An ATOMIC-in-Teltik SIM (`vendor='atomic'`) receiving SMS through the Teltik webhook is not found → the SMS (and rental capture) is dropped. Decide whether the Teltik webhook keys on `gateway_host='teltik'` (any vendor) instead of `vendor='teltik'`, and how rental carrier bucketing (`att` vs `tmobile`) should read for these.
2. **Onboarding / tagging UI.** Define how an ATOMIC-in-Teltik SIM first enters `sims` (manual dashboard add, CSV import, or a Teltik reconcile that adopts unknown ICCIDs) and set `gateway_host='teltik'` there.
3. **Dashboard "Query" health.** For `gateway_host='teltik'` SIMs regardless of vendor, health should consult Teltik `port-status` + `get-info`-by-MDN (the ICCID reverse-lookup `get-phone-number?iccid=` returns "MSISDN Not Found" for these), not the Skyline/ATOMIC path.
