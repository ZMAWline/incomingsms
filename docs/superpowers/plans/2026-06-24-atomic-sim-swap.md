# ATOMIC SIM Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator swap the ICCID behind an active AT&T/ATOMIC SIM (carrier `swapSIM`) from the dashboard, keeping the same `sims` row so number, rental, reseller, gateway slot, and history stay attached.

**Architecture:** Pure swap logic (ICCID validation, MSISDN/ZIP resolution, request building, response parsing) lives in a new shared ESM module `src/shared/sim-swap.mjs`, unit-tested with `node --test`. The dashboard worker (`src/dashboard/index.js`) gets a thin `handleAtomicSwapSim()` route that imports those helpers, calls ATOMIC via `relayFetch`, logs to `carrier_api_logs`, and on `statusCode === '00'` patches `sims.iccid` in place. The frontend (`public/index.html`) adds a "Swap SIM" button in the SIM detail modal (ATOMIC + active only) that opens a confirm modal.

**Tech Stack:** Cloudflare Workers (ESM), Supabase/PostgREST, vanilla JS frontend, `node --test` for unit tests.

**Reference spec:** `docs/superpowers/specs/2026-06-24-atomic-sim-swap-design.md`

---

## File Structure

- Create: `src/shared/sim-swap.mjs` — pure helpers (validation, resolution, request/response shaping).
- Create: `tests/sim-swap.test.mjs` — unit tests for the helpers.
- Modify: `src/dashboard/index.js` — `import` helpers, register `POST /api/atomic-swap-sim`, add `handleAtomicSwapSim()`.
- Modify: `src/dashboard/public/index.html` — swap modal markup + `showSwapSimModal()` / `submitSwapSim()` JS + detail-modal "Swap SIM" button.
- Modify: `.claude/skills/atomic-api/SKILL.md` — document the `swapSIM` operation.

---

## Task 1: Pure swap-logic module (`src/shared/sim-swap.mjs`)

**Files:**
- Create: `src/shared/sim-swap.mjs`
- Test: `tests/sim-swap.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/sim-swap.test.mjs`:

```js
// Tests for src/shared/sim-swap.mjs — pure logic behind the ATOMIC SIM swap
// (change ICCID in place). No network/DB here; the dashboard handler is the
// thin glue that wires these to relayFetch + Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ICCID_RE,
  to10DigitMsisdn,
  resolveMsisdn,
  resolveZip,
  validateNewIccid,
  buildSwapSimRequest,
  isSwapSuccess,
  swapErrorMessage,
} from '../src/shared/sim-swap.mjs';

test('ICCID_RE matches a real 89-prefixed ICCID, rejects dummy/IMEI', () => {
  assert.ok(ICCID_RE.test('8901240197155370510'));   // 19 digits, 89-prefix
  assert.ok(!ICCID_RE.test('356719117453485'));        // 15-digit dummy
  assert.ok(!ICCID_RE.test('89012'));                  // too short
  assert.ok(!ICCID_RE.test('1234567890123456789'));    // no 89 prefix
});

test('to10DigitMsisdn strips +1 and non-digits', () => {
  assert.equal(to10DigitMsisdn('+13322408354'), '3322408354');
  assert.equal(to10DigitMsisdn('1-332-240-8354'), '3322408354');
  assert.equal(to10DigitMsisdn('3322408354'), '3322408354');
  assert.equal(to10DigitMsisdn(''), null);
  assert.equal(to10DigitMsisdn(null), null);
});

test('resolveMsisdn prefers sims.msisdn, falls back to active e164', () => {
  assert.equal(resolveMsisdn({ msisdn: '3322408354' }), '3322408354');
  assert.equal(resolveMsisdn({ msisdn: null, sim_numbers: [{ e164: '+13322408354' }] }), '3322408354');
  assert.equal(resolveMsisdn({ msisdn: null, sim_numbers: [] }), null);
  assert.equal(resolveMsisdn({}), null);
});

test('resolveZip prefers explicit input, falls back to activation_zip', () => {
  assert.equal(resolveZip('98104', { activation_zip: '10001' }), '98104');
  assert.equal(resolveZip('  ', { activation_zip: '10001' }), '10001');
  assert.equal(resolveZip('', { activation_zip: null }), null);
});

test('validateNewIccid enforces format, difference', () => {
  assert.deepEqual(validateNewIccid('8901240197155370510', '8901240197155370999'), { ok: true });
  assert.equal(validateNewIccid('356719117453485', '8901240197155370999').ok, false); // bad format
  assert.equal(validateNewIccid('8901240197155370510', '8901240197155370510').ok, false); // same as current
  assert.equal(validateNewIccid('', '8901240197155370999').ok, false); // missing
});

test('buildSwapSimRequest produces the wholeSaleApi envelope', () => {
  const req = buildSwapSimRequest({
    session: { userName: 'u', token: 't', pin: 'p' },
    msisdn: '3322408354',
    zipCode: '98104',
    newSim: '8901240197155370510',
  });
  assert.deepEqual(req, {
    wholeSaleApi: {
      session: { userName: 'u', token: 't', pin: 'p' },
      wholeSaleRequest: {
        requestType: 'swapSIM',
        MSISDN: '3322408354',
        zipCode: '98104',
        newSim: '8901240197155370510',
      },
    },
  });
});

test('isSwapSuccess / swapErrorMessage read the ATOMIC response', () => {
  const ok = { wholeSaleApi: { wholeSaleResponse: { statusCode: '00', description: 'OK' } } };
  const bad = { wholeSaleApi: { wholeSaleResponse: { statusCode: '14', description: 'Invalid SIM' } } };
  assert.equal(isSwapSuccess(ok), true);
  assert.equal(isSwapSuccess(bad), false);
  assert.equal(isSwapSuccess(null), false);
  assert.equal(swapErrorMessage(bad, 200), 'ATOMIC statusCode 14: Invalid SIM');
  assert.equal(swapErrorMessage(null, 502), 'ATOMIC swapSIM HTTP 502');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="ICCID_RE"` (or `node --test tests/sim-swap.test.mjs`)
Expected: FAIL — `Cannot find module '../src/shared/sim-swap.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/sim-swap.mjs`:

```js
// Pure logic for the ATOMIC SIM swap (change ICCID in place). Kept dependency-
// free and unit-tested so the dashboard handler stays thin glue around
// relayFetch + Supabase. See docs/superpowers/specs/2026-06-24-atomic-sim-swap-design.md
//
// A swapSIM keeps the same MSISDN/BAN and moves the line to a new ICCID; the old
// ICCID auto-detaches at the carrier. Only sims.iccid changes on our side.

// Real ATOMIC ICCIDs: 89-prefixed, 19-21 digits total. Same detection the
// dashboard already uses in handleAtomicQuery.
export const ICCID_RE = /^89\d{17,19}$/;

// Reduce any MDN representation to the bare 10-digit US number swapSIM expects.
export function to10DigitMsisdn(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : (d || null);
}

// MSISDN comes from sims.msisdn (ATOMIC stores the 10-digit MDN) or, failing
// that, the active sim_numbers.e164 row reduced to 10 digits.
export function resolveMsisdn(sim) {
  if (!sim) return null;
  const fromCol = to10DigitMsisdn(sim.msisdn);
  if (fromCol) return fromCol;
  const e164 = sim.sim_numbers && sim.sim_numbers[0] && sim.sim_numbers[0].e164;
  return to10DigitMsisdn(e164);
}

// Explicit operator-entered ZIP wins; otherwise the ZIP we recorded at activation.
export function resolveZip(inputZip, sim) {
  const explicit = (inputZip == null ? '' : String(inputZip)).trim();
  if (explicit) return explicit;
  const z = sim && sim.activation_zip ? String(sim.activation_zip).trim() : '';
  return z || null;
}

// { ok: true } or { ok: false, error }.
export function validateNewIccid(newIccid, currentIccid) {
  const v = (newIccid == null ? '' : String(newIccid)).trim();
  if (!v) return { ok: false, error: 'New ICCID is required' };
  if (!ICCID_RE.test(v)) return { ok: false, error: 'New ICCID must be a real ICCID (starts with 89, 19-21 digits)' };
  if (v === String(currentIccid || '').trim()) return { ok: false, error: 'New ICCID is the same as the current ICCID' };
  return { ok: true };
}

export function buildSwapSimRequest({ session, msisdn, zipCode, newSim }) {
  return {
    wholeSaleApi: {
      session,
      wholeSaleRequest: {
        requestType: 'swapSIM',
        MSISDN: msisdn,
        zipCode,
        newSim,
      },
    },
  };
}

export function isSwapSuccess(json) {
  return !!(json && json.wholeSaleApi && json.wholeSaleApi.wholeSaleResponse
    && json.wholeSaleApi.wholeSaleResponse.statusCode === '00');
}

export function swapErrorMessage(json, httpStatus) {
  const wr = json && json.wholeSaleApi && json.wholeSaleApi.wholeSaleResponse;
  if (wr && wr.statusCode) return 'ATOMIC statusCode ' + wr.statusCode + ': ' + (wr.description || '');
  return 'ATOMIC swapSIM HTTP ' + httpStatus;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/sim-swap.test.mjs`
Expected: PASS (all tests green).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm test`
Expected: existing tests still pass; new file included.

- [ ] **Step 6: Commit**

```bash
git add src/shared/sim-swap.mjs tests/sim-swap.test.mjs
git commit -m "feat: pure ATOMIC SIM-swap logic + unit tests"
```

---

## Task 2: Document `swapSIM` in the atomic-api skill

**Files:**
- Modify: `.claude/skills/atomic-api/SKILL.md`

- [ ] **Step 1: Add the operations-table row**

In the "What This Skill Covers" table, add after the Swap MSISDN row:

```markdown
| 4b | Swap SIM | `swapSIM` | Change the ICCID on a line (physical SIM swap); MSISDN stays |
```

- [ ] **Step 2: Add the request example**

After the "7. Swap MSISDN (MDN Change)" example block, add:

````markdown
### 7b. Swap SIM (Change ICCID)
```json
{"wholeSaleApi": {
  "session": {
    "userName": "ezbiz",
    "token": "EZ(3928_*=wH)le",
    "pin": "EZ32726"
  },
  "wholeSaleRequest": {
    "requestType": "swapSIM",
    "MSISDN": "CURRENT_MDN",
    "zipCode": "SUBSCRIBER_ZIP",
    "newSim": "NEW_ICCID"
  }
}}
```
**Note:** Keeps the same MSISDN/BAN and moves the line to `newSim` (the new
ICCID). The old ICCID is auto-detached at the carrier — do **not** send a
separate `deactivateSubscriber`. `zipCode` is the subscriber's ZIP on file; if
it is wrong, fix it first with `UpdateSubscriberInfo`. `newSim` must be a real
ICCID (89-prefixed, 19-21 digits).
````

- [ ] **Step 3: Add the workflow note**

Under "Key Workflows", add:

```markdown
### SIM Swap Sequence (ICCID change)
1. **Swap SIM** — POST `swapSIM` with current `MSISDN`, `zipCode`, and `newSim` (new ICCID)
2. **Subscriber Inquiry** — Verify the line now reports the new ICCID
```

- [ ] **Step 4: Add the migration-notes row**

In the "Helix to ATOMIC Migration Notes" table, add:

```markdown
| 4.x Swap SIM / change ICCID | `swapSIM` (MSISDN + zipCode + newSim) |
```

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/atomic-api/SKILL.md
git commit -m "docs(atomic-api): document swapSIM (change ICCID) operation"
```

---

## Task 3: Backend route + handler (`src/dashboard/index.js`)

**Files:**
- Modify: `src/dashboard/index.js` (top-of-file import; route registration near the other `/api/...` routes; new handler near `handleAtomicQuery`)

- [ ] **Step 1: Add the shared import**

At the top of `src/dashboard/index.js`, next to the existing
`import { computeBillingBreakdown, computeResellerUtilization } from '../shared/billing.js';`
line (line 1), add:

```js
import { resolveMsisdn, resolveZip, validateNewIccid, buildSwapSimRequest, isSwapSuccess, swapErrorMessage } from '../shared/sim-swap.mjs';
```

- [ ] **Step 2: Register the route**

Find the line registering the ATOMIC query route (search for `handleAtomicQuery(`). Immediately after that route's `if (...) { return handleAtomicQuery(...); }` block, add:

```js
    if (url.pathname === '/api/atomic-swap-sim' && request.method === 'POST') {
      return handleAtomicSwapSim(request, env, corsHeaders);
    }
```

- [ ] **Step 3: Add the handler**

Immediately after the full `handleAtomicQuery(...)` function definition (search for `async function handleAtomicQuery`, place this after its closing brace), add:

```js
// POST /api/atomic-swap-sim — swap the ICCID on an active ATOMIC line in place.
// Carrier swapSIM keeps the MSISDN/BAN; only sims.iccid changes here. Approach A
// (see docs/superpowers/specs/2026-06-24-atomic-sim-swap-design.md): same sims
// row, so number/rental/reseller/slot/history stay attached.
async function handleAtomicSwapSim(request, env, corsHeaders) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json();
    const simId = body.sim_id;
    const newIccid = (body.new_iccid == null ? '' : String(body.new_iccid)).trim();
    if (!simId) return json({ ok: false, error: 'sim_id required' }, 400);

    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
      return json({ ok: false, error: 'ATOMIC credentials not configured on dashboard worker (push ATOMIC_USERNAME, ATOMIC_TOKEN, ATOMIC_PIN secrets)' }, 500);
    }

    // Load the SIM + its active number.
    const sims = await sbGet(env, 'sims?select=id,iccid,msisdn,vendor,status,activation_zip,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.' + encodeURIComponent(String(simId)) + '&limit=1');
    const sim = Array.isArray(sims) && sims[0] ? sims[0] : null;
    if (!sim) return json({ ok: false, error: 'SIM #' + simId + ' not found' }, 404);
    if (sim.vendor !== 'atomic') return json({ ok: false, error: 'SIM swap is only supported for ATOMIC (AT&T) SIMs; this SIM is ' + sim.vendor }, 400);
    if (sim.status === 'canceled') return json({ ok: false, error: 'SIM is canceled; cannot swap' }, 400);

    const fmt = validateNewIccid(newIccid, sim.iccid);
    if (!fmt.ok) return json({ ok: false, error: fmt.error }, 400);

    // Uniqueness pre-check: friendlier than a raw Postgres unique-violation.
    const clash = await sbGet(env, 'sims?select=id&iccid=eq.' + encodeURIComponent(newIccid) + '&limit=1');
    if (Array.isArray(clash) && clash[0] && String(clash[0].id) !== String(sim.id)) {
      return json({ ok: false, error: 'ICCID ' + newIccid + ' is already assigned to SIM #' + clash[0].id }, 409);
    }

    const msisdn = resolveMsisdn(sim);
    if (!msisdn) return json({ ok: false, error: 'No MSISDN on file for this SIM; cannot swap' }, 400);
    const zipCode = resolveZip(body.zip_code, sim);
    if (!zipCode) return json({ ok: false, error: 'ZIP required for swapSIM (none on file; enter one)' }, 400);

    const apiUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const requestBody = buildSwapSimRequest({
      session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
      msisdn,
      zipCode,
      newSim: newIccid,
    });

    const res = await relayFetch(env, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const success = res.ok && isSwapSuccess(data);
    const errMsg = success ? null : swapErrorMessage(data, res.status);

    await logCarrierApiCall(env, {
      run_id: 'atomic_swap_' + sim.iccid + '_' + Date.now(),
      step: 'swap_sim',
      iccid: sim.iccid,
      imei: null,
      vendor: 'atomic',
      request_url: apiUrl,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: data,
      error: errMsg,
    });

    if (!success) {
      await logSystemError(env, { source: 'dashboard', action: 'swap_sim', sim_id: sim.id, iccid: sim.iccid, error_message: 'ATOMIC swapSIM failed: ' + errMsg, error_details: { msisdn, new_iccid: newIccid, response: data, status: res.status } });
      return json({ ok: false, error: errMsg, response: data }, res.status >= 400 ? res.status : 502);
    }

    // Carrier accepted — flip the ICCID in place. Everything else stays attached.
    const note = 'ICCID swapped from ' + sim.iccid + ' to ' + newIccid + ' on ' + new Date().toISOString();
    await sbPatch(env, 'sims?id=eq.' + encodeURIComponent(String(sim.id)), { iccid: newIccid, status_reason: note });

    return json({ ok: true, sim_id: sim.id, old_iccid: sim.iccid, new_iccid: newIccid, msisdn, response: data });
  } catch (error) {
    return json({ ok: false, error: String(error) }, 500);
  }
}
```

- [ ] **Step 4: Syntax-check the worker module**

Run: `node --input-type=module --check < src/dashboard/index.js`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.js
git commit -m "feat(dashboard): POST /api/atomic-swap-sim — in-place ICCID swap"
```

---

## Task 4: Frontend swap modal + detail-modal entry (`src/dashboard/public/index.html`)

**Files:**
- Modify: `src/dashboard/public/index.html` (modal markup after `change-imei-modal`; JS near `showChangeImeiModal`; "Swap SIM" button in `renderSimDetailDetails`)

- [ ] **Step 1: Add the modal markup**

Find the closing of the `change-imei-modal` block (the `</div>` that closes `<div id="change-imei-modal" ...>`, just before `<script>` at the top of the main script). Immediately after that closing `</div>`, add:

```html
    <div id="swap-sim-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 class="text-lg font-semibold text-white">Swap SIM (ATOMIC)</h3>
                <button onclick="document.getElementById('swap-sim-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <div class="mb-4 p-3 rounded-lg bg-yellow-900/20 border border-yellow-800/40 text-xs text-yellow-300">
                    This performs a <strong>live AT&amp;T carrier change</strong>: the phone number stays, the line moves to the new ICCID, and the old ICCID is detached. All history stays on this SIM.
                </div>
                <p id="swap-sim-info" class="text-sm text-gray-400 mb-4"></p>
                <label class="block text-xs text-gray-500 mb-1">New ICCID (real ICCID, starts 89)</label>
                <input id="swap-sim-iccid" type="text" maxlength="22" inputmode="numeric" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono mb-3" placeholder="8901240197155370510">
                <label class="block text-xs text-gray-500 mb-1">ZIP (leave blank to use the ZIP on file)</label>
                <input id="swap-sim-zip" type="text" maxlength="10" inputmode="numeric" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono mb-4" placeholder="ZIP on file">
                <button id="swap-sim-submit" onclick="submitSwapSim()" class="w-full px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Swap SIM</button>
                <div id="swap-sim-result" class="mt-4 hidden">
                    <pre id="swap-sim-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('swap-sim-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>
```

- [ ] **Step 2: Add the JS functions**

Immediately before `function showChangeImeiModal(` (search for it), add:

```js
        let _swapSimId = null;
        function _sdSwap() { if (!_sdCurrentSim) return; var c = _sdCurrentSim; closeSimDetail(); showSwapSimModal(c.id); }
        function showSwapSimModal(simId) {
            const sim = tableState.sims && tableState.sims.data && tableState.sims.data.find(function(s){ return String(s.id) === String(simId); });
            if (!sim) { showToast('SIM #' + simId + ' not in current view — refresh first', 'error'); return; }
            if (sim.vendor !== 'atomic') { showToast('SIM swap is only for ATOMIC SIMs', 'error'); return; }
            _swapSimId = sim.id;
            document.getElementById('swap-sim-info').innerHTML =
                'SIM #' + sim.id + ' &middot; current ICCID <span class="font-mono text-gray-300">' + (sim.iccid || '-') + '</span><br>' +
                'Number <span class="font-mono text-gray-300">' + (sim.phone_number || '-') + '</span> &middot; reseller ' + (sim.reseller_name || '-');
            document.getElementById('swap-sim-iccid').value = '';
            document.getElementById('swap-sim-zip').value = '';
            document.getElementById('swap-sim-result').classList.add('hidden');
            document.getElementById('swap-sim-output').textContent = '';
            document.getElementById('swap-sim-modal').classList.remove('hidden');
        }
        async function submitSwapSim() {
            const newIccid = document.getElementById('swap-sim-iccid').value.trim();
            const zip = document.getElementById('swap-sim-zip').value.trim();
            if (!/^89\d{17,19}$/.test(newIccid)) { showToast('Enter a real ICCID (starts with 89, 19-21 digits)', 'error'); return; }
            const btn = document.getElementById('swap-sim-submit');
            const orig = btn.textContent;
            btn.disabled = true; btn.textContent = 'Swapping…';
            try {
                const res = await fetch(API_BASE + '/atomic-swap-sim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: _swapSimId, new_iccid: newIccid, zip_code: zip })
                });
                const result = await res.json();
                const out = document.getElementById('swap-sim-output');
                document.getElementById('swap-sim-result').classList.remove('hidden');
                out.textContent = JSON.stringify(result, null, 2);
                if (res.ok && result.ok) {
                    showToast('Swapped to ' + result.new_iccid, 'success');
                    document.getElementById('swap-sim-modal').classList.add('hidden');
                    loadSims(true);
                } else {
                    showToast('Swap failed: ' + (result.error || res.status), 'error');
                }
            } catch (e) {
                showToast('Swap error: ' + e, 'error');
            } finally {
                btn.disabled = false; btn.textContent = orig;
            }
        }
```

- [ ] **Step 3: Add the "Swap SIM" button to the detail modal**

In `renderSimDetailDetails(sim)`, find the `var canRetry = ...;` line and add after it:

```js
            var canSwap = sim.vendor === 'atomic' && sim.status === 'active';
```

Then in the `var actions = ...` concatenation, add this entry right after the `canRetry` button line:

```js
                (canSwap ? '<button onclick="_sdSwap()" class="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Swap SIM</button>' : '') +
```

- [ ] **Step 4: Syntax-check the frontend script**

Run:
```bash
node -e 'const fs=require("fs"),cp=require("child_process");const html=fs.readFileSync("src/dashboard/public/index.html","utf8");const re=/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;let m,i=0,fail=0;while((m=re.exec(html))){const b=m[1];if(!b.trim())continue;i++;fs.writeFileSync("/tmp/_sc"+i+".js",b);try{cp.execSync("node --check /tmp/_sc"+i+".js",{stdio:"pipe"});}catch(e){fail++;console.error("script #"+i+" FAIL:\n"+e.stderr.toString());}}for(let k=1;k<=i;k++){try{fs.unlinkSync("/tmp/_sc"+k+".js")}catch(e){}}console.log(fail?"FAIL":"All "+i+" script blocks OK");process.exit(fail?1:0)'
```
Expected: `All N script blocks OK`.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat(dashboard): Swap SIM modal + detail-modal entry (ATOMIC)"
```

---

## Task 5: Deploy + manual verification (operator-gated)

**Files:** none (deploy only)

- [ ] **Step 1: Confirm prod is the right target**

The dashboard frontend + worker both ship from `main` to the `dashboard` worker. Confirm with the operator before deploying (live carrier feature).

- [ ] **Step 2: Deploy**

```bash
cd src/dashboard && eval "$(grep -E '^export CLOUDFLARE_API_TOKEN=' ~/.bashrc | head -1)" && npx wrangler deploy --env="" 2>&1 | tail -15
```
Expected: `Deployed dashboard` with a new Version ID.

- [ ] **Step 3: Manual smoke test (operator)**

On the live dashboard: SIMs tab → open an **active ATOMIC** SIM → "Swap SIM" → enter a real spare ICCID → confirm. Verify the toast, that the SIM row now shows the new ICCID, that the number/reseller/rental are unchanged, and that `carrier_api_logs` has the `swap_sim` entry. Do **not** run a live swap during development — only the operator triggers the first real one.

- [ ] **Step 4: Push**

```bash
git push origin main
```

---

## Self-Review notes

- **Spec coverage:** skill doc (Task 2), backend route+handler+guards+logging+in-place patch (Task 3), frontend modal+entry (Task 4), validation/MSISDN/ZIP/uniqueness (Tasks 1+3), verification (syntax checks Tasks 3/4, manual Task 5). All spec sections mapped.
- **No `sim_status_history`** write (status unchanged; table has no reason column) — matches the corrected spec; audit is `carrier_api_logs` + `status_reason`.
- **Type consistency:** helper names (`resolveMsisdn`, `resolveZip`, `validateNewIccid`, `buildSwapSimRequest`, `isSwapSuccess`, `swapErrorMessage`) identical across module, tests, and handler. Frontend ICCID regex matches `ICCID_RE`.
