// =========================================================
// TELTIK WORKER
// Manages T-Mobile SIMs via Teltik REST API (api.smsgateway.xyz)
// Routes: POST /import, POST /webhook, POST /rotate, GET /setup-webhook, GET /sync-mdns
// Cron: every 30 min for MDN rotation (48h interval)
// =========================================================

const TELTIK_BASE = 'https://api.smsgateway.xyz';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret') || '';

    if (url.pathname === '/import' && request.method === 'POST') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      try {
        const result = await importTeltikLines(env, { offset, limit });
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!env.TELTIK_WEBHOOK_SECRET || secret !== env.TELTIK_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      return handleTeltikSmsWebhook(request, env);
    }

    // Lifecycle webhook (sim.activated / sim.canceled / sim.swapped).
    // HMAC-SHA256 of the raw body against TELTIK_LIFECYCLE_SECRET, header
    // X-Teltik-Signature: sha256=<hex>. Returns 2xx fast; processing is sync
    // but cheap (one event at a time) so no need for ctx.waitUntil yet.
    if (url.pathname === '/lifecycle-webhook' && request.method === 'POST') {
      return handleTeltikLifecycleWebhook(request, env);
    }

    if (url.pathname === '/rotate' && request.method === 'POST') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await rotateTeltikSims(env);
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    // Single-SIM rotate — called from the dashboard Rotate button for teltik SIMs.
    // `force=true` bypasses the 48h interval guard.
    if (url.pathname === '/rotate-sim' && (request.method === 'POST' || request.method === 'GET')) {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const iccid = url.searchParams.get('iccid') || '';
      const force = url.searchParams.get('force') === 'true';
      if (!iccid) return jsonResponse({ ok: false, error: 'iccid required' }, 400);
      try {
        const rows = await supabaseGetArray(
          env,
          `sims?iccid=eq.${encodeURIComponent(iccid)}&vendor=eq.teltik&select=id,iccid,reseller_sims(reseller_id,active)&limit=1`
        );
        if (!rows || rows.length === 0) return jsonResponse({ ok: false, error: `Teltik SIM not found: ${iccid}` }, 404);
        const result = await rotateOneTeltikSim(env, rows[0], { force });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    // Manual night-migration trigger (same engine as the daily cron). Defers
    // up to ?batch=N (default 100) morning-anchored lines to the next midnight.
    if (url.pathname === '/migrate-night' && (request.method === 'POST' || request.method === 'GET')) {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      const batch = parseInt(url.searchParams.get('batch') || '100', 10) || 100;
      try {
        const held = await supabaseRpc(env, 'teltik_hold_morning_batch', { p_batch: batch });
        return jsonResponse({ ok: true, held }, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/setup-webhook') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await setupTeltikForwardUrl(env);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/reconcile') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await reconcileWithTeltik(env);
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/sync-mdns') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await syncTeltikMdns(env);
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    return new Response('teltik-worker ok', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    // Night-migration tick (runs once/day at NY 22:00, OUTSIDE the rotation
    // window): defer one batch of morning-anchored lines to the next midnight.
    // Gated on TELTIK_NIGHT_MIGRATION='on' so it can be stopped instantly
    // without redeploy once migration is complete.
    if (event.cron === '0 2 * * *') {
      if (env.TELTIK_NIGHT_MIGRATION !== 'on') {
        console.log('[Migrate] TELTIK_NIGHT_MIGRATION not "on" — skipping');
        return;
      }
      const batch = parseInt(env.TELTIK_MIGRATION_BATCH || '100', 10) || 100;
      try {
        const held = await supabaseRpc(env, 'teltik_hold_morning_batch', { p_batch: batch });
        console.log(`[Migrate] held ${held} morning-anchored teltik lines for next-midnight rotation`);
      } catch (err) {
        console.error(`[Migrate] failed: ${err}`);
      }
      return;
    }

    if (!isInsideRotationWindowNY()) {
      console.log(`[Cron] teltik-worker outside NY rotation window (0-8); NY hour=${getNYHour()} — skipping`);
      return;
    }
    console.log('[Cron] teltik-worker rotation starting');
    try {
      const result = await rotateTeltikSims(env);
      console.log(`[Cron] rotation done: rotated=${result.rotated} errors=${result.errors} skipped=${result.skipped}`);
    } catch (err) {
      console.error(`[Cron] rotation failed: ${err}`);
    }
  },
};

// =========================================================
// Scheduling window: 12 AM – 9 AM America/New_York (DST-aware via Intl)
// =========================================================
function getNYHour() {
  const raw = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date()));
  return ((raw % 24) + 24) % 24;
}

function isInsideRotationWindowNY() {
  const h = getNYHour();
  return h >= 0 && h <= 8;
}

// Returns ISO string for midnight in New York timezone (DST-aware). Used as
// p_today_start for increment_rotation_fail (daily fail-count reset boundary).
function getNYMidnightISO() {
  const now = new Date();
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(now).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-5');
  return new Date(`${nyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

// =========================================================
// IMPORT — fetch all Teltik lines and upsert into DB
// =========================================================
async function importTeltikLines(env, opts = {}) {
  const apiKey = env.TELTIK_API_KEY;
  const offset = opts.offset || 0;
  const limit = opts.limit || 200;

  // Fetch the full Teltik line list, then slice — the unpaginated /import used
  // to walk every line in one Worker invocation and burst past Cloudflare's
  // 1000-subrequest cap around 250–500 SIMs in (INC-10). Callers loop with
  // ?offset=N&limit=K so each Worker run stays well under the cap.
  const allLinesRes = await relayFetch(env, `${TELTIK_BASE}/v1/all-lines/?apikey=${apiKey}`);
  if (!allLinesRes.ok) {
    throw new Error(`Teltik all-lines failed: ${allLinesRes.status} ${await allLinesRes.text()}`);
  }
  const allLines = await allLinesRes.json();

  if (!Array.isArray(allLines) || allLines.length === 0) {
    return {
      ok: true, total: 0, processed: 0, offset, limit,
      imported: 0, updated: 0, unchanged: 0, skipped: 0,
      next_offset: null, has_more: false,
      message: 'No lines returned from Teltik',
    };
  }

  const total = allLines.length;
  const slice = allLines.slice(offset, offset + limit);

  // Precompute existing ICCID → sim_id once per chunk so unchanged rows skip
  // the post-upsert SELECT (saves one subrequest per existing SIM).
  const existingDbRows = await supabaseGetAllArray(env, `sims?vendor=eq.teltik&select=id,iccid`);
  const iccidToSimId = new Map();
  for (const r of existingDbRows) iccidToSimId.set(String(r.iccid), r.id);

  let imported = 0, updated = 0, unchanged = 0, skipped = 0;

  for (const line of slice) {
    // Extract MDN from line object (try common field names)
    const rawMdn = line.mdn || line.phone_number || line.number || line.phonenumber || '';
    if (!rawMdn) {
      console.log(`[Import] Skipping line with no MDN: ${JSON.stringify(line)}`);
      skipped++;
      continue;
    }
    const mdn = normalizeToE164(rawMdn);
    if (!mdn) {
      console.log(`[Import] Could not normalize MDN: ${rawMdn}`);
      skipped++;
      continue;
    }

    // Prefer the iccid that came back in all-lines; only call get-info as a
    // fallback. Eliminating this per-SIM Teltik hit is what halves the
    // subrequest budget in the common case.
    let iccid = line.iccid || '';
    if (!iccid) {
      await sleep(100); // rate-limit only the slow path
      const mdnDigits = mdn.replace('+', '');
      const infoRes = await relayFetch(env, `${TELTIK_BASE}/v1/get-info?apikey=${apiKey}&mdn=${encodeURIComponent(mdnDigits)}`);
      if (infoRes.ok) {
        const info = await infoRes.json();
        iccid = info.iccid || '';
      } else {
        console.log(`[Import] get-info failed for ${mdn}: ${infoRes.status}`);
      }
    }

    if (!iccid) {
      console.log(`[Import] Could not get ICCID for MDN ${mdn}, skipping`);
      skipped++;
      continue;
    }

    // Existence lookup served from the precomputed map (no DB call here).
    const existingSimId = iccidToSimId.get(String(iccid)) || null;
    const existing = existingSimId ? { id: existingSimId } : null;

    // 4. Upsert SIM record (gateway_id/port/slot/imei null — Teltik has no physical gateway)
    const simData = {
      iccid,
      vendor: 'teltik',
      carrier: 'tmobile',
      rotation_interval_hours: 48,
      status: 'active',
      gateway_id: null,
      port: null,
      slot: null,
      imei: null,
    };

    // For brand-new rows only: stamp activation + rotation to import time so the
    // 48h rotation cron has a baseline. Existing rows are not overwritten.
    if (!existing) {
      const nowIso = new Date().toISOString();
      simData.activated_at = nowIso;
      simData.last_mdn_rotated_at = nowIso;
    }

    const upsertRes = await supabaseUpsert(env, 'sims', simData, 'iccid');
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.log(`[Import] Upsert failed for ICCID ${iccid}: ${upsertRes.status} ${errText}`);
      continue;
    }

    // Reuse the simId from the precomputed map for existing rows; only query
    // the DB for brand-new ones (one subrequest saved per existing SIM).
    let simId = existingSimId;
    if (!simId) {
      const simRows = await supabaseGetArray(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);
      if (!Array.isArray(simRows) || simRows.length === 0) {
        console.log(`[Import] Could not find SIM after upsert for ICCID ${iccid}`);
        skipped++;
        continue;
      }
      simId = simRows[0].id;
    }

    // 6. Sync sim_numbers — close old if different, insert new
    const currentNumbers = await supabaseGetArray(
      env,
      `sim_numbers?sim_id=eq.${simId}&valid_to=is.null&select=e164&limit=1`
    );
    const currentE164 = currentNumbers[0]?.e164;

    if (currentE164 === mdn) {
      unchanged++;
    } else {
      // Close old number row if exists
      if (currentE164) {
        await supabasePatch(env, `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`, {
          valid_to: new Date().toISOString(),
        });
      }
      // Insert new number
      const insRes = await supabaseInsert(env, 'sim_numbers', [{
        sim_id: simId,
        e164: mdn,
        valid_from: new Date().toISOString(),
        verification_status: 'verified',
      }]);
      if (!insRes.ok) {
        console.log(`[Import] sim_numbers insert failed for ${mdn}: ${insRes.status}`);
      }

      // INC-5: keep sims.msisdn in lockstep with sim_numbers so the rotator
      // and other consumers don't drift if they fall back to sims.msisdn.
      const bare10 = String(mdn).replace(/^\+?1?/, '');
      if (/^\d{10}$/.test(bare10)) {
        await supabasePatch(env, `sims?id=eq.${simId}`, { msisdn: bare10 }).catch(() => {});
      }

      if (existing) {
        updated++;
      } else {
        imported++;
      }
    }
  }

  const processed = slice.length;
  const nextOffset = offset + processed;
  const hasMore = nextOffset < total;
  return {
    ok: true,
    total,
    offset,
    limit,
    processed,
    imported,
    updated,
    unchanged,
    skipped,
    next_offset: hasMore ? nextOffset : null,
    has_more: hasMore,
  };
}

// =========================================================
// RECONCILE — compare Teltik's authoritative line list against our DB.
// Returns counts + the ICCID/MDN sets that are out of sync.
// =========================================================
async function reconcileWithTeltik(env) {
  const apiKey = env.TELTIK_API_KEY;
  const res = await relayFetch(env, `${TELTIK_BASE}/v1/all-lines/?apikey=${apiKey}`);
  if (!res.ok) throw new Error(`Teltik all-lines failed: ${res.status} ${await res.text()}`);
  const lines = await res.json();
  if (!Array.isArray(lines)) throw new Error('Teltik returned non-array');

  // Pull every Teltik ICCID we know about from our DB (paginated to bypass PostgREST 1000-row cap).
  const dbRows = await supabaseGetAllArray(env, `sims?vendor=eq.teltik&select=id,iccid,status`);
  const dbByIccid = new Map();
  const simIdToIccid = new Map();
  for (const r of dbRows) {
    dbByIccid.set(String(r.iccid), r.status);
    simIdToIccid.set(r.id, r.iccid);
  }

  // Active sim_numbers for the MDN-→ICCID fast path (paginated).
  const activeNums = await supabaseGetAllArray(env, `sim_numbers?valid_to=is.null&select=sim_id,e164`);
  const e164ToSimId = new Map();
  for (const n of activeNums) e164ToSimId.set(String(n.e164), n.sim_id);

  const teltikIccids = new Set();
  const unmatchedByMdn = [];
  for (const line of lines) {
    const rawMdn = line.mdn || line.phone_number || line.number || line.phonenumber || '';
    if (!rawMdn) continue;
    const mdn = normalizeToE164(rawMdn);
    let iccid = line.iccid || '';
    if (!iccid && mdn) {
      const simId = e164ToSimId.get(mdn);
      if (simId) iccid = simIdToIccid.get(simId) || '';
    }
    if (iccid) {
      teltikIccids.add(String(iccid));
    } else {
      unmatchedByMdn.push({ mdn, line });
    }
  }

  // For unmatched-by-MDN, call get-info to resolve their ICCID (slow path).
  const unresolved = [];
  for (const u of unmatchedByMdn) {
    if (!u.mdn) { unresolved.push(u); continue; }
    await sleep(120);
    const mdnDigits = u.mdn.replace('+', '');
    const r = await relayFetch(env, `${TELTIK_BASE}/v1/get-info?apikey=${apiKey}&mdn=${encodeURIComponent(mdnDigits)}`);
    if (!r.ok) { unresolved.push({ ...u, error: `get-info ${r.status}` }); continue; }
    const info = await r.json();
    if (info.iccid) teltikIccids.add(String(info.iccid));
    else unresolved.push({ ...u, info });
  }

  const dbIccids = new Set(dbByIccid.keys());
  const dbActiveIccids = new Set([...dbByIccid.entries()].filter(([_, s]) => s === 'active').map(([k]) => k));

  const inTeltikNotInDb = [...teltikIccids].filter(i => !dbIccids.has(i));
  const inTeltikButCanceledInDb = [...teltikIccids].filter(i => dbByIccid.get(i) === 'canceled');
  const activeInDbNotInTeltik = [...dbActiveIccids].filter(i => !teltikIccids.has(i));

  return {
    ok: true,
    teltik_line_count: lines.length,
    teltik_resolved_iccids: teltikIccids.size,
    teltik_unresolved: unresolved.length,
    db_teltik_total: dbIccids.size,
    db_teltik_active: dbActiveIccids.size,
    db_teltik_canceled: dbIccids.size - dbActiveIccids.size,
    in_teltik_not_in_db: inTeltikNotInDb,
    in_teltik_but_canceled_in_db: inTeltikButCanceledInDb,
    active_in_db_not_in_teltik: activeInDbNotInTeltik,
    unresolved_lines: unresolved.slice(0, 10),
  };
}

// =========================================================
// SYNC MDNS — reconcile DB sim_numbers against Teltik's current MDNs
// =========================================================
async function syncTeltikMdns(env) {
  const apiKey = env.TELTIK_API_KEY;

  const sims = await supabaseGetArray(
    env,
    `sims?vendor=eq.teltik&status=eq.active&select=id,iccid&order=id.asc&limit=5000`
  );

  if (!sims.length) {
    return { ok: true, checked: 0, updated: 0, unchanged: 0, errors: 0 };
  }

  let checked = 0, updated = 0, unchanged = 0, errors = 0;
  const mismatches = [];

  for (const sim of sims) {
    await sleep(150); // avoid hammering Teltik
    try {
      const phoneRes = await relayFetch(
        env,
        `${TELTIK_BASE}/v1/get-phone-number/?apikey=${apiKey}&iccid=${encodeURIComponent(sim.iccid)}`
      );
      if (!phoneRes.ok) {
        console.log(`[SyncMDN] SIM ${sim.iccid}: get-phone-number ${phoneRes.status}`);
        errors++;
        continue;
      }
      const phoneData = await phoneRes.json();
      const raw = phoneData.msisdn || phoneData.mdn || phoneData.phone_number || phoneData.number || '';
      const teltikMdn = normalizeToE164(raw);
      if (!teltikMdn) {
        console.log(`[SyncMDN] SIM ${sim.iccid}: no MDN in response: ${JSON.stringify(phoneData)}`);
        errors++;
        continue;
      }

      const currentNumbers = await supabaseGetArray(
        env,
        `sim_numbers?sim_id=eq.${sim.id}&valid_to=is.null&select=e164&limit=1`
      );
      const dbMdn = currentNumbers[0]?.e164 || null;

      checked++;

      if (dbMdn === teltikMdn) {
        unchanged++;
        continue;
      }

      console.log(`[SyncMDN] SIM ${sim.iccid}: mismatch db=${dbMdn} teltik=${teltikMdn} — updating`);
      mismatches.push({ iccid: sim.iccid, db: dbMdn, teltik: teltikMdn });

      if (dbMdn) {
        await supabasePatch(env, `sim_numbers?sim_id=eq.${sim.id}&valid_to=is.null`, {
          valid_to: new Date().toISOString(),
        });
      }
      const insRes = await supabaseInsert(env, 'sim_numbers', [{
        sim_id: sim.id,
        e164: teltikMdn,
        valid_from: new Date().toISOString(),
        verification_status: 'verified',
      }]);
      if (!insRes.ok) {
        console.log(`[SyncMDN] SIM ${sim.iccid}: insert failed ${insRes.status}`);
        errors++;
      } else {
        // INC-5: keep sims.msisdn in lockstep with sim_numbers.
        const bare10 = String(teltikMdn).replace(/^\+?1?/, '');
        if (/^\d{10}$/.test(bare10)) {
          await supabasePatch(env, `sims?id=eq.${sim.id}`, { msisdn: bare10 }).catch(() => {});
        }
        updated++;
      }
    } catch (err) {
      console.error(`[SyncMDN] SIM ${sim.iccid}: ${err}`);
      errors++;
    }
  }

  return { ok: true, checked, updated, unchanged, errors, mismatches };
}

// =========================================================
// WEBHOOK — receive inbound SMS pushed by Teltik
// Teltik SMSItem: { mdn, status, timestamp, sms, code }
// =========================================================
async function handleTeltikSmsWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Log raw payload to diagnose format issues
  console.log('[Webhook] raw payload:', JSON.stringify(body).slice(0, 500));

  // Teltik may push an array of messages or a single object
  if (Array.isArray(body)) {
    console.log(`[Webhook] Array payload with ${body.length} items, processing each`);
    for (const item of body) {
      await processTeltikSmsItem(item, env);
    }
    return new Response('OK', { status: 200 });
  }

  return processTeltikSmsItem(body, env);
}

async function processTeltikSmsItem(body, env) {
  // Teltik push format: { destination, origin, message, timestamp, port, gateway_id, nickname }
  // all-sms polling format: { to, from, message, time_stamp }
  const mdn = normalizeToE164(body.destination || body.to || body.mdn || '');
  const smsBody = body.message || body.sms || '';
  const fromNumber = body.origin || body.from || '';
  // Teltik timestamps have no timezone info (likely ET not UTC) — use delivery time instead
  const receivedAt = new Date().toISOString();

  if (!mdn) {
    console.log('[Webhook] No MDN in payload, ignoring');
    return new Response('OK', { status: 200 });
  }

  // Look up sim_id by current E.164 number
  const simNumbers = await supabaseGetArray(
    env,
    `sim_numbers?e164=eq.${encodeURIComponent(mdn)}&valid_to=is.null&select=sim_id&limit=1`
  );
  const simId = simNumbers[0]?.sim_id || null;

  // Generate deterministic message ID for dedup
  const messageId = await generateMessageIdAsync({
    eventType: 'sms.received',
    simId,
    number: mdn,
    from: '',
    body: smsBody,
    timestamp: receivedAt,
  });

  // Dedup check
  const existingMsg = await supabaseGetArray(
    env,
    `inbound_sms?message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`
  );
  if (existingMsg.length > 0) {
    console.log(`[Webhook] Duplicate ${messageId}, skipping`);
    return new Response('OK', { status: 200 });
  }

  // Insert into inbound_sms
  const insRes = await supabaseInsert(env, 'inbound_sms', [{
    sim_id: simId,
    to_number: mdn,
    from_number: fromNumber,
    body: smsBody,
    received_at: receivedAt,
    port: null,        // no physical port for Teltik
    message_id: messageId,
    raw: body,
  }]);

  if (!insRes.ok) {
    console.log(`[Webhook] inbound_sms insert failed: ${insRes.status}`);
  }

  // Send reseller sms.received webhook if SIM is assigned
  if (simId) {
    const resellerRows = await supabaseGetArray(
      env,
      `reseller_sims?sim_id=eq.${simId}&active=eq.true&select=reseller_id,resellers!inner(reseller_webhooks(url,enabled))&limit=1`
    );
    const resellerId = resellerRows[0]?.reseller_id;
    const webhook = resellerRows[0]?.resellers?.reseller_webhooks?.find(w => w.enabled);
    const webhookUrl = webhook?.url;

    if (resellerId && webhookUrl) {
      await sendWebhookWithDeduplication(env, webhookUrl, {
        event_type: 'sms.received',
        created_at: new Date().toISOString(),
        data: {
          sim_id: simId,
          number: mdn,
          from: fromNumber,
          message: smsBody,
          received_at: receivedAt,
          iccid: null,
          port: null,
        },
      }, {
        messageId,
        resellerId,
      });
    }
  }

  return new Response('OK', { status: 200 });
}

// =========================================================
// ROTATE — MDN rotation for Teltik SIMs (cron + manual)
// =========================================================
async function rotateTeltikSims(env) {
  const now = Date.now();

  // 1. Query active Teltik SIMs assigned to active resellers
  const sims = await supabaseGetArray(
    env,
    `sims?vendor=eq.teltik&status=eq.active&select=id,iccid,last_mdn_rotated_at,rotation_interval_hours,rotation_hold_until,reseller_sims!inner(reseller_id,active)&reseller_sims.active=eq.true&order=last_mdn_rotated_at.asc.nullsfirst&limit=5000`
  );

  // Filter: include if never rotated OR overdue based on rotation_interval_hours,
  // BUT skip any line on a night-migration hold whose hold window hasn't passed
  // (rotation_hold_until defers a morning-anchored line past its next slot so it
  // re-rotates at the following NY midnight; cleared on rotation).
  const isHeld = (sim) => sim.rotation_hold_until && now < new Date(sim.rotation_hold_until).getTime();
  const due = sims.filter(sim => {
    if (isHeld(sim)) return false;
    if (!sim.last_mdn_rotated_at) return true;
    const intervalMs = (sim.rotation_interval_hours || 48) * 60 * 60 * 1000;
    return (now - new Date(sim.last_mdn_rotated_at).getTime()) >= intervalMs;
  });

  // 2. Second pass: pick up SIMs that failed earlier this NY-night and are eligible
  //    for in-window retry. The claim_rotation_retry_slot RPC enforces the precise
  //    predicate (rotation_status=failed, today's NY date, 15-min backoff, etc.) —
  //    we just shortlist candidates here. Status must be active OR provisioning
  //    (latter covers SIMs stuck mid-rotation that the stuck-state sweeper flipped
  //    to rotation_status='failed' but never restored status to 'active').
  // Defensive try/catch: a malformed retry query must not abort the main
  // rotation pass. The embed `reseller_sims!inner(...)` MUST live inside
  // `select=` or PostgREST throws PGRST108 (mistake that hid in PR-B for hours
  // and silently killed tonight's entire cron window — see session 58).
  let retryCandidates = [];
  try {
    retryCandidates = await supabaseGetArray(
      env,
      `sims?vendor=eq.teltik&status=in.(active,provisioning)&rotation_status=eq.failed&rotation_eligible=eq.true&reseller_sims.active=eq.true&select=id,iccid,last_mdn_rotated_at,rotation_interval_hours,rotation_hold_until,reseller_sims!inner(reseller_id,active)&order=last_mdn_rotated_at.asc.nullsfirst&limit=5000`
    );
  } catch (err) {
    console.error(`[Rotate] retry-candidates query failed (continuing with main pass): ${err}`);
  }

  // Dedup: a SIM might appear in both `due` (never-rotated edge) and `retryCandidates`;
  // prefer the normal-due path so it goes through claim_rotation_slot, not the retry RPC.
  // Also drop any held line from the retry pass (defense in depth — a held line is healthy).
  const dueIds = new Set(due.map(s => s.id));
  const retryList = retryCandidates.filter(s => !dueIds.has(s.id) && !isHeld(s));

  console.log(`[Rotate] ${sims.length} active Teltik SIMs, ${due.length} due, ${retryList.length} eligible for in-window retry`);

  let rotated = 0, errors = 0, skipped = 0, retried = 0, retrySkipped = 0;

  // Bounded-concurrency pool + graceful time budget (speed-up approved
  // 2026-06-12). The old serial loop did ~6/min and was KILLED at the 15-min
  // scheduled cap mid-flight (the session-58 stuck-state source), stretching
  // 1,400 SIMs until ~8:30am NY. Lanes are tunable via TELTIK_ROTATE_CONCURRENCY
  // (default 4 — ramp after a clean night); the 13-min budget exits cleanly
  // before the platform cap, leftovers picked up by the next :10/:40 tick.
  // Per-SIM safety is unchanged: claim_rotation_slot / claim_rotation_retry_slot
  // RPCs remain the single source of eligibility truth.
  const ROTATE_TIME_BUDGET_MS = 13 * 60 * 1000;
  const startedMs = Date.now();
  const lanes = Math.max(1, parseInt(env.TELTIK_ROTATE_CONCURRENCY || '4', 10) || 4);
  let timedOut = false;

  // Outage circuit breaker: 8 CONSECUTIVE transport-level failures (relay
  // 5xx/530, timeouts, network errors) abort the tick — remaining SIMs stay
  // unclaimed and the next :10/:40 tick retries when the outage clears.
  // Application-level rejections (body status=FAILED, "Only 1 per 48h") do
  // NOT count: those are per-SIM verdicts, not signs the vendor is down.
  // Added with the concurrency speed-up so a relay outage at 4+ lanes can't
  // burn through the whole due list (the 2026-05-25 outage logged 12,150
  // failed carrier calls under the old always-keep-going loop).
  const BREAKER_THRESHOLD = 8;
  let consecutiveTransportFails = 0;
  let breakerTripped = false;
  const isTransportError = (msg) =>
    /\b5\d\d\b|timeout|timed out|network|fetch failed|TypeError|ECONN|socket/i.test(String(msg || ''));

  async function runPool(list, isRetry) {
    let next = 0;
    async function lane() {
      while (true) {
        if (breakerTripped) return;
        if (Date.now() - startedMs > ROTATE_TIME_BUDGET_MS) { timedOut = true; return; }
        const i = next++;
        if (i >= list.length) return;
        const sim = list[i];
        try {
          const result = await rotateOneTeltikSim(env, sim, { force: false, retry: isRetry });
          if (result.skipped) { if (isRetry) retrySkipped++; else skipped++; }
          else if (result.ok) { if (isRetry) retried++; else rotated++; }
          else errors++;
          if (result.ok || result.skipped || !isTransportError(result.error)) {
            consecutiveTransportFails = 0;
          } else if (++consecutiveTransportFails >= BREAKER_THRESHOLD) {
            breakerTripped = true;
            console.error(`[Rotate] circuit breaker: ${BREAKER_THRESHOLD} consecutive transport failures — aborting tick, ${list.length - next} SIMs deferred to next tick`);
          }
        } catch (err) {
          console.error(`[Rotate${isRetry ? '/Retry' : ''}] SIM ${sim.iccid}: error: ${err}`);
          errors++;
          if (isTransportError(err) && ++consecutiveTransportFails >= BREAKER_THRESHOLD) {
            breakerTripped = true;
            console.error(`[Rotate] circuit breaker tripped (thrown transport errors) — aborting tick`);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(lanes, list.length) }, lane));
  }

  await runPool(due, false);

  // Retry pass: rotateOneTeltikSim with retry:true takes the claim_rotation_retry_slot
  // path. The RPC will reject any SIM that doesn't meet the in-window predicate, so the
  // 15-min backoff and NY-today-only constraint are enforced at the DB layer (single
  // source of truth — the worker just kicks the tires).
  await runPool(retryList, true);

  if (timedOut) {
    console.log(`[Rotate] time budget reached after ${Math.round((Date.now() - startedMs) / 1000)}s — remaining SIMs roll to the next tick`);
  }

  return {
    ok: true,
    total: sims.length,
    due: due.length,
    rotated,
    errors,
    skipped,
    retry_eligible: retryList.length,
    retried,
    retry_skipped: retrySkipped,
    time_budget_hit: timedOut,
    breaker_tripped: breakerTripped,
    concurrency: lanes,
  };
}

// Rotate a single Teltik SIM. force=true bypasses the 48h interval guard.
// retry=true routes through claim_rotation_retry_slot instead, which only accepts
// SIMs whose previous attempt failed today and is older than the 15-min backoff.
// Returns { ok, skipped?, new_mdn?, error? }.
async function rotateOneTeltikSim(env, sim, opts = {}) {
  const force = opts.force === true;
  const retry = opts.retry === true;
  const apiKey = env.TELTIK_API_KEY;

  try {
    // Atomic dedup: claim_rotation_slot does the interval + activation-day check
    // AND stamps last_mdn_rotated_at + rotation_status='rotating' in one UPDATE.
    // The retry variant uses a sibling RPC with a different predicate (failed-today,
    // 15-min backoff) — see supabase/migrations/20260520_claim_rotation_retry_slot.sql.
    // If the RPC returns false, the SIM isn't eligible and we MUST NOT call the
    // carrier — would burn an extra MDN.
    const claimed = retry
      ? await supabaseRpc(env, 'claim_rotation_retry_slot', { p_sim_id: sim.id })
      : await supabaseRpc(env, 'claim_rotation_slot', { p_sim_id: sim.id, p_force: force });
    if (!claimed) {
      const rpcName = retry ? 'claim_rotation_retry_slot' : 'claim_rotation_slot';
      console.log(`[Rotate] SIM ${sim.iccid}: ${rpcName} returned false — skipping`);
      return { ok: false, skipped: true, reason: `${rpcName}=false` };
    }
    if (force) console.log(`[Rotate] SIM ${sim.iccid}: force=true — claimed with interval bypass`);
    if (retry) console.log(`[Rotate] SIM ${sim.iccid}: retry=true — in-window retry of failed rotation`);

    // 2. Initiate number change (async on Teltik's side). Do NOT poll here — the blocking
    //    poll inside the rotate path caused races where Teltik assigned a new MDN but our
    //    6-attempt / 62s window expired, leaving DB stamped as failed while Teltik had
    //    already rotated. Instead flip to provisioning and let details-finalizer (every
    //    5 min) pick up the new MDN via get-phone-number and fire the number.online webhook.
    const runId = `rotate_${sim.iccid}_${Date.now()}`;
    const changeUrl = `${TELTIK_BASE}/v1/change-number/?apikey=${apiKey}&iccid=${encodeURIComponent(sim.iccid)}`;
    const changeRes = await relayFetch(env, changeUrl);
    const changeText = await changeRes.text();
    let changeData = {};
    try { changeData = JSON.parse(changeText); } catch {}
    // Teltik returns HTTP 200 with body {status:"FAILED"} for application-level rejections
    // (the change-number request was accepted-then-denied, not a transport error). Treat
    // those as hard failures up front instead of flipping to mdn_pending and stalling the
    // details-finalizer for 30 min on an MDN that will never change.
    const bodyStatus = changeData && changeData.status ? String(changeData.status).toUpperCase() : null;
    const bodyFailed = bodyStatus === 'FAILED';
    await logCarrierApiCall(env, {
      run_id: runId, step: 'change_number_initiate', iccid: sim.iccid, imei: null,
      request_url: changeUrl.replace(/apikey=[^&]+/, 'apikey=***'),
      request_method: 'GET', request_body: null,
      response_status: changeRes.status, response_ok: changeRes.ok,
      response_body_text: changeText, response_body_json: changeData,
      error: changeRes.ok ? (bodyFailed ? `change-number body status=FAILED` : null) : `change-number failed ${changeRes.status}`,
    });
    if (!changeRes.ok) {
      throw new Error(`change-number failed ${changeRes.status}: ${changeText}`);
    }
    if (bodyFailed) {
      const detail = changeData.error || changeData.message || changeText;
      throw new Error(`change-number body status=FAILED: ${String(detail).slice(0, 300)}`);
    }
    console.log(`[Rotate] SIM ${sim.iccid}: change-number response: ${changeText}`);
    const requestId = changeData.requestId || changeData.request_id || null;

    // 3. Finalize inline. Teltik's change-number response is synchronous and carries
    //    the new MDN (status=SUCCESS, new_msisdn=...). Use it directly instead of
    //    flipping to provisioning and having details-finalizer re-poll get-phone-number
    //    for a number we already hold. This also makes rotation immune to a later
    //    get-phone-number failure (e.g. the relay outage that stranded 562 SIMs).
    const rawNew = changeData.new_msisdn || changeData.new_mdn || '';
    const newMdnBare = rawNew ? String(rawNew).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;

    if (newMdnBare) {
      const nowIso = new Date().toISOString();
      const newE164 = normalizeToE164(rawNew);
      const rawOld = changeData.old_msisdn || '';
      const oldBare = rawOld ? String(rawOld).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;

      // Close the prior number window, open the new one.
      await supabasePatch(env, `sim_numbers?sim_id=eq.${sim.id}&valid_to=is.null`, { valid_to: nowIso }).catch(() => {});
      await supabaseInsert(env, 'sim_numbers', [{
        sim_id: sim.id, e164: newE164, valid_from: nowIso, verification_status: 'verified',
      }]).catch((e) => console.error(`[Rotate] SIM ${sim.iccid}: sim_numbers insert failed: ${e}`));

      await supabasePatch(env, `sims?id=eq.${sim.id}`, {
        msisdn: newMdnBare,
        status: 'active',
        rotation_status: 'success',
        last_rotation_at: nowIso,
        last_rotation_error: null,
        rotation_fail_count: 0,
        rotation_hold_until: null, // night-migration hold satisfied once it rotates
      });

      // Reseller webhooks: old number offline, new number online.
      try {
        await sendTeltikSwapWebhooks(env, { ...sim, msisdn: oldBare }, sim.iccid, newE164, newMdnBare, nowIso);
      } catch (err) {
        console.error(`[Rotate] SIM ${sim.iccid}: reseller webhook err: ${err}`);
      }

      console.log(`[Rotate] SIM ${sim.iccid}: rotated inline ${oldBare || '?'} → ${newMdnBare} (synchronous change-number response, requestId=${requestId})`);
      return { ok: true, iccid: sim.iccid, sim_id: sim.id, new_mdn: newE164, rotated: true };
    }

    // Fallback: response lacked a usable new_msisdn — flip to provisioning and let
    // details-finalizer pick up the new MDN via get-phone-number (the old behavior).
    await supabasePatch(env, `sims?id=eq.${sim.id}`, {
      rotation_status: 'mdn_pending',
      status: 'provisioning',
      last_rotation_error: null,
      rotation_fail_count: 0,
      rotation_hold_until: null, // night-migration hold satisfied once it rotates
    });

    console.log(`[Rotate] SIM ${sim.iccid}: change-number issued (requestId=${requestId}) — no new_msisdn in response, status=provisioning, details-finalizer will pick up MDN`);
    return { ok: true, iccid: sim.iccid, sim_id: sim.id, pending: true, requestId };

  } catch (err) {
    console.error(`[Rotate] SIM ${sim.iccid}: error: ${err}`);
    // Increment the daily fail counter via the shared RPC, which also flips
    // status to 'rotation_failed' once the count hits 5 — dropping the SIM out
    // of both the due query (status=active) and the in-window retry query
    // (status in active/provisioning), so no further auto attempts occur.
    // last_mdn_rotated_at is left untouched (claim_rotation_retry_slot's 15-min
    // backoff keys off it) so we don't re-burn an MDN this cycle.
    await supabaseRpc(env, 'increment_rotation_fail', {
      p_sim_id: sim.id,
      p_error: String(err).slice(0, 500),
      p_today_start: getNYMidnightISO(),
    }).catch(() => {});
    return { ok: false, iccid: sim.iccid, error: String(err) };
  }
}

// =========================================================
// SETUP WEBHOOK — register this worker's /webhook URL with Teltik (one-time)
// =========================================================
async function setupTeltikForwardUrl(env) {
  const apiKey = env.TELTIK_API_KEY;
  const webhookSecret = env.TELTIK_WEBHOOK_SECRET;
  const workerUrl = `https://teltik-worker.zalmen-531.workers.dev/webhook?secret=${webhookSecret}`;

  const res = await relayFetch(env, `${TELTIK_BASE}/v1/forward-url?apikey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forward_url: workerUrl }),
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text };
  }

  return { ok: true, status: res.status, webhookUrl: workerUrl, response: text };
}

// =========================================================
// Relay
// =========================================================

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

// =========================================================
// Helpers
// =========================================================

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

function normalizeToE164(to) {
  const s = String(to || '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+')) return s;
  return s;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =========================================================
// Supabase Helpers
// =========================================================

async function supabaseGetArray(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : []; } catch { data = []; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

// Paginated fetch that bypasses the PostgREST 1000-row cap by chunking via
// Range headers. `path` MUST NOT include &limit= or &offset=.
async function supabaseGetAllArray(env, path) {
  const all = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      method: 'GET',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Range: `${offset}-${offset + pageSize - 1}`,
        'Range-Unit': 'items',
      },
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : []; } catch { data = []; }
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${JSON.stringify(data)}`);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
    if (offset > 50000) break; // safety stop
  }
  return all;
}

async function supabaseGetOne(env, path) {
  const rows = await supabaseGetArray(env, path);
  return rows[0] || null;
}

async function supabaseInsert(env, table, rows) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
}

async function supabaseUpsert(env, table, data, onConflict) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(env, path, data) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
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

// Calls a Supabase RPC and returns the parsed body (for scalar returns this is
// the raw value, e.g. boolean for claim_rotation_slot).
async function supabaseRpc(env, fnName, args) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args || {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RPC ${fnName} failed ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// =========================================================
// Webhook Helpers (copied from reseller-sync)
// =========================================================

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  let dedupeTs;
  if (eventType === 'number.online') {
    dedupeTs = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    dedupeTs = timestamp
      ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
      : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), dedupeTs].join('|');
  const encoder = new TextEncoder();
  const d = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', d);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${eventType}_${hashHex}`;
}

async function wasWebhookDelivered(env, messageId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`,
    {
      method: 'GET',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts } = delivery;
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
      response_body: delivery.responseBody ? String(delivery.responseBody).slice(0, 2000) : null,
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
      if (res.ok) return { ok: true, status: res.status, attempts: attempt, responseBody };
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      }
      lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
    }
    if (attempt <= maxRetries) {
      await sleep(initialDelayMs * Math.pow(2, attempt - 1));
    }
  }
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
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

  if (!options.force) {
    const alreadySent = await wasWebhookDelivered(env, messageId);
    if (alreadySent) {
      console.log(`[Webhook] Skipping duplicate ${messageId}`);
      return { ok: true, status: 200, attempts: 0, skipped: true };
    }
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

// =========================================================
// LIFECYCLE WEBHOOK — sim.activated / sim.canceled / sim.swapped
// Auth: HMAC-SHA256 of raw body with TELTIK_LIFECYCLE_SECRET.
// Dedup: event_id is PK on teltik_lifecycle_events.
// =========================================================
async function handleTeltikLifecycleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Teltik-Signature') || '';

  if (!env.TELTIK_LIFECYCLE_SECRET) {
    console.error('[Lifecycle] TELTIK_LIFECYCLE_SECRET not configured');
    return new Response('Unauthorized', { status: 401 });
  }
  const sigOk = await verifyHmacSha256(rawBody, signature, env.TELTIK_LIFECYCLE_SECRET);
  if (!sigOk) {
    console.warn('[Lifecycle] HMAC verification failed');
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const eventId = body && body.event_id;
  const eventType = body && body.event_type;
  const occurredAt = body && body.occurred_at;
  const data = body && body.data;
  if (!eventId || !eventType || !occurredAt || !data) {
    return new Response('Invalid envelope', { status: 400 });
  }

  // Insert dedup row. If event_id already exists, the upsert is a no-op and
  // we return early so re-deliveries don't re-apply the side effects.
  const insRes = await fetch(`${env.SUPABASE_URL}/rest/v1/teltik_lifecycle_events?on_conflict=event_id`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify([{ event_id: eventId, event_type: eventType, occurred_at: occurredAt, data }]),
  });
  if (!insRes.ok && insRes.status !== 409) {
    const t = await insRes.text();
    console.error(`[Lifecycle] dedup insert failed ${insRes.status}: ${t}`);
    return jsonResponse({ ok: false, error: 'dedup insert failed' }, 500);
  }

  const existing = await supabaseGetOne(
    env,
    `teltik_lifecycle_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id,processed_at&limit=1`
  );
  if (existing && existing.processed_at) {
    return jsonResponse({ ok: true, dedup: true, event_id: eventId }, 200);
  }

  let outcome = 'noop';
  let errMsg = null;
  let simId = null;
  try {
    if (eventType === 'sim.activated') {
      ({ outcome, simId } = await applyTeltikActivation(env, data));
    } else if (eventType === 'sim.canceled' || eventType === 'sim.cancelled') {
      ({ outcome, simId } = await applyTeltikCancellation(env, data));
    } else if (eventType === 'sim.swapped') {
      ({ outcome, simId } = await applyTeltikSwap(env, data));
    } else {
      outcome = 'noop';
      errMsg = `unknown event_type: ${eventType}`;
    }
  } catch (err) {
    outcome = 'error';
    errMsg = String(err).slice(0, 1000);
    console.error(`[Lifecycle] ${eventType} handler error:`, err);
  }

  await supabasePatch(env, `teltik_lifecycle_events?event_id=eq.${encodeURIComponent(eventId)}`, {
    processed_at: new Date().toISOString(),
    outcome,
    error: errMsg,
    sim_id: simId,
  }).catch(() => {});

  return jsonResponse({ ok: outcome !== 'error', event_id: eventId, outcome, sim_id: simId }, outcome === 'error' ? 500 : 200);
}

// data: { iccid, msisdn, plan? }
async function applyTeltikActivation(env, data) {
  const iccid = (data.iccid || '').trim();
  const rawMdn = data.msisdn || data.mdn || '';
  const mdnE164 = normalizeToE164(rawMdn);
  const mdnBare = rawMdn ? String(rawMdn).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;
  if (!iccid || !mdnE164) return { outcome: 'noop', simId: null };

  const nowIso = new Date().toISOString();
  const upsertRes = await supabaseUpsert(env, 'sims', {
    iccid,
    vendor: 'teltik',
    carrier: 'tmobile',
    rotation_interval_hours: 48,
    status: 'active',
    msisdn: mdnBare,
    activated_at: nowIso,
    last_mdn_rotated_at: nowIso,
    last_rotation_at: nowIso,
    rotation_status: 'success',
    last_rotation_error: null,
  }, 'iccid');
  if (!upsertRes.ok) throw new Error(`sims upsert failed: ${upsertRes.status}`);

  const simRow = await supabaseGetOne(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);
  if (!simRow) return { outcome: 'error', simId: null };

  const cur = await supabaseGetArray(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null&select=e164&limit=1`);
  const curE164 = cur[0]?.e164;
  if (curE164 !== mdnE164) {
    if (curE164) {
      await supabasePatch(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null`, { valid_to: nowIso });
    }
    await supabaseInsert(env, 'sim_numbers', [{
      sim_id: simRow.id,
      e164: mdnE164,
      valid_from: nowIso,
      verification_status: 'verified',
    }]);
  }
  return { outcome: 'applied', simId: simRow.id };
}

// data: { iccid, msisdn?, reason? }
async function applyTeltikCancellation(env, data) {
  const iccid = (data.iccid || '').trim();
  if (!iccid) return { outcome: 'noop', simId: null };

  const simRow = await supabaseGetOne(
    env,
    `sims?iccid=eq.${encodeURIComponent(iccid)}&vendor=eq.teltik&select=id&limit=1`
  );
  if (!simRow) return { outcome: 'noop', simId: null };

  await supabasePatch(env, `sims?id=eq.${simRow.id}`, {
    status: 'canceled',
    status_reason: data.reason ? `teltik:${data.reason}` : 'teltik_lifecycle_webhook',
  });
  await supabasePatch(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null`, {
    valid_to: new Date().toISOString(),
  });
  await supabasePatch(env, `reseller_sims?sim_id=eq.${simRow.id}&active=eq.true`, {
    active: false,
  });
  return { outcome: 'applied', simId: simRow.id };
}

// data: { old_iccid, new_iccid, old_msisdn?, new_msisdn?, reason? }
async function applyTeltikSwap(env, data) {
  const oldIccid = (data.old_iccid || '').trim();
  const newIccid = (data.new_iccid || '').trim();
  if (!oldIccid || !newIccid) return { outcome: 'noop', simId: null };

  const simRow = await supabaseGetOne(
    env,
    `sims?iccid=eq.${encodeURIComponent(oldIccid)}&vendor=eq.teltik&select=id,iccid,msisdn,rotation_interval_hours&limit=1`
  );
  if (!simRow) {
    console.log(`[Lifecycle/swap] no sim for old_iccid=${oldIccid}`);
    return { outcome: 'noop', simId: null };
  }

  const nowIso = new Date().toISOString();
  const rawNewMdn = data.new_msisdn || data.new_mdn || '';
  const newMdnE164 = rawNewMdn ? normalizeToE164(rawNewMdn) : null;
  const newMdnBare = rawNewMdn ? String(rawNewMdn).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1') : null;
  const mdnChanged = newMdnBare && simRow.msisdn !== newMdnBare;

  const patch = {
    iccid: newIccid,
    status: 'active',
    rotation_status: 'success',
    last_rotation_error: null,
  };
  if (mdnChanged) {
    patch.msisdn = newMdnBare;
    // Treat the swap as a successful rotation — reset the cycle clock so we don't
    // burn a rotation right after Teltik just handed us a fresh MDN.
    patch.last_rotation_at = nowIso;
    patch.last_mdn_rotated_at = nowIso;
  }
  await supabasePatch(env, `sims?id=eq.${simRow.id}`, patch);

  if (mdnChanged && newMdnE164) {
    await supabasePatch(env, `sim_numbers?sim_id=eq.${simRow.id}&valid_to=is.null`, { valid_to: nowIso });
    await supabaseInsert(env, 'sim_numbers', [{
      sim_id: simRow.id,
      e164: newMdnE164,
      valid_from: nowIso,
      verification_status: 'verified',
    }]);
    try {
      await sendTeltikSwapWebhooks(env, simRow, newIccid, newMdnE164, newMdnBare, nowIso);
    } catch (err) {
      console.error(`[Lifecycle/swap] reseller webhook err: ${err}`);
    }
  }

  return { outcome: 'applied', simId: simRow.id };
}

// Extract the reseller's rentalId from a number.online 200 response body.
// Mirrors reseller-sync / details-finalizer so rental capture is consistent
// across every path that fires number.online.
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

async function sendTeltikSwapWebhooks(env, sim, newIccid, newE164, newMsisdnBare, rotatedAtIso) {
  const rows = await supabaseGetArray(
    env,
    `reseller_sims?sim_id=eq.${sim.id}&active=eq.true&select=reseller_id,resellers!inner(reseller_webhooks(url,enabled))&limit=1`
  );
  const resellerId = rows[0]?.reseller_id;
  const webhook = rows[0]?.resellers?.reseller_webhooks?.find(w => w.enabled);
  const webhookUrl = webhook?.url;
  if (!resellerId || !webhookUrl) return;

  // Old number goes offline (only if there was a prior MDN).
  if (sim.msisdn) {
    const oldE164 = normalizeToE164(sim.msisdn);
    await sendWebhookWithDeduplication(env, webhookUrl, {
      event_type: 'number.offline',
      created_at: new Date().toISOString(),
      data: {
        sim_id: sim.id, number: oldE164, online: false, carrier: 'T-Mobile',
        iccid: sim.iccid, verified: true,
      },
    }, { idComponents: { simId: sim.id, iccid: sim.iccid, number: oldE164, kind: 'swap_offline' }, resellerId });
  }

  // New number online — online_until from the fresh rotation stamp.
  const intervalHours = sim.rotation_interval_hours || 48;
  const onlineUntil = midnightNYAfterInterval(rotatedAtIso, intervalHours);
  const onlineRes = await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: 'number.online',
    created_at: new Date().toISOString(),
    data: {
      sim_id: sim.id, number: newE164, online: true, online_until: onlineUntil,
      carrier: 'T-Mobile', iccid: newIccid, mobilitySubscriptionId: null, verified: true,
    },
  }, { idComponents: { simId: sim.id, iccid: newIccid, number: newE164, kind: 'swap_online' }, resellerId });

  if (onlineRes.ok) {
    await supabasePatch(env, `sims?id=eq.${sim.id}`, { last_notified_at: new Date().toISOString() }).catch(() => {});

    // INC-2 rental capture. This inline rotate path (used by the night-migration)
    // fires number.online directly instead of going through reseller-sync, so it
    // must mint the rental itself — otherwise the lifetime is billed by nothing.
    // One rental per (reseller, sim_number_id); idempotent via the DB UNIQUE.
    // The reseller's rentalId is echoed in the number.online 200 body.
    if (env.RENTAL_CAPTURE_ENABLED === 'true') {
      try {
        const resellerRentalId = parseRentalIdFromResponse(onlineRes.responseBody);
        const snRows = await supabaseGetArray(env, `sim_numbers?sim_id=eq.${sim.id}&valid_to=is.null&select=id&limit=1`);
        const simNumberId = snRows[0]?.id;
        if (simNumberId != null) {
          const { upsertRental } = await import('../shared/rentals.js');
          const r = await upsertRental(env, {
            resellerId, simId: sim.id, simNumberId, vendor: 'teltik', e164: newE164, resellerRentalId,
          });
          if (!r.ok) console.log(`[Rotate] SIM ${sim.id}: rental capture failed: status=${r.status} ${r.error || ''}`);
        }
        if (resellerRentalId != null) {
          await supabasePatch(env, `reseller_sims?reseller_id=eq.${resellerId}&sim_id=eq.${sim.id}`,
            { last_rental_id: resellerRentalId }).catch(() => {});
        }
      } catch (err) {
        console.error(`[Rotate] SIM ${sim.id}: rental capture threw: ${err}`);
      }
    }
  }
}

async function verifyHmacSha256(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const sigHex = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expectedHex = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  if (expectedHex.length !== sigHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ sigHex.charCodeAt(i);
  return diff === 0;
}
