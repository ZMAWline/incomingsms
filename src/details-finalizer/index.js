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
    if (url.pathname !== '/run') {
      return new Response('details-finalizer ok. Use /run?secret=... or /sweep-wing-cleanup?secret=...&limit=50&offset=0 or /reconcile-rotations?secret=...[&dry=1][&force=1] or /test-offline?secret=...&reseller_id=N&limit=10[&dry=1]', { status: 200 });
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
