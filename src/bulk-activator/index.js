// =========================================================
// SIM ACTIVATOR WORKER
// Queues individual Helix activations — one SIM at a time.
// Queue consumer calls POST /api/mobility-activation/activate per SIM
// (single-unit endpoint, no ICCID ordering ambiguity).
// =========================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/activate') {
      return handleActivateJson(request, env);
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

    const csvRes = await fetch(env.SHEET_CSV_URL);
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

    if ([iIccid, iImei, iReseller, iStatus].some(i => i < 0)) {
      return new Response('CSV missing required headers (iccid, imei, reseller_id, status)', { status: 400 });
    }

    const pending = dataRows.filter(r => (r[iStatus] || '').trim().toLowerCase() === 'pending');
    const toProcess = limit ? pending.slice(0, limit) : pending;

    if (toProcess.length === 0) return json({ ok: true, queued: 0, note: 'No pending rows' });

    const runId = `csv_${Date.now()}`;
    let queued = 0;
    let validationErrors = 0;

    for (const r of toProcess) {
      const iccid = String(r[iIccid] || '').trim();
      const imei = String(r[iImei] || '').trim();
      const resellerId = parseInt(String(r[iReseller] || '').trim(), 10);
      if (!iccid || !imei || !Number.isFinite(resellerId)) {
        validationErrors++;
        continue;
      }
      await env.ACTIVATION_QUEUE.send({ iccid, imei, reseller_id: resellerId, run_id: runId });
      queued++;
    }

    return json({ ok: true, queued, validation_errors: validationErrors, run_id: runId });
  },

  // ── Queue consumer — one SIM at a time ───────────────────────────────────
  async queue(batch, env) {
    let token;
    try {
      token = await hxGetBearerToken(env);
    } catch (e) {
      console.error(`[Activator] Token fetch failed: ${e} — leaving batch in queue`);
      // Do NOT ack — let all messages retry
      return;
    }

    for (const msg of batch.messages) {
      const { iccid, imei, reseller_id: resellerId, run_id: runId } = msg.body;
      try {
        // Skip if already has a sub_id (previous attempt may have succeeded)
        const existing = await supabaseSelect(
          env,
          `sims?select=id,mobility_subscription_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
        );
        if (existing?.[0]?.mobility_subscription_id) {
          console.log(`[Activator] ${iccid}: already has sub_id — skipping`);
          msg.ack();
          continue;
        }

        const result = await hxActivate(env, token, iccid, imei, runId);
        const subId = String(result.mobilitySubscriptionId);

        const simId = await upsertSim(env, iccid, subId);
        if (resellerId) await assignSimToReseller(env, resellerId, simId);

        console.log(`[Activator] ${iccid}: activated subId=${subId} simId=${simId}`);
        msg.ack();
      } catch (e) {
        console.error(`[Activator] ${iccid}: failed: ${e}`);
        try { await upsertSimError(env, iccid, String(e)); } catch {}
        msg.ack(); // ACK to prevent infinite retry — error recorded in DB, details-finalizer won't pick it up
      }
    }
  },
};

/* ── JSON activation endpoint (called from dashboard / scripts) ──────────── */

async function handleActivateJson(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret') || '';
  if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method must be POST' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }); }

  const sims = body.sims || [];
  if (!Array.isArray(sims) || sims.length === 0) return json({ ok: false, error: 'sims array required' });

  const runId = `json_${Date.now()}`;
  let queued = 0;
  let validationErrors = 0;

  for (const sim of sims) {
    const iccid = String(sim.iccid || '').trim();
    const imei = String(sim.imei || '').trim();
    const resellerId = parseInt(String(sim.reseller_id || ''), 10);
    if (!iccid || !imei || !Number.isFinite(resellerId)) {
      validationErrors++;
      continue;
    }
    await env.ACTIVATION_QUEUE.send({ iccid, imei, reseller_id: resellerId, run_id: runId });
    queued++;
  }

  return json({ ok: true, queued, validation_errors: validationErrors, attempted: sims.length, run_id: runId });
}

/* ── Helix ─────────────────────────────────────────────────────────────────── */

async function hxGetBearerToken(env) {
  const res = await fetch(env.HX_TOKEN_URL, {
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
  const url = `${env.HX_API_BASE}/api/mobility-activation/activate`;
  const requestBody = {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: 'new_activation',
    subscriber: { firstName: 'SUB', lastName: 'NINE' },
    address: {
      address1: env.HX_ADDRESS1,
      city: env.HX_CITY,
      state: env.HX_STATE,
      zipCode: env.HX_ZIP,
    },
    service: { iccid, imei },
  };

  const res = await fetch(url, {
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

async function upsertSimError(env, iccid, errorMessage) {
  const existing = await supabaseSelect(env, `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);
  const payload = { status: 'error', last_activation_error: `Activation failed: ${errorMessage}` };
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

/* ── Helix API logging ──────────────────────────────────────────────────────── */

async function logHelixApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
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
  console.log(`[Helix API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? 'OK' : 'FAIL'}`);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[Helix Log] Supabase failed: ${res.status}`);
}

/* ── CSV parser ─────────────────────────────────────────────────────────────── */

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else { cur += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c !== '\r') { cur += c; }
    }
  }
  row.push(cur);
  rows.push(row);
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

function normalizeRow(row, len) {
  const r = row.slice(0, len);
  while (r.length < len) r.push('');
  return r;
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
