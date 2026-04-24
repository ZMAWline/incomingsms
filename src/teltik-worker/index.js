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
      try {
        const result = await importTeltikLines(env);
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
    if (!isInsideRotationWindowNY()) {
      console.log(`[Cron] teltik-worker outside NY rotation window (0-5); NY hour=${getNYHour()} — skipping`);
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
// Scheduling window: 12 AM – 6 AM America/New_York (DST-aware via Intl)
// =========================================================
function getNYHour() {
  const raw = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', hour12: false,
  }).format(new Date()));
  return ((raw % 24) + 24) % 24;
}

function isInsideRotationWindowNY() {
  const h = getNYHour();
  return h >= 0 && h <= 5;
}

// =========================================================
// IMPORT — fetch all Teltik lines and upsert into DB
// =========================================================
async function importTeltikLines(env) {
  const apiKey = env.TELTIK_API_KEY;

  // 1. Fetch all lines
  const allLinesRes = await relayFetch(env, `${TELTIK_BASE}/v1/all-lines/?apikey=${apiKey}`);
  if (!allLinesRes.ok) {
    throw new Error(`Teltik all-lines failed: ${allLinesRes.status} ${await allLinesRes.text()}`);
  }
  const allLines = await allLinesRes.json();

  if (!Array.isArray(allLines) || allLines.length === 0) {
    return { ok: true, imported: 0, updated: 0, unchanged: 0, message: 'No lines returned from Teltik' };
  }

  let imported = 0, updated = 0, unchanged = 0;

  for (const line of allLines) {
    // Extract MDN from line object (try common field names)
    const rawMdn = line.mdn || line.phone_number || line.number || line.phonenumber || '';
    if (!rawMdn) {
      console.log(`[Import] Skipping line with no MDN: ${JSON.stringify(line)}`);
      continue;
    }
    const mdn = normalizeToE164(rawMdn);
    if (!mdn) {
      console.log(`[Import] Could not normalize MDN: ${rawMdn}`);
      continue;
    }

    await sleep(100); // Rate limit: 100ms between calls

    // 2. Get ICCID via get-info (MDN without + prefix)
    let iccid = line.iccid || '';
    if (!iccid) {
      const mdnDigits = mdn.replace('+', ''); // Teltik uses 11-digit format without +
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
      continue;
    }

    // 3. Check if SIM already exists
    const existing = await supabaseGetOne(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);

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

    const upsertRes = await supabaseUpsert(env, 'sims', simData, 'iccid');
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.log(`[Import] Upsert failed for ICCID ${iccid}: ${upsertRes.status} ${errText}`);
      continue;
    }

    // 5. Get SIM ID after upsert
    const simRows = await supabaseGetArray(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);
    if (!Array.isArray(simRows) || simRows.length === 0) {
      console.log(`[Import] Could not find SIM after upsert for ICCID ${iccid}`);
      continue;
    }
    const simId = simRows[0].id;

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

      if (existing) {
        updated++;
      } else {
        imported++;
      }
    }
  }

  return { ok: true, imported, updated, unchanged };
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
    `sims?vendor=eq.teltik&status=eq.active&select=id,iccid,last_mdn_rotated_at,rotation_interval_hours,reseller_sims!inner(reseller_id,active)&reseller_sims.active=eq.true&order=last_mdn_rotated_at.asc.nullsfirst&limit=5000`
  );

  // Filter: include if never rotated OR overdue based on rotation_interval_hours
  const due = sims.filter(sim => {
    if (!sim.last_mdn_rotated_at) return true;
    const intervalMs = (sim.rotation_interval_hours || 48) * 60 * 60 * 1000;
    return (now - new Date(sim.last_mdn_rotated_at).getTime()) >= intervalMs;
  });

  console.log(`[Rotate] ${sims.length} active Teltik SIMs, ${due.length} due for rotation`);

  let rotated = 0, errors = 0, skipped = 0;

  for (const sim of due) {
    try {
      const result = await rotateOneTeltikSim(env, sim, { force: false });
      if (result.skipped) skipped++;
      else if (result.ok) rotated++;
      else errors++;
    } catch (err) {
      console.error(`[Rotate] SIM ${sim.iccid}: error: ${err}`);
      errors++;
    }
  }

  return { ok: true, total: sims.length, due: due.length, rotated, errors, skipped };
}

// Rotate a single Teltik SIM. force=true bypasses the 48h interval guard.
// Returns { ok, skipped?, new_mdn?, error? }.
async function rotateOneTeltikSim(env, sim, opts = {}) {
  const force = opts.force === true;
  const apiKey = env.TELTIK_API_KEY;

  try {
    // Atomic dedup: claim_rotation_slot does the interval + activation-day check
    // AND stamps last_mdn_rotated_at + rotation_status='rotating' in one UPDATE.
    // If it returns false, another process already claimed (or SIM isn't eligible),
    // and we MUST NOT call the carrier — would burn an extra MDN.
    const claimed = await supabaseRpc(env, 'claim_rotation_slot', {
      p_sim_id: sim.id,
      p_force: force,
    });
    if (!claimed) {
      console.log(`[Rotate] SIM ${sim.iccid}: claim_rotation_slot returned false — skipping`);
      return { ok: false, skipped: true, reason: 'claim_rotation_slot=false' };
    }
    if (force) console.log(`[Rotate] SIM ${sim.iccid}: force=true — claimed with interval bypass`);

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
    await logCarrierApiCall(env, {
      run_id: runId, step: 'change_number_initiate', iccid: sim.iccid, imei: null,
      request_url: changeUrl.replace(/apikey=[^&]+/, 'apikey=***'),
      request_method: 'GET', request_body: null,
      response_status: changeRes.status, response_ok: changeRes.ok,
      response_body_text: changeText, response_body_json: changeData,
      error: changeRes.ok ? null : `change-number failed ${changeRes.status}`,
    });
    if (!changeRes.ok) {
      throw new Error(`change-number failed ${changeRes.status}: ${changeText}`);
    }
    console.log(`[Rotate] SIM ${sim.iccid}: change-number response: ${changeText}`);
    const requestId = changeData.requestId || changeData.request_id || null;

    // 3. Flip to provisioning. claim_rotation_slot already stamped last_mdn_rotated_at +
    //    rotation_status='rotating'; we move to 'mdn_pending' so details-finalizer owns it.
    //    sim.msisdn stays as the old number — finalizer uses that to detect when the new
    //    one arrives from Teltik (msisdn !== current from get-phone-number).
    await supabasePatch(env, `sims?id=eq.${sim.id}`, {
      rotation_status: 'mdn_pending',
      status: 'provisioning',
      last_rotation_error: null,
      rotation_fail_count: 0,
    });

    console.log(`[Rotate] SIM ${sim.iccid}: change-number issued (requestId=${requestId}) — status=provisioning, details-finalizer will pick up new MDN`);
    return { ok: true, iccid: sim.iccid, sim_id: sim.id, pending: true, requestId };

  } catch (err) {
    console.error(`[Rotate] SIM ${sim.iccid}: error: ${err}`);
    // Mark status=failed so stuck-state sweeper and dashboard don't show
    // this SIM as perpetually 'rotating'. last_mdn_rotated_at stays (from
    // claim_rotation_slot) so we don't retry and burn another MDN this cycle.
    await supabasePatch(env, `sims?id=eq.${sim.id}`, {
      rotation_status: 'failed',
      last_rotation_error: String(err).slice(0, 500),
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
