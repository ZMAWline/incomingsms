import { pickNextPpuAddress, markAddressVerifyFailure } from '../shared/address-picker.mjs';
import { buildAtomicActivateRequest, buildAtomicPortInRequest, normalizePhone10, parseAtomicPortInRequest, parseCsv, pickRandomPortIdentity, isAddressRejection, validateActivationSim } from '../shared/activation-bulk.mjs';

// =========================================================
// SIM ACTIVATOR WORKER
// Queues individual SIM activations — one SIM at a time.
// Supports multiple vendors: helix, atomic, wing_iot
// Queue consumer routes to appropriate carrier API per SIM.
// Now with per-SIM job tracking via activation_runs / activation_job_items.
// =========================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/activate') {
      return handleActivateJson(request, env);
    }

    if (url.pathname === '/retry') {
      return handleRetryJson(request, env);
    }

    if (url.pathname === '/retry-portin') {
      return handleRetryPortInJson(request, env);
    }

    if (url.pathname !== '/run') {
      return new Response('sim-activator ok. Use /run?secret=... or POST /activate?secret=...', { status: 200 });
    }

    const secret = url.searchParams.get('secret') || '';
    if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : null;

    const csvRes = await relayFetch(env, env.SHEET_CSV_URL);
    if (!csvRes.ok) return new Response(`Failed to fetch CSV: ${csvRes.status}`, { status: 500 });
    const csvText = await csvRes.text();

    const rows = parseCsv(csvText);
    if (rows.length < 2) return json({ ok: true, queued: 0, note: 'CSV empty' });

    const header = rows[0].map(h => (h || '').trim().toLowerCase());
    const dataRows = rows.slice(1).map(r => normalizeRow(r, header.length));

    const iIccid = header.indexOf('iccid');
    const iImei = header.indexOf('imei');
    const iReseller = header.indexOf('reseller_id');
    const iStatus = header.indexOf('status');
    const iVendor = header.indexOf('vendor');
    const iPortIn = header.indexOf('port_in');
    const iPortMdn = header.indexOf('port_mdn');
    const iPortAccountNumber = header.indexOf('port_account_number');
    const iPortPin = header.indexOf('port_pin');
    const iPortFirstName = header.indexOf('port_first_name');
    const iPortLastName = header.indexOf('port_last_name');
    const iPortStreetNumber = header.indexOf('port_street_number');
    const iPortStreetName = header.indexOf('port_street_name');
    const iPortZip = header.indexOf('port_zip');
    const iPortOldFirstName = header.indexOf('port_old_first_name');
    const iPortOldLastName = header.indexOf('port_old_last_name');

    if ([iIccid, iImei, iReseller, iStatus].some(i => i < 0)) {
      return new Response('CSV missing required headers (iccid, imei, reseller_id, status)', { status: 400 });
    }

    const pending = dataRows.filter(r => (r[iStatus] || '').trim().toLowerCase() === 'pending');
    const toProcess = limit ? pending.slice(0, limit) : pending;

    if (toProcess.length === 0) return json({ ok: true, queued: 0, note: 'No pending rows' });

    // Validate all rows first before any DB operations
    let validationErrors = 0;
    const rowErrors = [];
    const validatedSims = [];

    for (const r of toProcess) {
      const checked = validateActivationSim({
        iccid: String(r[iIccid] || '').trim(),
        imei: String(r[iImei] || '').trim(),
        reseller_id: String(r[iReseller] || '').trim(),
        vendor: iVendor >= 0 ? String(r[iVendor] || '').trim() : 'atomic',
        port_in: iPortIn >= 0 ? String(r[iPortIn] || '').trim() : '',
        port_mdn: iPortMdn >= 0 ? String(r[iPortMdn] || '').trim() : '',
        port_account_number: iPortAccountNumber >= 0 ? String(r[iPortAccountNumber] || '').trim() : '',
        port_pin: iPortPin >= 0 ? String(r[iPortPin] || '').trim() : '',
        port_first_name: iPortFirstName >= 0 ? String(r[iPortFirstName] || '').trim() : '',
        port_last_name: iPortLastName >= 0 ? String(r[iPortLastName] || '').trim() : '',
        port_street_number: iPortStreetNumber >= 0 ? String(r[iPortStreetNumber] || '').trim() : '',
        port_street_name: iPortStreetName >= 0 ? String(r[iPortStreetName] || '').trim() : '',
        port_zip: iPortZip >= 0 ? String(r[iPortZip] || '').trim() : '',
        port_old_first_name: iPortOldFirstName >= 0 ? String(r[iPortOldFirstName] || '').trim() : '',
        port_old_last_name: iPortOldLastName >= 0 ? String(r[iPortOldLastName] || '').trim() : '',
      }, { defaultVendor: 'atomic' });
      if (!checked.ok) {
        validationErrors++;
        rowErrors.push(...checked.errors);
        continue;
      }
      validatedSims.push(checked.sim);
    }

    // Create parent activation run
    const runId = `csv_${Date.now()}`;
    let runUuid;
    try {
      runUuid = await createActivationRun(env, {
        source: 'csv',
        totalItems: validatedSims.length,
        createdBy: 'csv_run',
      });
    } catch (e) {
      return new Response(`Failed to create activation run: ${e}`, { status: 502 });
    }

    let queued = 0;
    try {
      if (validatedSims.length > 0) {
        // One INSERT and one batch of queue sends instead of two round-trips
        // per SIM — the prior per-row loop was the dominant cost of a CSV run.
        await createActivationJobItems(env, runUuid, validatedSims);
        await sendQueueBatch(env.ACTIVATION_QUEUE, validatedSims.map(sim => ({
          body: { ...sim, run_id: runId, job_run_id: runUuid },
        })));
        queued = validatedSims.length;
      }
      await updateActivationRunCounts(env, runUuid, { queuedItems: queued, validationErrors, rowErrors });
    } catch (e) {
      return json({
        ok: false,
        error: `Activation run ${runUuid} created but queuing failed: ${e}`,
        queued,
        validation_errors: validationErrors,
        row_errors: rowErrors,
        run_id: runId,
        job_run_id: runUuid,
      }, 502);
    }

    return json({ ok: validationErrors === 0, queued, validation_errors: validationErrors, row_errors: rowErrors, run_id: runId, job_run_id: runUuid });
  },

  // ── Queue consumer — one SIM at a time, routes by vendor ─────────────────
  async queue(batch, env) {
    // Pre-fetch Helix token only if we have helix SIMs in batch
    let helixToken = null;
    const hasHelix = env.HELIX_ENABLED === 'true' && batch.messages.some(m => m.body.vendor === 'helix');
    if (hasHelix) {
      try {
        helixToken = await hxGetBearerToken(env);
      } catch (e) {
        console.error(`[Activator] Helix token fetch failed: ${e} — leaving Helix messages in queue`);
        // Only ack non-helix messages, retry helix ones
        for (const msg of batch.messages) {
          if (msg.body.vendor !== 'helix') {
            // Process non-helix normally
          } else {
            // Don't ack helix messages - they'll retry
          }
        }
      }
    }

    for (const msg of batch.messages) {
      const {
        iccid,
        imei,
        reseller_id: resellerId,
        run_id: runId,
        job_run_id: jobRunId,
        vendor = 'atomic',
        port_mdn: portMdn = '',
        port_account_number: portAccountNumber = '',
        port_pin: portPin = '',
        port_first_name: portFirstName = '',
        port_last_name: portLastName = '',
        port_street_number: portStreetNumber = '',
        port_street_name: portStreetName = '',
        port_zip: portZip = '',
        port_old_first_name: portOldFirstName = '',
        port_old_last_name: portOldLastName = '',
      } = msg.body;

      // Update job item to processing
      if (jobRunId) {
        await updateJobItemStatus(env, jobRunId, iccid, 'processing', { started_at: new Date().toISOString() });
      }

      try {
        // Skip if already activated (check for sub_id or msisdn based on vendor).
        // Gated on status too — sim-canceller sets status='canceled' without
        // clearing msisdn/mobility_subscription_id, so a canceled (or errored)
        // SIM being re-activated/re-ported still carries its old identifiers and
        // must NOT be mistaken for "already activated" here.
        const existing = await supabaseSelect(
          env,
          `sims?select=id,mobility_subscription_id,msisdn,vendor,status&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
        );
        const existingSim = existing?.[0];
        // A provisioning port-in SIM carries the customer's target MDN in
        // `msisdn` — the number we are trying to port, not one we were assigned
        // — so this heuristic reads it as "already activated" and silently
        // no-ops the retry. /retry-portin has already proven with the carrier
        // that no port request exists, so let it through. `active` is never
        // relaxed: that is the case this guard actually exists for.
        const isPortInRetry = msg.body.portin_retry === true;
        const alreadyActivated = existingSim
          && (existingSim.status === 'active'
              || (existingSim.status === 'provisioning' && !isPortInRetry))
          && (existingSim.mobility_subscription_id || existingSim.msisdn);
        if (alreadyActivated) {
          console.log(`[Activator] ${iccid}: already activated (status=${existingSim.status}) — skipping`);
          if (jobRunId) {
            await updateJobItemStatus(env, jobRunId, iccid, 'skipped', { finished_at: new Date().toISOString(), error_message: 'Already activated' });
          }
          msg.ack();
          continue;
        }

        let result;
        switch (vendor) {
          case 'atomic':
            result = await activateViaAtomic(env, iccid, imei, runId, {
              portMdn, portAccountNumber, portPin,
              port_first_name: portFirstName, port_last_name: portLastName,
              port_street_number: portStreetNumber, port_street_name: portStreetName, port_zip: portZip,
              port_old_first_name: portOldFirstName, port_old_last_name: portOldLastName,
              port_address_id: msg.body.port_address_id || null,
            });
            break;
          case 'wing_iot':
            result = await activateViaWingIot(env, iccid, runId);
            break;
          case 'helix':
            if (env.HELIX_ENABLED !== 'true') {
              console.warn(`[Activator] ${iccid}: Helix is disabled — acking without activation`);
              msg.ack(); continue;
            }
            if (!helixToken) {
              console.error(`[Activator] ${iccid}: No Helix token — skipping`);
              continue; // Don't ack, will retry
            }
            result = await activateViaHelix(env, helixToken, iccid, imei, runId);
            break;
          default:
            throw new Error(`Unknown vendor: ${vendor}`);
        }

        const simId = await upsertSimWithVendor(env, iccid, result, vendor);
        if (resellerId) await assignSimToReseller(env, resellerId, simId);

        console.log(`[Activator] ${iccid}: activated via ${vendor}, simId=${simId}`);

        // Update job item to done
        if (jobRunId) {
          await updateJobItemStatus(env, jobRunId, iccid, 'done', {
            finished_at: new Date().toISOString(),
            sim_id: simId,
            carrier_log_id: result?.carrierLogId || null,
          });
        }

        msg.ack();
      } catch (e) {
        const errorMsg = String(e);
        console.error(`[Activator] ${iccid}: failed: ${errorMsg}`);
        try { await upsertSimError(env, iccid, errorMsg, vendor); } catch {}

        // Update job item to failed with error
        if (jobRunId) {
          await updateJobItemStatus(env, jobRunId, iccid, 'failed', {
            finished_at: new Date().toISOString(),
            error_message: errorMsg,
            attempt_increment: true,
            carrier_log_id: e?.carrierLogId || null,
          });
        }

        msg.ack(); // ACK to prevent infinite retry — error recorded in DB
      }
    }
  },
};

/* ── JSON activation endpoint (called from dashboard / scripts) ──────────── */

async function handleActivateJson(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method must be POST' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }); }

  const sims = body.sims || [];
  if (!Array.isArray(sims) || sims.length === 0) return json({ ok: false, error: 'sims array required' });

  // Validate all SIMs first before any DB operations
  const defaultVendor = body.vendor || 'atomic';
  // Batch-wide reseller (dashboard's "activate to reseller" dropdown) — applied
  // to every row by validateActivationSim, overriding any per-row reseller_id.
  const resellerId = body.reseller_id;
  const validatedSims = [];
  let validationErrors = 0;
  const rowErrors = [];

  // Loaded once per batch so every auto-filled row skips addresses ATOMIC has
  // already rejected, instead of each row rediscovering them one carrier call
  // at a time.
  const addresses = await loadAddressPool(env);

  for (let i = 0; i < sims.length; i++) {
    const checked = validateActivationSim(sims[i], { rowNumber: i + 1, defaultVendor, resellerId, addresses });
    if (!checked.ok) {
      validationErrors++;
      rowErrors.push(...checked.errors);
      continue;
    }
    validatedSims.push(checked.sim);
  }

  // If Supabase is not configured, return validation results without creating DB records
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({
      ok: validationErrors === 0,
      queued: 0,
      validation_errors: validationErrors,
      row_errors: rowErrors,
      attempted: sims.length,
      run_id: null,
      job_run_id: null,
      note: 'Supabase not configured — validation only',
    });
  }

  // Create parent activation run
  const runId = `json_${Date.now()}`;
  let runUuid;
  try {
    runUuid = await createActivationRun(env, {
      source: 'json',
      totalItems: validatedSims.length,
      createdBy: 'dashboard',
    });
  } catch (e) {
    // Nothing was persisted — safe to report as a plain failure.
    return json({ ok: false, error: `Failed to create activation run: ${e}`, run_id: null, job_run_id: null }, 502);
  }

  let queued = 0;
  try {
    if (validatedSims.length > 0) {
      await createActivationJobItems(env, runUuid, validatedSims);
      await sendQueueBatch(env.ACTIVATION_QUEUE, validatedSims.map(sim => ({
        body: { ...sim, run_id: runId, job_run_id: runUuid },
      })));
      queued = validatedSims.length;
    }
    await updateActivationRunCounts(env, runUuid, { queuedItems: queued, validationErrors, rowErrors });
  } catch (e) {
    // The activation_runs row already exists at this point — always return its
    // job_run_id even on failure so the dashboard can open it and show whatever
    // partially succeeded, instead of surfacing a bare error and orphaning it.
    return json({
      ok: false,
      error: `Activation run ${runUuid} created but queuing failed: ${e}`,
      queued,
      validation_errors: validationErrors,
      row_errors: rowErrors,
      attempted: sims.length,
      run_id: runId,
      job_run_id: runUuid,
    }, 502);
  }

  return json({ ok: validationErrors === 0, queued, validation_errors: validationErrors, row_errors: rowErrors, attempted: sims.length, run_id: runId, job_run_id: runUuid });
}

// Retries existing job items in place: resets each item to 'queued' and
// re-sends it to ACTIVATION_QUEUE. This owns the queue producer binding that
// the dashboard worker doesn't have — the dashboard's /api/activation-runs
// retry route forwards here over the BULK_ACTIVATOR service binding rather
// than touching the queue directly (see handleActivateSims for the same
// service-binding pattern on the initial-submit path).
async function handleRetryJson(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method must be POST' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }); }

  const { run_id: runId, items } = body;
  if (!runId) return json({ ok: false, error: 'run_id required' });
  if (!Array.isArray(items) || items.length === 0) return json({ ok: false, error: 'items array required' });

  const runIdForQueue = `retry_${Date.now()}`;
  let retried = 0;
  try {
    for (const item of items) {
      const newAttempt = (item.attempt || 0) + 1;
      await supabasePatch(env, `activation_job_items?id=eq.${item.id}`, {
        status: 'queued',
        attempt: newAttempt,
        error_message: null,
        started_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      });
    }
    await sendQueueBatch(env.ACTIVATION_QUEUE, items.map(item => ({
      body: {
        iccid: item.iccid,
        imei: item.imei,
        reseller_id: item.reseller_id,
        vendor: item.vendor,
        run_id: runIdForQueue,
        job_run_id: runId,
      },
    })));
    retried = items.length;
    await recomputeActivationRunCounts(env, runId);
  } catch (e) {
    return json({ ok: false, error: `Retry failed: ${e}`, retried, run_id: runId }, 502);
  }

  return json({ ok: true, retried, run_id: runId });
}

// Re-submits the ORIGINAL portinRequest for SIMs whose port-in never created a
// port at the carrier. POST /retry-portin?secret=X with {"iccids":[...]}.
//
// Why this exists instead of reusing /retry: activation_job_items has no
// port-in columns, so /retry rebuilds a queue message with empty
// port_mdn/port_account_number/port_pin. activateViaAtomic branches on exactly
// those three fields, so an empty set falls through to the plain Activate path
// and assigns the SIM a BRAND-NEW MDN instead of porting the customer's number
// — silently, and reported as success. Never point /retry at a port-in SIM.
//
// The losing-carrier account number and PIN are deliberately not stored on
// `sims` (see docs/atomic-port-in-runbook.md); the only record is the original
// request body in carrier_api_logs. They are read here, inside the Worker, fed
// straight back to ATOMIC, and never included in the response.
//
// partnerTransactionId is deliberately NOT reused. buildAtomicPortInRequest
// mints a fresh one per call, and the skill's Unknowns list does not confirm
// whether replaying an id is idempotent or rejected. A fresh id is what the
// successful 2026-09-04 resubmissions used.
async function handleRetryPortInJson(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method must be POST' });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: 'Supabase not configured' }, 500);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }); }
  const iccids = Array.isArray(body?.iccids) ? body.iccids.map(String) : [];
  const newIdentity = body?.new_identity === true;
  let poolAddresses = null;
  if (iccids.length === 0) return json({ ok: false, error: 'iccids array required' });
  if (iccids.length > 50) return json({ ok: false, error: 'max 50 iccids per call' });

  const results = [];
  const toQueue = [];

  for (const iccid of iccids) {
    const skip = (reason) => results.push({ iccid, requeued: false, reason });

    // Newest portinRequest we ever sent for this SIM — the call being retried.
    const reqLogs = await supabaseSelect(
      env,
      `carrier_api_logs?select=request_body,response_body_json,created_at&iccid=eq.${encodeURIComponent(iccid)}&step=eq.portin&order=created_at.desc&limit=1`
    );
    const reqLog = reqLogs?.[0];
    if (!reqLog) {
      skip('no portinRequest was ever logged for this SIM — the port account number and PIN are unrecoverable and must be re-supplied');
      continue;
    }

    const statusLogs = await supabaseSelect(
      env,
      `carrier_api_logs?select=response_body_json,created_at&iccid=eq.${encodeURIComponent(iccid)}&step=eq.portin_status&order=created_at.desc&limit=1`
    );
    const statusLog = statusLogs?.[0];
    const lastStatus = statusLog?.response_body_json?.wholeSaleApi?.wholeSaleResponse;

    // Guard 1: the carrier's own view is authoritative. Anything other than
    // 948 "Port Request Does Not Exist" means something is live over there.
    if (lastStatus && lastStatus.statusCode !== '948') {
      skip(`carrier's latest portinStatus is ${lastStatus.statusCode} (${lastStatus.description || 'no description'}) — not resubmitting over an existing port request`);
      continue;
    }

    // Guard 2: our own last attempt succeeded, so we believe a port exists.
    // Overridden only by a MORE RECENT status check saying the port is gone —
    // ports do open and then disappear (2026-09-04: 15 SIMs got a Success with
    // reasonCode=OP, and every later status check returned 948). Without the
    // recency comparison this guard would permanently block exactly the SIMs
    // that most need resubmitting.
    const lastReqStatus = reqLog.response_body_json?.wholeSaleApi?.wholeSaleResponse?.statusCode;
    const statusIsNewer = statusLog && reqLog.created_at && statusLog.created_at > reqLog.created_at;
    if (lastReqStatus === '00' && !(lastStatus?.statusCode === '948' && statusIsNewer)) {
      skip('last portinRequest succeeded and no newer status check contradicts it — a port already exists; resubmitting would duplicate it');
      continue;
    }

    // Recover the exact original inputs via the builder's inverse.
    const original = parseAtomicPortInRequest(reqLog.request_body);
    if (!original) {
      skip('logged request body is not a portinRequest — cannot rebuild the call');
      continue;
    }
    // With new_identity, only the SUBSCRIBER block is redrawn. The
    // old_service_provider fields — account number, PIN, and the losing
    // carrier's account-holder name — must still match that carrier's records
    // exactly or the port rejects, so they are always replayed verbatim.
    // Use this when the carrier rejected the address itself (streetNumber Is
    // Invalid / streetName Is Invalid / Invalid Zipcode); replaying those
    // unchanged just reproduces the rejection.
    if (newIdentity && !poolAddresses) poolAddresses = await loadAddressPool(env);
    const fresh = newIdentity ? pickRandomPortIdentity(poolAddresses) : null;
    const fields = {
      port_mdn: original.portMdn,
      port_account_number: original.portAccountNumber,
      port_pin: original.portPin,
      port_first_name: fresh ? fresh.port_first_name : original.firstName,
      port_last_name: fresh ? fresh.port_last_name : original.lastName,
      port_street_number: fresh ? fresh.port_street_number : original.streetNumber,
      port_street_name: fresh ? fresh.port_street_name : original.streetName,
      port_zip: fresh ? fresh.port_zip : original.zip,
      port_old_first_name: original.oldFirstName,
      port_old_last_name: original.oldLastName,
    };
    const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      skip(`original request body is missing ${missing.join(', ')} — cannot rebuild the call`);
      continue;
    }

    // Guard 3: the carrier's live view of the SIM. portinStatus cannot tell
    // "no port was ever created" from "the port completed and its request
    // record aged out" — both answer 948. This is what distinguishes them.
    const subscriberState = await atomicSubscriberState(env, iccid);
    if (subscriberState === 'active') {
      skip('SIM already has active service at ATOMIC — the number is already ours; a port-in would be refused as "not eligible"');
      continue;
    }

    const simRows = await supabaseSelect(
      env,
      `sims?select=id,imei,vendor,reseller_sims(reseller_id)&iccid=eq.${encodeURIComponent(iccid)}&reseller_sims.active=eq.true&limit=1`
    );
    const sim = simRows?.[0];
    if (!sim) { skip('no sims row for this ICCID'); continue; }

    toQueue.push({
      iccid,
      imei: original.imei || sim.imei || '',
      reseller_id: sim.reseller_sims?.[0]?.reseller_id ?? null,
      vendor: sim.vendor || 'atomic',
      // Tells the consumer this SIM's `provisioning` status is a pending port,
      // not a live activation, so its already-activated guard does not no-op
      // the retry. Only set here, never on a first-time submission.
      portin_retry: true,
      port_address_id: fresh ? fresh.port_address_id : null,
      ...fields,
    });
    results.push({ iccid, requeued: true, reason: 'resubmitting the original portinRequest' });
  }

  if (toQueue.length === 0) {
    return json({ ok: true, queued: 0, attempted: iccids.length, results, run_id: null, job_run_id: null });
  }

  // activation_runs.source is CHECK-constrained to csv/json/dashboard, so the
  // retry provenance rides on run_id and created_by rather than a new source
  // value — adding one would need a migration applied to both PROD and TEST,
  // and this repo has repeatedly been bitten by that pair drifting apart.
  const runId = `portin_retry_${Date.now()}`;
  let runUuid;
  try {
    runUuid = await createActivationRun(env, {
      source: 'json',
      totalItems: toQueue.length,
      createdBy: 'retry-portin',
    });
  } catch (e) {
    return json({ ok: false, error: `Failed to create activation run: ${e}`, results }, 502);
  }

  try {
    await createActivationJobItems(env, runUuid, toQueue);
    await sendQueueBatch(env.ACTIVATION_QUEUE, toQueue.map(sim => ({
      body: { ...sim, run_id: runId, job_run_id: runUuid },
    })));
    await updateActivationRunCounts(env, runUuid, { queuedItems: toQueue.length, validationErrors: 0, rowErrors: [] });
  } catch (e) {
    return json({
      ok: false,
      error: `Activation run ${runUuid} created but queuing failed: ${e}`,
      results,
      run_id: runId,
      job_run_id: runUuid,
    }, 502);
  }

  return json({ ok: true, queued: toQueue.length, attempted: iccids.length, results, run_id: runId, job_run_id: runUuid });
}

// The live address pool. address_pool membership is the source of truth: a
// deleted row is gone from rotation permanently, everywhere.
//
// Falls back to the in-code ADDRESS_POOL (via pickRandomPortIdentity's own
// default) when the table is empty or unreadable, so TEST and any un-seeded
// environment keep working rather than failing activations.
async function loadAddressPool(env) {
  try {
    const rows = await supabaseSelect(
      env,
      'address_pool?select=address_id,street_number,street_name,street_direction,city,state,zip_code&limit=5000'
    );
    return (rows || []).map(r => ({
      id: r.address_id,
      streetNumber: r.street_number,
      streetName: r.street_name,
      streetDirection: r.street_direction || '',
      city: r.city,
      state: r.state,
      zipCode: r.zip_code,
    }));
  } catch (e) {
    console.warn(`[Activator] could not load address_pool, falling back to the code pool: ${e}`);
    return [];
  }
}

// Asks ATOMIC whether this SIM already has live service, so /retry-portin does
// not submit a port for a number that is already ours.
//
// Guards 1 and 2 both read portinStatus, and portinStatus answers 948 "Port
// Request Does Not Exist" for two different situations: no port was ever
// created, and a port that completed long enough ago that the request record is
// gone. They are indistinguishable from that endpoint alone. On 2026-09-08 that
// ambiguity cost 12 pointless carrier calls, every one answered "This MSIDN is
// not eligible for the Portin. Number already assigned to NBI".
//
// Returns 'active' | 'inactive' | 'unknown'. Callers treat 'unknown' as
// permission to proceed: a rejected duplicate port is harmless (the carrier
// refuses it, nothing changes), so an ATOMIC outage must not block retries.
async function atomicSubscriberState(env, iccid) {
  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) return 'unknown';
  try {
    const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const res = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wholeSaleApi: {
          session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
          wholeSaleRequest: { requestType: 'subsriberInquiry', MSISDN: '', sim: iccid },
        },
      }),
    });
    if (!res.ok) return 'unknown';
    const body = await res.json().catch(() => ({}));
    const wsr = body?.wholeSaleApi?.wholeSaleResponse;
    if (wsr?.statusCode !== '00') return 'inactive';
    // Result.attStatus is lowercase-keyed msisdn/attStatus on this requestType.
    const attStatus = String(wsr?.Result?.attStatus || wsr?.Result?.status || '').trim();
    return attStatus.toLowerCase() === 'active' ? 'active' : 'inactive';
  } catch (e) {
    console.warn(`[Activator] subscriber inquiry for ${iccid} failed, proceeding: ${e}`);
    return 'unknown';
  }
}

// Removes an address permanently and records why. The audit row is what makes
// a permanent delete safe to operate: without it there is no way to answer
// "why is this address gone" or to notice a rule deleting too much — which is
// exactly how the previous quarantine went wrong unnoticed for four months.
async function deletePoolAddress(env, addressId, reason, carrierStep) {
  if (!addressId) return;
  try {
    await supabaseInsert(env, 'address_pool_deletions', [{
      address_id: addressId,
      reason: String(reason || '').slice(0, 500),
      carrier_step: carrierStep || null,
    }]);
    await supabaseDelete(env, `address_pool?address_id=eq.${encodeURIComponent(addressId)}`);
    console.log(`[Activator] deleted address ${addressId} from the pool: ${reason}`);
  } catch (e) {
    console.warn(`[Activator] could not delete address ${addressId}: ${e}`);
  }
}

/* ── Relay fetch helper (routes through VPS to avoid CF-to-CF blocking) ─────── */

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        'x-relay-key': env.RELAY_KEY,
      },
    });
  }
  return fetch(url, init);
}

/* ── Activation Run / Job Item DB helpers ─────────────────────────────────── */

async function createActivationRun(env, { source, totalItems, createdBy }) {
  const rows = await supabaseInsert(env, 'activation_runs', [{
    source,
    status: 'queued',
    total_items: totalItems,
    queued_items: 0,
    processing_items: 0,
    done_items: 0,
    failed_items: 0,
    retry_needed_items: 0,
    skipped_items: 0,
    created_by: createdBy,
    started_at: new Date().toISOString(),
  }]);
  if (!rows?.[0]?.id) throw new Error('Failed to create activation run');
  return rows[0].id;
}

// One INSERT for the whole batch instead of one round-trip per SIM — the
// per-item loop this replaced was the dominant cost of a bulk /activate call.
async function createActivationJobItems(env, runId, sims) {
  const queuedAt = new Date().toISOString();
  const rows = await supabaseInsert(env, 'activation_job_items', sims.map(sim => ({
    run_id: runId,
    iccid: sim.iccid,
    imei: sim.imei,
    reseller_id: sim.reseller_id,
    vendor: sim.vendor,
    status: 'queued',
    attempt: 0,
    max_attempts: 3,
    queued_at: queuedAt,
  })));
  if (rows.length !== sims.length) throw new Error(`Expected ${sims.length} activation job items, got ${rows.length}`);
  return rows;
}

// Cloudflare Queues caps sendBatch() at 100 messages per call.
async function sendQueueBatch(queue, messages) {
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100));
  }
}

async function updateActivationRunCounts(env, runId, { queuedItems = 0, validationErrors = 0, rowErrors = [] }) {
  const status = validationErrors > 0 ? 'failed' : 'processing';
  await supabasePatch(env, `activation_runs?id=eq.${runId}`, {
    status,
    queued_items: queuedItems,
    processing_items: status === 'processing' ? queuedItems : 0,
    error: validationErrors > 0 ? `Validation errors: ${rowErrors.join('; ')}` : null,
    updated_at: new Date().toISOString(),
  });
}

async function updateJobItemStatus(env, runId, iccid, status, { started_at = null, finished_at = null, sim_id = null, error_message = null, attempt_increment = false, carrier_log_id = null } = {}) {
  const patch = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (started_at) patch.started_at = started_at;
  if (finished_at) patch.finished_at = finished_at;
  if (sim_id) patch.sim_id = sim_id;
  if (error_message) patch.error_message = error_message;
  if (carrier_log_id) patch.carrier_log_id = carrier_log_id;
  if (attempt_increment) {
    // We need to read current attempt first, then increment
    const existing = await supabaseSelect(env, `activation_job_items?select=attempt&run_id=eq.${runId}&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);
    if (existing?.[0]) {
      patch.attempt = (existing[0].attempt || 0) + 1;
      // If attempts >= max_attempts, mark as retry_needed
      if (patch.attempt >= (existing[0].max_attempts || 3)) {
        patch.status = 'retry_needed';
      }
    }
  }
  await supabasePatch(env, `activation_job_items?run_id=eq.${runId}&iccid=eq.${encodeURIComponent(iccid)}`, patch);
  await recomputeActivationRunCounts(env, runId);
}

// Re-derives the parent run's per-status counts and overall status from its
// child job items. Recompute-from-source-of-truth rather than incrementing a
// counter, since Cloudflare Queue consumers can process a run's items across
// concurrent invocations and a read-then-increment would race.
async function recomputeActivationRunCounts(env, runId) {
  const items = await supabaseSelect(env, `activation_job_items?select=status&run_id=eq.${runId}`);
  const counts = { queued: 0, processing: 0, done: 0, failed: 0, retry_needed: 0, skipped: 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status]++;
  }
  const total = items.length;
  const terminal = counts.done + counts.failed + counts.retry_needed + counts.skipped;
  const patch = {
    queued_items: counts.queued,
    processing_items: counts.processing,
    done_items: counts.done,
    failed_items: counts.failed,
    retry_needed_items: counts.retry_needed,
    skipped_items: counts.skipped,
    updated_at: new Date().toISOString(),
  };
  if (total > 0 && terminal === total) {
    patch.status = (counts.failed > 0 || counts.retry_needed > 0) ? 'failed' : 'done';
    patch.finished_at = new Date().toISOString();
  } else {
    patch.status = 'processing';
  }
  await supabasePatch(env, `activation_runs?id=eq.${runId}`, patch);
}

/* ── Vendor-specific activation functions ──────────────────────────────────── */

async function activateViaAtomic(env, iccid, imei, runId, options = {}) {
  const normalizedPortMdn = normalizePhone10(options.portMdn || options.port_mdn || '');
  const portAccountNumber = String(options.portAccountNumber || options.port_account_number || '').trim();
  const portPin = String(options.portPin || options.port_pin || '').trim();

  // Port-in path: use Atomic Wholesale portinRequest with full carrier field set.
  if (normalizedPortMdn || portAccountNumber || portPin) {
    return await activateViaAtomicPortIn(env, iccid, imei, runId, {
      ...options,
      normalizedPortMdn,
      portAccountNumber,
      portPin,
    });
  }

  // New-number activation path.
  const addr = await pickNextPpuAddress(env, {});
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const requestBody = buildAtomicActivateRequest({
    session: {
      userName: env.ATOMIC_USERNAME,
      token: env.ATOMIC_TOKEN,
      pin: env.ATOMIC_PIN,
    },
    iccid,
    imei,
    address: addr,
    portMdn: '',
  });

  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}

  const carrierLogId = await logCarrierApiCall(env, {
    run_id: runId,
    step: 'activation',
    iccid,
    imei,
    vendor: 'atomic',
    request_url: url,
    request_method: 'POST',
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: responseJson,
    error: res.ok ? null : `ATOMIC activation failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new CarrierActivationError(`ATOMIC activation failed ${res.status}: ${responseText.slice(0, 300)}`, carrierLogId);
  }

  // Quarantine the picked address if AT&T rejected it (won't be re-picked for 90d).
  const respDesc = responseJson?.wholeSaleApi?.wholeSaleResponse?.description || '';
  if (/address.*verif|verif.*address/i.test(respDesc)) {
    await markAddressVerifyFailure(env, addr.id, `ATOMIC activate rejected address: ${respDesc.slice(0, 200)}`);
  }

  const result = responseJson?.wholeSaleApi?.wholeSaleResponse?.Result;
  if (!result?.MSISDN) {
    throw new CarrierActivationError(`ATOMIC activation returned no MSISDN: ${responseText.slice(0, 300)}`, carrierLogId);
  }

  return {
    msisdn: result.MSISDN,
    ban: result.BAN || '',
    status: 'active', // ATOMIC activations are immediately active
    zipCode: addr.zipCode,
    carrierLogId,
  };
}

async function activateViaAtomicPortIn(env, iccid, imei, runId, options = {}) {
  const normalizedPortMdn = options.normalizedPortMdn || normalizePhone10(options.portMdn || options.port_mdn || '');
  const portAccountNumber = String(options.portAccountNumber || options.port_account_number || '').trim();
  const portPin = String(options.portPin || options.port_pin || '').trim();
  let portFields = mapPortFields(options);
  let addressId = options.port_address_id || options.portAddressId || null;
  let poolAddresses = null;

  // Belt-and-suspenders: validateActivationSim already blocks incomplete port-in
  // rows upstream (CSV /run, JSON /activate, dashboard). This guard covers
  // messages already queued before that validation existed, and refuses rather
  // than silently falling back to a new-number Activate submission.
  const missing = [];
  if (!normalizedPortMdn) missing.push('port_mdn (10 digits)');
  if (!portAccountNumber) missing.push('port_account_number');
  if (!portPin) missing.push('port_pin');
  if (!portFields.firstName) missing.push('port_first_name');
  if (!portFields.lastName) missing.push('port_last_name');
  if (!portFields.streetNumber) missing.push('port_street_number');
  if (!portFields.streetName) missing.push('port_street_name');
  if (!portFields.zip) missing.push('port_zip');
  if (!portFields.oldFirstName) missing.push('port_old_first_name');
  if (!portFields.oldLastName) missing.push('port_old_last_name');
  if (missing.length) {
    throw new Error(`ATOMIC port-in refused — missing required field(s): ${missing.join(', ')}`);
  }

  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';

  // ATOMIC rejects some pool addresses outright ("streetName Is Invalid",
  // "streetNumber Is Invalid", "Invalid Zipcode"). Those are permanent for that
  // address, so quarantine it, draw a replacement, and resubmit in the same
  // invocation rather than leaving the port to be retried by hand days later.
  // Only the street/zip change -- the subscriber name is already arbitrary, and
  // old_service_provider must keep matching the losing carrier's records.
  const MAX_ADDRESS_ATTEMPTS = 3;
  let res, responseText, responseJson, requestBody, carrierLogId;

  for (let attempt = 1; ; attempt++) {
    requestBody = buildAtomicPortInRequest({
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      iccid,
      imei,
      portMdn: normalizedPortMdn,
      portAccountNumber,
      portPin,
      firstName: portFields.firstName,
      lastName: portFields.lastName,
      streetNumber: portFields.streetNumber,
      streetName: portFields.streetName,
      zip: portFields.zip,
      oldFirstName: portFields.oldFirstName,
      oldLastName: portFields.oldLastName,
    });

    res = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    responseText = await res.text();
    responseJson = {};
    try { responseJson = JSON.parse(responseText); } catch {}

    carrierLogId = await logCarrierApiCall(env, {
      run_id: runId,
      step: 'portin',
      iccid,
      imei,
      vendor: 'atomic',
      request_url: url,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: responseText,
      response_body_json: responseJson,
      error: res.ok ? null : `ATOMIC port-in failed: ${res.status}`,
    });

    const description = responseJson?.wholeSaleApi?.wholeSaleResponse?.description;
    if (!res.ok || attempt >= MAX_ADDRESS_ATTEMPTS || !isAddressRejection(description)) break;

    console.log(`[Activator] ${iccid}: address rejected (${description}) — deleting ${addressId || 'unknown'} and redrawing (attempt ${attempt}/${MAX_ADDRESS_ATTEMPTS})`);
    await deletePoolAddress(env, addressId, `portinRequest: ${description}`, 'portinRequest');
    poolAddresses = await loadAddressPool(env);

    const fresh = pickRandomPortIdentity(poolAddresses);
    portFields = {
      ...portFields,
      streetNumber: fresh.port_street_number,
      streetName: fresh.port_street_name,
      zip: fresh.port_zip,
    };
    addressId = fresh.port_address_id;
  }

  if (!res.ok) {
    throw new CarrierActivationError(`ATOMIC port-in failed ${res.status}: ${responseText.slice(0, 300)}`, carrierLogId);
  }

  // ATOMIC answers a REJECTED port with HTTP 200 and the real verdict in the
  // body. Without this check every rejection was recorded as a successful
  // submission: the SIM went to `provisioning` with port_in_pending=true, the
  // job item said `done`, and the only trace was a carrier_api_logs row nobody
  // was reading. That is how 53 SIMs accumulated looking healthy while no port
  // existed — including `Error!!Port Request Does Not Exist` (948),
  // `Error!!streetName Is Invalid` (948) and `Invalid Zipcode.` (510), all
  // HTTP 200.
  //
  // Confirmed from PROD: an accepted port returns statusCode "00" with
  // Result.reasonCode "OP" (Open) and a portRequestNumber. Anything else is a
  // rejection and must fail loudly so it lands in the Activation Runs error
  // detail with the carrier's own words.
  const wholeSaleResponse = responseJson?.wholeSaleApi?.wholeSaleResponse;
  const carrierStatusCode = wholeSaleResponse?.statusCode ?? null;
  if (carrierStatusCode !== null && carrierStatusCode !== '00') {
    throw new CarrierActivationError(
      `ATOMIC port-in rejected (statusCode ${carrierStatusCode}): ${wholeSaleResponse?.description || responseText.slice(0, 300)}`,
      carrierLogId
    );
  }

  // The success shape itself is still not hard-required. A port is accepted
  // asynchronously by the losing carrier, so we don't insist on an MSISDN echo
  // the way the new-number path does — we already know the target MDN. The SIM
  // is recorded as provisioning rather than active until the portinStatus poll
  // sees it complete.
  const result = wholeSaleResponse?.Result;
  return {
    msisdn: result?.MSISDN || normalizedPortMdn,
    ban: result?.BAN || '',
    status: 'provisioning', // sims.status CHECK constraint has no "pending port" value
    zipCode: portFields.zip,
    portInPending: true, // marks this SIM for details-finalizer's portinStatus poll
    carrierLogId,
  };
}

function mapPortFields(options) {
  const get = (k) => String(options?.[k] ?? '').trim();
  return {
    firstName: get('port_first_name'),
    lastName: get('port_last_name'),
    streetNumber: get('port_street_number'),
    streetName: get('port_street_name'),
    zip: get('port_zip'),
    oldFirstName: get('port_old_first_name'),
    oldLastName: get('port_old_last_name'),
  };
}

async function activateViaWingIot(env, iccid, runId) {
  // Wing IoT activation - PUT with dialable plan
  const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const url = `${baseUrl}/v1/devices/${iccid}`;
  const auth = `Basic ${btoa(`${env.WING_IOT_USERNAME}:${env.WING_IOT_API_KEY}`)}`;

  const requestBody = {
    communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US',
    status: 'ACTIVATED',
  };

  const res = await relayFetch(env, url, {
    method: 'PUT',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}

  const carrierLogId = await logCarrierApiCall(env, {
    run_id: runId,
    step: 'activation',
    iccid,
    imei: null,
    vendor: 'wing_iot',
    request_url: url,
    request_method: 'PUT',
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: responseJson,
    error: res.ok ? null : `Wing IoT activation failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new CarrierActivationError(`Wing IoT activation failed ${res.status}: ${responseText.slice(0, 300)}`, carrierLogId);
  }

  // MDN takes ~1-4 min to propagate — mdn-rotator's syncWingIotPendingMdns cron fills it in
  return { msisdn: '', status: 'provisioning', carrierLogId };
}

async function activateViaHelix(env, token, iccid, imei, runId) {
  const result = await hxActivate(env, token, iccid, imei, runId);
  return {
    mobilitySubscriptionId: String(result.mobilitySubscriptionId),
    status: 'provisioning', // Helix needs details-finalizer to get MDN
  };
}

/* ── Helix ─────────────────────────────────────────────────────────────────── */

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
  const text = await res.text();
  let j = {};
  try { j = JSON.parse(text); } catch {}
  if (!res.ok || !j?.access_token) {
    throw new Error(`Token failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return j.access_token;
}

async function hxActivate(env, token, iccid, imei, runId) {
  const addr = await pickNextPpuAddress(env, {});
  const url = `${env.HX_API_BASE}/api/mobility-activation/activate`;
  const requestBody = {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: 'new_activation',
    subscriber: { firstName: 'SUB', lastName: 'NINE' },
    address: {
      address1: `${addr.streetNumber} ${addr.streetName}`,
      city: addr.city,
      state: addr.state,
      zipCode: addr.zipCode,
    },
    service: { iccid, imei },
  };

  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}

  logHelixApiCall(env, {
    run_id: runId,
    step: 'activation',
    iccid,
    imei,
    request_url: url,
    request_method: 'POST',
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: responseJson,
    error: res.ok ? null : `Activation failed: ${res.status}`,
  }).catch(e => console.error(`[Helix Log] ${e}`));

  if (!res.ok) {
    if (/address.*verif|verif.*address/i.test(responseText)) {
      await markAddressVerifyFailure(env, addr.id, `Helix activate rejected address: ${responseText.slice(0, 200)}`);
    }
    throw new Error(`Activation failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  if (responseJson?.mobilitySubscriptionId) return responseJson;

  // Fallback: extract from raw text
  const match = responseText.match(/"mobilitySubscriptionId"\s*:\s*"?(\d+)"?/);
  if (match) return { mobilitySubscriptionId: match[1] };

  throw new Error(`Activation returned ${res.status} but no mobilitySubscriptionId. Raw: ${responseText.slice(0, 200)}`);
}

/* ── Supabase ───────────────────────────────────────────────────────────────── */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase SELECT ${res.status}: ${text.slice(0, 300)}`);
  if (!text.trim()) return [];
  try { return JSON.parse(text); } catch (e) { throw new Error(`Supabase SELECT parse failed: ${e}. Raw: ${text.slice(0, 300)}`); }
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

async function supabaseDelete(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${res.status}: ${await res.text().catch(() => '')}`);
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(rows),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase INSERT ${res.status}: ${text.slice(0, 300)}`);
  if (!text.trim()) return [];
  try { return JSON.parse(text); } catch (e) { throw new Error(`Supabase INSERT parse failed: ${e}`); }
}

async function upsertSim(env, iccid, subId) {
  const existing = await supabaseSelect(env, `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);
  if (existing?.[0]?.id) {
    await supabasePatch(env, `sims?id=eq.${existing[0].id}`, {
      mobility_subscription_id: subId,
      status: 'provisioning',
      last_activation_error: null,
    });
    return existing[0].id;
  }
  const inserted = await supabaseInsert(env, 'sims', [{ iccid, mobility_subscription_id: subId, status: 'provisioning' }]);
  if (!inserted?.[0]?.id) throw new Error('Supabase INSERT returned no rows');
  return inserted[0].id;
}

async function upsertSimWithVendor(env, iccid, result, vendor) {
  const existing = await supabaseSelect(env, `sims?select=id,activated_at&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);

  // Build payload based on vendor
  const payload = {
    vendor,
    carrier: 'att', // All these vendors are AT&T
    status: result.status || 'active',
    last_activation_error: null,
  };

  if (vendor === 'atomic' || vendor === 'wing_iot') {
    // ATOMIC and Wing IoT use MSISDN, not mobilitySubscriptionId
    payload.msisdn = result.msisdn;
    // New-number Activate is immediately active with MDN. Port-in is accepted
    // asynchronously by the losing carrier — activateViaAtomicPortIn returns
    // status: 'provisioning' precisely so this does NOT get forced to 'active'
    // before the port has actually completed.
    if (result.msisdn && result.status !== 'provisioning') {
      payload.status = 'active';
    }
    if (result.zipCode) {
      payload.activation_zip = result.zipCode;
    }
    // Explicit true/false (not just "set when true"): an ICCID being
    // reactivated via plain Activate after a prior port-in attempt must not
    // keep a stale port_in_pending=true, which would leave it stuck in
    // details-finalizer's portinStatus poll forever.
    if (vendor === 'atomic') {
      payload.port_in_pending = !!result.portInPending;
    }
  } else if (vendor === 'helix') {
    payload.mobility_subscription_id = result.mobilitySubscriptionId;
    payload.status = 'provisioning'; // Helix needs finalizer to get MDN
  }

  // Stamp activation time. ATOMIC/Wing go straight to 'active' here, so unlike
  // helix they never pass through the details-finalizer backfill that sets
  // activated_at — without this they stay NULL until their first rotation.
  // Only set on first activation (preserve the original date on re-activation).
  if (payload.status === 'active' && !existing?.[0]?.activated_at) {
    payload.activated_at = new Date().toISOString();
  }

  if (existing?.[0]?.id) {
    await supabasePatch(env, `sims?id=eq.${existing[0].id}`, payload);
    // If we have an MSISDN, also create the sim_numbers entry
    if (result.msisdn) {
      await createSimNumber(env, existing[0].id, result.msisdn);
    }
    return existing[0].id;
  }

  const inserted = await supabaseInsert(env, 'sims', [{ iccid, ...payload }]);
  if (!inserted?.[0]?.id) throw new Error('Supabase INSERT returned no rows');

  // Create sim_numbers entry for immediate MDN
  if (result.msisdn) {
    await createSimNumber(env, inserted[0].id, result.msisdn);
  }

  return inserted[0].id;
}

async function createSimNumber(env, simId, mdn) {
  // Normalize to E.164
  const e164 = mdn.startsWith('+1') ? mdn : mdn.startsWith('1') ? `+${mdn}` : `+1${mdn}`;

  // Close any existing numbers for this SIM
  await supabasePatch(env, `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`, {
    valid_to: new Date().toISOString(),
  });

  // Insert new number
  await supabaseInsert(env, 'sim_numbers', [{
    sim_id: simId,
    e164,
    valid_from: new Date().toISOString(),
    valid_to: null,
    verified_at: new Date().toISOString(), // Pre-verified (no SMS verification needed)
    verification_status: 'verified',
  }]);
}

async function upsertSimError(env, iccid, errorMessage, vendor = 'helix') {
  const existing = await supabaseSelect(env, `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);
  const payload = {
    status: 'error',
    last_activation_error: `Activation failed: ${errorMessage}`,
    vendor,
    carrier: 'att',
  };
  if (existing?.[0]?.id) {
    await supabasePatch(env, `sims?id=eq.${existing[0].id}`, payload);
  } else {
    await supabaseInsert(env, 'sims', [{ iccid, ...payload }]);
  }
}

async function assignSimToReseller(env, resellerId, simId) {
  const existing = await supabaseSelect(
    env,
    `reseller_sims?select=reseller_id&reseller_id=eq.${resellerId}&sim_id=eq.${simId}&limit=1`
  );
  if (existing.length) return;
  await supabaseInsert(env, 'reseller_sims', [{ reseller_id: resellerId, sim_id: simId, active: true }]);
}

/* ── Carrier API logging ───────────────────────────────────────────────────── */

// Returns the inserted row's id (for linking back via
// activation_job_items.carrier_log_id) or null if logging was skipped/failed.
async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const vendor = logData.vendor || 'helix';
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    vendor,
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
  console.log(`[${vendor.toUpperCase()} API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? 'OK' : 'FAIL'}`);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { console.error(`[Carrier Log] Supabase failed: ${res.status}`); return null; }
  try {
    const rows = await res.json();
    return rows?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

// Thrown by the activateVia* functions so the queue consumer can link the
// carrier log for a call that failed (e.g. a port-in the carrier rejected on
// PIN) — logCarrierApiCall() already wrote the row before the throw, but a
// plain Error would drop that id on the floor.
class CarrierActivationError extends Error {
  constructor(message, carrierLogId) {
    super(message);
    this.carrierLogId = carrierLogId ?? null;
  }
}

// Backward compatibility alias
async function logHelixApiCall(env, logData) {
  return logCarrierApiCall(env, { ...logData, vendor: 'helix' });
}

function normalizeRow(row, len) {
  const r = row.slice(0, len);
  while (r.length < len) r.push('');
  return r;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
