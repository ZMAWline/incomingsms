# Apex PPU-then-MDN Rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a mandatory `UpdateSubscriberInfo`-before-`swapMSISDN` step into every `atomic` and `helix` MDN change, with a ~1000-entry civic-address pool and LRU picker. Wire activation/retry-activation to the same picker. Roll out behind a feature flag with a per-SIM canary column.

**Architecture:** Static JS pool of civic addresses (≥ 20 ZIPs/state) → Supabase `address_pool_usage` table tracks last-used per address → `claim_address_pool_entry` RPC (`FOR UPDATE SKIP LOCKED`) picks LRU excluding current state/zip → `pickNextPpuAddress()` in `src/shared/address-picker.js` joins RPC result back to static pool → new shared helper `runApexMdnChange()` inserts `UpdateSubscriberInfo` between pre-inquiry and `swapMSISDN` for both ATOMIC and Helix paths.

**Tech Stack:** Cloudflare Workers, Supabase Postgres (with PostgREST + RPCs), ATOMIC API (`solutionsatt-atomic.telgoo5.com`), Helix API (`api.helixsolo.app`), Node's built-in test runner for picker unit tests.

**Spec:** `docs/superpowers/specs/2026-05-20-apex-ppu-then-mdn-design.md`

**Spec deviation:** The spec describes a "shared helper `runApexMdnChange()`" wrapping both vendors. In this plan, the apex flow is inlined into each existing rotation path (atomic at `~line 1797`, helix at `~line 2010`) rather than extracted into one function. Reason: ATOMIC and Helix use different auth, endpoints, and request shapes — a "shared" function would just be a dispatcher over two vendor-specific bodies. The spec's intent (the 4-step ordered workflow) is preserved verbatim in both inline blocks.

**Project conventions to follow:**
- All external API calls via `relayFetch(env, url, init)` — never bare `fetch()` (memory: `agent/constraints.md §11`).
- All API call logging via `logCarrierApiCall(env, {...})` at `src/mdn-rotator/index.js:3494`.
- Run `npm run check:db-constraints` before any deploy that touches DB writes (memory: `feedback_verify_db_constraints`).
- Migrations applied via `mcp__supabase__apply_migration` — there's no Supabase CLI auth (memory: BOOTSTRAP).
- Deploy: `cd src/<worker> && npx wrangler deploy --env=""` (prod) or `--env test` for staging.
- Commit messages: subject + blank + body + `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Phase 0 — Database Setup

### Task 0.1: Create `address_pool_usage` table and `claim_address_pool_entry` RPC

**Files:**
- Create (via `mcp__supabase__apply_migration`): migration named `address_pool_usage`

- [ ] **Step 1: Apply the migration**

Use `mcp__supabase__apply_migration` with `name: "address_pool_usage"` and the following SQL:

```sql
CREATE TABLE IF NOT EXISTS address_pool_usage (
  address_id    text PRIMARY KEY,
  state         text NOT NULL,
  zip_code      text NOT NULL,
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS address_pool_usage_lru
  ON address_pool_usage (last_used_at NULLS FIRST, address_id);

CREATE INDEX IF NOT EXISTS address_pool_usage_state
  ON address_pool_usage (state);

CREATE OR REPLACE FUNCTION claim_address_pool_entry(
  p_exclude_state text DEFAULT NULL,
  p_exclude_zip   text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  picked_id text;
BEGIN
  WITH candidate AS (
    SELECT address_id
      FROM address_pool_usage
     WHERE (p_exclude_state IS NULL OR state    <> p_exclude_state)
       AND (p_exclude_zip   IS NULL OR zip_code <> p_exclude_zip)
     ORDER BY last_used_at ASC NULLS FIRST, address_id
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE address_pool_usage u
     SET last_used_at = now(),
         use_count    = use_count + 1
    FROM candidate
   WHERE u.address_id = candidate.address_id
   RETURNING u.address_id INTO picked_id;
  RETURN picked_id;
END $$;

GRANT EXECUTE ON FUNCTION claim_address_pool_entry(text, text) TO service_role;
```

- [ ] **Step 2: Verify via MCP**

Use `mcp__supabase__execute_sql` with:
```sql
SELECT
  (SELECT count(*) FROM address_pool_usage)                                AS row_count,
  (SELECT count(*) FROM pg_proc WHERE proname='claim_address_pool_entry')  AS rpc_count;
```
Expected: `row_count = 0`, `rpc_count = 1`.

- [ ] **Step 3: Smoke-test the RPC with a fake row**

Use `mcp__supabase__execute_sql`:
```sql
INSERT INTO address_pool_usage (address_id, state, zip_code) VALUES
  ('test-ca-90012', 'CA', '90012'),
  ('test-ny-10118', 'NY', '10118');
SELECT claim_address_pool_entry(NULL, NULL) AS first_pick;
SELECT claim_address_pool_entry('CA', '90012') AS second_pick;
SELECT address_id, last_used_at, use_count FROM address_pool_usage ORDER BY last_used_at NULLS FIRST;
DELETE FROM address_pool_usage WHERE address_id LIKE 'test-%';
```
Expected: `first_pick` returns either id (oldest = both NULL), `second_pick` returns `'test-ny-10118'` (CA excluded), the listed rows show `use_count=1` for the picked entries.

- [ ] **Step 4: Commit (DB only; no code change yet)**

No git commit — migrations live in Supabase, not the repo. Record the migration name in the PR description.

---

### Task 0.2: Add `canary_apex_ppu` column to `sims`

- [ ] **Step 1: Apply migration**

Use `mcp__supabase__apply_migration` with `name: "sims_canary_apex_ppu"`:
```sql
ALTER TABLE sims
  ADD COLUMN IF NOT EXISTS canary_apex_ppu boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Verify**

Use `mcp__supabase__execute_sql`:
```sql
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='sims' AND column_name='canary_apex_ppu';
```
Expected: one row with `data_type='boolean'` and `column_default='false'`.

---

## Phase 1 — Address Pool & Picker

### Task 1.1: Define the address pool data shape and write a verifier

**Files:**
- Create: `scripts/verify-address-pool.mjs`

- [ ] **Step 1: Write the verifier**

Create `scripts/verify-address-pool.mjs`:
```js
import { ADDRESS_POOL } from '../src/shared/address-pool.js';

const REQUIRED_FIELDS = ['id', 'streetNumber', 'streetName', 'city', 'state', 'zipCode'];
const MIN_ZIPS_PER_STATE = 20;
const REQUIRED_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC'
];

const errors = [];
const idsSeen = new Set();
const stateZips = new Map();

for (const [i, e] of ADDRESS_POOL.entries()) {
  for (const f of REQUIRED_FIELDS) {
    if (!e[f] || typeof e[f] !== 'string') {
      errors.push(`entry[${i}] missing/non-string field "${f}": ${JSON.stringify(e)}`);
    }
  }
  if (idsSeen.has(e.id)) errors.push(`duplicate id: ${e.id}`);
  idsSeen.add(e.id);
  if (!/^[A-Z]{2}$/.test(e.state)) errors.push(`bad state for id=${e.id}: ${e.state}`);
  if (!/^\d{5}$/.test(e.zipCode)) errors.push(`bad zip for id=${e.id}: ${e.zipCode}`);

  const key = e.state;
  if (!stateZips.has(key)) stateZips.set(key, new Set());
  if (stateZips.get(key).has(e.zipCode)) {
    errors.push(`duplicate zip ${e.zipCode} within state ${e.state} (id=${e.id})`);
  }
  stateZips.get(key).add(e.zipCode);
}

for (const st of REQUIRED_STATES) {
  const count = stateZips.get(st)?.size ?? 0;
  if (count < MIN_ZIPS_PER_STATE) {
    errors.push(`state ${st} has only ${count} unique zips (need ${MIN_ZIPS_PER_STATE})`);
  }
}

if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} issue(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`OK: ${ADDRESS_POOL.length} entries, ${stateZips.size} states, all checks passed.`);
```

- [ ] **Step 2: Run against the existing (small) pool to confirm it fails loudly**

Run: `node scripts/verify-address-pool.mjs`
Expected: FAIL — current pool has 25 entries, one per state, well below the 20-per-state minimum.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-address-pool.mjs
git commit -m "scripts: add address-pool verifier (≥20 zips/state, no dup ids/zips)"
```

---

### Task 1.2: Expand the address pool to ≥ 20 ZIPs per state (~1000 civic addresses)

**Files:**
- Modify: `src/shared/address-pool.js` (rewrite)

This is a data-collection task. Process per state:
1. Look up 20+ ZIP codes within the state that lie in *different rate centers*. Rate-center boundaries roughly track NPA-NXX prefixes; in practice picking one ZIP per major city/town in the state is sufficient — small towns each get their own rate center.
2. For each chosen ZIP, find a real **civic address** (post office, library, courthouse, city hall, public school). USPS Post Office Locator (`tools.usps.com/find-location.htm`) gives an exact street address per ZIP.
3. Add an entry to `ADDRESS_POOL` with a stable id slug `<state-lower>-<zip>-<street-slug>`.

- [ ] **Step 1: Rewrite `src/shared/address-pool.js`**

The file structure:
```js
// Address pool used for ATOMIC/Helix PPU updates and activations.
// Each entry MUST be a real civic address (post office, library, courthouse,
// city hall, public school) in the listed ZIP. No residential addresses.
//
// Adding an entry: pick a ZIP in a rate center not already represented for
// that state, find a public-building street address via USPS Post Office
// Locator (tools.usps.com/find-location.htm), and append below. The verifier
// at scripts/verify-address-pool.mjs enforces ≥20 unique zips per state.

export const ADDRESS_POOL = [
  // ----- AL -----
  { id: 'al-35203-1701-4th-ave-n',     streetNumber: '1701', streetName: '4th Ave N',     streetDirection: '', city: 'Birmingham',  state: 'AL', zipCode: '35203' },
  { id: 'al-36104-600-dexter-ave',     streetNumber: '600',  streetName: 'Dexter Ave',    streetDirection: '', city: 'Montgomery',  state: 'AL', zipCode: '36104' },
  // ... 18 more AL entries
  // ----- AK -----
  { id: 'ak-99501-344-w-3rd-ave',      streetNumber: '344',  streetName: 'W 3rd Ave',     streetDirection: '', city: 'Anchorage',   state: 'AK', zipCode: '99501' },
  // ... etc through DC
];

// Kept for backward compatibility — delegate to LRU picker via address-picker.js
// Do NOT use for new code. Imports of pickRandomAddress should be migrated.
export function pickRandomAddress() {
  return ADDRESS_POOL[Math.floor(Math.random() * ADDRESS_POOL.length)];
}
```

Bulk-fill the entries per the rules above. Aim for ~22 per state to give the verifier headroom.

- [ ] **Step 2: Run verifier**

Run: `node scripts/verify-address-pool.mjs`
Expected: `OK: ~1100 entries, 51 states, all checks passed.`

- [ ] **Step 3: Syntax check the module**

Run: `node --input-type=module --check < src/shared/address-pool.js`
Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add src/shared/address-pool.js
git commit -m "shared: expand address pool to ≥20 civic addresses per US state + DC

Replaces the 25-entry pool (one per state) with ~1100 entries (~22 per
state + DC), each a real civic address (post office, library, courthouse,
or city hall). Each entry has a stable id slug.

Backward-compat pickRandomAddress() retained but should be considered
deprecated; new code should use pickNextPpuAddress() from address-picker."
```

---

### Task 1.3: Build the LRU picker module

**Files:**
- Create: `src/shared/address-picker.js`
- Create: `tests/address-picker.test.mjs`

- [ ] **Step 1: Write the picker**

Create `src/shared/address-picker.js`:
```js
import { ADDRESS_POOL } from './address-pool.js';

export const APEX_VENDORS = ['atomic', 'helix'];
export function isApexVendor(vendor) {
  return APEX_VENDORS.includes(vendor);
}

// Build an in-memory id → entry index once per worker invocation.
let _byId = null;
function indexById() {
  if (_byId) return _byId;
  _byId = new Map();
  for (const e of ADDRESS_POOL) _byId.set(e.id, e);
  return _byId;
}

// Pick the least-recently-used PPU address from the pool, excluding any
// entry whose state matches excludeState OR whose zipCode matches excludeZip.
// Returns the full address record. Throws if pool exhausted.
export async function pickNextPpuAddress(env, opts = {}) {
  const excludeState = opts.excludeState ?? null;
  const excludeZip   = opts.excludeZip ?? null;

  const url = `${env.SUPABASE_URL}/rest/v1/rpc/claim_address_pool_entry`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:        env.SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    },
    body: JSON.stringify({ p_exclude_state: excludeState, p_exclude_zip: excludeZip }),
  });
  if (!res.ok) {
    throw new Error(`pickNextPpuAddress: RPC HTTP ${res.status}: ${await res.text()}`);
  }
  const addressId = await res.json();
  if (!addressId || typeof addressId !== 'string') {
    throw new Error(`pickNextPpuAddress: pool exhausted (excludeState=${excludeState} excludeZip=${excludeZip})`);
  }
  const entry = indexById().get(addressId);
  if (!entry) {
    throw new Error(`pickNextPpuAddress: address_id ${addressId} in DB but not in static pool`);
  }
  return entry;
}

// Idempotent seeder. Called once after deploying the static pool change.
// Upserts every static entry into address_pool_usage (last_used_at left NULL
// for new entries, preserved for existing ones).
export async function seedAddressPoolUsage(env) {
  const rows = ADDRESS_POOL.map(e => ({
    address_id: e.id,
    state:      e.state,
    zip_code:   e.zipCode,
  }));
  const url = `${env.SUPABASE_URL}/rest/v1/address_pool_usage?on_conflict=address_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      apikey:           env.SUPABASE_SERVICE_ROLE,
      Authorization:    `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
      Prefer:           'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`seedAddressPoolUsage HTTP ${res.status}: ${await res.text()}`);
  return rows.length;
}
```

Note: this module does NOT use `relayFetch` because (per memory `BOOTSTRAP.md`) Supabase calls are explicitly exempt from the relay rule.

- [ ] **Step 2: Write the unit test**

Create `tests/address-picker.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX_VENDORS, isApexVendor, pickNextPpuAddress } from '../src/shared/address-picker.js';
import { ADDRESS_POOL } from '../src/shared/address-pool.js';

test('APEX_VENDORS contains atomic and helix', () => {
  assert.deepEqual([...APEX_VENDORS].sort(), ['atomic', 'helix']);
});

test('isApexVendor returns true only for apex vendors', () => {
  assert.equal(isApexVendor('atomic'), true);
  assert.equal(isApexVendor('helix'),  true);
  assert.equal(isApexVendor('teltik'), false);
  assert.equal(isApexVendor('wing_iot'), false);
  assert.equal(isApexVendor(undefined), false);
});

test('pickNextPpuAddress returns full address record on RPC hit', async () => {
  const sample = ADDRESS_POOL[0];
  const fakeEnv = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE: 'fake',
  };
  globalThis.fetch = async () => new Response(JSON.stringify(sample.id), { status: 200 });
  const got = await pickNextPpuAddress(fakeEnv, {});
  assert.equal(got.id, sample.id);
  assert.equal(got.zipCode, sample.zipCode);
});

test('pickNextPpuAddress throws on pool exhausted (RPC returns null)', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE: 'fake' };
  globalThis.fetch = async () => new Response('null', { status: 200 });
  await assert.rejects(
    () => pickNextPpuAddress(fakeEnv, { excludeState: 'CA', excludeZip: '90012' }),
    /pool exhausted/i
  );
});

test('pickNextPpuAddress throws on RPC error', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE: 'fake' };
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  await assert.rejects(() => pickNextPpuAddress(fakeEnv, {}), /HTTP 500/);
});

test('pickNextPpuAddress throws if DB returns id not in static pool', async () => {
  const fakeEnv = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE: 'fake' };
  globalThis.fetch = async () => new Response(JSON.stringify('does-not-exist-id'), { status: 200 });
  await assert.rejects(() => pickNextPpuAddress(fakeEnv, {}), /not in static pool/);
});
```

- [ ] **Step 3: Run the tests**

Run: `node --test tests/address-picker.test.mjs`
Expected: `# pass 5  # fail 0`.

- [ ] **Step 4: Syntax check the picker module**

Run: `node --input-type=module --check < src/shared/address-picker.js`
Expected: no output (success).

- [ ] **Step 5: Commit**

```bash
git add src/shared/address-picker.js tests/address-picker.test.mjs
git commit -m "shared: add pickNextPpuAddress LRU picker for apex PPU updates

Picks the least-recently-used address from the pool, excluding the
SIM's current state+zip, via the claim_address_pool_entry RPC (uses
FOR UPDATE SKIP LOCKED for concurrency safety). Includes APEX_VENDORS
constant and seedAddressPoolUsage helper."
```

---

### Task 1.4: Build the one-time seed script

**Files:**
- Create: `scripts/seed-address-pool.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/seed-address-pool.mjs`:
```js
import { seedAddressPoolUsage } from '../src/shared/address-picker.js';

const env = {
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE: process.env.SUPABASE_SERVICE_ROLE,
};
if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE env vars before running.');
  process.exit(1);
}

const n = await seedAddressPoolUsage(env);
console.log(`Seeded/upserted ${n} address_pool_usage rows.`);
```

- [ ] **Step 2: Dry-run via MCP to inspect pre-state**

Use `mcp__supabase__execute_sql`:
```sql
SELECT count(*) AS before_count FROM address_pool_usage;
```
Record the result.

- [ ] **Step 3: Run the seed**

Run with the project's Supabase env loaded (the user runs this — direct env is needed):
```bash
SUPABASE_URL="<value>" SUPABASE_SERVICE_ROLE="<value>" node scripts/seed-address-pool.mjs
```
Expected: `Seeded/upserted ~1100 address_pool_usage rows.`

- [ ] **Step 4: Verify post-state**

Use `mcp__supabase__execute_sql`:
```sql
SELECT count(*) AS row_count,
       count(DISTINCT state) AS states,
       count(*) FILTER (WHERE last_used_at IS NULL) AS unused
  FROM address_pool_usage;
```
Expected: `row_count = pool size`, `states = 51`, `unused = pool size`.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-address-pool.mjs
git commit -m "scripts: add one-time seeder for address_pool_usage"
```

---

## Phase 2 — Apex MDN-change helper (atomic path, behind flag)

### Task 2.1: Add `atomicUpdateSubscriberInfo` helper to the rotator

**Files:**
- Modify: `src/mdn-rotator/index.js` (add new function near other atomic helpers, ~line 1797)

- [ ] **Step 1: Add the helper function**

Find a stable insertion point above `runAtomicRotation` (currently the first `async function runAtomic...` near line 1797). Add the helper:

```js
// Issues ATOMIC UpdateSubscriberInfo. Throws on non-'00' statusCode or
// network error. Returns the parsed response on success.
async function atomicUpdateSubscriberInfo(env, { session, msisdn, address }, runId, iccid) {
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const body = {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'UpdateSubscriberInfo',
        MSISDN:    msisdn,
        firstName: 'EZ',
        lastName:  'Biz',
        address: {
          streetNumber:    address.streetNumber,
          streetName:      address.streetName,
          streetDirection: address.streetDirection || '',
          zipCode:         address.zipCode,
        },
      },
    },
  };
  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  const r = json?.wholeSaleApi?.wholeSaleResponse;
  await logCarrierApiCall(env, {
    run_id: runId, step: 'ppu_update', iccid, imei: null, vendor: 'atomic',
    request_url: url, request_method: 'POST', request_body: body,
    response_status: res.status, response_ok: res.ok,
    response_body_text: text, response_body_json: json,
    error: (res.ok && r?.statusCode === '00') ? null
         : `ATOMIC UpdateSubscriberInfo failed: ${r?.description || res.status}`,
  });
  if (!res.ok || r?.statusCode !== '00') {
    throw new Error(`ATOMIC UpdateSubscriberInfo failed: ${r?.description || res.status}`);
  }
  return r;
}
```

- [ ] **Step 2: Syntax check the rotator**

Run: `node --input-type=module --check < src/mdn-rotator/index.js`
Expected: no output (success).

- [ ] **Step 3: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "rotator: add atomicUpdateSubscriberInfo helper (no caller yet)"
```

---

### Task 2.2: Refactor `runAtomicRotation` to use the apex flow behind a flag

**Files:**
- Modify: `src/mdn-rotator/index.js:1797-1870` (atomic rotation body)
- Modify: `src/mdn-rotator/wrangler.toml` (add new env var)

- [ ] **Step 1: Add the import**

At top of `src/mdn-rotator/index.js` (currently `import { pickRandomAddress } from '../shared/address-pool.js';` is on line 2), change to:
```js
import { pickRandomAddress } from '../shared/address-pool.js';
import { pickNextPpuAddress } from '../shared/address-picker.js';
```

- [ ] **Step 2: Patch the atomic rotation body**

In `runAtomicRotation` (the function starting around line 1797), locate the block between the pre-inquiry success check and the swapMSISDN call (between current lines ~1853 and ~1865). Replace the existing zip-extraction and swap-body construction:

**OLD (~lines 1855-1869):**
```js
const zipCode = preInqR.Result?.address?.zipCode || sim.activation_zip || env.HX_ZIP || '11238';

// Sync zip to DB if AT&T has a different value
if (preInqR.Result?.address?.zipCode && preInqR.Result.address.zipCode !== sim.activation_zip) {
  await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
    activation_zip: preInqR.Result.address.zipCode,
  }).catch(() => {});
  console.log(`SIM ${iccid}: updated activation_zip ${sim.activation_zip} → ${preInqR.Result.address.zipCode}`);
}

// 2) swapMSISDN
const swapBody = {
  wholeSaleApi: {
    session,
    wholeSaleRequest: { requestType: 'swapMSISDN', MSISDN: currentMsisdn, zipCode },
  },
};
```

**NEW:**
```js
const currentZip   = preInqR.Result?.address?.zipCode || sim.activation_zip || null;
const currentState = preInqR.Result?.address?.state || null;

// Sync zip to DB if AT&T has a different value (unchanged)
if (preInqR.Result?.address?.zipCode && preInqR.Result.address.zipCode !== sim.activation_zip) {
  await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
    activation_zip: preInqR.Result.address.zipCode,
  }).catch(() => {});
  console.log(`SIM ${iccid}: updated activation_zip ${sim.activation_zip} → ${preInqR.Result.address.zipCode}`);
}

// Apex flow: pick a new PPU address (different state + zip) and update
// AT&T's PPU before swapMSISDN. Per ATOMIC API Rule #5 (2026-05-20), swap
// will be rejected if zipCode doesn't match the subscriber's current PPU.
// Gated by env flag + per-SIM canary column during rollout.
const apexEnabled = String(env.APEX_PPU_THEN_MDN_ENABLED || '').toLowerCase() === 'true';
const canaryOnly  = String(env.APEX_PPU_CANARY_ONLY || 'true').toLowerCase() === 'true';
const useApexFlow = apexEnabled && (!canaryOnly || sim.canary_apex_ppu === true);

let zipCode;
if (useApexFlow) {
  const newAddr = await pickNextPpuAddress(env, {
    excludeState: currentState,
    excludeZip:   currentZip,
  });
  console.log(`SIM ${iccid}: apex flow — picked PPU ${newAddr.id} (${newAddr.state} ${newAddr.zipCode})`);
  await atomicUpdateSubscriberInfo(env, {
    session, msisdn: currentMsisdn, address: newAddr,
  }, runId, iccid);
  zipCode = newAddr.zipCode;
  await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
    activation_zip: newAddr.zipCode,
  }).catch(() => {});
} else {
  zipCode = currentZip || env.HX_ZIP || '11238';
}

// 2) swapMSISDN
const swapBody = {
  wholeSaleApi: {
    session,
    wholeSaleRequest: { requestType: 'swapMSISDN', MSISDN: currentMsisdn, zipCode },
  },
};
```

Also: the `sims?select=...` query that loads the SIM into `sim` near line 1417/1498 must include `canary_apex_ppu`. Locate the two select strings that list `sims?select=id,iccid,mobility_subscription_id,msisdn,vendor,...` and append `,canary_apex_ppu` to each.

- [ ] **Step 3: Update wrangler.toml to declare the env vars (optional but cleaner)**

Wrangler picks env vars up at runtime regardless, but if `wrangler.toml` has a `[vars]` block, document them there:
```toml
[vars]
# existing vars...
APEX_PPU_THEN_MDN_ENABLED = "false"
APEX_PPU_CANARY_ONLY      = "true"
```

If `wrangler.toml` has no `[vars]` block for env-toggleable values, skip this step — the user will set the var via `wrangler secret put` or `wrangler.toml [env.test.vars]` per deploy preference.

- [ ] **Step 4: Syntax check**

Run: `node --input-type=module --check < src/mdn-rotator/index.js`
Expected: no output.

- [ ] **Step 5: Run the project DB-constraints check**

Run: `npm run check:db-constraints`
Expected: passes (this guards against schema/code drift per memory `feedback_verify_db_constraints`).

- [ ] **Step 6: Run the relay check**

Run: `node _check_relay.js`
Expected: no violations. The new code uses `relayFetch` for ATOMIC and direct fetch for Supabase (which is exempt).

- [ ] **Step 7: Commit**

```bash
git add src/mdn-rotator/index.js src/mdn-rotator/wrangler.toml
git commit -m "rotator: insert apex PPU update before swapMSISDN (flag-gated)

When APEX_PPU_THEN_MDN_ENABLED=true AND the sim has canary_apex_ppu=true
(or APEX_PPU_CANARY_ONLY=false), rotation now:
  pre_swap_inquiry → pickNextPpuAddress(excludeState, excludeZip)
                   → UpdateSubscriberInfo
                   → swapMSISDN (with the picked zip, not the old one)
Per ATOMIC API rev 2026-05-20 Rule #5: swap is rejected if zipCode does
not match current PPU. Legacy path preserved when flag is off."
```

---

### Task 2.3: Deploy with flag OFF and verify legacy path still works

- [ ] **Step 1: Confirm flag default**

Inspect wrangler.toml (or the deploy command) to confirm `APEX_PPU_THEN_MDN_ENABLED` is not set OR is `"false"`.

- [ ] **Step 2: Deploy**

Run:
```bash
cd src/mdn-rotator && npx wrangler deploy --env=""
```
Expected: deploy succeeds with no errors.

- [ ] **Step 3: Wait one rotation cycle (20 min cron tick) and verify**

Use `mcp__supabase__execute_sql`:
```sql
SELECT count(*) AS rotated_last_hour
  FROM carrier_api_logs
 WHERE vendor='atomic'
   AND step='mdn_change'
   AND created_at > now() - interval '1 hour'
   AND error IS NULL;
SELECT count(*) AS ppu_updates_last_hour
  FROM carrier_api_logs
 WHERE step='ppu_update'
   AND created_at > now() - interval '1 hour';
```
Expected: `rotated_last_hour > 0` (legacy path still works); `ppu_updates_last_hour = 0` (apex flow is off).

---

### Task 2.4: Enable canary on one atomic SIM and verify

- [ ] **Step 1: Pick a canary SIM**

Use `mcp__supabase__execute_sql` to find an active atomic SIM with an active reseller:
```sql
SELECT s.id, s.iccid, s.msisdn, s.activation_zip
  FROM sims s
  JOIN reseller_sims rs ON rs.sim_id = s.id AND rs.active = true
 WHERE s.vendor = 'atomic' AND s.status = 'active'
 ORDER BY s.last_mdn_rotated_at NULLS FIRST
 LIMIT 5;
```
Pick one with the oldest `last_mdn_rotated_at`. Record its `iccid` and current `activation_zip` for the verification step.

- [ ] **Step 2: Flip the SIM's canary column to true**

```sql
UPDATE sims SET canary_apex_ppu = true WHERE iccid = '<canary-iccid>';
```

- [ ] **Step 3: Enable the env flag**

Run:
```bash
printf "true" | npx wrangler secret put APEX_PPU_THEN_MDN_ENABLED --env=""
# (or update wrangler.toml [vars] and redeploy)
cd src/mdn-rotator && npx wrangler deploy --env=""
```

- [ ] **Step 4: Force a rotation on the canary**

The rotator exposes a manual rotation endpoint. From the dashboard, or via direct service call, trigger rotation for the canary SIM (use the existing "Rotate now" UI or call the worker's `/rotate-sim` endpoint with `force=true`).

- [ ] **Step 5: Verify the 4-step audit trail**

```sql
SELECT run_id, step, response_ok, error, created_at
  FROM carrier_api_logs
 WHERE iccid = '<canary-iccid>'
   AND created_at > now() - interval '10 minutes'
 ORDER BY created_at;
```
Expected (in order): `pre_swap_inquiry → ppu_update → mdn_change → subscriber_inquiry` (or `subscriber_inquiry` only if the swap response carried the new MDN inline). All `error IS NULL`.

- [ ] **Step 6: Verify the SIM picked a different state/zip**

```sql
SELECT activation_zip FROM sims WHERE iccid = '<canary-iccid>';
SELECT address_id, state, zip_code, last_used_at, use_count
  FROM address_pool_usage
 ORDER BY last_used_at DESC NULLS LAST
 LIMIT 5;
```
Expected: `activation_zip` is now the picked zip (different from the recorded pre-rotation value); the picked address shows `use_count = 1` and a fresh `last_used_at`.

- [ ] **Step 7: Repeat rotation 2 more times on the same canary**

Force rotation twice more (with appropriate delay between, or via the dashboard "Rotate now" with bypass-interval). Verify each rotation picks a new state and the `address_pool_usage.last_used_at` ordering advances.

---

## Phase 3 — Activation & retry-activation use the picker

### Task 3.1: Replace `pickRandomAddress` at activation site

**Files:**
- Modify: `src/mdn-rotator/index.js:3303` (and surrounding activate function)

- [ ] **Step 1: Locate the activate function**

The current activation reference is at line 3303 (`pickRandomAddress`) inside an `atomicActivate`-style helper. Read 30 lines around line 3303 to confirm context before editing.

- [ ] **Step 2: Replace the call**

Change:
```js
const addr = pickRandomAddress();
```
to:
```js
const addr = await pickNextPpuAddress(env, {});
```

- [ ] **Step 3: Verify the surrounding function is `async`**

If the function containing the change is not declared `async`, it must be. Look at the function signature on the lines above; if not async, change `function foo(...)` to `async function foo(...)`. (It almost certainly already is — it issues `await relayFetch` in the same body.)

- [ ] **Step 4: Syntax check**

Run: `node --input-type=module --check < src/mdn-rotator/index.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "rotator: use LRU picker (not random) at atomic activation

Activations now contribute to the address rotation pool so they don't
concentrate on the same 25 addresses."
```

---

### Task 3.2: Replace `pickRandomAddress` at retry-activation site

**Files:**
- Modify: `src/mdn-rotator/index.js:3358`

- [ ] **Step 1: Repeat the swap at the second site**

Change:
```js
const addr = pickRandomAddress();
```
to:
```js
const addr = await pickNextPpuAddress(env, {});
```
Confirm the enclosing function is async.

- [ ] **Step 2: Syntax check**

Run: `node --input-type=module --check < src/mdn-rotator/index.js`

- [ ] **Step 3: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "rotator: use LRU picker at atomic retry-activation"
```

---

### Task 3.3: Deploy and verify activation path

- [ ] **Step 1: Deploy**

```bash
cd src/mdn-rotator && npx wrangler deploy --env=""
```

- [ ] **Step 2: Observe next real activation (or trigger one)**

Wait for any natural new-SIM activation or use the bulk-activator to push one through. After the activation:

```sql
SELECT address_id, state, zip_code, last_used_at, use_count
  FROM address_pool_usage
 WHERE last_used_at > now() - interval '15 minutes'
 ORDER BY last_used_at DESC;
SELECT iccid, activation_zip, status, activated_at
  FROM sims
 WHERE activated_at > now() - interval '15 minutes';
```
Expected: a row in `address_pool_usage` was bumped; the newly-activated SIM's `activation_zip` matches one of the picked addresses' `zip_code`.

---

## Phase 4 — Helix support

### Task 4.1: Add `hxUpdateSubscriberDetails` helper

**Files:**
- Modify: `src/shared/helix.ts` (add new exported function)
- Modify: `src/mdn-rotator/index.js` (re-export or import the new helper if needed)

- [ ] **Step 1: Append the helper to `src/shared/helix.ts`**

Per the helix-api reference (4.4):
- Endpoint: `PATCH ${HX_API_BASE}/api/mobility-subscriber/details`
- Body: array of `{ subscriberNumber, firstName, lastName, address: { address1, address2, city, state, zipCode }, streetName, streetType, streetNumber }`

Match the existing helpers' style in `src/shared/helix.ts` — they use `env.HX_API_BASE`, accept the bearer token as a parameter, and log via the file-local `logHelixApiCall` helper (defined ~line 240 of the same file). Append after the existing `hxOtaRefresh`/`hxChangeSubscriberStatus` functions:

```ts
export async function hxUpdateSubscriberDetails(
  env: Env,
  token: string,
  data: {
    subscriberNumber: string;
    firstName: string;
    lastName: string;
    streetNumber: string;
    streetName: string;     // full street name including type, e.g. "Maple Ave"
    streetType: string;     // e.g. "Ave", "St", "Blvd"
    city: string;
    state: string;
    zipCode: string;
  },
  runId: string,
  iccid: string,
): Promise<any> {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/details`;
  const method = 'PATCH';
  const requestBody = [{
    subscriberNumber: data.subscriberNumber,
    firstName:        data.firstName,
    lastName:         data.lastName,
    address: {
      address1: `${data.streetNumber} ${data.streetName}`,
      address2: '',
      city:     data.city,
      state:    data.state,
      zipCode:  data.zipCode,
    },
    streetName:   data.streetName,
    streetType:   data.streetType,
    streetNumber: data.streetNumber,
  }];
  const res = await relayFetch(env, url, {
    method,
    headers: {
      'Content-Type':  'application/json',
      Authorization:   `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });
  const responseText = await res.text();
  let json: any = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: 'ppu_update',
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `Update subscriber details failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`Update subscriber details failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}
```

`logHelixApiCall` already accepts `step: string` — the new `'ppu_update'` value is compatible since the underlying `carrier_api_logs` table doesn't constrain `step`. No type/schema change required.

- [ ] **Step 2: Wire helper inputs in the rotator**

To call `hxUpdateSubscriberDetails`, the rotator needs to derive `streetType` from `streetName`. Add a tiny helper near the top of the file (or in `src/shared/utils.ts`):
```js
function splitStreetSuffix(streetName) {
  const tokens = streetName.trim().split(/\s+/);
  if (tokens.length < 2) return { name: streetName, type: '' };
  const type = tokens[tokens.length - 1];
  const name = tokens.slice(0, -1).join(' ');
  return { name, type };
}
```

- [ ] **Step 3: Syntax check**

Run:
```bash
node --input-type=module --check < src/mdn-rotator/index.js
npx tsc --noEmit src/shared/helix.ts  # if ts is configured for stand-alone check
```
For the helix.ts check, you may instead rely on the worker bundle step succeeding at deploy. If `tsc --noEmit` is not configured, skip and rely on deploy.

- [ ] **Step 4: Commit**

```bash
git add src/shared/helix.ts src/mdn-rotator/index.js
git commit -m "shared/helix: add hxUpdateSubscriberDetails (4.4) helper

Wraps Helix's PATCH /api/mobility-subscriber/details for use before
hxMdnChange. Logs to carrier_api_logs with step='ppu_update' to match
the ATOMIC audit trail."
```

---

### Task 4.2: Insert PPU update step into the helix rotation

**Files:**
- Modify: `src/mdn-rotator/index.js:~2028` (the `// 1) MDN change` block in the helix rotation, function continues from line 2010)

- [ ] **Step 1: Read the helix rotation function (lines ~2005-2106)**

Confirm exact structure: pre-flight, `claimRotationSlot`, then `hxMdnChange`.

- [ ] **Step 2: Insert the PPU step before `hxMdnChange`**

After `const runId = ...` (around line 2026) and before `let mdnChange; try { mdnChange = await hxMdnChange(...)` (around line 2030), insert:

```js
// Apex flow (helix): pick a new PPU address and call 4.4 before 4.16.
// Even though the rejection per ATOMIC Rule #5 is documented for the ATOMIC
// endpoint, the same AT&T-side requirement governs all APEX-backed lines.
const apexEnabled = String(env.APEX_PPU_THEN_MDN_ENABLED || '').toLowerCase() === 'true';
const canaryOnly  = String(env.APEX_PPU_CANARY_ONLY || 'true').toLowerCase() === 'true';
const useApexFlow = apexEnabled && (!canaryOnly || sim.canary_apex_ppu === true);

if (useApexFlow) {
  // Need current state/zip to exclude — pull from hxSubscriberDetails first.
  const preDetails = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const preD = Array.isArray(preDetails) ? preDetails[0] : null;
  const curState = preD?.address?.state || null;
  const curZip   = preD?.address?.zipCode || sim.activation_zip || null;
  const subscriberNumber = preD?.phoneNumber || sim.msisdn;
  if (!subscriberNumber) {
    throw new Error(`SIM ${iccid}: cannot run apex PPU update — no subscriberNumber`);
  }

  const newAddr = await pickNextPpuAddress(env, { excludeState: curState, excludeZip: curZip });
  const { name: streetNameOnly, type: streetType } = splitStreetSuffix(newAddr.streetName);
  console.log(`SIM ${iccid}: helix apex flow — picked PPU ${newAddr.id} (${newAddr.state} ${newAddr.zipCode})`);

  await hxUpdateSubscriberDetails(env, token, {
    subscriberNumber,
    firstName:    'EZ',
    lastName:     'Biz',
    streetNumber: newAddr.streetNumber,
    streetName:   newAddr.streetName,   // full e.g. "Maple Ave"
    streetType,                          // e.g. "Ave"
    city:         newAddr.city,
    state:        newAddr.state,
    zipCode:      newAddr.zipCode,
  }, runId, iccid);

  await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
    activation_zip: newAddr.zipCode,
  }).catch(() => {});
}
```

Add the import at top of `src/mdn-rotator/index.js`:
```js
import { hxUpdateSubscriberDetails } from '../shared/helix';
// (alongside existing helix imports)
```
Confirm the existing helix imports — they may already exist; just add `hxUpdateSubscriberDetails` to the list.

- [ ] **Step 3: Also extend the sims-select to include `canary_apex_ppu`**

The select strings that load `sim` in the helix-rotation path also need `,canary_apex_ppu` appended. Search for occurrences and update; you may have already done this in Task 2.2 (the same query feeds both paths).

- [ ] **Step 4: Syntax check**

Run: `node --input-type=module --check < src/mdn-rotator/index.js`

- [ ] **Step 5: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "rotator: insert apex PPU update before Helix MDN change (flag-gated)

Mirrors the atomic path. When the flag + canary column allow it, the
helix rotation now:
  hxSubscriberDetails → pickNextPpuAddress(excludeState, excludeZip)
                      → hxUpdateSubscriberDetails (4.4)
                      → hxMdnChange (4.16, unchanged)"
```

---

### Task 4.3: Deploy and canary-test one helix SIM

- [ ] **Step 1: Deploy**

```bash
cd src/mdn-rotator && npx wrangler deploy --env=""
```

- [ ] **Step 2: Pick a helix canary SIM and flip its column**

```sql
SELECT s.id, s.iccid, s.msisdn, s.activation_zip
  FROM sims s
  JOIN reseller_sims rs ON rs.sim_id = s.id AND rs.active = true
 WHERE s.vendor = 'helix' AND s.status = 'active'
 ORDER BY s.last_mdn_rotated_at NULLS FIRST
 LIMIT 5;

UPDATE sims SET canary_apex_ppu = true WHERE iccid = '<helix-canary-iccid>';
```

- [ ] **Step 3: Trigger rotation and verify**

Force a rotation on the canary, then:
```sql
SELECT run_id, step, response_ok, error, created_at
  FROM carrier_api_logs
 WHERE iccid = '<helix-canary-iccid>' AND vendor='helix'
   AND created_at > now() - interval '10 minutes'
 ORDER BY created_at;
```
Expected: rows for `ppu_update` (new), `mdn_change`, then subscriber details fetch — all with `error IS NULL`.

- [ ] **Step 4: Spot-check that activation_zip changed and use_count incremented**

```sql
SELECT activation_zip FROM sims WHERE iccid='<helix-canary-iccid>';
SELECT address_id, state, zip_code, use_count, last_used_at
  FROM address_pool_usage
 ORDER BY last_used_at DESC NULLS LAST LIMIT 3;
```

---

## Phase 5 — Expand & Cleanup

### Task 5.1: Expand canary to all atomic SIMs after 24h of stability

- [ ] **Step 1: Wait 24h after Task 2.4 canary success, then check error rate**

```sql
SELECT count(*) AS ppu_errors
  FROM carrier_api_logs
 WHERE step='ppu_update'
   AND vendor='atomic'
   AND error IS NOT NULL
   AND created_at > now() - interval '24 hours';
```
Expected: 0 errors. If > 0, investigate before expanding; do not proceed.

- [ ] **Step 2: Flip the column on all atomic SIMs**

```sql
UPDATE sims SET canary_apex_ppu = true WHERE vendor = 'atomic' AND status IN ('active', 'provisioning');
```
This requires no redeploy — the flag check reads the column on each rotation.

- [ ] **Step 3: Monitor for one full rotation cycle**

```sql
SELECT
  count(*) FILTER (WHERE step='ppu_update' AND error IS NULL) AS ppu_ok,
  count(*) FILTER (WHERE step='ppu_update' AND error IS NOT NULL) AS ppu_err,
  count(*) FILTER (WHERE step='mdn_change' AND vendor='atomic' AND error IS NULL) AS swap_ok,
  count(*) FILTER (WHERE step='mdn_change' AND vendor='atomic' AND error IS NOT NULL) AS swap_err
FROM carrier_api_logs
WHERE created_at > now() - interval '1 hour';
```
Expected: `ppu_err = 0`, `swap_err ≈ 0` (a few transient 5xx are tolerable as they are today).

---

### Task 5.2: Expand canary to all helix SIMs (same procedure)

- [ ] **Step 1: 24h stability check (helix)**

```sql
SELECT count(*) AS ppu_errors
  FROM carrier_api_logs
 WHERE step='ppu_update' AND vendor='helix'
   AND error IS NOT NULL
   AND created_at > now() - interval '24 hours';
```
Expected: 0.

- [ ] **Step 2: Flip the column on all helix SIMs**

```sql
UPDATE sims SET canary_apex_ppu = true WHERE vendor = 'helix' AND status IN ('active', 'provisioning');
```

- [ ] **Step 3: Monitor as in Task 5.1 Step 3 (vendor='helix' variant).**

---

### Task 5.3: Update the atomic-api skill

**Files:**
- Modify: `.claude/skills/atomic-api/SKILL.md`

- [ ] **Step 1: Add API doc version line under H1**

After the H1 (`# AT&T ATOMIC API Expert Skill`), insert:
```markdown
**API doc version:** 2026-05-20 (Critical Reference Guide EB)
```

- [ ] **Step 2: Replace Critical Enforcement Rules (lines 262-268)**

Replace the existing list with the 6-rule version from the spec's "Skill Update Specifics → Edit 2":

```markdown
1. **Only use assigned credentials** (ezbiz / EZ32726)
2. **Always use plan code `ATTNOVOICE`** for activations
3. **Always verify MDN after activation** using Subscriber Inquiry
4. **Use correct reasonCode** for each status change action (see table above)
5. **PPU before swap (NEW 2026-05-20):** When changing a subscriber's PPU address, always issue `UpdateSubscriberInfo` before `swapMSISDN`. If the new ZIP differs from the subscriber's current ZIP, the swap will be rejected unless the PPU has been updated first. The two calls must be paired and issued in order — never call `swapMSISDN` standalone with a mismatched ZIP.
6. **Rate-center spread for rotation (project rule):** For our MDN rotation workflow, every rotation MUST pick a new PPU ZIP from a different state than the SIM's current state. Reusing the same rate center on every rotation drains the NAPPA pool and triggers AT&T's number team. Use `pickNextPpuAddress()` from `src/shared/address-picker.js` — never hardcode an address.
```

- [ ] **Step 3: Replace MDN Change Sequence (lines 61-65)**

Replace `### MDN Change Sequence (Area Code Change)` block with:
```markdown
### MDN Change Sequence (mandatory order)

| Step | Action | Purpose |
|------|--------|---------|
| 1 | `subsriberInquiry` | Verify address currently associated with MDN |
| 2 | `UpdateSubscriberInfo` | Update PPU address to target ZIP (mandatory — see Rule 5) |
| 3 | `swapMSISDN` | Change MDN; `zipCode` MUST equal the ZIP set in step 2 |
| 4 | `subsriberInquiry` | Verify new MDN after swap |

**Hard rule:** Skipping step 2 or sending a mismatched `zipCode` in step 3 will be rejected by AT&T. See Critical Enforcement Rule 5.
```

- [ ] **Step 4: Replace the swapMSISDN note on line 221**

Replace:
```markdown
**Note:** New MDN area code is based on the ZIP currently associated with the MDN. Update address first via UpdateSubscriberInfo if targeting a specific area code.
```
with:
```markdown
**Mandatory:** `zipCode` must equal the subscriber's current PPU ZIP. To target a different area code, first call `UpdateSubscriberInfo` with the new ZIP, then call `swapMSISDN` with that same ZIP. AT&T will reject a mismatched ZIP. See Critical Enforcement Rule 5.
```

- [ ] **Step 5: Add the UpdateSubscriberInfo callout (above line 223 block)**

Immediately above the `### 8. Update Subscriber Information` request-block heading, add a paragraph:
```markdown
**When to call:** Mandatory before every `swapMSISDN` (see Rule 5). Optional standalone for name/address-only updates with no MDN change.
```

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/atomic-api/SKILL.md
git commit -m "skill/atomic-api: encode the 2026-05-20 PPU-before-swap rule (Rule 5)

Adds Rule 5 (PPU before swap) verbatim from the 2026-05-20 EB revision,
plus project Rule 6 (rate-center spread). Restructures the MDN Change
Sequence into the 4-step ordered workflow. Hardens the swapMSISDN
note and UpdateSubscriberInfo callout."
```

---

### Task 5.4: Update `agent/constraints.md`

**Files:**
- Modify: `agent/constraints.md` (append new rule)

- [ ] **Step 1: Read the current constraints file to find the next available section number**

Read `agent/constraints.md` and identify the highest `§N` number. The new rule becomes `§(N+1)`.

- [ ] **Step 2: Append the new rule**

Append at the end of the file:
```markdown
## §<N+1> — Apex PPU-then-MDN

Every `helix` / `atomic` (and any future AT&T APEX-backed) MDN change MUST call `UpdateSubscriberInfo` (ATOMIC) or `hxUpdateSubscriberDetails` (Helix 4.4) immediately before `swapMSISDN` / `hxMdnChange`. The `zipCode` sent to the swap call MUST equal the ZIP set in the preceding update call. Never call the swap standalone.

Enforced in `runAtomicRotation` and the helix rotation path in `src/mdn-rotator/index.js`. The picker (`pickNextPpuAddress` in `src/shared/address-picker.js`) excludes the SIM's current state and ZIP to guarantee a rate-center change. AT&T will reject mismatched-ZIP swaps as of the 2026-05-20 ATOMIC API revision.

Pool fairness is enforced by the `claim_address_pool_entry` Supabase RPC (`ORDER BY last_used_at ASC, FOR UPDATE SKIP LOCKED`). Activation and retry-activation also use the LRU picker so the pool churns evenly across all entry points.
```

- [ ] **Step 3: Commit**

```bash
git add agent/constraints.md
git commit -m "constraints: document Apex PPU-then-MDN rule (§N)"
```

---

### Task 5.5: Remove the canary gate after 48h stability on full fleet

- [ ] **Step 1: 48h stability check**

```sql
SELECT
  vendor,
  count(*) FILTER (WHERE step='ppu_update' AND error IS NOT NULL) AS ppu_errors,
  count(*) FILTER (WHERE step='mdn_change' AND error IS NOT NULL) AS swap_errors,
  count(*) FILTER (WHERE step='ppu_update') AS ppu_total
FROM carrier_api_logs
WHERE vendor IN ('atomic','helix')
  AND created_at > now() - interval '48 hours'
GROUP BY vendor;
```
Expected: `ppu_errors = 0` for both vendors. `ppu_total > 0` confirms the apex flow ran.

- [ ] **Step 2: Remove the canary column gate from the rotator**

In `src/mdn-rotator/index.js`, find both occurrences (atomic and helix) of:
```js
const apexEnabled = String(env.APEX_PPU_THEN_MDN_ENABLED || '').toLowerCase() === 'true';
const canaryOnly  = String(env.APEX_PPU_CANARY_ONLY || 'true').toLowerCase() === 'true';
const useApexFlow = apexEnabled && (!canaryOnly || sim.canary_apex_ppu === true);
```
Replace with:
```js
const useApexFlow = true;  // apex flow is now the only path; legacy preserved in git history
```

Also remove the now-unused `canary_apex_ppu` reads from the `sims?select=...` strings if you'd like, or leave them — the column itself can stay in the DB for historical purposes.

- [ ] **Step 3: Syntax check + deploy**

```bash
node --input-type=module --check < src/mdn-rotator/index.js
cd src/mdn-rotator && npx wrangler deploy --env=""
```

- [ ] **Step 4: Verify rotation continues to work**

```sql
SELECT count(*) FROM carrier_api_logs
 WHERE step='ppu_update' AND created_at > now() - interval '30 minutes';
```
Expected: > 0 (full fleet running the apex flow).

- [ ] **Step 5: Commit**

```bash
git add src/mdn-rotator/index.js
git commit -m "rotator: remove apex PPU-then-MDN canary gate (now default)

After 48h of clean carrier_api_logs across atomic and helix vendors,
the apex flow is the only MDN-change path. The env flag and canary
column reads are dropped; legacy path remains in git history."
```

---

### Task 5.6: Drop deprecated `pickRandomAddress` references

- [ ] **Step 1: Confirm no live callers**

Run:
```bash
grep -rn "pickRandomAddress" src/ scripts/ tests/
```
Expected: zero hits (all callers were migrated in Phase 3).

- [ ] **Step 2: Remove the function**

In `src/shared/address-pool.js`, delete the `export function pickRandomAddress() {...}` block.

- [ ] **Step 3: Verify, then commit**

```bash
grep -rn "pickRandomAddress" src/ scripts/ tests/   # expect zero
node --input-type=module --check < src/shared/address-pool.js
git add src/shared/address-pool.js
git commit -m "shared: drop deprecated pickRandomAddress (no callers remain)"
```

---

## Self-Review Checklist (for the engineer executing this plan)

After completing all phases, verify:

- [ ] `npm run check:db-constraints` passes.
- [ ] `node _check_relay.js` reports zero violations.
- [ ] `node --test tests/address-picker.test.mjs` passes.
- [ ] `node scripts/verify-address-pool.mjs` passes.
- [ ] No `step='ppu_update'` rows with `error IS NOT NULL` in the past 48 hours.
- [ ] `address_pool_usage` has `use_count > 0` for at least 50% of entries within one week of full rollout — confirms healthy LRU spread.
- [ ] Atomic skill SKILL.md displays the new Rule 5 + Rule 6 + 4-step sequence.
- [ ] `agent/constraints.md` has the new apex-PPU section.
