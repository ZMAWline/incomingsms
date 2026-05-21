// =========================================================
// DETAILS FINALIZER WORKER
// Cron: every 5 minutes.
// Runs four finalizers per tick:
//   1) Helix finalizer — for provisioning Helix SIMs (gated on HELIX_ENABLED)
//   2) Wing IoT finalizer — for provisioning Wing IoT SIMs (activation + post-rotation)
//   3) Teltik finalizer — for provisioning Teltik SIMs (post-rotation MDN sync)
//   4) ATOMIC finalizer — for ATOMIC SIMs stuck after 5xx/network error during swapMSISDN
//      (calls mdn-rotator's /atomic-inquiry via service binding since it holds ATOMIC creds)
// =========================================================

import { syncSimFromHelixDetails } from '../shared/subscriber-sync.js';
import { PLAYBOOK, classifyFailure, UNCLASSIFIED_BUCKET } from '../shared/rotation-playbook.mjs';

const TELTIK_BASE = 'https://api.smsgateway.xyz';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/sweep-wing-cleanup') {
      const secret = url.searchParams.get('secret') || '';
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
      const result = await runWingIotCleanupSweep(env, { limit, offset });
      return json(result);
    }
    if (url.pathname === '/reconcile-rotations') {
      // Daily 6:30 AM EDT post-rotation reconciliation. Three buckets:
      //   A — wing_iot stuck in rotation_status='mdn_pending' (status=active or
      //       provisioning). GETs AT&T per SIM (read-only) and either syncs to
      //       success+webhook or marks rotation_status='failed' for tomorrow's
      //       stuck-wing pass.
      //   B — any vendor rotated in last 24h with last_notified_at < last_mdn_rotated_at
      //       (webhook missed). Re-fires sendNumberOnlineWebhook with force=true to
      //       bypass the ABIR guard since we already filtered to rotation_status=success.
      //   C — wing_iot eligible but not rotated in 24h. Logged only; no action.
      // Hard caps: ≤60 AT&T GETs, ≤60 webhook POSTs, 0 PUTs to AT&T, 90s wall-clock,
      // single audit row written. Cannot self-trigger (no internal fetch to own URL).
      const secret = url.searchParams.get('secret') || '';
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const dryRun = url.searchParams.get('dry') === '1';
      const force = url.searchParams.get('force') === '1';
      // Manual call respects RECONCILIATION_ENABLED unless force=1 is passed.
      if (!force && !dryRun && env.RECONCILIATION_ENABLED !== 'true') {
        return json({ ok: false, skipped: true, reason: 'RECONCILIATION_ENABLED=false; pass force=1 to override' });
      }
      const result = await runReconciliationSweep(env, { trigger: dryRun ? 'dry' : 'manual', dryRun });
      return json(result);
    }
    if (url.pathname === '/test-offline') {
      // One-shot replay endpoint: fires number.offline for N SIMs that have a
      // closed (old) sim_numbers row + a current open one. Used to give the
      // reseller test fixtures without waiting for a real rotation. Auth +
      // bounded by limit. Use ?dry=1 to preview without sending webhooks.
      const secret = url.searchParams.get('secret') || '';
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const resellerId = parseInt(url.searchParams.get('reseller_id') || '0', 10);
      if (!resellerId) {
        return json({ ok: false, error: 'reseller_id required' }, 400);
      }
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 50);
      const dryRun = url.searchParams.get('dry') === '1';
      const force = url.searchParams.get('force') === '1';
      const result = await runOfflineTestBatch(env, { resellerId, limit, dryRun, force });
      return json(result);
    }
    if (url.pathname === '/rotation-review') {
      // Daily morning review of last night's rotation cron (called by CCR
      // routine at 12:30 UTC). Queries Supabase for rotation stats across all
      // vendors, auto-fixes recoverable failure patterns (notably Teltik's
      // "Only 1 per 48h" cohort where Teltik rotated but our worker died
      // before capturing the response), triggers a finalizer drain, then
      // returns a markdown report the CCR agent commits to the repo.
      const secret = url.searchParams.get('secret') || '';
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const dryRun = url.searchParams.get('dry') === '1';
      const result = await runRotationReview(env, { dryRun });
      return new Response(result, { status: 200, headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
    }
    if (url.pathname === '/refill-pool') {
      // Manual trigger for the address-pool refill cron. Replaces quarantined
      // PPU addresses with new OSM-sourced civic-building addresses in the
      // same zip. Bounded by maxZips (default 5, max 20). Use ?dry=1 to query
      // OSM without inserting.
      const secret = url.searchParams.get('secret') || '';
      if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const maxZips = parseInt(url.searchParams.get('max') || '5', 10) || 5;
      const dryRun  = url.searchParams.get('dry') === '1';
      const result = await runAddressPoolRefill(env, { maxZips, dryRun });
      return json(result);
    }
    if (url.pathname !== '/run') {
      return new Response('details-finalizer ok. Use /run?secret=... or /sweep-wing-cleanup?secret=...&limit=50&offset=0 or /reconcile-rotations?secret=...[&dry=1][&force=1] or /test-offline?secret=...&reseller_id=N&limit=10[&dry=1] or /refill-pool?secret=...[&max=5][&dry=1]', { status: 200 });
    }
    const secret = url.searchParams.get('secret') || '';
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : 1000;
    const helix = await runHelixFinalizer(env, limit);
    const wing = await runWingIotFinalizer(env, limit);
    const teltik = await runTeltikFinalizer(env, limit);
    const atomic = await runAtomicFinalizer(env, limit);
    return json({ ok: true, helix, wing, teltik, atomic });
  },

  async scheduled(event, env, ctx) {
    // Daily reconciliation cron (6:30 AM EDT / 5:30 AM EST) — separate from the
    // 5-min finalizer cron. Gated on RECONCILIATION_ENABLED so it can be turned
    // off instantly via secret without redeploy.
    if (event.cron === '30 10 * * *') {
      if (env.RECONCILIATION_ENABLED !== 'true') {
        console.log('[Reconcile] disabled via RECONCILIATION_ENABLED, skipping');
        return;
      }
      ctx.waitUntil(runReconciliationSweep(env, { trigger: 'cron', dryRun: false }));
      return;
    }
    if (event.cron === '0 */6 * * *') {
      // Address-pool refill every 6h. Picks ≤5 zips whose only address is
      // quarantined and inserts a fresh OSM replacement so the pool keeps
      // coverage even as AT&T verifier rejects addresses.
      ctx.waitUntil(runAddressPoolRefill(env, {}).catch(err =>
        console.error(`[Refill] cron error: ${err}`)));
      return;
    }
    ctx.waitUntil(runHelixFinalizer(env, 25));
    ctx.waitUntil(runWingIotFinalizer(env, 50));
    ctx.waitUntil(runTeltikFinalizer(env, 50));
    ctx.waitUntil(runAtomicFinalizer(env, 50));
  },
};

/* ── Helix finalizer ──────────────────────────────────────────────────────── */

async function runHelixFinalizer(env, limit) {
  if (env.HELIX_ENABLED !== 'true') {
    return { processed: 0, activated: 0, message: 'helix_disabled' };
  }
  const token = await hxGetBearerToken(env);

  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,mobility_subscription_id,status,imei,activated_at,vendor&status=eq.provisioning&vendor=eq.helix&limit=${limit}`
  );

  let processed = 0;
  let activated = 0;
  let errors = 0;

  for (const sim of sims) {
    processed++;
    const subId = sim.mobility_subscription_id;
    if (!subId) continue;

    let d;
    try {
      const details = await hxSubscriberDetails(env, token, subId);
      d = Array.isArray(details) ? details[0] : details;
    } catch (e) {
      console.error(`[Finalizer/Helix] subId=${subId} iccid=${sim.iccid}: subscriber_details failed: ${e}`);
      errors++;
      continue;
    }

    let synced;
    try {
      synced = await syncSimFromHelixDetails(env, sim, d, { isFinalization: true });
    } catch (e) {
      console.error(`[Finalizer/Helix] sim_id=${sim.id}: sync failed: ${e}`);
      errors++;
      continue;
    }

    if (synced.iccidMismatch) {
      errors++;
      continue;
    }

    if (synced.statusUpdated) {
      console.log(`[Finalizer/Helix] sim_id=${sim.id}: Helix status → ${synced.statusUpdated}, skipping activation`);
      continue;
    }

    if (!synced.phoneNumber) {
      console.log(`[Finalizer/Helix] sim_id=${sim.id} iccid=${sim.iccid}: no MDN yet, will retry`);
      continue;
    }

    const activatedAt = synced.activatedAt || sim.activated_at || new Date().toISOString();
    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(sim.id))}`,
      { status: 'active', status_reason: null, activated_at: activatedAt }
    );
    activated++;
    console.log(`[Finalizer/Helix] SIM ${sim.iccid} (id=${sim.id}): activated with MDN ${synced.phoneNumber}`);
  }

  return { ok: true, processed, activated, errors };
}

/* ── Wing IoT finalizer ───────────────────────────────────────────────────── */

async function runWingIotFinalizer(env, limit) {
  if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
    return { processed: 0, synced: 0, message: 'wing_iot_credentials_missing' };
  }

  // Catches both post-activation (msisdn IS NULL) and post-rotation (rotation_status='mdn_pending').
  // Both states use status='provisioning' — the unified signal that details-finalizer owns MDN sync.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,activated_at&vendor=eq.wing_iot&status=eq.provisioning&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
  const headers = { Authorization: auth, Accept: 'application/json' };

  let processed = 0;
  let synced = 0;
  let errors = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    const isPostRotation = sim.rotation_status === 'mdn_pending';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(sim.iccid);

    try {
      const res = await relayFetch(env, url, { method: 'GET', headers });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `GET ${res.status}` });
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const mdnRaw = data.msisdn || data.mdn || null;
      if (!mdnRaw) {
        results.push({ iccid: sim.iccid, ok: true, pending: true });
        continue;
      }

      const msisdnBare = String(mdnRaw).replace(/^\+?1?/, '');

      // Post-rotation: AT&T may still return the old MDN during the ~1 min propagation window.
      // Skip until it changes — the next cron tick in 5 min will try again.
      if (isPostRotation && sim.msisdn && msisdnBare === sim.msisdn) {
        results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'old MDN not yet replaced' });
        continue;
      }

      // Guardrail: refuse to mark success while AT&T still has the SIM on the non-dialable (ABIR)
      // plan. Happens when rotation's second PUT returned 200 but AT&T didn't actually switch back.
      // Skip; mdn-rotator's verify_dialable poll should have thrown, but keep this as defense-in-depth.
      const plan = data.communicationPlan || null;
      if (isPostRotation && plan && plan !== 'Wing Tel Inc - NON ABIR SMS MO/MT US') {
        results.push({ iccid: sim.iccid, ok: true, pending: true, note: `plan=${plan} (not dialable yet)` });
        continue;
      }

      const e164 = normalizeUS(mdnRaw);

      // Fire offline for the OLD MDN before closing it (only on rotation, not first activation).
      const oldMsisdnBare = sim.msisdn || '';
      if (oldMsisdnBare && oldMsisdnBare !== msisdnBare) {
        try {
          await sendNumberOfflineWebhook(env, sim.id, normalizeUS(oldMsisdnBare), sim.iccid, oldMsisdnBare, e164);
        } catch (offErr) {
          console.error(`[Finalizer/WingIoT] SIM ${sim.id}: number.offline failed: ${offErr}`);
        }
      }

      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);

      const patch = {
        msisdn: msisdnBare,
        status: 'active',
      };
      if (isPostRotation) {
        patch.rotation_status = 'success';
        patch.last_rotation_at = new Date().toISOString();
      }
      // Backfill activated_at when it's null (first time the SIM becomes usable).
      // Never override an existing date — that's the real activation timestamp.
      if (!sim.activated_at) patch.activated_at = new Date().toISOString();
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, patch);

      await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, msisdnBare);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: isPostRotation ? 'post-rotation' : 'activation' });
      console.log(`[Finalizer/WingIoT] SIM ${sim.iccid}: wrote ${e164} (${isPostRotation ? 'post-rotation' : 'activation'})`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/WingIoT] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, results };
}

/* ── Wing IoT cleanup sweep — one-shot reconciliation ────────────────────── */
// Iterates wing_iot SIMs (status NOT IN canceled/error). For each:
//   - GET AT&T device state
//   - If status=ACTIVATED + plan=NON ABIR: sync DB to active+success, write
//     sim_numbers if MDN changed, fire number.online webhook unconditionally
//   - Else (wrong plan or wrong status): set rotation_status='failed' so the
//     mdn-rotator's stuck-wing remediation pass picks it up
// Concurrency 5; paginate with offset/limit so the request fits in the
// CF Worker wall-clock budget.

async function runWingIotCleanupSweep(env, { limit = 50, offset = 0 }) {
  if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
    return { ok: false, error: 'wing_iot_credentials_missing' };
  }

  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,status,rotation_status,activated_at` +
    `&vendor=eq.wing_iot` +
    `&status=neq.canceled` +
    `&status=neq.error` +
    `&order=id.asc&limit=${limit}&offset=${offset}`
  );
  if (!sims || sims.length === 0) {
    return { ok: true, processed: 0, offset, limit, next_offset: offset, message: 'no SIMs at offset' };
  }

  const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
  const headers = { Authorization: auth, Accept: 'application/json' };
  const DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';

  let synced = 0, marked_failed = 0, errors = 0, webhooks_sent = 0, skipped = 0;
  const sample = [];
  const concurrency = 5;
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= sims.length) return;
      const sim = sims[idx];
      try {
        const url = baseUrl + '/v1/devices/' + encodeURIComponent(sim.iccid);
        const res = await relayFetch(env, url, { method: 'GET', headers });
        if (!res.ok) {
          errors++;
          if (sample.length < 10) sample.push({ id: sim.id, iccid: sim.iccid, ok: false, error: 'GET ' + res.status });
          continue;
        }
        const data = await res.json().catch(() => ({}));
        const wingStatus = (data.status || '').toLowerCase();
        const plan = data.communicationPlan || '';
        const mdnRaw = data.msisdn || data.mdn || null;

        if ((wingStatus === 'activated' || wingStatus === 'active')) {
          if (plan === DIALABLE_PLAN && mdnRaw) {
            const msisdnBare = String(mdnRaw).replace(/^\+?1?/, '');
            const e164 = normalizeUS(mdnRaw);
            if (sim.msisdn !== msisdnBare) {
              // Offline for old MDN before close (skip when there was no prior MDN).
              if (sim.msisdn) {
                try {
                  await sendNumberOfflineWebhook(env, sim.id, normalizeUS(sim.msisdn), sim.iccid, sim.msisdn, e164);
                } catch (offErr) {
                  console.error(`[Sweep/WingIoT] SIM ${sim.id}: number.offline failed: ${offErr}`);
                }
              }
              await closeCurrentNumber(env, sim.id);
              await insertNewNumber(env, sim.id, e164);
            }
            const patch = {
              status: 'active',
              rotation_status: 'success',
              msisdn: msisdnBare,
              last_rotation_error: null,
            };
            // Real rotation (prior MDN replaced) → stamp success time.
            // First-activation reconcile (no prior MDN) → leave last_rotation_at null.
            if (sim.msisdn && sim.msisdn !== msisdnBare) patch.last_rotation_at = new Date().toISOString();
            if (!sim.activated_at) patch.activated_at = new Date().toISOString();
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, patch);
            try {
              await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, msisdnBare);
              webhooks_sent++;
            } catch (we) {
              // Webhook failure shouldn't fail the whole sweep — already logged in helper.
            }
            synced++;
            if (sample.length < 10) sample.push({ id: sim.id, iccid: sim.iccid, action: 'synced', mdn: msisdnBare });
          } else {
            await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
              rotation_status: 'failed',
              last_rotation_error: 'Sweep cleanup: plan="' + plan + '" mdn=' + mdnRaw + '. Flagged for mdn-rotator retry at ' + new Date().toISOString(),
            });
            marked_failed++;
            if (sample.length < 10) sample.push({ id: sim.id, iccid: sim.iccid, action: 'marked_failed', plan, mdn: mdnRaw });
          }
        } else {
          // SIM not active on AT&T (e.g., shipped, deactivated). Leave alone.
          skipped++;
          if (sample.length < 10) sample.push({ id: sim.id, iccid: sim.iccid, action: 'skipped', att_status: wingStatus });
        }
      } catch (e) {
        errors++;
        if (sample.length < 10) sample.push({ id: sim.id, iccid: sim.iccid, ok: false, error: String(e) });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return {
    ok: true,
    offset, limit,
    processed: sims.length,
    synced, marked_failed, errors, webhooks_sent, skipped,
    next_offset: offset + sims.length,
    sample,
  };
}

/* ── Daily post-rotation reconciliation ─────────────────────────────────── */
// Runs once a day at UTC 10:30 (NY 6:30 EDT / 5:30 EST), 30 min after the
// rotation window closes. Catches three failure modes the other safety nets
// miss, all under hard runtime caps so it cannot loop or burn API budget:
//   Bucket A — wing_iot stuck in rotation_status='mdn_pending' (orphan or
//              still-provisioning). GETs AT&T per SIM (read-only) and either
//              syncs to success+webhook (if plan=NON ABIR) or marks
//              rotation_status='failed' so tomorrow's stuck-wing pass picks up.
//   Bucket B — any vendor whose last_notified_at is older than its
//              last_mdn_rotated_at within the last 24h. Re-fires
//              sendNumberOnlineWebhook with force=true (bypasses ABIR guard
//              since query already filters to rotation_status='success').
//   Bucket C — wing_iot eligible-but-not-attempted in 24h. Logged only.
// Hard caps: ≤60 AT&T GETs, ≤60 webhook POSTs, 0 PUTs to AT&T, 90s wall-clock.
// Single audit row written to rotation_audit per run.

async function runReconciliationSweep(env, { trigger, dryRun }) {
  const startedAtMs = Date.now();
  const startedAtISO = new Date(startedAtMs).toISOString();
  const log = (msg) => console.log(`[Reconcile/${trigger}] ${msg}`);

  const MAX_ATT_CALLS = 60;
  const MAX_WEBHOOK_FIRES = 60;
  const TIMEOUT_MS = 90_000;
  const deadline = startedAtMs + TIMEOUT_MS;
  const timeRemaining = () => Math.max(0, deadline - Date.now());

  let attCalls = 0;
  let webhookFires = 0;
  let timedOut = false;

  const cutoff24hISO = new Date(startedAtMs - 24 * 60 * 60 * 1000).toISOString();
  const nyDateStr = new Date(startedAtMs).toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });

  // ── Bucket A — wing_iot stuck mdn_pending ─────────────────────────────────
  const bucketA = (await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,status,rotation_status,activated_at` +
      `&vendor=eq.wing_iot` +
      `&rotation_status=eq.mdn_pending` +
      `&status=in.(active,provisioning)` +
      `&order=last_mdn_rotated_at.asc.nullsfirst&limit=${MAX_ATT_CALLS}`
  )) || [];
  const bucketAIds = bucketA.map((s) => s.id);
  log(`Bucket A (stuck mdn_pending): ${bucketA.length} SIMs`);

  // ── Bucket B — any vendor: rotated <24h ago, last_notified_at stale ───────
  // PostgREST doesn't allow column-to-column comparison in or=(), so fetch
  // candidates (rotated in last 24h) and filter in JS for stale notify.
  const bucketBCandidates = (await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,vendor,last_mdn_rotated_at,last_notified_at` +
      `&status=eq.active` +
      `&rotation_status=eq.success` +
      `&last_mdn_rotated_at=gte.${encodeURIComponent(cutoff24hISO)}` +
      `&order=last_mdn_rotated_at.asc&limit=500`
  )) || [];
  const bucketB = bucketBCandidates
    .filter((s) => !s.last_notified_at || new Date(s.last_notified_at) < new Date(s.last_mdn_rotated_at))
    .slice(0, MAX_WEBHOOK_FIRES);
  const bucketBIds = bucketB.map((s) => s.id);
  log(`Bucket B (rotated, not notified): ${bucketB.length} SIMs`);

  // ── Bucket C — wing_iot eligible but not rotated in 24h (log only) ────────
  const bucketC = (await supabaseSelect(
    env,
    `sims?select=id,iccid,vendor,last_mdn_rotated_at` +
      `&status=eq.active` +
      `&vendor=eq.wing_iot` +
      `&rotation_eligible=eq.true` +
      `&or=(last_mdn_rotated_at.is.null,last_mdn_rotated_at.lt.${encodeURIComponent(cutoff24hISO)})` +
      `&limit=200`
  )) || [];
  const bucketCIds = bucketC.map((s) => s.id);
  log(`Bucket C (eligible, not attempted): ${bucketC.length} SIMs`);

  if (dryRun) {
    log('Dry run — no actions taken, no audit row written');
    return {
      ok: true,
      dry_run: true,
      ny_date: nyDateStr,
      bucket_a_count: bucketA.length,
      bucket_b_count: bucketB.length,
      bucket_c_count: bucketC.length,
      bucket_a_sim_ids: bucketAIds,
      bucket_b_sim_ids: bucketBIds,
      bucket_c_sim_ids: bucketCIds,
      caps: { att_calls: MAX_ATT_CALLS, webhook_fires: MAX_WEBHOOK_FIRES, timeout_ms: TIMEOUT_MS },
    };
  }

  // ── Process Bucket A: GET AT&T per SIM, sync if plan=NON ABIR ─────────────
  const attBaseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
  const aActions = { synced: 0, marked_failed: 0, errors: 0, webhooks: 0, skipped_no_creds: 0 };

  if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
    aActions.skipped_no_creds = bucketA.length;
    log('Bucket A skipped — wing_iot credentials missing');
  } else {
    const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
    const headers = { Authorization: auth, Accept: 'application/json' };

    for (const sim of bucketA) {
      if (timeRemaining() < 5000) { timedOut = true; break; }
      if (attCalls >= MAX_ATT_CALLS) break;
      attCalls++;
      try {
        const res = await relayFetch(env, attBaseUrl + '/v1/devices/' + encodeURIComponent(sim.iccid), {
          method: 'GET',
          headers,
        });
        if (!res.ok) { aActions.errors++; continue; }
        const data = await res.json().catch(() => ({}));
        const wingStatus = String(data.status || '').toLowerCase();
        const plan = data.communicationPlan || '';
        const mdnRaw = data.msisdn || data.mdn || null;

        const isActivated = wingStatus === 'activated' || wingStatus === 'active';
        if (isActivated && plan === DIALABLE_PLAN && mdnRaw) {
          const msisdnBare = String(mdnRaw).replace(/^\+?1?/, '');
          const e164 = normalizeUS(mdnRaw);
          if (sim.msisdn !== msisdnBare) {
            if (sim.msisdn) {
              try {
                await sendNumberOfflineWebhook(env, sim.id, normalizeUS(sim.msisdn), sim.iccid, sim.msisdn, e164);
              } catch (offErr) {
                console.error(`[Reconcile/A] SIM ${sim.id}: offline webhook failed: ${offErr}`);
              }
            }
            await closeCurrentNumber(env, sim.id);
            await insertNewNumber(env, sim.id, e164);
          }
          const patch = {
            status: 'active',
            rotation_status: 'success',
            msisdn: msisdnBare,
            last_rotation_error: null,
          };
          // Real rotation (prior MDN replaced) → stamp success time.
          // First-activation reconcile (no prior MDN) → leave last_rotation_at null.
          if (sim.msisdn && sim.msisdn !== msisdnBare) patch.last_rotation_at = new Date().toISOString();
          if (!sim.activated_at) patch.activated_at = new Date().toISOString();
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, patch);
          if (webhookFires < MAX_WEBHOOK_FIRES) {
            try {
              await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, msisdnBare, { force: true });
              webhookFires++;
              aActions.webhooks++;
            } catch (we) {
              // already logged inside helper
            }
          }
          aActions.synced++;
        } else {
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            rotation_status: 'failed',
            last_rotation_error: `Reconcile: plan="${plan}" mdn=${mdnRaw} att_status=${wingStatus} at ${new Date().toISOString()}`,
          });
          aActions.marked_failed++;
        }
      } catch (e) {
        aActions.errors++;
        console.error(`[Reconcile/A] SIM ${sim.id}: ${e}`);
      }
    }
  }

  // ── Process Bucket B: re-fire number.online webhook ───────────────────────
  const bActions = { fired: 0, errors: 0, no_msisdn: 0 };
  for (const sim of bucketB) {
    if (timeRemaining() < 5000) { timedOut = true; break; }
    if (webhookFires >= MAX_WEBHOOK_FIRES) break;
    if (!sim.msisdn) { bActions.no_msisdn++; continue; }
    webhookFires++;
    try {
      const e164 = normalizeUS(sim.msisdn);
      await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, sim.msisdn, { force: true });
      bActions.fired++;
    } catch (e) {
      bActions.errors++;
      console.error(`[Reconcile/B] SIM ${sim.id}: ${e}`);
    }
  }

  // ── Insert audit row ──────────────────────────────────────────────────────
  const durationMs = Date.now() - startedAtMs;
  const auditRow = {
    run_at: startedAtISO,
    ny_date: nyDateStr,
    trigger,
    bucket_a_count: bucketA.length,
    bucket_b_count: bucketB.length,
    bucket_c_count: bucketC.length,
    bucket_a_sim_ids: bucketAIds,
    bucket_b_sim_ids: bucketBIds,
    bucket_c_sim_ids: bucketCIds,
    actions_taken: { bucket_a: aActions, bucket_b: bActions },
    duration_ms: durationMs,
    caps_hit: {
      att_calls: attCalls,
      webhook_fires: webhookFires,
      timed_out: timedOut,
      hit_att_cap: attCalls >= MAX_ATT_CALLS,
      hit_webhook_cap: webhookFires >= MAX_WEBHOOK_FIRES,
    },
  };
  try {
    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rotation_audit`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(auditRow),
    });
    if (!insertRes.ok) {
      log(`Audit insert failed: HTTP ${insertRes.status}`);
    }
  } catch (e) {
    log(`Audit insert threw: ${e}`);
  }

  log(
    `Done in ${durationMs}ms. A: ${aActions.synced} synced / ${aActions.marked_failed} flagged / ${aActions.errors} errors. ` +
      `B: ${bActions.fired} webhooks fired / ${bActions.errors} errors. C: ${bucketC.length} logged. ` +
      `attCalls=${attCalls}/${MAX_ATT_CALLS} webhookFires=${webhookFires}/${MAX_WEBHOOK_FIRES} timedOut=${timedOut}`
  );

  return { ok: true, ...auditRow };
}

/* ── Offline-event replay (test fixtures) ────────────────────────────────── */
// Picks the N most-recently-rotated active SIMs assigned to a given reseller
// that have BOTH an open and a closed sim_numbers row, then fires
// number.offline for each using the closed (old) MDN as the offline subject
// and the open (current) MDN as `replaced_by`. Goes through the same
// sendNumberOfflineWebhook helper that prod rotations use, so the receiver
// sees an identical payload shape.

async function runOfflineTestBatch(env, { resellerId, limit, dryRun, force }) {
  // 1) Find active SIMs assigned to this reseller, most-recently-rotated first.
  // We over-fetch (limit*4) to allow filtering down to ones that have both an
  // open and a closed sim_numbers row.
  const overFetch = Math.min(limit * 4, 100);
  const sims = await supabaseSelect(env,
    `sims?select=id,iccid,vendor,msisdn,mobility_subscription_id,last_mdn_rotated_at,reseller_sims!inner(reseller_id,active)` +
    `&reseller_sims.reseller_id=eq.${resellerId}` +
    `&reseller_sims.active=eq.true` +
    `&status=eq.active` +
    `&last_mdn_rotated_at=not.is.null` +
    `&order=last_mdn_rotated_at.desc&limit=${overFetch}`
  );
  if (!sims || sims.length === 0) {
    return { ok: true, fired: 0, skipped: 0, message: 'no SIMs match', candidates: [] };
  }

  // 2) For each SIM, look up the most recent CLOSED sim_numbers row + the
  // current OPEN row. Skip if either is missing.
  const eligible = [];
  for (const sim of sims) {
    if (eligible.length >= limit) break;
    const rows = await supabaseSelect(env,
      `sim_numbers?select=e164,valid_from,valid_to&sim_id=eq.${sim.id}&order=valid_from.desc&limit=10`
    ).catch(() => []);
    const open = rows.find(r => r.valid_to === null);
    const closed = rows.find(r => r.valid_to !== null);
    if (!open || !closed || !open.e164 || !closed.e164) continue;
    if (open.e164 === closed.e164) continue;
    eligible.push({ sim, oldE164: closed.e164, newE164: open.e164 });
  }

  if (eligible.length === 0) {
    return { ok: true, fired: 0, skipped: 0, message: 'no SIMs with both open + closed sim_numbers rows', candidates: [] };
  }

  // 3) Fire number.offline for each (or just preview if dryRun).
  const results = [];
  let fired = 0, errors = 0;
  for (const { sim, oldE164, newE164 } of eligible) {
    const oldBare = oldE164.replace(/^\+?1?/, '');
    const oldMobilityId = sim.vendor === 'helix' ? (sim.mobility_subscription_id || oldBare) : oldBare;
    if (dryRun) {
      results.push({ sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, old: oldE164, replaced_by: newE164, dry: true });
      continue;
    }
    try {
      if (force) {
        // Bypass per-day dedup so the test can be re-fired without waiting for
        // UTC midnight. Inlines the lookup chain that sendNumberOfflineWebhook
        // does, but passes force:true to sendWebhookWithDeduplication.
        const rid = await findResellerIdBySimId(env, sim.id);
        const whUrl = rid ? await findWebhookUrlByResellerId(env, rid) : null;
        if (!whUrl) {
          results.push({ sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, old: oldE164, replaced_by: newE164, ok: false, error: 'no webhook' });
          continue;
        }
        const r = await sendWebhookWithDeduplication(env, whUrl, {
          event_type: 'number.offline',
          created_at: new Date().toISOString(),
          data: {
            sim_id: sim.id,
            number: oldE164,
            online: false,
            iccid: sim.iccid,
            mobilitySubscriptionId: oldMobilityId,
            replaced_by: newE164,
            verified: true,
          },
        }, { idComponents: { simId: sim.id, iccid: sim.iccid, number: oldE164 }, resellerId: rid, force: true });
        if (r.ok) fired++; else errors++;
        results.push({ sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, old: oldE164, replaced_by: newE164, ok: r.ok, status: r.status, attempts: r.attempts });
      } else {
        await sendNumberOfflineWebhook(env, sim.id, oldE164, sim.iccid, oldMobilityId, newE164);
        fired++;
        results.push({ sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, old: oldE164, replaced_by: newE164, ok: true });
      }
    } catch (e) {
      errors++;
      results.push({ sim_id: sim.id, iccid: sim.iccid, vendor: sim.vendor, old: oldE164, replaced_by: newE164, ok: false, error: String(e) });
    }
  }

  return {
    ok: true,
    reseller_id: resellerId,
    requested: limit,
    eligible_found: eligible.length,
    fired,
    errors,
    dry_run: !!dryRun,
    results,
  };
}

/* ── Teltik finalizer ─────────────────────────────────────────────────────── */

async function runTeltikFinalizer(env, limit) {
  if (!env.TELTIK_API_KEY) {
    return { processed: 0, synced: 0, message: 'teltik_api_key_missing' };
  }

  // Post-rotation: rotateOneTeltikSim flipped status=provisioning + rotation_status=mdn_pending.
  // sim.msisdn still holds the OLD MDN — we call get-phone-number; when the returned MDN
  // differs, the change-number actually took effect and we finalize.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,last_mdn_rotated_at,rotation_interval_hours&vendor=eq.teltik&status=eq.provisioning&rotation_status=eq.mdn_pending&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const apiKey = env.TELTIK_API_KEY;
  const STUCK_MINUTES = 30;

  let processed = 0;
  let synced = 0;
  let errors = 0;
  let failed = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    const url = `${TELTIK_BASE}/v1/get-phone-number/?apikey=${apiKey}&iccid=${encodeURIComponent(sim.iccid)}`;
    const runId = `finalize_${sim.iccid}_${Date.now()}`;

    try {
      const res = await relayFetch(env, url, { method: 'GET' });
      const bodyText = await res.text();
      let data = {};
      try { data = JSON.parse(bodyText); } catch {}
      await logTeltikApiCall(env, {
        run_id: runId, step: 'post_rotate_get', iccid: sim.iccid,
        request_url: url.replace(/apikey=[^&]+/, 'apikey=***'),
        request_method: 'GET', request_body: null,
        response_status: res.status, response_ok: res.ok,
        response_body_text: bodyText, response_body_json: data,
        error: res.ok ? null : `GET ${res.status}`,
      });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `GET ${res.status}` });
        continue;
      }
      const raw = data.msisdn || data.mdn || data.phone_number || data.number || null;
      const msisdnBare = raw ? String(raw).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;

      // Timeout guard: if Teltik hasn't changed the MDN in STUCK_MINUTES, mark failed so
      // dashboard/ops can see it. last_mdn_rotated_at was stamped by claim_rotation_slot.
      const startedAt = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).getTime() : 0;
      const ageMin = startedAt ? (Date.now() - startedAt) / 60000 : 0;

      if (!msisdnBare || msisdnBare === sim.msisdn) {
        if (ageMin >= STUCK_MINUTES) {
          failed++;
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            rotation_status: 'failed',
            status: 'active',
            last_rotation_error: `MDN did not change within ${STUCK_MINUTES}m (Teltik returned ${msisdnBare || 'null'})`,
          });
          results.push({ iccid: sim.iccid, ok: false, note: 'timeout' });
        } else {
          results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'MDN unchanged — still pending' });
        }
        continue;
      }

      // Finalize
      const e164 = `+1${msisdnBare}`;

      // Offline for old MDN (only on rotation, not first activation).
      const oldMsisdnBare = sim.msisdn || '';
      if (oldMsisdnBare && oldMsisdnBare !== msisdnBare) {
        try {
          await sendNumberOfflineWebhook(env, sim.id, normalizeUS(oldMsisdnBare), sim.iccid, oldMsisdnBare, e164);
        } catch (offErr) {
          console.error(`[Finalizer/Teltik] SIM ${sim.id}: number.offline failed: ${offErr}`);
        }
      }

      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        msisdn: msisdnBare,
        status: 'active',
        rotation_status: 'success',
        last_rotation_at: new Date().toISOString(),
        last_rotation_error: null,
      });

      await sendTeltikNumberOnlineWebhook(env, sim, e164, msisdnBare);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: 'post-rotation' });
      console.log(`[Finalizer/Teltik] SIM ${sim.iccid}: wrote ${e164} (post-rotation)`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/Teltik] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, failed, results };
}

async function sendTeltikNumberOnlineWebhook(env, sim, e164, msisdnBare) {
  const resellerId = await findResellerIdBySimId(env, sim.id);
  if (!resellerId) return;
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) return;

  const intervalHours = sim.rotation_interval_hours || 48;
  const onlineUntil = midnightNYAfterInterval(sim.last_mdn_rotated_at, intervalHours);

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.online',
    created_at: new Date().toISOString(),
    data: {
      sim_id: sim.id,
      number: e164,
      online: true,
      online_until: onlineUntil,
      carrier: 'T-Mobile',
      iccid: sim.iccid,
      mobilitySubscriptionId: null,
      verified: true,
    },
  }, { idComponents: { simId: sim.id, iccid: sim.iccid, number: e164 }, resellerId });

  if (result.ok) {
    await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
      last_notified_at: new Date().toISOString(),
    }).catch(() => {});
  }
}

async function logTeltikApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: null,
    vendor: 'teltik',
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_body_text: (logData.response_body_text || '').slice(0, 5000),
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn(`[Teltik API log] insert failed: ${e}`);
  }
}

function midnightNYAfterInterval(lastRotatedAt, intervalHours) {
  const baseDt = new Date(lastRotatedAt || Date.now());
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(baseDt);
  const [y, m, d] = nyDate.split('-').map(Number);
  const intervalDays = Math.ceil((intervalHours || 48) / 24);
  const probe = new Date(Date.UTC(y, m - 1, d + intervalDays, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-4');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

/* ── ATOMIC finalizer ─────────────────────────────────────────────────────── */

async function runAtomicFinalizer(env, limit) {
  if (!env.MDN_ROTATOR) {
    return { processed: 0, synced: 0, message: 'mdn_rotator_binding_missing' };
  }
  if (!env.ADMIN_RUN_SECRET) {
    return { processed: 0, synced: 0, message: 'admin_run_secret_missing' };
  }

  // Only reconcile post-rotation stuck ATOMIC SIMs; normal activation flow doesn't use
  // provisioning for ATOMIC. mdn_pending is the signal that swapMSISDN returned 5xx or
  // threw a network error and we don't know the final state.
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,msisdn,rotation_status,status,last_mdn_rotated_at&vendor=eq.atomic&status=eq.provisioning&rotation_status=eq.mdn_pending&limit=${limit}`
  );
  if (!sims || sims.length === 0) return { ok: true, processed: 0, synced: 0 };

  const STUCK_MINUTES = 30;

  let processed = 0;
  let synced = 0;
  let errors = 0;
  let failed = 0;
  const results = [];

  for (const sim of sims) {
    processed++;
    try {
      const inqUrl = `https://mdn-rotator/atomic-inquiry?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(sim.iccid)}`;
      const res = await env.MDN_ROTATOR.fetch(inqUrl, { method: 'GET' });
      if (!res.ok) {
        errors++;
        results.push({ iccid: sim.iccid, ok: false, error: `inquiry ${res.status}` });
        continue;
      }
      const data = await res.json().catch(() => ({}));
      const newMsisdn = data.msisdn ? String(data.msisdn).replace(/^\+?1?/, '') : null;

      const startedAt = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).getTime() : 0;
      const ageMin = startedAt ? (Date.now() - startedAt) / 60000 : 0;

      if (!data.ok || !newMsisdn || newMsisdn === sim.msisdn) {
        if (ageMin >= STUCK_MINUTES) {
          failed++;
          await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
            rotation_status: 'failed',
            status: 'active',
            last_rotation_error: `ATOMIC inquiry: MDN unchanged within ${STUCK_MINUTES}m (got ${newMsisdn || 'null'})`,
          });
          results.push({ iccid: sim.iccid, ok: false, note: 'timeout' });
        } else {
          results.push({ iccid: sim.iccid, ok: true, pending: true, note: 'MDN unchanged — still pending' });
        }
        continue;
      }

      const e164 = `+1${newMsisdn}`;

      // Offline for old MDN (only on rotation, not first activation).
      if (sim.msisdn && sim.msisdn !== newMsisdn) {
        try {
          await sendNumberOfflineWebhook(env, sim.id, normalizeUS(sim.msisdn), sim.iccid, sim.msisdn, e164);
        } catch (offErr) {
          console.error(`[Finalizer/ATOMIC] SIM ${sim.id}: number.offline failed: ${offErr}`);
        }
      }

      await closeCurrentNumber(env, sim.id);
      await insertNewNumber(env, sim.id, e164);
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(sim.id))}`, {
        msisdn: newMsisdn,
        status: 'active',
        rotation_status: 'success',
        last_rotation_at: new Date().toISOString(),
        last_rotation_error: null,
      });

      await sendNumberOnlineWebhook(env, sim.id, e164, sim.iccid, newMsisdn);

      synced++;
      results.push({ iccid: sim.iccid, ok: true, mdn: e164, kind: 'post-rotation-recovery' });
      console.log(`[Finalizer/ATOMIC] SIM ${sim.iccid}: reconciled ${sim.msisdn} → ${newMsisdn}`);
    } catch (e) {
      errors++;
      results.push({ iccid: sim.iccid, ok: false, error: String(e) });
      console.error(`[Finalizer/ATOMIC] SIM ${sim.iccid}: ${e}`);
    }
  }

  return { ok: true, processed, synced, errors, failed, results };
}

/* ── Rotation Review (daily 12:30 UTC) ────────────────────────────────────── */
// Called by CCR routine after the cron window closes. Produces a markdown
// report summarizing rotation health and auto-fixes recoverable failure
// patterns. Bounded by:
//   - Run-lock (one active rotation_review at a time, via cron_runs)
//   - Per-SIM 3-attempts-per-NY-day budget for force_rotate (via
//     remediation_attempts + attempts_today RPC)
//   - Per-vendor 5xx circuit breaker (5 consecutive 5xx → skip vendor)
// Sends email via Resend if RESEND_API_KEY is set; otherwise returns the
// markdown only (CCR routine commits it to the repo as a fallback).

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdUtc(d = new Date()) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`; }
function nyMidnightUtcIso(d = new Date()) {
  // Start of today's NY calendar date as a UTC ISO timestamp.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).reduce((acc, p) => (p.type !== 'literal' && (acc[p.type] = p.value), acc), {});
  for (const offset of [4, 5]) {
    const candidate = `${parts.year}-${parts.month}-${parts.day}T${pad2(offset)}:00:00Z`;
    const back = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(candidate)).reduce((acc, p) => (p.type !== 'literal' && (acc[p.type] = p.value), acc), {});
    if (back.year === parts.year && back.month === parts.month && back.day === parts.day) {
      return candidate;
    }
  }
  return null;
}

async function rotationReviewQuery(env, fragment) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${fragment}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

// Lock acquire: INSERT into cron_runs with status='running'. The partial
// unique index `cron_runs_one_active_per_kind` prevents a second active row.
// Also marks any prior 'running' rows older than 30 min as 'stale' first
// (covers crashed/killed prior runs).
async function acquireReviewLock(env, kind = 'rotation_review') {
  // Mark stale runs first
  await fetch(`${env.SUPABASE_URL}/rest/v1/cron_runs?kind=eq.${kind}&status=eq.running&started_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 60 * 1000).toISOString())}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ status: 'stale', ended_at: new Date().toISOString() }),
  }).catch(() => {});

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/cron_runs`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify([{ kind, status: 'running' }]),
  });
  if (res.status === 409 || res.status === 23505) return { acquired: false, reason: 'another_run_active' };
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (/duplicate key|cron_runs_one_active_per_kind/i.test(t)) return { acquired: false, reason: 'another_run_active' };
    throw new Error(`acquireReviewLock: ${res.status} ${t}`);
  }
  const rows = await res.json().catch(() => []);
  return { acquired: true, run: Array.isArray(rows) ? rows[0] : rows };
}

async function releaseReviewLock(env, runDbId, status, summary, reportMd) {
  const body = { status, ended_at: new Date().toISOString(), summary };
  if (reportMd) body.report_md = reportMd;
  await fetch(`${env.SUPABASE_URL}/rest/v1/cron_runs?id=eq.${runDbId}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// ---- pending_review_items helpers --------------------------------------
async function loadOpenPendingItems(env) {
  return rotationReviewQuery(env,
    `pending_review_items?status=in.(open,answered)&select=id,kind,summary,sim_id,status,operator_response,agent_seen_at,created_at&order=created_at.desc&limit=200`);
}

async function findOpenPendingForSim(env, simId, kind) {
  // Used for dedup so we don't create duplicate items for the same SIM+kind
  const rows = await rotationReviewQuery(env,
    `pending_review_items?status=eq.open&kind=eq.${encodeURIComponent(kind)}&sim_id=eq.${simId}&select=id&limit=1`);
  return rows[0] || null;
}

async function insertPendingItem(env, item) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/pending_review_items`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([item]),
  });
  return res.ok;
}

async function markPendingItemSeen(env, ids) {
  if (!ids || ids.length === 0) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/pending_review_items?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ agent_seen_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function recordAttempt(env, simId, runId, action, result, error) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/remediation_attempts`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify([{ sim_id: simId, run_id: runId, action, result, error: error ? String(error).slice(0, 500) : null }]),
  }).catch(() => {});
}

async function attemptsToday(env, simId, action) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/attempts_today`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_sim_id: simId, p_action: action }),
  });
  if (!res.ok) return 0;
  const n = await res.json().catch(() => 0);
  return typeof n === 'number' ? n : 0;
}

// Force-rotate one SIM via the appropriate worker (service binding — CF blocks
// worker→public-.workers.dev fetches which is what tripped the first version).
async function forceRotateSim(env, sim) {
  const worker = sim.vendor === 'teltik' ? env.TELTIK_WORKER : env.MDN_ROTATOR;
  if (!worker) return { ok: false, status: 0, error: `no service binding for vendor=${sim.vendor}` };
  const base = sim.vendor === 'teltik' ? 'https://teltik-worker' : 'https://mdn-rotator';
  const url = `${base}/rotate-sim?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET || '')}&iccid=${encodeURIComponent(sim.iccid)}&force=true`;
  try {
    const res = await worker.fetch(url, { method: 'POST', signal: AbortSignal.timeout(75000) });
    const text = await res.text().catch(() => '');
    let body = {};
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    return { ok: res.ok && body.ok === true, status: res.status, response: body };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

// Second-read verification for atomic: after force-rotate, ask AT&T what the
// SIM's current MSISDN is. If it changed from the pre-rotate value, success.
async function atomicSecondRead(env, sim) {
  if (!env.MDN_ROTATOR) return { verified: null, error: 'no MDN_ROTATOR binding' };
  try {
    const url = `https://mdn-rotator/atomic-inquiry?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET || '')}&iccid=${encodeURIComponent(sim.iccid)}`;
    const res = await env.MDN_ROTATOR.fetch(url, { method: 'GET', signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { verified: null, error: `http ${res.status}` };
    const body = await res.json().catch(() => ({}));
    if (!body.ok) return { verified: null, error: body.description || `statusCode=${body.statusCode}` };
    const newMsisdn = body.msisdn || null;
    if (!newMsisdn) return { verified: null, error: 'no msisdn in response' };
    return { verified: newMsisdn !== sim.msisdn, new_msisdn: newMsisdn, prior_msisdn: sim.msisdn };
  } catch (err) {
    return { verified: null, error: String(err) };
  }
}

// Detect SIMs that have failed N or more consecutive review-run days.
async function detectMultiDayFailures(env, minStreak = 3) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await rotationReviewQuery(env,
    `remediation_attempts?select=sim_id,result,created_at&action=eq.force_rotate&created_at=gt.${encodeURIComponent(since)}&order=sim_id.asc,created_at.desc&limit=5000`);
  const bySim = new Map();
  for (const r of rows) {
    if (!bySim.has(r.sim_id)) bySim.set(r.sim_id, []);
    bySim.get(r.sim_id).push(r);
  }
  const streaks = [];
  for (const [simId, attempts] of bySim) {
    // attempts already DESC by created_at; group by NY date
    const days = new Map();
    for (const a of attempts) {
      const day = ymdUtc(new Date(a.created_at));
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(a);
    }
    // Walk back from today; count consecutive days where the LAST attempt of
    // the day was 'fail'.
    const dayList = [...days.keys()].sort().reverse();
    let streak = 0;
    for (const day of dayList) {
      const lastOfDay = days.get(day)[0]; // already DESC
      if (lastOfDay.result === 'fail') streak++;
      else break;
    }
    if (streak >= minStreak) streaks.push({ sim_id: simId, days_failed: streak });
  }
  streaks.sort((a, b) => b.days_failed - a.days_failed);
  return streaks.slice(0, 50);
}

// Send the report as HTML email via Resend. Gated on RESEND_API_KEY.
async function sendReportEmail(env, subject, markdown) {
  if (!env.RESEND_API_KEY || !env.REPORT_EMAIL_TO) {
    return { sent: false, reason: 'RESEND_API_KEY or REPORT_EMAIL_TO not set' };
  }
  // Minimal markdown → HTML conversion (the report uses a tiny subset)
  const html = markdownToHtml(markdown);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.REPORT_EMAIL_FROM || 'rotation-review@incoming-sms.com',
      to: env.REPORT_EMAIL_TO,
      subject,
      html,
      text: markdown,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return { sent: false, reason: `Resend ${res.status}: ${t.slice(0, 200)}` };
  }
  const body = await res.json().catch(() => ({}));
  return { sent: true, id: body.id };
}

function markdownToHtml(md) {
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = md.split('\n');
  const out = ['<!DOCTYPE html><html><head><meta charset="utf-8"><style>',
    'body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;color:#222;max-width:760px;margin:24px auto;padding:0 16px}',
    'h1{font-size:22px;border-bottom:2px solid #333;padding-bottom:6px}',
    'h2{font-size:16px;margin-top:24px;color:#333}',
    'table{border-collapse:collapse;margin:8px 0}',
    'th,td{border:1px solid #ddd;padding:6px 10px;font-size:13px}',
    'th{background:#f4f4f4;text-align:left}',
    'code{background:#f4f4f4;padding:1px 4px;border-radius:3px;font-size:12px}',
    'hr{border:none;border-top:1px solid #ccc;margin:24px 0}',
    'li{margin:4px 0}',
    '</style></head><body>'];
  let inTable = false;
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^# /.test(line))       { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h1>${esc(line.slice(2))}</h1>`); continue; }
    if (/^## /.test(line))      { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h2>${esc(line.slice(3))}</h2>`); continue; }
    if (/^---$/.test(line))     { if (inList) { out.push('</ul>'); inList = false; } out.push('<hr>'); continue; }
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map(c => c.trim());
      if (/^[-:\s|]+$/.test(line.replace(/[|]/g, ''))) continue; // separator row
      if (!inTable) { out.push('<table>'); inTable = true; }
      const tag = i > 0 && /^\|.*\|$/.test(lines[i+1] || '') && /^[-:\s|]+$/.test((lines[i+1]||'').replace(/[|]/g, '')) ? 'th' : 'td';
      out.push('<tr>' + cells.map(c => `<${tag}>${esc(c)}</${tag}>`).join('') + '</tr>');
      continue;
    }
    if (inTable) { out.push('</table>'); inTable = false; }
    if (/^- /.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      const content = esc(line.slice(2)).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
      out.push(`<li>${content}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (line.trim() === '') { out.push('<br>'); continue; }
    const content = esc(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    out.push(`<p>${content}</p>`);
  }
  if (inList)  out.push('</ul>');
  if (inTable) out.push('</table>');
  out.push('</body></html>');
  return out.join('');
}

// Vendor circuit breaker. Tracks consecutive 5xx per-vendor. If we see 5
// in a row from a vendor, skip that vendor for the rest of the run.
function newCircuitBreaker() {
  const counts = new Map();
  const tripped = new Set();
  return {
    record(vendor, ok, status) {
      if (tripped.has(vendor)) return;
      if (ok || (status >= 0 && status < 500)) { counts.set(vendor, 0); return; }
      const c = (counts.get(vendor) || 0) + 1;
      counts.set(vendor, c);
      if (c >= 5) tripped.add(vendor);
    },
    isTripped(vendor) { return tripped.has(vendor); },
    trippedVendors() { return [...tripped]; },
  };
}

async function runRotationReview(env, opts = {}) {
  const dryRun = opts.dryRun === true;
  const tonightStart = nyMidnightUtcIso() || new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const today = ymdUtc();
  const startedAt = Date.now();

  // ── 0. Acquire run-lock ────────────────────────────────────────────────────
  let lockHandle = null;
  let runId = null;
  if (!dryRun) {
    lockHandle = await acquireReviewLock(env, 'rotation_review');
    if (!lockHandle.acquired) {
      return `# Rotation Review — ${today}\n\nAnother review run is currently active (${lockHandle.reason}). Aborting to avoid concurrent runs. Try again after the active run finishes (max 30 min lock).\n`;
    }
    runId = lockHandle.run?.run_id || null;
  }

  const breaker = newCircuitBreaker();
  let report = '';

  try {
    // ── 1. Tally last night's rotations by vendor ─────────────────────────────
    const tally = {};
    for (const v of ['atomic', 'helix', 'wing_iot', 'teltik']) {
      const rows = await rotationReviewQuery(env,
        `sims?select=rotation_status,status,last_mdn_rotated_at,last_rotation_at,last_notified_at&vendor=eq.${v}&last_mdn_rotated_at=gt.${encodeURIComponent(tonightStart)}&limit=5000`);
      const stats = { rotated: rows.length, success: 0, mdn_pending: 0, rotating: 0, failed: 0, notified: 0 };
      for (const r of rows) {
        if (r.rotation_status === 'success') stats.success++;
        else if (r.rotation_status === 'mdn_pending') stats.mdn_pending++;
        else if (r.rotation_status === 'rotating')   stats.rotating++;
        else if (r.rotation_status === 'failed')     stats.failed++;
        if (r.last_notified_at && r.last_mdn_rotated_at && r.last_notified_at >= r.last_mdn_rotated_at) stats.notified++;
      }
      tally[v] = stats;
    }

    // ── 2. Classify failed SIMs via the playbook ─────────────────────────────
    const failedRows = await rotationReviewQuery(env,
      `sims?select=id,iccid,vendor,msisdn,rotation_status,status,last_mdn_rotated_at,last_rotation_error&rotation_status=eq.failed&last_mdn_rotated_at=gt.${encodeURIComponent(tonightStart)}&limit=5000`);
    const buckets = {}; // bucketId → { entry, sims: [] }
    const unclassified = [];
    for (const sim of failedRows) {
      const entry = classifyFailure(sim);
      if (!entry) { unclassified.push(sim); continue; }
      if (!buckets[entry.id]) buckets[entry.id] = { entry, sims: [] };
      buckets[entry.id].sims.push(sim);
    }

    // ── 3. Apply playbook auto-fixes ─────────────────────────────────────────
    const actions = {
      flipped_to_mdn_pending: 0,
      force_rotated: { attempted: 0, ok: 0, fail: 0, skipped_budget: 0, skipped_breaker: 0 },
      finalizer_drained: { helix: 0, wing: 0, teltik: 0, atomic: 0 },
      second_read_verified: 0,
      second_read_failed: 0,
    };
    const breakerEvents = [];

    for (const { entry, sims } of Object.values(buckets)) {
      if (entry.action === 'flip_to_mdn_pending') {
        if (!dryRun && sims.length > 0) {
          const ids = sims.map(s => s.id).join(',');
          const flipRes = await fetch(`${env.SUPABASE_URL}/rest/v1/sims?id=in.(${ids})`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ status: 'provisioning', rotation_status: 'mdn_pending' }),
          });
          if (flipRes.ok) {
            actions.flipped_to_mdn_pending += sims.length;
            await Promise.all(sims.map(s => recordAttempt(env, s.id, runId, 'flip_to_mdn_pending', 'ok', null)));
          }
        }
      } else if (entry.action === 'force_rotate' && !dryRun) {
        const maxThisRun = Math.min(entry.maxAttempts || 1, sims.length);
        for (const sim of sims.slice(0, maxThisRun)) {
          if (breaker.isTripped(sim.vendor)) {
            actions.force_rotated.skipped_breaker++;
            continue;
          }
          const used = await attemptsToday(env, sim.id, 'force_rotate');
          if (used >= 3) {
            actions.force_rotated.skipped_budget++;
            await recordAttempt(env, sim.id, runId, 'force_rotate', 'fail', `budget exhausted (${used}/3 today)`);
            continue;
          }
          actions.force_rotated.attempted++;
          const r = await forceRotateSim(env, sim);
          breaker.record(sim.vendor, r.ok, r.status || 0);
          if (breaker.isTripped(sim.vendor)) {
            breakerEvents.push(`${sim.vendor}: 5 consecutive 5xx, skipping remaining ${sim.vendor} SIMs for this run`);
          }
          if (r.ok) {
            // Second-read verification (atomic only — confirms msisdn changed)
            if (sim.vendor === 'atomic') {
              const verify = await atomicSecondRead(env, sim);
              if (verify.verified === true) actions.second_read_verified++;
              else if (verify.verified === false) actions.second_read_failed++;
            }
            actions.force_rotated.ok++;
            await recordAttempt(env, sim.id, runId, 'force_rotate', 'ok', null);
          } else {
            actions.force_rotated.fail++;
            await recordAttempt(env, sim.id, runId, 'force_rotate', 'fail', r.error || `status=${r.status}`);
          }
          await new Promise(res => setTimeout(res, 2000)); // polite gap between rotations
        }
      }
    }

    // ── 4. Drain pending finalizer work ──────────────────────────────────────
    if (!dryRun) {
      try { actions.finalizer_drained.helix  = (await runHelixFinalizer (env, 200))?.activated ?? 0; } catch (e) { console.error('[Review] helix drain:',  e); }
      try { actions.finalizer_drained.wing   = (await runWingIotFinalizer(env, 200))?.activated ?? 0; } catch (e) { console.error('[Review] wing drain:',   e); }
      try { actions.finalizer_drained.teltik = (await runTeltikFinalizer (env, 500))?.synced    ?? 0; } catch (e) { console.error('[Review] teltik drain:', e); }
      try { actions.finalizer_drained.atomic = (await runAtomicFinalizer (env, 200))?.synced    ?? 0; } catch (e) { console.error('[Review] atomic drain:', e); }
    }

    // ── 5. Pool health ───────────────────────────────────────────────────────
    async function poolCount(filter) {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/address_pool_usage?${filter}&select=address_id&limit=1`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
        },
      });
      const cr = res.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+|\*)$/);
      return m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
    }
    const poolStats = {
      total:               await poolCount(''),
      quarantined:         await poolCount('verify_failed_at=not.is.null'),
      quarantined_tonight: await poolCount(`verify_failed_at=gt.${encodeURIComponent(tonightStart)}`),
    };

    // ── 6. Multi-day pattern detection ───────────────────────────────────────
    const multiDayFailures = await detectMultiDayFailures(env, 3);

    // ── 6b. Read operator responses from pending items ───────────────────────
    const openPending = await loadOpenPendingItems(env).catch(() => []);
    const answeredItems = openPending.filter(i => i.status === 'answered' && i.operator_response);
    const stillOpenCount = openPending.filter(i => i.status === 'open').length;

    // ── 6c. Create/update pending_review_items for this run ──────────────────
    let newPendingCreated = 0;
    if (!dryRun) {
      for (const { entry, sims } of Object.values(buckets)) {
        if (entry.safe) continue; // auto-fix; no operator action needed
        for (const sim of sims) {
          const existing = await findOpenPendingForSim(env, sim.id, 'human_review_failure');
          if (existing) continue;
          const summary = `${entry.id}: SIM #${sim.id} (${sim.vendor})`;
          const details = `**Bucket:** ${entry.id}\n**Vendor:** ${sim.vendor}\n**MSISDN:** ${sim.msisdn || '—'}\n**Error:** ${(sim.last_rotation_error || '').slice(0, 400)}\n\n**Playbook description:** ${entry.description}`;
          await insertPendingItem(env, {
            kind: 'human_review_failure', summary, details_md: details,
            run_id: runId, sim_id: sim.id, status: 'open',
          });
          newPendingCreated++;
        }
      }
      for (const sim of unclassified) {
        const existing = await findOpenPendingForSim(env, sim.id, 'unclassified_pattern');
        if (existing) continue;
        const summary = `unclassified: SIM #${sim.id} (${sim.vendor})`;
        const details = `**No playbook entry matched.** Operator decision needed; consider adding a playbook entry to \`src/shared/rotation-playbook.mjs\`.\n\n**Vendor:** ${sim.vendor}\n**MSISDN:** ${sim.msisdn || '—'}\n**Error:** ${(sim.last_rotation_error || '').slice(0, 400)}`;
        await insertPendingItem(env, {
          kind: 'unclassified_pattern', summary, details_md: details,
          run_id: runId, sim_id: sim.id, status: 'open',
        });
        newPendingCreated++;
      }
      for (const s of multiDayFailures) {
        const existing = await findOpenPendingForSim(env, s.sim_id, 'multi_day_failure');
        if (existing) continue;
        const summary = `multi_day: SIM #${s.sim_id} failed ${s.days_failed} days running`;
        const details = `SIM #${s.sim_id} has now failed force_rotate on **${s.days_failed} consecutive NY-days**. Suggested action: manually rotate via dashboard, or mark the SIM as quarantined if a vendor-side issue is suspected.`;
        await insertPendingItem(env, {
          kind: 'multi_day_failure', summary, details_md: details,
          run_id: runId, sim_id: s.sim_id, status: 'open',
        });
        newPendingCreated++;
      }
      // Mark any answered items as seen so they roll out of the "needs attention" count
      const answeredIds = answeredItems.map(i => i.id);
      if (answeredIds.length > 0) await markPendingItemSeen(env, answeredIds);
    }

    // ── 7. Render markdown report ────────────────────────────────────────────
    const lines = [];
    lines.push(`# Rotation Review — ${today}`);
    lines.push(`Generated: ${new Date().toISOString()} (NY-night started ${tonightStart}, dryRun=${dryRun}, run_id=${runId || 'n/a'})`);
    lines.push('');

    lines.push('## Tally by vendor');
    lines.push('');
    lines.push('| Vendor | Rotated | Success | mdn_pending | rotating | Failed | Notified |');
    lines.push('|--------|--------:|--------:|------------:|---------:|-------:|---------:|');
    for (const v of ['atomic', 'helix', 'wing_iot', 'teltik']) {
      const s = tally[v];
      lines.push(`| ${v} | ${s.rotated} | ${s.success} | ${s.mdn_pending} | ${s.rotating} | ${s.failed} | ${s.notified} |`);
    }
    lines.push('');

    lines.push('## Failure breakdown (playbook classified)');
    lines.push('');
    if (Object.keys(buckets).length === 0 && unclassified.length === 0) {
      lines.push('_No failures tonight — clean run._');
    } else {
      for (const { entry, sims } of Object.values(buckets)) {
        const exampleIds = sims.slice(0, 3).map(s => `#${s.id}`).join(', ');
        const more = sims.length > 3 ? ` …+${sims.length - 3} more` : '';
        const safe = entry.safe ? '🤖 auto-fix' : '👤 human review';
        lines.push(`- **${entry.id}** (${entry.vendor}, ${sims.length} SIMs) — ${safe}: ${exampleIds}${more}`);
      }
      if (unclassified.length > 0) {
        const ids = unclassified.slice(0, 3).map(s => `#${s.id}`).join(', ');
        const more = unclassified.length > 3 ? ` …+${unclassified.length - 3} more` : '';
        lines.push(`- **${UNCLASSIFIED_BUCKET}** (${unclassified.length} SIMs) — 👤 human review (no playbook match): ${ids}${more}`);
      }
    }
    lines.push('');

    lines.push('## Auto-fixes applied');
    lines.push('');
    lines.push(`- Flipped to mdn_pending: **${actions.flipped_to_mdn_pending}**`);
    lines.push(`- Force-rotated: **${actions.force_rotated.attempted}** attempted (${actions.force_rotated.ok} ok, ${actions.force_rotated.fail} fail, ${actions.force_rotated.skipped_budget} skipped-budget, ${actions.force_rotated.skipped_breaker} skipped-breaker)`);
    if (actions.second_read_verified + actions.second_read_failed > 0) {
      lines.push(`- Atomic second-read verification: ${actions.second_read_verified} confirmed new MDN, ${actions.second_read_failed} MDN unchanged after force-rotate`);
    }
    lines.push(`- Finalizer drain: helix=${actions.finalizer_drained.helix}, wing=${actions.finalizer_drained.wing}, teltik=${actions.finalizer_drained.teltik}, atomic=${actions.finalizer_drained.atomic}`);
    if (breakerEvents.length > 0) {
      lines.push('');
      lines.push('### Circuit breaker tripped');
      for (const e of breakerEvents) lines.push(`- ${e}`);
    }
    lines.push('');

    lines.push('## Address pool');
    lines.push('');
    lines.push(`- Total: ${poolStats.total} | Quarantined: ${poolStats.quarantined} | Quarantined tonight: ${poolStats.quarantined_tonight}`);
    if (poolStats.quarantined_tonight > 30) {
      lines.push(`- ⚠️ Quarantine spike (${poolStats.quarantined_tonight} tonight). Consider running \`/refill-pool?max=20\` once or twice.`);
    }
    lines.push('');

    // Unclassified + human-review failures with detail
    const humanReviewBuckets = Object.values(buckets).filter(({ entry }) => !entry.safe);
    if (humanReviewBuckets.length > 0 || unclassified.length > 0) {
      lines.push('## Failures needing human review');
      lines.push('');
      for (const { entry, sims } of humanReviewBuckets) {
        for (const s of sims.slice(0, 10)) {
          const err = String(s.last_rotation_error || '').slice(0, 140);
          lines.push(`- **${entry.id}** SIM #${s.id} (${s.vendor}, msisdn=${s.msisdn || '—'}): ${err}`);
        }
        if (sims.length > 10) lines.push(`  …+${sims.length - 10} more in this bucket`);
      }
      for (const s of unclassified.slice(0, 10)) {
        const err = String(s.last_rotation_error || '').slice(0, 140);
        lines.push(`- **${UNCLASSIFIED_BUCKET}** SIM #${s.id} (${s.vendor}, msisdn=${s.msisdn || '—'}): ${err}`);
      }
      if (unclassified.length > 10) lines.push(`  …+${unclassified.length - 10} more unclassified`);
      lines.push('');
    }

    if (multiDayFailures.length > 0) {
      lines.push('## SIMs failing multiple days in a row');
      lines.push('');
      lines.push(`${multiDayFailures.length} SIMs have failed force_rotate on ${multiDayFailures[0].days_failed} or more consecutive days. Likely needs manual investigation:`);
      lines.push('');
      for (const s of multiDayFailures.slice(0, 20)) {
        lines.push(`- SIM #${s.sim_id}: ${s.days_failed} consecutive day(s)`);
      }
      lines.push('');
    }

    if (answeredItems.length > 0) {
      lines.push('## Operator responses since last run');
      lines.push('');
      for (const it of answeredItems) {
        lines.push(`- **${it.kind}** ${it.summary} → operator: "${(it.operator_response || '').slice(0, 200)}"`);
      }
      lines.push('');
    }

    if (newPendingCreated > 0 || stillOpenCount > 0) {
      lines.push('## Pending operator items');
      lines.push('');
      lines.push(`- New items this run: **${newPendingCreated}**`);
      lines.push(`- Still open from prior runs: **${stillOpenCount}**`);
      lines.push(`- Respond via the dashboard /rotation-reviews page.`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`_Generated by details-finalizer /rotation-review in ${(Date.now() - startedAt) / 1000}s. Source: src/details-finalizer/index.js runRotationReview(). Playbook: src/shared/rotation-playbook.mjs (${PLAYBOOK.length} entries)._`);

    report = lines.join('\n');

    // ── 8. Send email if configured ──────────────────────────────────────────
    if (!dryRun) {
      const urgent = (Object.values(buckets).some(({ entry }) => !entry.safe))
        || unclassified.length > 0
        || multiDayFailures.length > 0
        || breakerEvents.length > 0;
      const subject = urgent
        ? `🔧 Rotation Review ${today} — ${unclassified.length + humanReviewBuckets.reduce((n, b) => n + b.sims.length, 0)} need review`
        : `✅ Rotation Review ${today} — all clear`;
      const emailResult = await sendReportEmail(env, subject, report);
      report += `\n_Email: ${emailResult.sent ? 'sent (id=' + emailResult.id + ')' : 'skipped — ' + emailResult.reason}_\n`;
    }

    if (!dryRun && lockHandle?.run?.id) {
      await releaseReviewLock(env, lockHandle.run.id, 'completed', {
        tally, actions, pool: poolStats,
        multi_day_count: multiDayFailures.length,
        breaker: breaker.trippedVendors(),
        pending_open: stillOpenCount,
        pending_new:  newPendingCreated,
      }, report);
    }
    return report;
  } catch (err) {
    if (!dryRun && lockHandle?.run?.id) {
      await releaseReviewLock(env, lockHandle.run.id, 'aborted', { error: String(err) });
    }
    throw err;
  }
}

/* ── Address Pool Refill ──────────────────────────────────────────────────── */
// Every 6h cron picks ≤5 zips where the sole address is quarantined, queries
// OpenStreetMap Overpass for a different civic-building address at that zip,
// and INSERTs the replacement into address_pool_usage. The quarantined row
// stays (90d cooldown is preserved as history); the new row becomes the LRU
// pick on next rotation since last_used_at is NULL.

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const REFILL_DEFAULT_MAX_ZIPS = 5;
const REFILL_QUERY_DELAY_MS   = 5000; // polite delay between Overpass queries

function refillSlug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeOsmAddress(tags) {
  const norm = (k) => String(tags[k] || '').trim().replace(/\s+/g, ' ');
  const housenumber = norm('addr:housenumber');
  const street      = norm('addr:street');
  const city        = norm('addr:city');
  const zip         = norm('addr:postcode').slice(0, 5); // strip ZIP+4
  if (!housenumber || !street || !city || !zip) return null;
  if (!/^\d+[a-zA-Z]?$/.test(housenumber)) return null;  // skip "13-15", etc.
  if (!/^\d{5}$/.test(zip))               return null;   // skip non-5-digit
  return { housenumber, street, city, zip };
}

async function overpassFetchByZip(env, state, zip) {
  // Scope to state area or Overpass does a full-planet postcode scan and 504s.
  // Postcode matched both exactly and as a ZIP+4 prefix.
  const amenities = ['post_office', 'library', 'townhall', 'courthouse', 'fire_station'];
  const filters = amenities.flatMap(a => [
    `nwr["amenity"="${a}"]["addr:postcode"="${zip}"](area.searchArea);`,
    `nwr["amenity"="${a}"]["addr:postcode"~"^${zip}-"](area.searchArea);`,
  ]).join('\n  ');
  const query = `[out:json][timeout:60];\narea["ISO3166-2"="US-${state}"]->.searchArea;\n(\n  ${filters}\n);\nout tags center;`;
  // Single retry on 429/504 — Overpass is famously transient under load.
  let lastErr;
  for (const attempt of [1, 2]) {
    try {
      // Direct fetch, NOT relayFetch: Overpass is a public unauthenticated OSM
      // mirror — relay routing adds latency without value and the relay appears
      // to time out on long-running Overpass queries. Relay exists for AT&T /
      // Helix IP allowlist needs, not for public APIs like OSM.
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'incomingsms address-pool refill (https://github.com/ZMAWline/incomingsms)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200);
        if ((res.status === 429 || res.status === 504) && attempt === 1) {
          lastErr = new Error(`Overpass HTTP ${res.status}: ${text}`);
          await new Promise(r => setTimeout(r, 30000)); // 30s backoff before retry
          continue;
        }
        throw new Error(`Overpass HTTP ${res.status}: ${text}`);
      }
      const data = await res.json();
      const elements = Array.isArray(data.elements) ? data.elements : [];
      const candidates = [];
      for (const el of elements) {
        const norm = normalizeOsmAddress(el.tags || {});
        if (!norm) continue;
        if (norm.zip !== zip) continue;
        candidates.push(norm);
      }
      return candidates;
    } catch (err) {
      lastErr = err;
      if (attempt === 2) throw err;
    }
  }
  throw lastErr;
}

async function supabaseRpc(env, fn, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey:        env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`Supabase RPC ${fn} ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function runAddressPoolRefill(env, opts = {}) {
  const maxZips = Math.min(Math.max(parseInt(opts.maxZips, 10) || REFILL_DEFAULT_MAX_ZIPS, 1), 20);
  const dryRun  = opts.dryRun === true;

  const targets = await supabaseRpc(env, 'list_zips_needing_refill', { p_limit: maxZips });
  if (!Array.isArray(targets) || targets.length === 0) {
    console.log('[Refill] no zips needing refill');
    return { ok: true, attempted: 0, results: [] };
  }
  console.log(`[Refill] processing ${targets.length} zip(s), dry=${dryRun}`);

  const results = [];
  for (const target of targets) {
    if (results.length > 0) await new Promise(r => setTimeout(r, REFILL_QUERY_DELAY_MS));
    let outcome;
    try {
      const candidates = await overpassFetchByZip(env, target.state, target.zip_code);
      const excludeKey = `${target.street_number}|${target.street_name}`.toLowerCase();
      const fresh = candidates.find(c =>
        `${c.housenumber}|${c.street}`.toLowerCase() !== excludeKey
      );
      if (!fresh) {
        outcome = {
          zip: target.zip_code, state: target.state, status: 'no_alternative',
          osm_candidates: candidates.length, quarantined_id: target.address_id,
        };
      } else {
        const newId = `${target.state.toLowerCase()}-${target.zip_code}-${fresh.housenumber}-${refillSlug(fresh.street)}`;
        if (!dryRun) {
          // Use ON CONFLICT DO NOTHING via Prefer header to swallow rare slug collisions.
          const insRes = await fetch(`${env.SUPABASE_URL}/rest/v1/address_pool_usage?on_conflict=address_id`, {
            method: 'POST',
            headers: {
              apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization:   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type':  'application/json',
              Prefer:          'resolution=ignore-duplicates,return=minimal',
            },
            body: JSON.stringify([{
              address_id:       newId,
              state:            target.state,
              zip_code:         target.zip_code,
              street_number:    fresh.housenumber,
              street_name:      fresh.street,
              street_direction: '',
              city:             fresh.city,
            }]),
          });
          if (!insRes.ok) throw new Error(`INSERT HTTP ${insRes.status}: ${await insRes.text().catch(() => '')}`);
        }
        outcome = {
          zip: target.zip_code, state: target.state, status: dryRun ? 'would_replace' : 'replaced',
          new_id: newId, replaced_id: target.address_id,
        };
      }
    } catch (err) {
      outcome = {
        zip: target.zip_code, state: target.state, status: 'error',
        error: String(err).slice(0, 200), quarantined_id: target.address_id,
      };
    }
    results.push(outcome);
    console.log(`[Refill] ${target.state} ${target.zip_code}: ${outcome.status}`);
  }
  return { ok: true, attempted: targets.length, results };
}

/* ── Relay ────────────────────────────────────────────────────────────────── */

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

/* ── Helix ────────────────────────────────────────────────────────────────── */

async function hxGetBearerToken(env) {
  const res = await relayFetch(env, env.HX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: env.HX_CLIENT_ID,
      audience: env.HX_AUDIENCE,
      username: env.HX_GRANT_USERNAME,
      password: env.HX_GRANT_PASSWORD,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Failed to get Helix token');
  return data.access_token;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId) {
  const res = await relayFetch(env, `${env.HX_API_BASE}/api/mobility-subscriber/details`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mobilitySubscriptionId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`subscriber_details failed ${res.status}`);
  return data;
}

/* ── Supabase ─────────────────────────────────────────────────────────────── */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase SELECT ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text().catch(() => '')}`);
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase INSERT ${res.status}: ${await res.text().catch(() => '')}`);
}

/* ── sim_numbers helpers ──────────────────────────────────────────────────── */

async function closeCurrentNumber(env, simId) {
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
}

async function insertNewNumber(env, simId, e164) {
  await supabaseInsert(env, 'sim_numbers', [
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
      verification_status: 'verified',
    },
  ]);
}

function normalizeUS(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/* ── Webhook (number.online) ──────────────────────────────────────────────── */

async function sendNumberOnlineWebhook(env, simId, number, iccid, mobilitySubscriptionId, opts = {}) {
  // Defensive guard: never fire number.online for a wing_iot SIM stuck in
  // rotation_status='failed' — that signals it's on the non-dialable ABIR plan
  // and the MDN we're about to broadcast is a 5xxx interim number that can't
  // receive normal SMS. The cleanup sweep + processRotationBatch flag these.
  // Bypassed when opts.force=true — caller (reconciliation) already filtered
  // to rotation_status='success' so the guard read would be redundant.
  if (!opts.force) {
    const guard = await supabaseSelect(env,
      `sims?select=vendor,rotation_status&id=eq.${encodeURIComponent(String(simId))}&limit=1`
    ).catch(() => []);
    const guardRow = Array.isArray(guard) && guard[0];
    if (guardRow && guardRow.vendor === 'wing_iot' && guardRow.rotation_status === 'failed') {
      console.log(`[Webhook] SIM ${simId}: skipping number.online — wing_iot rotation_status=failed (likely on ABIR)`);
      return;
    }
  }

  const resellerId = await findResellerIdBySimId(env, simId);
  if (!resellerId) {
    console.log(`[Webhook] SIM ${simId}: no active reseller, skipping number.online`);
    return;
  }
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) {
    console.log(`[Webhook] SIM ${simId}: reseller ${resellerId} has no enabled webhook`);
    return;
  }

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.online',
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid,
      mobilitySubscriptionId,
      verified: true,
    },
  }, { idComponents: { simId, iccid, number }, resellerId });

  if (!result.ok) {
    console.error(`[Webhook] SIM ${simId}: number.online FAILED after ${result.attempts} attempts`);
  }

  if (result.ok) {
    try {
      await supabasePatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
        last_notified_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[Webhook] SIM ${simId}: last_notified_at PATCH failed: ${err}`);
    }
  }
}

/* ── Webhook (number.offline) ─────────────────────────────────────────────── */
// Fired before closeCurrentNumber when an MDN is being replaced. Resellers that
// route by phone-number (not sim_id) need the OLD number's offline event so they
// can deprovision the route before AT&T reassigns the MDN to another customer.
async function sendNumberOfflineWebhook(env, simId, oldNumber, iccid, oldMobilityId, newNumber) {
  const resellerId = await findResellerIdBySimId(env, simId);
  if (!resellerId) {
    console.log(`[Webhook] SIM ${simId}: no active reseller, skipping number.offline`);
    return;
  }
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
  if (!webhookUrl) {
    console.log(`[Webhook] SIM ${simId}: reseller ${resellerId} has no enabled webhook, skipping number.offline`);
    return;
  }

  const result = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.offline',
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number: oldNumber,
      online: false,
      iccid,
      mobilitySubscriptionId: oldMobilityId,
      replaced_by: newNumber,
      verified: true,
    },
  }, { idComponents: { simId, iccid, number: oldNumber }, resellerId });

  if (!result.ok) {
    console.error(`[Webhook] SIM ${simId}: number.offline FAILED after ${result.attempts} attempts (old=${oldNumber})`);
  }
  // Deliberately do NOT stamp last_notified_at — that's specifically the last
  // online notification timestamp.
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const data = await supabaseSelect(
    env,
    `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`
  ).catch(() => null);
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const data = await supabaseSelect(
    env,
    `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`
  ).catch(() => null);
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

async function sendWebhookWithDeduplication(env, webhookUrl, payload, options = {}) {
  if (!webhookUrl) return { ok: false, status: 0, attempts: 0, error: 'No webhook URL' };

  let messageId = options.messageId;
  if (!messageId && options.idComponents) {
    messageId = await generateMessageIdAsync({
      eventType: payload.event_type,
      ...options.idComponents,
    });
  }
  if (!messageId) {
    messageId = `${payload.event_type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  payload.message_id = messageId;

  const alreadySent = await wasWebhookDelivered(env, messageId);
  if (alreadySent) {
    console.log(`[Webhook] Skipping duplicate ${messageId}`);
    return { ok: true, status: 200, attempts: 0, skipped: true };
  }

  const result = await postWebhookWithRetry(env, webhookUrl, payload, { messageId });

  try {
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
  } catch (err) {
    console.log(`[Webhook] Failed to record delivery: ${err}`);
  }

  return result;
}

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  let dedupeTs;
  if (eventType === 'number.online' || eventType === 'number.offline') {
    dedupeTs = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    dedupeTs = timestamp
      ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
      : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), dedupeTs].join('|');
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${eventType}_${hashHex}`;
}

async function wasWebhookDelivered(env, messageId) {
  const data = await supabaseSelect(
    env,
    `webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`
  ).catch(() => null);
  return Array.isArray(data) && data.length > 0;
}

async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts, responseBody } = delivery;
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
      last_attempt_at: new Date().toISOString(),
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      response_body: responseBody ? String(responseBody).slice(0, 2000) : null,
    }),
  });
}

async function postWebhookWithRetry(env, url, payload, options = {}) {
  const { maxRetries = 4, initialDelayMs = 1000, messageId = 'unknown' } = options;
  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await relayFetch(env, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      const responseBody = await res.text().catch(() => '');
      if (res.ok) {
        // number.online: 2xx is only a true success if the reseller echoes a rentalId.
        // Incident 2026-05-11 16:59:57Z: TrustOTP returned 200 with empty body for a
        // ~53s batch; we marked 168 SIMs delivered, no rentals were created on their
        // side, and the next-day per-day dedup hid the gap.
        if (payload?.event_type === 'number.online' && parseRentalIdFromResponse(responseBody) == null) {
          lastError = `2xx with no rentalId (status ${res.status}, body ${responseBody.slice(0, 200) || '<empty>'})`;
        } else {
          return { ok: true, status: res.status, attempts: attempt, responseBody };
        }
      } else if (res.status >= 400 && res.status < 500) {
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      } else {
        lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
      }
    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
    }
    if (attempt <= maxRetries) await sleep(initialDelayMs * Math.pow(2, attempt - 1));
  }
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
}

// Loose rentalId extractor; matches TrustOTP's {"rentalId":N} and any reseller that
// returns rental_id / id. Used by postWebhookWithRetry to validate number.online 2xx.
function parseRentalIdFromResponse(body) {
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextRotationUtcISO() {
  const now = new Date();
  const nyDateToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const [y, m, d] = nyDateToday.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-5');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
