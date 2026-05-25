# Reseller Portal Resend & Visibility — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add self-serve `number.online` webhook resend (per-SIM + bulk) and per-SIM delivery history to the reseller portal so Maxim/TrustOTP can recover from webhook drift without operator intervention.

**Architecture:** Two existing workers extended in place. `reseller-portal` gains three new authenticated endpoints + UI elements. `reseller-sync` gains two new service-binding-only endpoints reusing its existing `sendWebhookWithDeduplication` pipeline (with `force=true`, so each call always re-emits). Schema adds `source` + `sim_id` columns to `webhook_deliveries` and a new `reseller_actions_log` table for rate-limit accounting.

**Tech Stack:** Cloudflare Workers (JS), Supabase Postgres (PostgREST), Tailwind CSS (via CDN, in portal HTML). No test framework — verification is via syntax checks (`node --check`, `_check_portal_frontend.js`, `_check_relay.js`), `npm run check:db-constraints`, and manual smoke tests against the `test` environment workers (`reseller-portal-test`, `reseller-sync-test`).

**Reference spec:** `docs/superpowers/specs/2026-05-25-reseller-portal-resend-design.md`

---

## Pre-flight: codebase facts you must know

Read these before starting Task 1. They are referenced repeatedly below.

1. **Worker entry points:**
   - `src/reseller-portal/index.js` (878 lines) — single file, contains both backend handlers and `portalHtml()` which returns the SPA HTML string.
   - `src/reseller-sync/index.js` (544 lines) — single file, has `fetch()` handler that today only routes `/run`.

2. **No tests exist in this repo.** Do not attempt to write Jest/Vitest tests — there is no harness. Verification commands per task are syntax checks and smoke tests against the deployed `*-test` environment.

3. **Deployment is per-worker via wrangler:** `cd src/<worker> && npx wrangler deploy --env=""` (prod) or `--env test` (test). Test environment worker names are `<name>-test` (e.g. `reseller-portal-test`).

4. **PostgREST traps:**
   - Server caps responses at 1000 rows regardless of `&limit` — use offset pagination if needed.
   - 3s statement timeout silently returns `[]` for jsonb-path filters without a functional index. **This plan adds a real `sim_id` column instead of relying on `payload->data->>sim_id`** to avoid this trap.

5. **Existing webhook dispatch flow** (in `src/reseller-sync/index.js`):
   - Lines 107-132: payload builder for `number.online` (canonical shape — match it exactly when extracting).
   - Lines 426-470: `sendWebhookWithDeduplication(env, webhookUrl, payload, options)` — does message-ID generation, dedup lookup, retry, and writes to `webhook_deliveries`. Pass `force: true` to bypass dedup.
   - Lines 342-366: `recordWebhookDelivery(env, delivery)` — writes the audit row. Must be extended to carry `source` and `sim_id`.

6. **Relay rule** (per `agent/constraints.md §11`): ANY external API POST must use `relayFetch(env, url, init)`. The existing dispatch path at line 378 already uses it — by reusing `sendWebhookWithDeduplication` we inherit this.

7. **Patch rule:** This plan touches `reseller-portal/index.js` and `reseller-sync/index.js`. **Neither is `src/dashboard/index.js`**, so the `patch-dashboard` skill is NOT required and must NOT be invoked.

8. **Authentication:** `authenticate(request, env)` in `src/reseller-portal/index.js:141` returns `{resellerId, name}` from either `rsk_*` API key or `rps_*` HMAC session cookie. All new endpoints reuse it as-is.

9. **No native dialogs** (memory `feedback_no_native_dialogs.md`): never `alert()` / `confirm()` / `prompt()`. The portal frontend has no `showConfirm()/showToast()` helpers today — this plan adds minimal inline-modal helpers as part of Task 10.

10. **Existing `reseller_sims` columns** (verified): `reseller_id`, `sim_id`, `active`, `created_at`, `last_number_online_sent_at`, `last_rental_id`. Use these — do not invent new columns.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `migrations/<timestamp>_reseller_portal_resend.sql` | Create (via MCP) | Adds `webhook_deliveries.source`, `webhook_deliveries.sim_id`, backfills `sim_id` from payload, creates `reseller_actions_log` |
| `src/reseller-sync/index.js` | Modify | Add `/resend-online` + `/resync-reseller` routes; extend `recordWebhookDelivery` to persist `source` + `sim_id`; new `resendOneSim()` helper extracted from `runResellerSync` |
| `src/reseller-portal/wrangler.toml` | Modify | Add `[[services]] binding="RESELLER_SYNC"` to both prod and `[env.test]` |
| `src/reseller-portal/index.js` | Modify | Add 3 new endpoints, rate-limit helper, UI buttons + history modal section |

No new shared modules; the work fits cleanly within two existing files.

---

## Task 1: Database migration — add columns + rate-limit table

**Files:**
- Create: Supabase migration named `reseller_portal_resend` (applied via `mcp__supabase__apply_migration`)

- [ ] **Step 1: Verify current webhook_deliveries schema**

Run via MCP:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='webhook_deliveries' ORDER BY ordinal_position;
```
Expected columns: `id, message_id, event_type, reseller_id, webhook_url, payload, status, attempts, last_attempt_at, delivered_at, created_at, response_body`.
If `source` or `sim_id` already exist, **stop and re-read this plan** — schema is out of sync.

- [ ] **Step 2: Apply migration**

Use `mcp__supabase__apply_migration` with name `reseller_portal_resend` and this body:

```sql
-- Add source column to track who triggered each webhook delivery.
-- 'cron' = scheduled reseller-sync backstop; 'pipeline' = rotation-driven (mdn-rotator, teltik-worker, details-finalizer);
-- 'portal_resend' = single-SIM resend from reseller portal; 'portal_resync' = bulk resync from reseller portal.
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'cron';

-- Add sim_id column so the per-SIM history endpoint can filter without jsonb-path queries
-- (jsonb-path filters silently hit the PostgREST 3s timeout — see memory postgrest_statement_timeout.md).
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS sim_id bigint;

-- Backfill sim_id from existing payload jsonb for number.online / number.offline rows
-- (events that carry data.sim_id). Other event types leave sim_id NULL.
UPDATE webhook_deliveries
SET sim_id = (payload->'data'->>'sim_id')::bigint
WHERE sim_id IS NULL
  AND event_type IN ('number.online', 'number.offline')
  AND payload->'data'->>'sim_id' ~ '^[0-9]+$';

-- Index for the per-SIM history endpoint (event_type filter + sim_id filter + created_at order).
CREATE INDEX IF NOT EXISTS webhook_deliveries_sim_id_event_created_idx
  ON webhook_deliveries (sim_id, event_type, created_at DESC)
  WHERE sim_id IS NOT NULL;

-- Index for source filtering (operator queries like "show me what cron sent vs what portal sent").
CREATE INDEX IF NOT EXISTS webhook_deliveries_source_created_idx
  ON webhook_deliveries (source, created_at DESC);

-- Rate-limit accounting table. One row per accepted action.
-- Read-side queries: "how many portal_resync rows for reseller R in the last 10 min" and
-- "how many portal_resend rows for reseller R + sim S in the last 5 min" and
-- "how many portal_resend rows for reseller R in the last 60 min".
CREATE TABLE IF NOT EXISTS reseller_actions_log (
  id          bigserial PRIMARY KEY,
  reseller_id bigint NOT NULL,
  action      text NOT NULL CHECK (action IN ('portal_resend', 'portal_resync')),
  sim_id      bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reseller_actions_log_reseller_action_created_idx
  ON reseller_actions_log (reseller_id, action, created_at DESC);

CREATE INDEX IF NOT EXISTS reseller_actions_log_reseller_sim_created_idx
  ON reseller_actions_log (reseller_id, sim_id, created_at DESC)
  WHERE sim_id IS NOT NULL;
```

- [ ] **Step 3: Verify migration landed**

```sql
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_name='webhook_deliveries' AND column_name IN ('source','sim_id');
SELECT count(*) FROM webhook_deliveries WHERE event_type='number.online' AND sim_id IS NOT NULL;
SELECT count(*) FROM webhook_deliveries WHERE event_type='number.online' AND sim_id IS NULL;
```
Expected: two `webhook_deliveries` rows returned (source + sim_id). Backfill count should be large (every historical number.online row); null count should only cover rows missing `data.sim_id` in payload (likely 0 or few).

```sql
SELECT count(*) FROM reseller_actions_log;
```
Expected: 0.

- [ ] **Step 4: Run constraint checker**

```bash
cd /home/zalmen/projects/incomingsms && npm run check:db-constraints
```
Expected: passes. If it complains about the new columns, fix code drift in the dashboard's expected schema before continuing (memory `feedback_verify_db_constraints.md`).

- [ ] **Step 5: Commit**

The migration is stored server-side by Supabase; commit a note so the repo history reflects it:
```bash
cd /home/zalmen/projects/incomingsms
git commit --allow-empty -m "db: migration reseller_portal_resend (source/sim_id on webhook_deliveries + reseller_actions_log)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extend `recordWebhookDelivery` to carry source + sim_id

**Files:**
- Modify: `src/reseller-sync/index.js:342-366` (function `recordWebhookDelivery`)

- [ ] **Step 1: Read the current implementation**

Open `src/reseller-sync/index.js` and confirm `recordWebhookDelivery` matches the version shown in the spec's §5.5 (lines 342-366). If it has drifted, adapt the patch below accordingly.

- [ ] **Step 2: Replace the function body to accept new fields**

Replace lines 342-366 with:

```javascript
async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts } = delivery;

  // source: who triggered this delivery. Defaults to 'cron' for backward compat with callers
  // that haven't been updated. Callers from the resend pipeline pass 'portal_resend' or 'portal_resync'.
  // The rotation pipeline (mdn-rotator, teltik-worker, details-finalizer) should pass 'pipeline'.
  const source = delivery.source || 'cron';

  // sim_id: extracted from payload.data.sim_id when present so the per-SIM history endpoint
  // can filter via a real indexed column instead of jsonb-path (which hits PostgREST 3s timeout).
  let simId = delivery.simId;
  if (simId == null && payload && payload.data && payload.data.sim_id != null) {
    const n = Number(payload.data.sim_id);
    simId = Number.isFinite(n) ? n : null;
  }

  await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_deliveries`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      message_id: messageId,
      event_type: eventType,
      reseller_id: resellerId,
      webhook_url: webhookUrl,
      payload,
      status,
      attempts,
      source,
      sim_id: simId,
      last_attempt_at: new Date().toISOString(),
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      response_body: delivery.responseBody ? String(delivery.responseBody).slice(0, 2000) : null,
    }),
  });
}
```

- [ ] **Step 3: Update `sendWebhookWithDeduplication` to forward source + simId**

In `src/reseller-sync/index.js`, find the call to `recordWebhookDelivery` inside `sendWebhookWithDeduplication` (around line 455). Extend the object to forward the new fields from `options`:

Replace:
```javascript
    await recordWebhookDelivery(env, {
      messageId,
      eventType: payload.event_type,
      resellerId: options.resellerId,
      webhookUrl,
      payload,
      status: result.ok ? 'delivered' : 'failed',
      attempts: result.attempts,
      responseBody: result.responseBody || null,
    });
```

With:
```javascript
    await recordWebhookDelivery(env, {
      messageId,
      eventType: payload.event_type,
      resellerId: options.resellerId,
      simId: options.simId,
      source: options.source,
      webhookUrl,
      payload,
      status: result.ok ? 'delivered' : 'failed',
      attempts: result.attempts,
      responseBody: result.responseBody || null,
    });
```

- [ ] **Step 4: Pass `simId` from the existing cron-side caller so backfill stays consistent**

In `runResellerSync` (around line 124-132), update the options object passed to `sendWebhookWithDeduplication`:

Replace:
```javascript
      }, {
        idComponents: {
          simId,
          iccid: sim.iccid,
          number: currentNumber,
        },
        resellerId,
        force,
      });
```

With:
```javascript
      }, {
        idComponents: {
          simId,
          iccid: sim.iccid,
          number: currentNumber,
        },
        resellerId,
        simId,
        source: 'cron',
        force,
      });
```

- [ ] **Step 5: Syntax check**

```bash
cd /home/zalmen/projects/incomingsms
node --check src/reseller-sync/index.js
node _check_relay.js
```
Expected: both exit 0. The relay check confirms no bare `fetch()` was introduced; the existing patched function still uses Supabase REST (which is allow-listed).

- [ ] **Step 6: Commit**

```bash
git add src/reseller-sync/index.js
git commit -m "reseller-sync: thread source + sim_id through recordWebhookDelivery

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract `resendOneSim()` helper from `runResellerSync`

**Files:**
- Modify: `src/reseller-sync/index.js` (add new function below `runResellerSync`, around line 200)

The cron-side payload builder is currently inline inside `runResellerSync`. Extract it so the resend endpoints can call the exact same shape without duplicating logic.

- [ ] **Step 1: Add the new helper function**

Insert this function in `src/reseller-sync/index.js` immediately after the closing brace of `runResellerSync` (around line 201):

```javascript
/**
 * Re-emit number.online for a single SIM, identified by sim_id.
 *
 * Used by the portal-driven resend endpoints. Always passes force=true to sendWebhookWithDeduplication,
 * so the dedup cache is bypassed and the webhook is re-fired even if we already delivered today.
 * Does NOT update sims.last_notified_at (so the cron's natural cadence isn't perturbed); does update
 * reseller_sims.last_rental_id if the reseller's response carries a rentalId — same as the cron path.
 *
 * Returns { ok, status, attempts, error, responseBody, rental_id }.
 */
async function resendOneSim(env, simId, source) {
  // Source must be one of the portal_* tags; reject misuse so cron-side callers don't accidentally
  // hit this helper.
  if (source !== 'portal_resend' && source !== 'portal_resync') {
    return { ok: false, status: 0, attempts: 0, error: `Invalid source: ${source}` };
  }

  // Fetch the SIM + its current number + reseller webhook in one query, mirroring runResellerSync's
  // select shape (line 59-62) but constrained to a single sim_id.
  const rows = await sbGetArray(
    env,
    `sims?select=id,iccid,status,vendor,rotation_interval_hours,last_mdn_rotated_at,last_rotation_at,sim_numbers!inner(e164),reseller_sims!inner(reseller_id,resellers!inner(reseller_webhooks(url,enabled)))` +
    `&id=eq.${encodeURIComponent(simId)}` +
    `&sim_numbers.valid_to=is.null` +
    `&reseller_sims.active=eq.true` +
    `&limit=1`
  );

  if (!rows.length) {
    return { ok: false, status: 404, attempts: 0, error: 'SIM not found, not active, or has no current number' };
  }

  const sim = rows[0];
  const currentNumber = sim.sim_numbers?.[0]?.e164;
  const resellerId = sim.reseller_sims?.[0]?.reseller_id;
  const webhook = sim.reseller_sims?.[0]?.resellers?.reseller_webhooks?.find(w => w.enabled);
  const webhookUrl = webhook?.url;

  if (!currentNumber) return { ok: false, status: 404, attempts: 0, error: 'No current number on this SIM' };
  if (!resellerId)    return { ok: false, status: 404, attempts: 0, error: 'No reseller assigned to this SIM' };
  if (!webhookUrl)    return { ok: false, status: 412, attempts: 0, error: 'Reseller has no enabled webhook configured' };

  // Same payload shape as runResellerSync's cron path (lines 107-123) — keep these in sync.
  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      sim_id: sim.id,
      iccid: sim.iccid,
      number: currentNumber,
      status: sim.status,
      online: true,
      online_until: midnightNYAfterInterval(sim.last_rotation_at || sim.last_mdn_rotated_at, sim.rotation_interval_hours || 24),
      carrier: sim.vendor === 'teltik' ? 'T-Mobile' : 'att',
      verified: true,
    },
  }, {
    idComponents: {
      simId: sim.id,
      iccid: sim.iccid,
      number: currentNumber,
      // Salt the dedup key with a timestamp so each manual resend gets a unique message_id;
      // otherwise the per-day dedup would short-circuit before reaching the network.
      from: `portal_${Date.now()}`,
    },
    resellerId,
    simId: sim.id,
    source,
    force: true,
  });

  // Persist rentalId echoed back by the reseller (whether new or same as last) — matches the cron
  // path at runResellerSync lines 149-160.
  let rentalId = null;
  if (result.ok && !result.skipped) {
    rentalId = parseRentalIdFromResponse(result.responseBody);
    if (rentalId != null) {
      await fetch(`${env.SUPABASE_URL}/rest/v1/reseller_sims?reseller_id=eq.${resellerId}&sim_id=eq.${sim.id}`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_rental_id: rentalId }),
      }).catch(err => console.log(`[Resend] Failed to write last_rental_id for sim ${sim.id}: ${err}`));
    }
  }

  return {
    ok: !!result.ok,
    status: result.status || 0,
    attempts: result.attempts || 0,
    error: result.error || null,
    responseBody: result.responseBody || null,
    rental_id: rentalId,
    sim_id: sim.id,
    reseller_id: resellerId,
    number: currentNumber,
  };
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/reseller-sync/index.js
node _check_relay.js
```
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/reseller-sync/index.js
git commit -m "reseller-sync: extract resendOneSim helper for portal-driven re-emit

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Add `/resend-online` and `/resync-reseller` routes to reseller-sync

**Files:**
- Modify: `src/reseller-sync/index.js:7-41` (the `export default { fetch, scheduled }` block)

These endpoints are reachable only via service binding (and via test curl with the `FINALIZER_RUN_SECRET` so we can smoke-test them directly). Defense in depth: require the `X-Internal-Caller: reseller-portal` header so an accidentally-public deployment can't be hit blind.

- [ ] **Step 1: Replace the `fetch()` handler**

Replace lines 8-27 of `src/reseller-sync/index.js` with:

```javascript
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const internalCaller = request.headers.get('X-Internal-Caller') || '';

    // --- Public-ish endpoint: secret-guarded daily backstop trigger. Unchanged from prior behavior. ---
    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 2000, 1) : 2000;
      const force = url.searchParams.get("force") === "true";
      const online = await runResellerSync(env, limit, force);
      const offline = await runOfflineRetrySweep(env);
      return json({ ok: true, online, offline }, 200);
    }

    // --- Service-binding-only endpoints. ---
    // Either internal-caller header OR FINALIZER_RUN_SECRET (for direct curl smoke tests).
    const secret = url.searchParams.get("secret") || "";
    const internalOk = internalCaller === 'reseller-portal' || (env.FINALIZER_RUN_SECRET && secret === env.FINALIZER_RUN_SECRET);

    if (url.pathname === "/resend-online" && request.method === 'POST') {
      if (!internalOk) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const simId = body && body.simId;
      const source = body && body.source;
      if (!simId || !Number.isFinite(Number(simId))) return json({ ok: false, error: 'simId required' }, 400);
      if (source !== 'portal_resend' && source !== 'portal_resync') return json({ ok: false, error: 'source must be portal_resend or portal_resync' }, 400);
      try {
        const result = await resendOneSim(env, Number(simId), source);
        return json(result, result.ok ? 200 : (result.status === 404 ? 404 : 500));
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (url.pathname === "/resync-reseller" && request.method === 'POST') {
      if (!internalOk) return new Response("Unauthorized", { status: 401 });
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const resellerId = body && body.resellerId;
      if (!resellerId || !Number.isFinite(Number(resellerId))) return json({ ok: false, error: 'resellerId required' }, 400);
      try {
        const result = await resyncReseller(env, Number(resellerId));
        return json(result, 200);
      } catch (e) {
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    return new Response("reseller-sync ok. Use /run?secret=...&limit=2000&force=false", { status: 200 });
  },
```

- [ ] **Step 2: Add the `resyncReseller` function**

Insert below `resendOneSim` (added in Task 3):

```javascript
/**
 * Re-emit number.online for every currently-active SIM owned by `resellerId`, in bounded-concurrency
 * batches. Calls resendOneSim for each. Returns aggregate counts + per-SIM results.
 *
 * Concurrency cap (5) chosen so a 1300-SIM reseller (TrustOTP) completes in ~roughly 4-5 minutes
 * worst case while keeping the CF Worker wall-clock + the reseller's endpoint load reasonable.
 * If we ever exceed the 30s sub-request cap in practice, switch to ctx.waitUntil with a job table —
 * see spec §12 open question.
 */
async function resyncReseller(env, resellerId) {
  const startedAt = new Date().toISOString();

  // Get every active sim_id this reseller currently owns.
  const rows = await sbGetArray(
    env,
    `reseller_sims?select=sim_id&reseller_id=eq.${encodeURIComponent(resellerId)}&active=eq.true&order=sim_id.asc&limit=2000`
  );
  const simIds = rows.map(r => r.sim_id).filter(id => Number.isFinite(Number(id)));

  let succeeded = 0;
  let failed = 0;
  const results = [];

  const CONCURRENCY = 5;
  for (let i = 0; i < simIds.length; i += CONCURRENCY) {
    const slice = simIds.slice(i, i + CONCURRENCY);
    const batch = await Promise.all(slice.map(async simId => {
      try {
        return await resendOneSim(env, simId, 'portal_resync');
      } catch (e) {
        return { ok: false, sim_id: simId, error: String(e) };
      }
    }));
    for (const r of batch) {
      if (r.ok) succeeded++; else failed++;
      results.push({
        sim_id: r.sim_id,
        ok: r.ok,
        status: r.status || 0,
        error: r.error || null,
        rental_id: r.rental_id || null,
      });
    }
  }

  return {
    ok: true,
    startedAt,
    reseller_id: resellerId,
    queued: simIds.length,
    succeeded,
    failed,
    results,
  };
}
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-sync/index.js
node _check_relay.js
```
Expected: both exit 0.

- [ ] **Step 4: Deploy to test environment**

```bash
cd src/reseller-sync && npx wrangler deploy --env test
```
Expected: deploys as `reseller-sync-test`. Confirm in output.

- [ ] **Step 5: Smoke test against test env**

Pick a known active sim_id owned by a low-volume test reseller (NOT Maxim's account). Query Supabase for one:
```sql
SELECT rs.sim_id, rs.reseller_id, r.name
FROM reseller_sims rs JOIN resellers r ON r.id = rs.reseller_id
WHERE rs.active = true AND r.name NOT ILIKE '%trustotp%' AND r.name NOT ILIKE '%maxim%'
LIMIT 5;
```

Then:
```bash
curl -X POST "https://reseller-sync-test.zalmen-531.workers.dev/resend-online?secret=$FINALIZER_RUN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"simId":<PICKED_SIM_ID>,"source":"portal_resend"}'
```
Expected: HTTP 200 with `{ok: true, status: 200, rental_id: <some_number_or_null>, ...}`. If the reseller's test webhook is unreachable, you'll see `ok: false, status: 5xx` — that's still proof the routing works.

Then verify the row landed:
```sql
SELECT id, source, sim_id, status, response_body, created_at
FROM webhook_deliveries
WHERE source = 'portal_resend'
ORDER BY created_at DESC LIMIT 1;
```
Expected: one row matching your call.

- [ ] **Step 6: Smoke test resync-reseller**

```bash
curl -X POST "https://reseller-sync-test.zalmen-531.workers.dev/resync-reseller?secret=$FINALIZER_RUN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"resellerId":<PICKED_RESELLER_ID>}'
```
Expected: HTTP 200 with `{ok: true, queued: N, succeeded: M, failed: K, results: [...]}`.

If the reseller has zero active SIMs, expect `queued: 0`. Verify in DB:
```sql
SELECT count(*) FROM webhook_deliveries WHERE source = 'portal_resync' AND created_at > now() - interval '5 minutes';
```

- [ ] **Step 7: Commit**

```bash
git add src/reseller-sync/index.js
git commit -m "reseller-sync: add /resend-online + /resync-reseller endpoints (service-binding only)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Add RESELLER_SYNC service binding to reseller-portal

**Files:**
- Modify: `src/reseller-portal/wrangler.toml`

- [ ] **Step 1: Read current wrangler.toml**

```bash
cat /home/zalmen/projects/incomingsms/src/reseller-portal/wrangler.toml
```

- [ ] **Step 2: Add service binding to both prod and test env**

Use the Edit tool to add to `src/reseller-portal/wrangler.toml`. After the `[observability.logs]` block (around line 16) but before the `# ============ TEST ENVIRONMENT ============` line, insert:

```toml

# Service binding so portal can call reseller-sync without going over public HTTP.
[[services]]
binding = "RESELLER_SYNC"
service = "reseller-sync"
```

Then, after the `name = "reseller-portal-test"` line in the `[env.test]` block, insert:

```toml

[[env.test.services]]
binding = "RESELLER_SYNC"
service = "reseller-sync-test"
```

- [ ] **Step 3: Validate wrangler config**

```bash
cd src/reseller-portal && npx wrangler deploy --dry-run --env test 2>&1 | tail -20
```
Expected: dry-run succeeds; output mentions `RESELLER_SYNC` binding. If it errors about binding to a non-existent service, confirm `reseller-sync-test` was deployed in Task 4.

- [ ] **Step 4: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/wrangler.toml
git commit -m "reseller-portal: add RESELLER_SYNC service binding (prod + test)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Add rate-limit helpers to reseller-portal

**Files:**
- Modify: `src/reseller-portal/index.js` (add new functions near the other helpers, around line 45)

- [ ] **Step 1: Add `sbPost` helper (used by the rate-limit logger)**

Find `sbGetAll` at line 31 in `src/reseller-portal/index.js`. Insert immediately after it:

```javascript
async function sbPost(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('PostgREST POST ' + res.status + ': ' + t);
  }
}
```

- [ ] **Step 2: Add rate-limit check + log helpers**

Insert below `sbPost`:

```javascript
// --- Rate limits ---
// All windows expressed in seconds; counts are read from reseller_actions_log.
// Per spec §5.6:
//   portal_resync : 1 per reseller per 600s
//   portal_resend : 1 per (reseller, sim_id) per 300s AND 100 per reseller per 3600s
// On violation we return a structured object that the caller turns into HTTP 429.

async function countActionsSince(env, resellerId, action, sinceIsoSeconds, simId = null) {
  const since = new Date(Date.now() - sinceIsoSeconds * 1000).toISOString();
  let path =
    'reseller_actions_log?select=id' +
    '&reseller_id=eq.' + encodeURIComponent(resellerId) +
    '&action=eq.' + encodeURIComponent(action) +
    '&created_at=gte.' + encodeURIComponent(since);
  if (simId != null) path += '&sim_id=eq.' + encodeURIComponent(simId);
  path += '&limit=1000';
  const resp = await sbGet(env, path);
  if (!resp.ok) return 0;
  const rows = await resp.json();
  return Array.isArray(rows) ? rows.length : 0;
}

async function checkRateLimit(env, resellerId, action, simId = null) {
  if (action === 'portal_resync') {
    const recent = await countActionsSince(env, resellerId, 'portal_resync', 600);
    if (recent >= 1) return { allowed: false, retryAfter: 600, reason: 'Bulk resync allowed once per 10 minutes' };
    return { allowed: true };
  }
  if (action === 'portal_resend') {
    if (simId != null) {
      const perSim = await countActionsSince(env, resellerId, 'portal_resend', 300, simId);
      if (perSim >= 1) return { allowed: false, retryAfter: 300, reason: 'This SIM was resent within the last 5 minutes' };
    }
    const perHour = await countActionsSince(env, resellerId, 'portal_resend', 3600);
    if (perHour >= 100) return { allowed: false, retryAfter: 3600, reason: 'Per-reseller resend cap (100/hour) reached' };
    return { allowed: true };
  }
  return { allowed: true };
}

async function logAction(env, resellerId, action, simId = null) {
  try {
    await sbPost(env, 'reseller_actions_log', {
      reseller_id: Number(resellerId),
      action,
      sim_id: simId != null ? Number(simId) : null,
    });
  } catch (e) {
    console.log('[RateLimit] failed to log action: ' + e);
  }
}
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_relay.js
node _check_portal_frontend.js
```
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/reseller-portal/index.js
git commit -m "reseller-portal: add rate-limit helpers (sbPost, countActionsSince, checkRateLimit, logAction)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Add `/api/sims/:simId/resend-online` endpoint

**Files:**
- Modify: `src/reseller-portal/index.js` (add handler function + route registration)

- [ ] **Step 1: Add the handler function**

In `src/reseller-portal/index.js`, after `handleSimLifetime` (around line 456), add:

```javascript
async function handleResendOnline(simId, auth, env) {
  // 1. Ownership check — reseller must own this SIM and it must currently be active.
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id,active' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&active=eq.true' +
    '&limit=1'
  );
  if (!ownResp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const ownRows = await ownResp.json();
  if (!Array.isArray(ownRows) || ownRows.length === 0) {
    return jsonResp({ error: 'SIM not owned by this reseller or not currently active' }, 404);
  }

  // 2. Rate-limit check. Reject BEFORE calling reseller-sync (and before logging).
  const rl = await checkRateLimit(env, auth.resellerId, 'portal_resend', simId);
  if (!rl.allowed) {
    return jsonResp({ error: rl.reason, retry_after_seconds: rl.retryAfter }, 429);
  }

  // 3. Service-binding call to reseller-sync. Defense-in-depth header per Task 4's auth check.
  if (!env.RESELLER_SYNC) return jsonResp({ error: 'RESELLER_SYNC binding not configured' }, 500);
  let result;
  try {
    const upstream = await env.RESELLER_SYNC.fetch('https://reseller-sync.internal/resend-online', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Caller': 'reseller-portal' },
      body: JSON.stringify({ simId: Number(simId), source: 'portal_resend' }),
    });
    result = await upstream.json().catch(() => ({ ok: false, error: 'Non-JSON response from reseller-sync' }));
    if (!upstream.ok && !result.error) result.error = 'reseller-sync HTTP ' + upstream.status;
  } catch (e) {
    return jsonResp({ error: 'Resend pipeline unavailable: ' + String(e) }, 502);
  }

  // 4. Log the accepted action (whether or not the webhook delivered — the *attempt* counts).
  await logAction(env, auth.resellerId, 'portal_resend', simId);

  return jsonResp({
    ok: !!result.ok,
    delivered: !!result.ok,
    http_status: result.status || 0,
    rental_id: result.rental_id || null,
    error: result.error || null,
    note: 'Your system may return the same rental ID (replay) or a new one (treated as a fresh rental). We record whichever you return.',
  }, result.ok ? 200 : 502);
}
```

- [ ] **Step 2: Register the route**

In the `fetch()` block at the bottom of the file (around line 856-865), inside `if (url.pathname.startsWith('/api/'))`, add this route line right after the existing `/api/sims/:simId/lifetime` route:

Find:
```javascript
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/lifetime$/))) return handleSimLifetime(m[1], auth, env);
```

Add immediately after it:
```javascript
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/resend-online$/)) && request.method === 'POST') return handleResendOnline(m[1], auth, env);
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_relay.js
node _check_portal_frontend.js
```
Expected: all exit 0.

- [ ] **Step 4: Deploy + smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
```

Test with a session cookie or API key for a non-Maxim reseller. Use a key:
```bash
curl -X POST "https://reseller-portal-test.zalmen-531.workers.dev/api/sims/<simId>/resend-online" \
  -H "Authorization: Bearer rsk_<test_reseller_key>"
```
Expected: HTTP 200 with `{ok: true, delivered: true|false, http_status: 200, rental_id: ...}`.

Try it again within 5 minutes:
Expected: HTTP 429 with `{error: 'This SIM was resent within the last 5 minutes', retry_after_seconds: 300}`.

Try it against a sim_id owned by a different reseller:
Expected: HTTP 404 with `{error: 'SIM not owned by this reseller or not currently active'}`.

- [ ] **Step 5: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/index.js
git commit -m "reseller-portal: add POST /api/sims/:simId/resend-online (single-SIM resend)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Add `/api/sims/resync-all` endpoint

**Files:**
- Modify: `src/reseller-portal/index.js`

- [ ] **Step 1: Add the handler function**

Below `handleResendOnline` (added in Task 7), add:

```javascript
async function handleResyncAll(auth, env) {
  // Rate-limit first. Bulk is the more dangerous call; reject early.
  const rl = await checkRateLimit(env, auth.resellerId, 'portal_resync');
  if (!rl.allowed) {
    return jsonResp({ error: rl.reason, retry_after_seconds: rl.retryAfter }, 429);
  }

  if (!env.RESELLER_SYNC) return jsonResp({ error: 'RESELLER_SYNC binding not configured' }, 500);

  let result;
  try {
    const upstream = await env.RESELLER_SYNC.fetch('https://reseller-sync.internal/resync-reseller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Caller': 'reseller-portal' },
      body: JSON.stringify({ resellerId: Number(auth.resellerId) }),
    });
    result = await upstream.json().catch(() => ({ ok: false, error: 'Non-JSON response from reseller-sync' }));
    if (!upstream.ok && !result.error) result.error = 'reseller-sync HTTP ' + upstream.status;
  } catch (e) {
    return jsonResp({ error: 'Resync pipeline unavailable: ' + String(e) }, 502);
  }

  // Log AFTER the upstream call returns so a 502 doesn't burn the user's 10-minute window.
  // The cost is a small race: two simultaneous resyncs could both reach reseller-sync before
  // either logs. Acceptable: bulk-resync is idempotent on the reseller's side (TrustOTP dedups
  // by rentalId/MDN), and a true panic-double-click is rare and rate-bounded by the upstream
  // worker's wall-clock anyway.
  await logAction(env, auth.resellerId, 'portal_resync', null);

  return jsonResp({
    ok: !!result.ok,
    queued: result.queued || 0,
    succeeded: result.succeeded || 0,
    failed: result.failed || 0,
    // Don't return the full per-SIM results array to the client — it can be 1300+ entries for TrustOTP
    // and the portal only needs aggregate counts. Operators can query webhook_deliveries directly.
  }, 200);
}
```

- [ ] **Step 2: Register the route**

In the `fetch()` block, immediately after the `/api/sims` route (around line 860), add:

Find:
```javascript
      if (url.pathname === '/api/sims') return handleSims(auth, env, url);
```

Add immediately after it:
```javascript
      if (url.pathname === '/api/sims/resync-all' && request.method === 'POST') return handleResyncAll(auth, env);
```

**Important:** This must come BEFORE the regex-matched `/api/sims/:simId/...` routes so the literal path matches first.

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_relay.js
node _check_portal_frontend.js
```
Expected: all exit 0.

- [ ] **Step 4: Deploy + smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
```

```bash
curl -X POST "https://reseller-portal-test.zalmen-531.workers.dev/api/sims/resync-all" \
  -H "Authorization: Bearer rsk_<test_reseller_key>"
```
Expected: HTTP 200 with `{ok: true, queued: N, succeeded: M, failed: K}`.

Hit it again within 10 minutes:
Expected: HTTP 429 with `{error: 'Bulk resync allowed once per 10 minutes', retry_after_seconds: 600}`.

- [ ] **Step 5: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/index.js
git commit -m "reseller-portal: add POST /api/sims/resync-all (bulk resync)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Add `/api/sims/:simId/online-history` endpoint

**Files:**
- Modify: `src/reseller-portal/index.js`

- [ ] **Step 1: Add the handler function**

Below `handleResyncAll`, add:

```javascript
async function handleOnlineHistory(simId, auth, env) {
  // Ownership check (historical: even if the SIM is no longer active, the reseller is allowed
  // to see deliveries that happened while they owned it). We still require an active or past
  // ownership row.
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&limit=1'
  );
  if (!ownResp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const ownRows = await ownResp.json();
  if (!Array.isArray(ownRows) || ownRows.length === 0) {
    return jsonResp({ error: 'SIM not owned by this reseller' }, 404);
  }

  // Filter via the real sim_id column (added in Task 1 migration). Also filter reseller_id as
  // belt-and-suspenders so a backfill that misset sim_id can't leak cross-reseller rows.
  const resp = await sbGet(env,
    'webhook_deliveries?select=created_at,sim_id,reseller_id,status,response_body,source,payload' +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&event_type=eq.number.online' +
    '&order=created_at.desc' +
    '&limit=20'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();

  // Parse rentalId from response_body using the same helper logic as reseller-sync. Inline
  // here rather than import — the shared module would be one function and complicate the worker
  // dependency graph for very little gain.
  function parseRentalId(body) {
    if (!body) return null;
    const s = String(body);
    try {
      const obj = JSON.parse(s);
      const v = obj && (obj.rentalId ?? obj.rental_id ?? obj.id);
      if (v != null) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {}
    const m = s.match(/"rental[_]?[Ii]d"\s*:\s*([0-9]+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  const out = (Array.isArray(rows) ? rows : []).map(r => {
    const rentalId = parseRentalId(r.response_body);
    return {
      delivered_at: r.created_at,
      msisdn_at_send: r.payload?.data?.number || null,
      http_status: r.status === 'delivered' ? 200 : 0,  // status is text ('delivered'|'failed'|'pending'); response_body holds the real numeric status only when present
      rental_id: rentalId,
      source: r.source || 'cron',
      delivered: r.status === 'delivered' && rentalId != null,
    };
  });

  return jsonResp(out);
}
```

- [ ] **Step 2: Register the route**

In the `fetch()` block, alongside the other regex-matched `/api/sims/:simId/...` routes, add:

```javascript
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/online-history$/))) return handleOnlineHistory(m[1], auth, env);
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_relay.js
node _check_portal_frontend.js
```

- [ ] **Step 4: Deploy + smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
curl "https://reseller-portal-test.zalmen-531.workers.dev/api/sims/<simId>/online-history" \
  -H "Authorization: Bearer rsk_<test_reseller_key>"
```
Expected: HTTP 200 with a JSON array of up to 20 history rows. If the SIM is fresh, expect `[]`.

Cross-reseller probe:
```bash
curl "https://reseller-portal-test.zalmen-531.workers.dev/api/sims/<other-reseller-simId>/online-history" \
  -H "Authorization: Bearer rsk_<test_reseller_key>"
```
Expected: HTTP 404.

- [ ] **Step 5: Commit**

```bash
git add src/reseller-portal/index.js
git commit -m "reseller-portal: add GET /api/sims/:simId/online-history

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: UI — add inline confirm/toast helpers + Resend button per row

**Files:**
- Modify: `src/reseller-portal/index.js` inside `portalHtml()` (lines 516-830)

Per memory `feedback_no_native_dialogs.md` we cannot use `confirm()`. The portal already has a `showModal()/closeModal()` pair (lines 603-617) we can extend.

- [ ] **Step 1: Add `showConfirm` and `showToast` helpers**

Inside the `<script>` block of `portalHtml()`, after the `closeModal()` function definition (around line 616), add:

```javascript
function showToast(message, kind) {
  // kind: 'success' | 'error' | 'info'
  const colorClass = kind === 'success' ? 'bg-emerald-600'
                   : kind === 'error'   ? 'bg-red-600'
                                        : 'bg-slate-700';
  const t = document.createElement('div');
  t.className = 'fixed bottom-6 right-6 z-50 px-4 py-3 rounded shadow-lg text-white text-sm ' + colorClass;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 300ms'; }, 3500);
  setTimeout(() => { t.remove(); }, 4000);
}

function showConfirm(opts) {
  // opts: { title, body, confirmText, cancelText, danger }
  return new Promise(resolve => {
    const confirmText = opts.confirmText || 'Confirm';
    const cancelText  = opts.cancelText  || 'Cancel';
    const btnClass = opts.danger
      ? 'bg-red-600 hover:bg-red-500'
      : 'bg-cyan-600 hover:bg-cyan-500';
    showModal(
      '<h2 class="text-lg font-semibold mb-2">' + esc(opts.title) + '</h2>' +
      '<div class="text-slate-300 text-sm mb-5">' + opts.body + '</div>' +
      '<div class="flex justify-end gap-2">' +
        '<button id="rp-confirm-cancel" class="px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">' + esc(cancelText) + '</button>' +
        '<button id="rp-confirm-ok" class="px-4 py-2 text-sm text-white rounded ' + btnClass + '">' + esc(confirmText) + '</button>' +
      '</div>'
    );
    document.getElementById('rp-confirm-cancel').addEventListener('click', () => { closeModal(); resolve(false); });
    document.getElementById('rp-confirm-ok').addEventListener('click', () => { closeModal(); resolve(true); });
  });
}
```

- [ ] **Step 2: Add `Resend` button to each active-SIM row**

Find `renderSimTable` in `portalHtml()` (around line 653). Replace the function with the version below — it adds an "Actions" column with a Resend button on rows where `opts.showAssigned` is false (i.e. the currently-active table only).

```javascript
function renderSimTable(sims, container, opts) {
  opts = opts || {};
  if (!sims.length) { container.innerHTML = '<div class="text-slate-500 text-sm py-4">None</div>'; return; }
  const showActions = !opts.showAssigned;
  const rows = sims.map(s => {
    const actionsCell = showActions
      ? '<td class="px-3 py-2 text-right"><button onclick="event.stopPropagation(); resendOne(' + s.sim_id + ', this)" class="px-2 py-1 text-xs bg-slate-700 hover:bg-cyan-600 text-slate-200 hover:text-white rounded">Resend</button></td>'
      : '';
    return '<tr class="hover:bg-slate-800 cursor-pointer" onclick="openLifetime(' + s.sim_id + ')">' +
      '<td class="px-3 py-2 text-slate-200 font-mono">' + (s.rental_id != null ? '#' + esc(s.rental_id) : '<span class="text-slate-600">—</span>') + '</td>' +
      '<td class="px-3 py-2 text-slate-200 font-mono">' + esc(s.msisdn || '—') + '</td>' +
      '<td class="px-3 py-2 text-slate-300">' + esc(s.status) + '</td>' +
      '<td class="px-3 py-2 text-slate-400 text-xs">' + (opts.showAssigned ? fmtDate(s.assigned_at) : esc(fmtDateTime(s.start_at))) + '</td>' +
      '<td class="px-3 py-2 text-slate-400 text-xs">' + (opts.showAssigned ? '' : esc(fmtDateTime(s.online_until))) + '</td>' +
      actionsCell +
    '</tr>';
  }).join('');
  const startLabel = opts.showAssigned ? 'Assigned' : 'Start';
  const expiresHeader = opts.showAssigned ? '' : '<th class="px-3 py-2 text-left">Expires</th>';
  const expiresPlaceholder = opts.showAssigned ? '<th class="px-3 py-2"></th>' : '';
  const actionsHeader = showActions ? '<th class="px-3 py-2 text-right">Actions</th>' : '';
  container.innerHTML =
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-800 text-slate-400 text-xs uppercase">' +
    '<tr><th class="px-3 py-2 text-left">Rental ID</th><th class="px-3 py-2 text-left">MDN</th><th class="px-3 py-2 text-left">Status</th><th class="px-3 py-2 text-left">' + startLabel + '</th>' +
    (opts.showAssigned ? expiresPlaceholder : expiresHeader) +
    actionsHeader +
    '</tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + rows + '</tbody></table></div>';
}
```

- [ ] **Step 3: Add the `resendOne` handler in the same `<script>` block**

Below `loadSims` (around line 693), add:

```javascript
async function resendOne(simId, btn) {
  const sim = allSims.find(s => s.sim_id === simId);
  const mdn = sim ? (sim.msisdn || 'unknown') : 'unknown';
  const rental = sim && sim.rental_id != null ? ('#' + sim.rental_id) : '(no rental id yet)';
  const confirmed = await showConfirm({
    title: 'Resend number.online for ' + mdn + '?',
    body: 'This re-fires the number.online webhook to your endpoint for this single SIM. ' +
          'Your system may echo the current rental ID ' + rental + ' (replay) or return a new one (treated as a fresh rental). ' +
          'We will record whichever you return. No MDN swap will occur.',
    confirmText: 'Resend',
  });
  if (!confirmed) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const r = await fetch('/api/sims/' + simId + '/resend-online', { method: 'POST', credentials: 'include' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) {
      showToast('Rate limited: ' + (data.error || 'try again later'), 'error');
    } else if (r.ok && data.ok) {
      showToast('Resent. ' + (data.rental_id != null ? 'Rental ID: ' + data.rental_id : 'No rental ID echoed.'), 'success');
      // Refresh SIMs in the background so any rental_id change shows up.
      loadSims();
    } else {
      showToast('Resend failed: ' + (data.error || ('HTTP ' + r.status)), 'error');
    }
  } catch (e) {
    showToast('Resend failed: ' + (e.message || String(e)), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
  }
}
```

- [ ] **Step 4: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_portal_frontend.js
```
Expected: both exit 0. The portal frontend check actually executes the IIFE and re-validates the embedded `<script>` — it will fail loudly on a backtick / quoting / unescaped issue.

- [ ] **Step 5: Deploy + visual smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
```
Visit `https://reseller-portal-test.zalmen-531.workers.dev/` in a browser. Log in as a test reseller. Confirm:
- Active SIM rows show a "Resend" button on the right.
- Clicking Resend opens the confirm modal with the SIM's MDN.
- Confirming triggers the call; toast appears with result.
- Clicking the row body (not the button) still opens the lifetime modal (because of `event.stopPropagation()` in the button onclick).

- [ ] **Step 6: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/index.js
git commit -m "reseller-portal UI: add per-row Resend button + showConfirm/showToast helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: UI — add "Resync all" and "Download CSV" buttons to SIMs tab

**Files:**
- Modify: `src/reseller-portal/index.js` inside `portalHtml()`

- [ ] **Step 1: Add the buttons to the SIMs tab header**

Find the SIMs tab header in `portalHtml()` (around line 537-541):

```html
    <div class="mb-3 flex items-center gap-3">
      <input id="sim-filter" type="text" placeholder="Filter by Rental ID, MDN, or ICCID" class="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm w-72">
      <span class="text-slate-500 text-xs" id="sim-summary"></span>
      <a href="/logout" class="ml-auto text-xs text-slate-400 hover:text-slate-200">Sign out</a>
    </div>
```

Replace with:

```html
    <div class="mb-3 flex items-center gap-3">
      <input id="sim-filter" type="text" placeholder="Filter by Rental ID, MDN, or ICCID" class="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm w-72">
      <span class="text-slate-500 text-xs" id="sim-summary"></span>
      <button id="csv-btn" onclick="downloadCsv()" class="ml-auto px-3 py-2 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded">Download CSV</button>
      <button id="resync-btn" onclick="resyncAll()" class="px-3 py-2 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded">Resync all</button>
      <a href="/logout" class="text-xs text-slate-400 hover:text-slate-200">Sign out</a>
    </div>
```

- [ ] **Step 2: Add `resyncAll` and `downloadCsv` functions in the `<script>` block**

Below `resendOne` (added in Task 10), add:

```javascript
async function resyncAll() {
  const active = allSims.filter(s => s.active);
  const confirmed = await showConfirm({
    title: 'Resync all ' + active.length + ' active rentals?',
    body: 'This re-fires the number.online webhook for every SIM currently assigned to your account. ' +
          'Your endpoint will receive ' + active.length + ' events over the next few minutes. ' +
          'If your billing/accounting counts events rather than rental IDs, that is your system to manage. ' +
          'You can only run this once per 10 minutes.',
    confirmText: 'Resync ' + active.length + ' rentals',
    danger: true,
  });
  if (!confirmed) return;
  const btn = document.getElementById('resync-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resyncing…'; }
  try {
    const r = await fetch('/api/sims/resync-all', { method: 'POST', credentials: 'include' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 429) {
      showToast('Rate limited: ' + (data.error || 'try again later'), 'error');
    } else if (r.ok && data.ok) {
      showToast('Resync complete: ' + data.succeeded + ' succeeded, ' + data.failed + ' failed (of ' + data.queued + ').',
                data.failed === 0 ? 'success' : 'info');
      loadSims();
    } else {
      showToast('Resync failed: ' + (data.error || ('HTTP ' + r.status)), 'error');
    }
  } catch (e) {
    showToast('Resync failed: ' + (e.message || String(e)), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resync all'; }
  }
}

function downloadCsv() {
  // Snapshot the currently filtered list (matches what's on screen).
  const q = document.getElementById('sim-filter').value.trim().toLowerCase();
  const list = q ? allSims.filter(s =>
    String(s.rental_id||'').toLowerCase().includes(q) ||
    (s.msisdn||'').toLowerCase().includes(q) ||
    (s.iccid||'').toLowerCase().includes(q)
  ) : allSims;
  const csvEscape = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['Rental ID','MDN','Status','Start (UTC)','Expires (UTC)','ICCID','Carrier','Active'];
  const rows = list.map(s => [
    s.rental_id != null ? s.rental_id : '',
    s.msisdn || '',
    s.status || '',
    s.start_at || '',
    s.online_until || '',
    s.iccid || '',
    s.carrier || '',
    s.active ? 'true' : 'false',
  ].map(csvEscape).join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.download = 'rentals-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Downloaded ' + list.length + ' rows.', 'success');
}
```

- [ ] **Step 3: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_portal_frontend.js
```
Expected: both exit 0.

- [ ] **Step 4: Deploy + visual smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
```
Visit the test portal:
- "Resync all" button visible top-right of SIMs tab.
- Clicking it shows a confirm modal with the count.
- Confirming triggers the bulk call; toast shows aggregate result.
- Re-clicking within 10 min shows the rate-limit toast.
- "Download CSV" downloads a file named `rentals-YYYY-MM-DD-HH-MM-SS.csv`; open it and confirm columns match expectations.

- [ ] **Step 5: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/index.js
git commit -m "reseller-portal UI: add 'Resync all' and 'Download CSV' buttons

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: UI — add "Number.online history" section to lifetime modal

**Files:**
- Modify: `src/reseller-portal/index.js` inside `portalHtml()`, function `openLifetime` (around line 802-820)

- [ ] **Step 1: Replace `openLifetime` with the extended version**

Find the existing function (around line 802):

```javascript
async function openLifetime(simId) {
  showModal('<div class="text-slate-400">Loading…</div>');
  const d = await api('/api/sims/' + simId + '/lifetime');
  if (!d) return;
  showModal(
    // ... existing HTML ...
  );
}
```

Replace it entirely with:

```javascript
async function openLifetime(simId) {
  showModal('<div class="text-slate-400">Loading…</div>');
  // Fire both in parallel; lifetime is cheap, history is small.
  const [d, history] = await Promise.all([
    api('/api/sims/' + simId + '/lifetime'),
    api('/api/sims/' + simId + '/online-history').catch(() => []),
  ]);
  if (!d) return;

  const histRows = Array.isArray(history) ? history : [];
  const historyTable = histRows.length === 0
    ? '<div class="text-slate-500 text-sm italic">No number.online events recorded yet for this SIM.</div>'
    : '<div class="overflow-x-auto rounded border border-slate-700"><table class="w-full text-xs"><thead class="bg-slate-900 text-slate-400 uppercase">' +
      '<tr><th class="px-3 py-2 text-left">When</th><th class="px-3 py-2 text-left">MDN</th><th class="px-3 py-2 text-left">Rental ID</th><th class="px-3 py-2 text-left">Source</th><th class="px-3 py-2 text-left">Status</th></tr>' +
      '</thead><tbody class="divide-y divide-slate-800">' +
      histRows.map(h => {
        const statusBadge = h.delivered
          ? '<span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300">delivered</span>'
          : '<span class="px-2 py-0.5 rounded bg-red-500/20 text-red-300">failed</span>';
        const sourceLabel = h.source === 'portal_resend' ? 'manual (single)'
                          : h.source === 'portal_resync' ? 'manual (bulk)'
                          : h.source === 'pipeline'      ? 'rotation'
                                                         : 'cron';
        return '<tr>' +
          '<td class="px-3 py-2 text-slate-300">' + esc(fmtDateTime(h.delivered_at)) + '</td>' +
          '<td class="px-3 py-2 text-slate-200 font-mono">' + esc(h.msisdn_at_send || '—') + '</td>' +
          '<td class="px-3 py-2 text-cyan-300 font-mono">' + (h.rental_id != null ? '#' + esc(h.rental_id) : '<span class="text-slate-600">—</span>') + '</td>' +
          '<td class="px-3 py-2 text-slate-400">' + esc(sourceLabel) + '</td>' +
          '<td class="px-3 py-2">' + statusBadge + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';

  showModal(
    '<h2 class="text-lg font-semibold mb-1">SIM ' + esc(d.iccid) + '</h2>' +
    '<div class="text-slate-500 text-xs mb-4">Carrier ' + esc(d.carrier || '—') + ' · Status ' + esc(d.status) + ' · ' + (d.currently_active ? 'Currently active' : 'Previously assigned') + '</div>' +
    '<div class="grid grid-cols-2 gap-4 mb-4">' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Total SMS lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.total_sms_lifetime) + '</div></div>' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Billable ' + esc(d.unit_label) + ' lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.billable_units_lifetime) + '</div></div>' +
    '</div>' +
    '<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm mb-6">' +
      '<dt class="text-slate-500">MSISDN (current)</dt><dd class="text-slate-200 font-mono">' + esc(d.current_msisdn || '—') + '</dd>' +
      '<dt class="text-slate-500">Activated</dt><dd class="text-slate-200">' + fmtDate(d.activated_at) + '</dd>' +
      '<dt class="text-slate-500">Assigned to you</dt><dd class="text-slate-200">' + fmtDate(d.assigned_at) + '</dd>' +
    '</dl>' +
    '<h3 class="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-2">Number.online history (last 20)</h3>' +
    historyTable +
    '<div class="text-xs text-slate-500 mt-4 italic">Lifetime totals are computed from the date this SIM was assigned to your account onward.</div>'
  );
}
```

- [ ] **Step 2: Syntax check**

```bash
node --check src/reseller-portal/index.js
node _check_portal_frontend.js
```

- [ ] **Step 3: Deploy + visual smoke test**

```bash
cd src/reseller-portal && npx wrangler deploy --env test
```
In the test portal, click a SIM row to open the lifetime modal. Confirm:
- The new "Number.online history" section is visible.
- A SIM that has been through cron rotations shows rows with source `cron`.
- A SIM you just resent shows rows with source `manual (single)` or `manual (bulk)`.
- Rentals successfully echoed back show as `delivered`; failures (if any) show as `failed`.

- [ ] **Step 4: Commit**

```bash
cd /home/zalmen/projects/incomingsms
git add src/reseller-portal/index.js
git commit -m "reseller-portal UI: add number.online history to SIM lifetime modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: End-to-end verification + production deploy

- [ ] **Step 1: Full repo verification pass**

```bash
cd /home/zalmen/projects/incomingsms
npm run check:db-constraints
node _check_relay.js
node --check src/reseller-portal/index.js
node --check src/reseller-sync/index.js
node _check_portal_frontend.js
```
Expected: all exit 0.

- [ ] **Step 2: Test-env end-to-end run-through**

Log into `https://reseller-portal-test.zalmen-531.workers.dev/` as a test reseller, and walk through this checklist (it mirrors the spec's §10 testing section):

1. Click "Resend" on one SIM → toast says "Resent" with rental ID.
2. Immediately click "Resend" on the same SIM → toast shows rate-limit error.
3. Click "Resync all" → confirm modal → confirm → toast shows aggregate counts.
4. Immediately click "Resync all" again → toast shows rate-limit error.
5. Open a SIM's lifetime modal → "Number.online history" lists today's cron + manual rows.
6. Click "Download CSV" → file downloads with correct rows.
7. Open a different reseller's sim_id via crafted URL (`/api/sims/<other-sim-id>/resend-online`) → 404.

If anything fails, stop and fix before deploying to prod.

- [ ] **Step 3: Deploy to production**

Deploy reseller-sync first (so the binding target is live before the portal calls it):

```bash
cd /home/zalmen/projects/incomingsms/src/reseller-sync && npx wrangler deploy --env=""
```

Then deploy reseller-portal:

```bash
cd /home/zalmen/projects/incomingsms/src/reseller-portal && npx wrangler deploy --env=""
```

- [ ] **Step 4: Production smoke test**

Pick a low-volume non-Maxim reseller account in prod and:

```bash
curl -X POST "https://portal.incoming-sms.com/api/sims/<lowvol-sim-id>/resend-online" \
  -H "Authorization: Bearer rsk_<lowvol-reseller-key>"
```
Expected: 200 with `ok: true`. Verify the row in prod `webhook_deliveries`:
```sql
SELECT id, source, sim_id, status, created_at FROM webhook_deliveries
WHERE source = 'portal_resend' ORDER BY created_at DESC LIMIT 1;
```

If anything looks wrong, the rollback is "delete the worker version" via wrangler or revert the commits and redeploy.

- [ ] **Step 5: Update agent docs**

Edit `agent/current-state.md` to add a session entry summarizing what shipped:
- New endpoints in reseller-sync (`/resend-online`, `/resync-reseller`)
- New endpoints + UI in reseller-portal
- Migration applied: `reseller_portal_resend`
- Rate limits in force
- Maxim should be told once you confirm low-volume rollout went clean

- [ ] **Step 6: Final commit + summary**

```bash
git add agent/current-state.md
git commit -m "agent: session log — reseller portal resend shipped

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Tell the user the work is shipped, the smoke test passed, and recommend they wait one production cycle before mentioning the new buttons to Maxim. Suggest they spot-check `webhook_deliveries` filtered by `source IN ('portal_resend', 'portal_resync')` over the next 24h to confirm normal usage patterns.

---

## Self-review (already performed; here for reference)

- **Spec coverage:** §1–§4 covered by tasks 7/8/9/10/11/12. §5.1 reused as-is. §5.2 (service binding) → Task 5. §5.3 → Tasks 7/8/9. §5.4 → Tasks 3/4. §5.5 (resend semantics) → Task 3 helper. §5.6 (rate limits) → Tasks 1/6. §5.7 (history endpoint) → Task 9. §5.8 (CSV) → Task 11. §6 (UI) → Tasks 10/11/12. §7 (schema) → Task 1. §8 (error handling) → embedded in handler tasks. §9 (security) → embedded. §10 (testing) → Task 13. §11 (deploy) → Task 13. §12 (open questions) — KV vs table for rate limits resolved to table (simpler, no new infra); large-reseller wall-clock noted in Task 4 comments, deferred per spec.
- **Placeholder scan:** none — every step has runnable commands or full code blocks.
- **Type consistency:** `resendOneSim` and `resyncReseller` and the rate-limit helpers all use consistent names (`simId`, `resellerId`, `source`). `handleResendOnline`/`handleResyncAll`/`handleOnlineHistory` consistently use `auth.resellerId`.

