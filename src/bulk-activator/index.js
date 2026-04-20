import { pickRandomAddress } from '../shared/address-pool.js';

// =========================================================
// SIM ACTIVATOR WORKER
// Queues individual SIM activations — one SIM at a time.
// Supports multiple vendors: helix, atomic, wing_iot
// Queue consumer routes to appropriate carrier API per SIM.
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
      // Default vendor is 'atomic' for new AT&T activations
      const vendor = 'atomic';
      await env.ACTIVATION_QUEUE.send({ iccid, imei, reseller_id: resellerId, run_id: runId, vendor });
      queued++;
    }

    return json({ ok: true, queued, validation_errors: validationErrors, run_id: runId });
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
      const { iccid, imei, reseller_id: resellerId, run_id: runId, vendor = 'atomic' } = msg.body;
      try {
        // Skip if already activated (check for sub_id or msisdn based on vendor)
        const existing = await supabaseSelect(
          env,
          `sims?select=id,mobility_subscription_id,msisdn,vendor&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
        );
        const existingSim = existing?.[0];
        if (existingSim?.mobility_subscription_id || existingSim?.msisdn) {
          console.log(`[Activator] ${iccid}: already activated — skipping`);
          msg.ack();
          continue;
        }

        let result;
        switch (vendor) {
          case 'atomic':
            result = await activateViaAtomic(env, iccid, imei, runId);
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
        msg.ack();
      } catch (e) {
        console.error(`[Activator] ${iccid}: failed: ${e}`);
        try { await upsertSimError(env, iccid, String(e), vendor); } catch {}
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

  // Default vendor from request body, or 'atomic' for AT&T
  const defaultVendor = body.vendor || 'atomic';

  for (const sim of sims) {
    const iccid = String(sim.iccid || '').trim();
    const imei = String(sim.imei || '').trim();
    const resellerId = parseInt(String(sim.reseller_id || ''), 10);
    // Per-SIM vendor override, fallback to default
    const vendor = sim.vendor || defaultVendor;

    // IMEI not required for wing_iot
    if (!iccid || (!imei && vendor !== 'wing_iot') || !Number.isFinite(resellerId)) {
      validationErrors++;
      continue;
    }
    await env.ACTIVATION_QUEUE.send({ iccid, imei, reseller_id: resellerId, run_id: runId, vendor });
    queued++;
  }

  return json({ ok: true, queued, validation_errors: validationErrors, attempted: sims.length, run_id: runId });
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

/* ── Vendor-specific activation functions ──────────────────────────────────── */

async function activateViaAtomic(env, iccid, imei, runId) {
  // ATOMIC activation - returns MSISDN immediately
  const addr = pickRandomAddress();
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const requestBody = {
    wholeSaleApi: {
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      wholeSaleRequest: {
        requestType: 'Activate',
        partnerTransactionId: `act_${Date.now()}`,
        imei,
        sim: iccid,
        eSim: 'N',
        EID: '',
        BAN: '',
        firstName: 'SUB',
        lastName: 'NINE',
        streetNumber: addr.address1.split(' ')[0],
        streetDirection: '',
        streetName: addr.address1.split(' ').slice(1).join(' '),
        zip: addr.zipCode,
        plan: 'ATTNOVOICE',
        portMdn: '',
      },
    },
  };

  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}

  await logCarrierApiCall(env, {
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
    throw new Error(`ATOMIC activation failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  const result = responseJson?.wholeSaleApi?.wholeSaleResponse?.Result;
  if (!result?.MSISDN) {
    throw new Error(`ATOMIC activation returned no MSISDN: ${responseText.slice(0, 300)}`);
  }

  return {
    msisdn: result.MSISDN,
    ban: result.BAN || '',
    status: 'active', // ATOMIC activations are immediately active
    zipCode: addr.zipCode,
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

  await logCarrierApiCall(env, {
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
    throw new Error(`Wing IoT activation failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  // MSISDN takes ~1 minute to propagate after activation
  await new Promise(r => setTimeout(r, 60000));

  // GET to verify and get MDN
  const getRes = await relayFetch(env, url, {
    method: 'GET',
    headers: { Authorization: auth },
  });
  const getJson = await getRes.json().catch(() => ({}));

  return {
    msisdn: getJson.msisdn || getJson.mdn || '',
    status: 'active',
  };
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
  const addr = pickRandomAddress();
  const url = `${env.HX_API_BASE}/api/mobility-activation/activate`;
  const requestBody = {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: 'new_activation',
    subscriber: { firstName: 'SUB', lastName: 'NINE' },
    address: {
      address1: addr.address1,
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

async function upsertSimWithVendor(env, iccid, result, vendor) {
  const existing = await supabaseSelect(env, `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`);

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
    // For ATOMIC/Wing, SIM is immediately active with MDN
    if (result.msisdn) {
      payload.status = 'active';
    }
    if (result.zipCode) {
      payload.activation_zip = result.zipCode;
    }
  } else if (vendor === 'helix') {
    payload.mobility_subscription_id = result.mobilitySubscriptionId;
    payload.status = 'provisioning'; // Helix needs finalizer to get MDN
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

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
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
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[Carrier Log] Supabase failed: ${res.status}`);
}

// Backward compatibility alias
async function logHelixApiCall(env, logData) {
  return logCarrierApiCall(env, { ...logData, vendor: 'helix' });
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
