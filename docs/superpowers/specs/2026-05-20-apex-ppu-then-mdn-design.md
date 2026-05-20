# Apex PPU-then-MDN Rotation Workflow

**Date:** 2026-05-20
**Status:** Approved (design)
**Scope:** Mandatory PPU-then-MDN sequence for AT&T APEX-backed vendors (`atomic`, `helix`, future apex vendors). Includes expanded address pool, LRU picker, rotation flow change, skill update, and rollout plan.

## Background & Motivation

AT&T assigns MDNs based on "rate centers." Each rate center covers 5–20 ZIP codes and has a finite pool of numbers allocated by NAPPA. The PPU (Place of Primary Use) address on a SIM determines which rate center it pulls from when an MDN is swapped. If we call `swapMSISDN` without first updating the PPU, we keep pulling from the same rate center, depleting it and flagging AT&T's number team.

As of the **05/20/2026 ATOMIC API Critical Reference Guide (EB)** revision, this is no longer a soft convention — it is enforced at the AT&T API level (new Rule #5):

> "When changing a subscriber's PPU address, always issue `UpdateSubscriberInfo` before `swapMSISDN`. If the new ZIP differs from the subscriber's current ZIP, the swap will be rejected unless the PPU has been updated first. The two calls must be paired and issued in order — never call `swapMSISDN` standalone with a mismatched ZIP."

The same rule applies to legacy `helix` (Helix Airespring) lines, which are also backed by AT&T APEX. All future APEX-backed vendors will inherit the rule.

### Current state

- `src/shared/address-pool.js` has only **25 entries** (one per state, all major-city downtowns).
- `pickRandomAddress()` is used at **activation** (`src/mdn-rotator/index.js:3303`) and **retry-activation** (`:3358`) only.
- Rotation flow (atomic path, `src/mdn-rotator/index.js:1827-1869`) does `subsriberInquiry → swapMSISDN`, reusing the existing AT&T-side ZIP. **It never calls `UpdateSubscriberInfo`** — which means under the new API rule, every cross-area-code swap will start failing.

## Goals

1. Always issue `UpdateSubscriberInfo` immediately before `swapMSISDN` for every apex-vendor MDN change.
2. The PPU address used for each rotation must come from a different state and ZIP than the SIM's current PPU, so each rotation actually shifts rate centers.
3. The address pool must be large enough (~20+ ZIPs/state, ~1000 entries) and the pick algorithm fair enough (LRU) that AT&T sees evenly-distributed rate-center hits over time.
4. Activation and retry-activation must also draw from the same pool with the same fairness, so they contribute to the rotation rather than concentrate on the same 25 ZIPs.
5. Auditable: each step logged to `carrier_api_logs`; pool usage observable via a dedicated table.

## Non-Goals

- Per-state quota balancing (LRU is global; adequate at current SIM volume).
- Dashboard UI for pool usage stats (post-launch).
- Auto-curation / replenishment of pool entries when AT&T flags one.
- Changes to `wing_iot` rotation (uses a different AT&T pathway).

## Architecture

Three composable pieces:

### 1. Static address pool — `src/shared/address-pool.js`

Replace the 25-entry array with **~1000 entries (≥ 20 ZIPs per US state + DC)**. Schema:

```js
{
  id: 'ca-90012-200-n-spring',     // stable slug, survives reordering
  streetNumber: '200',
  streetName: 'N Spring St',
  streetDirection: '',
  city: 'Los Angeles',
  state: 'CA',
  zipCode: '90012'
}
```

**Sourcing:** curated from public USPS / Census ZIP data paired with real civic addresses (libraries, post offices, courthouses, city halls) — public buildings, no real residents. Each ZIP must be in a different rate center from the other ZIPs in the same state.

**Backward compat:** the existing `pickRandomAddress()` export remains but routes through the new picker (so any unintended caller continues to work).

### 2. LRU picker — `src/shared/address-picker.js`

Exports:

```js
// Returns a full address record. Throws if the pool is exhausted.
async pickNextPpuAddress(env, { excludeState, excludeZip } = {})

// One-time seeder. Idempotent — upserts every entry from the static pool
// into address_pool_usage. Safe to re-run after pool additions.
async seedAddressPoolUsage(env)
```

**Pick algorithm:** delegates to the Supabase RPC below, which returns one `address_id`; the picker joins back to the static JSON to produce the full address record.

### 3. Supabase storage — `address_pool_usage` table + `claim_address_pool_entry` RPC

```sql
CREATE TABLE address_pool_usage (
  address_id    text PRIMARY KEY,
  state         text NOT NULL,
  zip_code      text NOT NULL,
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0
);
CREATE INDEX address_pool_usage_state_lru
  ON address_pool_usage (state, last_used_at NULLS FIRST);

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
```

`FOR UPDATE SKIP LOCKED` ensures two concurrent rotations never claim the same row. Returns `NULL` only if the pool is empty / fully excluded — the picker turns that into a thrown error.

### 4. Apex MDN-change workflow

A new shared helper consolidates the apex sequence so `atomic` and `helix` reuse one implementation:

```
runApexMdnChange(env, sim, vendor, runId):
  1. pre_swap_inquiry    — subsriberInquiry; read currentState, currentZip
  2. pick                — pickNextPpuAddress({excludeState: currentState,
                                                excludeZip:   currentZip})
  3. ppu_update          — UpdateSubscriberInfo with newAddr; require statusCode='00'
  4. mdn_change          — swapMSISDN with zipCode = newAddr.zipCode  (NOT old zip)
  5. subscriber_inquiry  — verify new MDN
```

Vendor gate: `APEX_VENDORS = ['helix', 'atomic']` in `src/shared/address-picker.js`. Anywhere rotation branches on vendor, route apex vendors through `runApexMdnChange`.

## Components & File Changes

### New files

| Path | Purpose |
|------|---------|
| `src/shared/address-pool.js` (rewrite) | ~1000-entry static array with `id` field; retains `pickRandomAddress()` as a thin delegator |
| `src/shared/address-picker.js` | `pickNextPpuAddress`, `seedAddressPoolUsage`, `APEX_VENDORS` constant |
| `migrations/<ts>_address_pool_usage.sql` | Table + RPC above |
| `scripts/seed-address-pool.mjs` | One-time admin tool to populate `address_pool_usage` |
| `scripts/verify-address-pool.mjs` | Pre-deploy sanity check: ≥ 20 ZIPs per state, no dup IDs, no dup ZIPs within state |

### Modified files

**`src/mdn-rotator/index.js`**
- **Atomic rotation** (~line 1797–1960): extract the apex MDN-change body into `runApexMdnChange`. Insert `pickNextPpuAddress` + `UpdateSubscriberInfo` step between pre-inquiry and swap. Set `swapBody.wholeSaleRequest.zipCode = pickedAddr.zipCode` (currently reads from `preInqR.Result.address.zipCode`, which is stale after the PPU update).
- **Helix rotation:** same insertion. Helix uses the `4.4 Update Subscriber` request (per the Helix→ATOMIC migration table in the existing skill) — confirm exact shape during implementation.
- **Activation (~3303) and retry-activation (~3358):** replace `pickRandomAddress()` with `await pickNextPpuAddress(env, {})` (no exclusions — pure LRU; no current state/zip at activation time).
- Wrap all new calls with the existing `logCarrierApiCall(env, {...})` helper: `step: 'ppu_update'` for the update call, existing `step: 'mdn_change'` unchanged.

**`.claude/skills/atomic-api/SKILL.md`** — see "Skill update specifics" below.

**`agent/constraints.md`** — new rule:
> **§N — Apex PPU-then-MDN:** Every `helix` / `atomic` (and any future apex) MDN change MUST call `UpdateSubscriberInfo` immediately before `swapMSISDN`. The `zipCode` sent to `swapMSISDN` MUST equal the ZIP set in the preceding `UpdateSubscriberInfo`. Never call `swapMSISDN` standalone. Enforced in `runApexMdnChange()` in `src/mdn-rotator/index.js`. The picker (`pickNextPpuAddress`) excludes the SIM's current state and ZIP to guarantee a rate-center change.

### Unchanged

- `carrier_api_logs` schema — existing `step` field accommodates `ppu_update` naturally.
- `claim_rotation_slot` RPC — still the per-SIM gate; composes cleanly with the new per-address gate.
- `runAtomicFinalizer` (provisioning reconciliation) — unchanged.

## Data Flow

### Rotation (happy path)

```
[cron tick] → claim_rotation_slot(sim.id)              ← existing atomic gate
              ↓ (claimed)
              POST subsriberInquiry                    ← step: pre_swap_inquiry
              ↓ read Result.address.state + zipCode
              claim_address_pool_entry(state, zip)     ← RPC, FOR UPDATE SKIP LOCKED
              ↓ returns address_id; module joins to static pool
              POST UpdateSubscriberInfo(pickedAddr)    ← step: ppu_update
              ↓ require statusCode='00'
              POST swapMSISDN(zipCode=pickedAddr.zip)  ← step: mdn_change
              ↓ existing 5xx/uncertain-swap path unchanged
              POST subsriberInquiry                    ← step: subscriber_inquiry
              [existing DB updates, webhooks, etc.]
```

### Activation (simpler)

```
claim_address_pool_entry(NULL, NULL)
  → POST Activate(streetNumber, streetName, zip)
  → existing post-activation inquiry
```

## Error Handling

| Failure | Behavior | Rationale |
|---------|----------|-----------|
| Pre-inquiry fails | Throw; rotation marked failed | Unchanged |
| `claim_address_pool_entry` returns NULL | Throw `Address pool exhausted (excludes: state=X zip=Y)`; rotation marked failed | Pool exhaustion is a deploy/seed bug — surface loudly |
| `UpdateSubscriberInfo` returns non-`00` | Throw with AT&T `description`; **swap is NOT called** | Hard rule: no swap without confirmed PPU |
| `UpdateSubscriberInfo` network 5xx / timeout | Throw; **swap is NOT called** | Don't know if PPU was set; calling swap risks rejection per Rule #5. Next rotation picks a different address. |
| `swapMSISDN` returns non-`00` | Throw with description; PPU stays at new value (no rollback) | Per user decision. PPU drift is harmless; next rotation overwrites. |
| `swapMSISDN` network 5xx / timeout | Flip SIM to `provisioning` for `runAtomicFinalizer` to reconcile (existing logic) | Unchanged |
| `swapMSISDN` rejected with PPU-ZIP-mismatch error | Throw; alert in logs as hard-rule violation | Should be impossible by construction — indicates code bug |

## Concurrency

- `claim_rotation_slot` prevents the same SIM from being rotated twice in parallel (existing gate).
- `claim_address_pool_entry` with `FOR UPDATE SKIP LOCKED` prevents two concurrent rotations from picking the same address.
- The two gates compose; no new races are introduced.

## Idempotency on retry

If a rotation throws after `UpdateSubscriberInfo` succeeded, the next rotation will:
1. Re-inquire (now sees the *new* state/zip from the previous run),
2. Exclude that state/zip and pick a *third* address,
3. Update PPU again, then swap.

Each rotation independently advances the PPU. No special retry / rollback logic is required.

## Audit trail

- **Per-rotation:** filter `carrier_api_logs` by `run_id = rotate_<iccid>_<ts>` → 4 ordered rows (`pre_swap_inquiry`, `ppu_update`, `mdn_change`, `subscriber_inquiry`).
- **Pool fairness:** `SELECT state, count(*), avg(use_count), max(last_used_at) FROM address_pool_usage GROUP BY state ORDER BY 3 DESC` — bias detection.
- **Rule violations:** `SELECT * FROM carrier_api_logs WHERE step='ppu_update' AND error IS NOT NULL` — should always be empty.

## Testing & Rollout

### Pre-deploy verification

1. `node scripts/verify-address-pool.mjs` — ≥ 20 ZIPs/state, no dup IDs, no dup ZIPs within a state.
2. `npm run check:db-constraints` — required by project policy (see memory `feedback_verify_db_constraints`).
3. Run `seedAddressPoolUsage()` in staging; confirm table row count matches static pool length.

### Canary test (manual, gated)

Use one known-good atomic SIM:

1. `subsriberInquiry` → note current state/zip.
2. Call `pickNextPpuAddress({excludeState, excludeZip})` via a one-off script — must return a different state.
3. Trigger a single rotation against the canary with the flag enabled.
4. Verify `carrier_api_logs` shows 4-step run, MDN actually changed, post-inquiry PPU matches the picked address.
5. Repeat 3× — confirm LRU advances and never picks the same state twice in a row.

Repeat the same canary cycle for one **helix** SIM.

### Feature flag

`APEX_PPU_THEN_MDN_ENABLED` (env var on `mdn-rotator` worker):
- `false` (default at first deploy): rotation uses the existing pre-inquiry-zip path (legacy).
- `true`: rotation uses the new `runApexMdnChange()` path.

Flag check lives inside `runApexMdnChange`'s entry point. Same flag governs both vendors so a single toggle rolls back the whole change.

### Rollout sequence

1. Merge code with flag = `false`. Migration applied, table seeded, picker available but unused. No behavior change.
2. Run picker-only verification (steps above).
3. Set flag = `true`. Canary is gated by a new boolean column `sims.canary_apex_ppu` (default `false`). `runApexMdnChange` checks both the env flag AND the column: when the flag is on but the column scope is in effect, only SIMs with `canary_apex_ppu=true` run through the new path; non-canary SIMs continue on the legacy path. Set the column to `true` for one atomic SIM and watch one 20-min cron tick. Once expanding (step 4), set the column to `true` for all atomic SIMs; once removing the column gate (step 6), drop the column check.
4. Expand to all atomic SIMs after 24 hours of clean `carrier_api_logs`.
5. Repeat for helix.
6. After 48 hours of stability, remove the flag check from `runApexMdnChange()`.

### Post-deploy monitoring

- Hourly count of `step='ppu_update' AND error IS NOT NULL` — alert on non-zero.
- Weekly review of `address_pool_usage` use_count distribution — flag any address used > 2× the median.
- AT&T number-team complaints — the original symptom — should disappear. **This is the real success metric.**

## Skill Update Specifics

The atomic skill at `.claude/skills/atomic-api/SKILL.md` gets five targeted edits.

### Edit 1 — Last Updated header

Insert under the H1:
```markdown
**API doc version:** 2026-05-20 (Critical Reference Guide EB)
```

### Edit 2 — Critical Enforcement Rules (replace lines 262–268)

```markdown
1. **Only use assigned credentials** (ezbiz / EZ32726)
2. **Always use plan code `ATTNOVOICE`** for activations
3. **Always verify MDN after activation** using Subscriber Inquiry
4. **Use correct reasonCode** for each status change action (see table above)
5. **PPU before swap (NEW 2026-05-20):** When changing a subscriber's PPU address, always issue `UpdateSubscriberInfo` before `swapMSISDN`. If the new ZIP differs from the subscriber's current ZIP, the swap will be rejected unless the PPU has been updated first. The two calls must be paired and issued in order — never call `swapMSISDN` standalone with a mismatched ZIP.
6. **Rate-center spread for rotation (project rule):** For our MDN rotation workflow, every rotation MUST pick a new PPU ZIP from a different state than the SIM's current state. Reusing the same rate center on every rotation drains the NAPPA pool and triggers AT&T's number team. Use `pickNextPpuAddress()` from `src/shared/address-picker.js` — never hardcode an address.
```

### Edit 3 — MDN Change Sequence (replace lines 61–65)

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

### Edit 4 — Section 7 swapMSISDN note (replace the "Note:" on line 221)

```markdown
**Mandatory:** `zipCode` must equal the subscriber's current PPU ZIP. To target a different area code, first call `UpdateSubscriberInfo` with the new ZIP, then call `swapMSISDN` with that same ZIP. AT&T will reject a mismatched ZIP. See Critical Enforcement Rule 5.
```

### Edit 5 — Section 8 UpdateSubscriberInfo header

Add a callout immediately above the request block on line 223:
```markdown
**When to call:** Mandatory before every `swapMSISDN` (see Rule 5). Optional standalone for name/address-only updates with no MDN change.
```

## Locked Decisions

1. **Address sourcing:** civic / public-building addresses only (libraries, post offices, courthouses, city halls). No residential.
2. **Canary mechanism:** boolean column `sims.canary_apex_ppu` (default `false`). `runApexMdnChange` checks both the env flag and the column during the canary phase.
3. **Feature flag:** single `APEX_PPU_THEN_MDN_ENABLED` env var governing both vendors.

## Open Items (resolve during implementation)

1. **Helix `UpdateSubscriberInfo` request shape** — confirm exact endpoint and body during implementation. The migration table in the existing skill lists it as `4.4 Update Subscriber`, but the request payload may differ from ATOMIC's. Test against staging before flipping the column on for any helix SIM.
2. **`pickRandomAddress()` deprecation timeline** — keep as a delegator for now; remove after the env flag is removed.

## Success Criteria

- All `helix` and `atomic` rotations issue `UpdateSubscriberInfo` before `swapMSISDN`.
- Every rotation's picked PPU is in a different state and ZIP than the prior PPU.
- `address_pool_usage.use_count` distribution stays within 2× median across entries.
- Zero `step='ppu_update'` rows with non-null `error` in `carrier_api_logs` during normal operation.
- AT&T number-team complaints about rate-center depletion cease.
