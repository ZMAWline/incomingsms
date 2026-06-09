// =========================================================
// Vendor API clients used by the bad-rental-remediator (INC-21 / INC-16e).
//
// These are inline, single-purpose adapters that:
//   - call exactly one vendor endpoint each (no fan-out helpers, no shared
//     state beyond the Helix token cache),
//   - never invoke any §H.2 forbidden capability,
//   - return a uniform { ok, status, requestId, body, error } so the
//     actions.mjs executors don't care about vendor-specific shapes.
//
// Credentials are loaded from environment secrets at the worker boundary:
//   ATOMIC : ATOMIC_API_URL? + ATOMIC_USERNAME + ATOMIC_TOKEN + ATOMIC_PIN
//   WING   : WING_IOT_BASE_URL? + WING_IOT_USERNAME + WING_IOT_API_KEY
//   HELIX  : HX_API_BASE + HX_TOKEN_URL + HX_CLIENT_ID + HX_AUDIENCE
//            + HX_GRANT_USERNAME + HX_GRANT_PASSWORD
//            (token cached in REMEDIATOR_KV with 25-min TTL)
//   TELTIK : TELTIK_API_KEY
//
// Relay support — if RELAY_URL+RELAY_KEY are set every outbound vendor call
// is proxied through the relay so the worker doesn't need an IP allowlist on
// the carrier side. Identical pattern to src/shared/atomic.ts etc.
// =========================================================

import { mdn10 } from './teltik.mjs';

const HELIX_TOKEN_CACHE_KEY = 'bad_rental_remediator_helix_token';
const HELIX_TOKEN_TTL_SECONDS = 25 * 60;

const WING_DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';

// ---------------------------------------------------------
// Atomic — resendOtaProfile (A1)
// ---------------------------------------------------------
export async function atomicResendOta(env, { msisdn, iccid }) {
  return atomicCall(env, 'resendOtaProfile', { MSISDN: msisdn, sim: iccid });
}

// Atomic — restoreSubscriber reasonCode=CR (A3)
export async function atomicRestoreSubscriber(env, { msisdn }) {
  return atomicCall(env, 'restoreSubscriber', { MSISDN: msisdn, reasonCode: 'CR' });
}

async function atomicCall(env, requestType, requestData) {
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
    return { ok: false, status: 0, error: 'atomic_credentials_missing', body: null };
  }
  const body = {
    wholeSaleApi: {
      session: {
        userName: env.ATOMIC_USERNAME,
        token:    env.ATOMIC_TOKEN,
        pin:      env.ATOMIC_PIN,
      },
      wholeSaleRequest: { requestType, ...requestData },
    },
  };
  let resp, text;
  try {
    resp = await relayFetch(env, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err), body: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const ws  = json && json.wholeSaleApi && json.wholeSaleApi.wholeSaleResponse;
  const sc  = ws && ws.statusCode;
  const ok  = resp.ok && sc === '00';
  const rid = ws && (ws.partnerTransactionId || ws.requestId) || null;
  return {
    ok,
    status: resp.status,
    requestId: rid,
    error: ok ? null : (ws && ws.description) || ('atomic_status_' + resp.status + (sc ? '_sc_' + sc : '')),
    body: json,
  };
}

// ---------------------------------------------------------
// Wing IoT — PUT NON-ABIR dialable plan (W7).
// NEVER PUTs the ABIR (non-dialable) plan from the remediator.
// ---------------------------------------------------------
export async function wingPutDialable(env, { iccid }) {
  if (!iccid) return { ok: false, status: 0, error: 'missing_iccid', body: null };
  if (!env.WING_IOT_USERNAME || !env.WING_IOT_API_KEY) {
    return { ok: false, status: 0, error: 'wing_credentials_missing', body: null };
  }
  const base = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
  const url  = base + '/v1/devices/' + encodeURIComponent(iccid);
  const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
  const body = { communicationPlan: WING_DIALABLE_PLAN };

  let resp, text;
  try {
    resp = await relayFetch(env, url, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err), body: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return {
    ok: resp.ok,
    status: resp.status,
    requestId: (json && (json.requestId || json.request_id)) || null,
    error: resp.ok ? null : ('wing_status_' + resp.status),
    body: json,
  };
}

// ---------------------------------------------------------
// Helix — 4.11 OTA refresh (H3)
// ---------------------------------------------------------
export async function helixOtaRefresh(env, { ban, subscriberNumber, iccid }) {
  if (!ban || !subscriberNumber || !iccid) {
    return { ok: false, status: 0, error: 'helix_ota_missing_fields', body: null };
  }
  return helixPatch(env, '/api/mobility-subscriber/reset-ota',
    [{ ban, subscriberNumber, iccid }]);
}

// Helix — 4.6 Unsuspend reasonCode CR/35 (H4).
// Caller MUST pass subscriberNumber and may pass mobilitySubscriptionId; the
// vendor wrapper strips mobilitySubscriptionId before send (matches the
// mdn-rotator hxChangeSubscriberStatus contract).
export async function helixUnsuspend(env, { subscriberNumber, mobilitySubscriptionId }) {
  if (!subscriberNumber) {
    return { ok: false, status: 0, error: 'helix_unsuspend_missing_subscriber_number', body: null };
  }
  const payload = {
    subscriberNumber,
    reasonCode: 'CR',
    reasonCodeId: 35,
    subscriberState: 'Active',
  };
  if (mobilitySubscriptionId) payload.mobilitySubscriptionId = mobilitySubscriptionId;
  // strip mobilitySubscriptionId — vendor rejects it on the status PATCH
  const { mobilitySubscriptionId: _drop, ...clean } = payload;
  return helixPatch(env, '/api/mobility-subscriber/status', [clean]);
}

async function helixPatch(env, path, body) {
  if (!env.HX_API_BASE) {
    return { ok: false, status: 0, error: 'helix_credentials_missing', body: null };
  }
  let token;
  try {
    token = await getHelixToken(env);
  } catch (err) {
    return { ok: false, status: 0, error: 'helix_token_error:' + (err && err.message || err), body: null };
  }
  const url = env.HX_API_BASE + path;
  let resp, text;
  try {
    resp = await relayFetch(env, url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
    text = await resp.text();
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err), body: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const requestId = (json && (json.requestId || json.request_id || json.correlationId)) || null;
  return {
    ok: resp.ok,
    status: resp.status,
    requestId,
    error: resp.ok ? null : ('helix_status_' + resp.status),
    body: json,
  };
}

async function getHelixToken(env) {
  if (env.REMEDIATOR_KV) {
    const cached = await env.REMEDIATOR_KV.get(HELIX_TOKEN_CACHE_KEY);
    if (cached) return cached;
  }
  if (!env.HX_TOKEN_URL || !env.HX_CLIENT_ID || !env.HX_AUDIENCE
      || !env.HX_GRANT_USERNAME || !env.HX_GRANT_PASSWORD) {
    throw new Error('helix_token_env_missing');
  }
  const resp = await relayFetch(env, env.HX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id:  env.HX_CLIENT_ID,
      audience:   env.HX_AUDIENCE,
      username:   env.HX_GRANT_USERNAME,
      password:   env.HX_GRANT_PASSWORD,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error('helix_token_http_' + resp.status);
  }
  if (env.REMEDIATOR_KV) {
    await env.REMEDIATOR_KV.put(HELIX_TOKEN_CACHE_KEY, json.access_token,
      { expirationTtl: HELIX_TOKEN_TTL_SECONDS });
  }
  return json.access_token;
}

// ---------------------------------------------------------
// Teltik — /v1/reset-network (T3) and /v1/reset-port (T4/T5/T3-fallback).
// 10-digit MDN enforced via mdn10() at this boundary (no other call site
// normalizes for Teltik — classifier passes E.164 through).
// 409 on /reset-port is treated by the executor as success (already in
// flight); this wrapper just returns the raw status and the executor
// classifies it.
// ---------------------------------------------------------
export async function teltikResetNetwork(env, { mdn }) {
  return teltikGet(env, '/v1/reset-network', mdn);
}
export async function teltikResetPort(env, { mdn }) {
  return teltikGet(env, '/v1/reset-port', mdn);
}

async function teltikGet(env, path, mdn) {
  if (!env.TELTIK_API_KEY) {
    return { ok: false, status: 0, error: 'teltik_credentials_missing', body: null };
  }
  const norm = mdn10(mdn);
  if (!norm || norm.length !== 10) {
    return { ok: false, status: 0, error: 'teltik_mdn_invalid:' + norm, body: null };
  }
  const url = 'https://api.smsgateway.xyz' + path
    + '?apikey=' + encodeURIComponent(env.TELTIK_API_KEY)
    + '&mdn=' + encodeURIComponent(norm);
  let resp, text;
  try {
    resp = await relayFetch(env, url, { method: 'GET' });
    text = await resp.text();
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err), body: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return {
    ok: resp.ok,
    status: resp.status,
    requestId: (json && (json.request_id || json.requestId)) || null,
    error: resp.ok ? null : ('teltik_status_' + resp.status),
    body: json,
    mdn10: norm,
  };
}

// ---------------------------------------------------------
// Teltik /v1/port-status — used by the T3/T4/T5 §C.4 extra predicate.
// Returns { online: bool, raw: <state>, status }.
// ---------------------------------------------------------
export async function teltikPortStatus(env, { mdn }) {
  if (!env.TELTIK_API_KEY) {
    return { online: false, status: 0, error: 'teltik_credentials_missing' };
  }
  const norm = mdn10(mdn);
  if (!norm || norm.length !== 10) {
    return { online: false, status: 0, error: 'teltik_mdn_invalid:' + norm };
  }
  const url = 'https://api.smsgateway.xyz/v1/port-status'
    + '?apikey=' + encodeURIComponent(env.TELTIK_API_KEY)
    + '&mdn=' + encodeURIComponent(norm);
  let resp, text;
  try {
    resp = await relayFetch(env, url, { method: 'GET' });
    text = await resp.text();
  } catch (err) {
    return { online: false, status: 0, error: String(err && err.message || err) };
  }
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const state = String(
    (json && (json.port_status || json.status || json.state)) || ''
  ).toLowerCase();
  const online = state === 'online' || state === 'registered' || state === 'active';
  return { online, status: resp.status, raw: state || null, body: json };
}

// ---------------------------------------------------------
// Plumbing
// ---------------------------------------------------------
function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(env.RELAY_URL + '/' + url, {
      ...init,
      headers: { ...(init && init.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}
