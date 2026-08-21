import { pickNextPpuAddress, markAddressVerifyFailure } from '../shared/address-picker.mjs';
import { buildAtomicActivateRequest, buildAtomicPortInRequest, normalizePhone10, parseCsv, validateActivationSim } from '../shared/activation-bulk.mjs';

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

    const runId = `csv_${Date.now()}`;
    let queued = 0;
    let validationErrors = 0;
    const rowErrors = [];

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
      await env.ACTIVATION_QUEUE.send({ ...checked.sim, run_id: runId });
      queued++;
    }

    return json({ ok: validationErrors === 0, queued, validation_errors: validationErrors, row_errors: rowErrors, run_id: runId });
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
        const alreadyActivated = existingSim
          && (existingSim.status === 'active' || existingSim.status === 'provisioning')
          && (existingSim.mobility_subscription_id || existingSim.msisdn);
        if (alreadyActivated) {
          console.log(`[Activator] ${iccid}: already activated (status=${existingSim.status}) — skipping`);
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
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method must be POST' });

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }); }

  const sims = body.sims || [];
  if (!Array.isArray(sims) || sims.length === 0) return json({ ok: false, error: 'sims array required' });

  const runId = `json_${Date.now()}`;
  let queued = 0;
  let validationErrors = 0;
  const rowErrors = [];

  // Default vendor from request body, or 'atomic' for AT&T
  const defaultVendor = body.vendor || 'atomic';

  for (let i = 0; i < sims.length; i++) {
    const checked = validateActivationSim(sims[i], { rowNumber: i + 1, defaultVendor });
    if (!checked.ok) {
      validationErrors++;
      rowErrors.push(...checked.errors);
      continue;
    }
    await env.ACTIVATION_QUEUE.send({ ...checked.sim, run_id: runId });
    queued++;
  }

  return json({ ok: validationErrors === 0, queued, validation_errors: validationErrors, row_errors: rowErrors, attempted: sims.length, run_id: runId });
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

  // Quarantine the picked address if AT&T rejected it (won't be re-picked for 90d).
  const respDesc = responseJson?.wholeSaleApi?.wholeSaleResponse?.description || '';
  if (/address.*verif|verif.*address/i.test(respDesc)) {
    await markAddressVerifyFailure(env, addr.id, `ATOMIC activate rejected address: ${respDesc.slice(0, 200)}`);
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

async function activateViaAtomicPortIn(env, iccid, imei, runId, options = {}) {
  const normalizedPortMdn = options.normalizedPortMdn || normalizePhone10(options.portMdn || options.port_mdn || '');
  const portAccountNumber = String(options.portAccountNumber || options.port_account_number || '').trim();
  const portPin = String(options.portPin || options.port_pin || '').trim();
  const portFields = mapPortFields(options);

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
  const requestBody = buildAtomicPortInRequest({
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

  if (!res.ok) {
    throw new Error(`ATOMIC port-in failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  // Unlike Activate, a port is accepted asynchronously by the losing carrier —
  // the carrier's success/response shape for portinRequest is not independently
  // confirmed (see docs/atomic-port-in-runbook.md), so we don't hard-require an
  // MSISDN echo here. We already know the target MDN; use it as the identifier
  // and record the SIM as still provisioning rather than immediately active.
  const result = responseJson?.wholeSaleApi?.wholeSaleResponse?.Result;
  return {
    msisdn: result?.MSISDN || normalizedPortMdn,
    ban: result?.BAN || '',
    status: 'provisioning', // sims.status CHECK constraint has no "pending port" value
    zipCode: portFields.zip,
    portInPending: true, // marks this SIM for details-finalizer's portinStatus poll
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

  // MDN takes ~1-4 min to propagate — mdn-rotator's syncWingIotPendingMdns cron fills it in
  return { msisdn: '', status: 'provisioning' };
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

function normalizeRow(row, len) {
  const r = row.slice(0, len);
  while (r.length < len) r.push('');
  return r;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
