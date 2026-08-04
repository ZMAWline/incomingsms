// =========================================================
// Canonical Teltik hosting port-status tracking.
//
// Every Teltik /v1/port-status read — dashboard SIM query, Teltik host check,
// bad-rental-remediator host probe, Sims bulk action, 12h scheduled sweep —
// records one row per attempt into `hosting_port_status_checks` via
// recordHostingPortCheck(). Latest status + uptime stats are DERIVED from that
// history (get_hosting_port_status_summary RPC), so manual and automatic
// checks feed the same statistics and the Sims table shows the newest check
// regardless of source.
//
// State normalization rule: a check is only 'offline' when a SUCCESSFUL
// port-status response explicitly says so. HTTP errors, wrong-MDN rejections,
// missing credentials and exceptions are 'error'; a 2xx with an unrecognized
// state is 'unknown'. A read failure must never look like the port is down.
//
// Provider-vs-host rule: sims.vendor stays the SERVICE PROVIDER
// (atomic/wing_iot/teltik/helix); gateway_host='teltik' is the HOST. Checks
// are keyed by the Teltik-known MDN (latest raw Teltik inbound SMS payload
// destination via pickTeltikKnownMdn), never by ICCID, and never write the
// resolved Teltik MDN back onto the SIM.
// =========================================================

import { pickTeltikKnownMdn, latestTeltikSmsQuery } from './teltik-known-mdn.mjs';

export const CHECK_SOURCES = ['cron', 'manual_bulk', 'manual_sweep', 'single_query', 'bad_rental_remediator'];

// --- pure helpers ---------------------------------------------------------

export function toTeltik10Digit(mdn) {
  if (!mdn) return '';
  const digits = String(mdn).replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

// Normalize a Teltik /v1/port-status result to online|offline|unknown|error.
export function normalizeHostPortState(httpStatus, body) {
  if (!httpStatus || httpStatus < 200 || httpStatus >= 300) return 'error';
  const state = String((body && (body.port_status || body.status || body.state)) || '').toLowerCase();
  if (state === 'online' || state === 'registered' || state === 'active') return 'online';
  if (state === 'offline' || state === 'down' || state === 'inactive'
      || state === 'not_registered' || state === 'unregistered') return 'offline';
  return 'unknown';
}

// One insert-ready row. Callers pass what they know; nulls are fine.
export function buildHostingPortCheckRow({
  sim_id = null, iccid = null, vendor = null, gateway_host = 'teltik',
  mdn = null, mdn_source = null, source, attempt = 1,
  http_status = null, state, raw = null, error = null,
} = {}) {
  return {
    sim_id, iccid, vendor, gateway_host,
    mdn: mdn || null,
    mdn_source: mdn_source || null,
    source: CHECK_SOURCES.includes(source) ? source : 'single_query',
    attempt,
    http_status,
    state: ['online', 'offline', 'unknown', 'error'].includes(state) ? state : 'error',
    raw: raw == null ? null : raw,
    error: error || null,
    checked_at: new Date().toISOString(),
  };
}

// --- IO helpers -----------------------------------------------------------

function relayUrl(env, url) {
  return env.RELAY_URL ? env.RELAY_URL + '/' + url : url;
}
function relayHeaders(env) {
  return env.RELAY_KEY ? { 'x-relay-key': env.RELAY_KEY } : {};
}
function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };
}

// Persist one check attempt. Never throws — recording must not break the
// operation that ran the check (missing table before migration included).
export async function recordHostingPortCheck(env, row) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_checks', {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    if (!resp.ok) console.log('[HostPort] record failed HTTP ' + resp.status + ' sim=' + row.sim_id);
    return resp.ok;
  } catch (e) {
    console.log('[HostPort] record exception: ' + (e && e.message || e));
    return false;
  }
}

// Mirror one port-status attempt into carrier_api_logs so it shows in the
// dashboard API Logs alongside other Teltik calls. API key and relay key are
// redacted. Never throws — logging must not break the check.
async function logPortStatusCarrierApi(env, iccid, requestUrl, out) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/carrier_api_logs', {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({
        run_id: 'port_status_' + (iccid || 'unknown') + '_' + Date.now(),
        step: 'port_status',
        iccid: iccid || null,
        imei: null,
        vendor: 'teltik',
        request_url: requestUrl,
        request_method: 'GET',
        request_headers: env.RELAY_KEY ? { 'x-relay-key': '[REDACTED]' } : null,
        request_body: null,
        response_status: out.http_status,
        response_ok: out.http_status != null && out.http_status >= 200 && out.http_status < 300,
        response_body_text: out.body == null ? null : JSON.stringify(out.body).slice(0, 5000),
        response_body_json: out.body,
        error: out.error || null,
        created_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) console.log('[HostPort] carrier_api_logs mirror failed HTTP ' + resp.status);
  } catch (e) {
    console.log('[HostPort] carrier_api_logs mirror exception: ' + (e && e.message || e));
  }
}

// Raw Teltik /v1/port-status read. Returns { http_status, body, state, error }.
// Every attempt (including credential/MDN skips and exceptions) is also
// mirrored to carrier_api_logs; pass meta.iccid when known.
export async function readTeltikPortStatus(env, mdn, meta = {}) {
  const norm = toTeltik10Digit(mdn);
  const redactedUrl = 'https://api.smsgateway.xyz/v1/port-status?apikey=***&mdn=' + encodeURIComponent(norm);
  let out;
  if (!env.TELTIK_API_KEY) {
    out = { http_status: null, body: null, state: 'error', error: 'teltik_credentials_missing' };
  } else if (norm.length !== 10) {
    out = { http_status: null, body: null, state: 'error', error: 'no valid Teltik-known MDN — port-status skipped' };
  } else {
    const url = 'https://api.smsgateway.xyz/v1/port-status'
      + '?apikey=' + encodeURIComponent(env.TELTIK_API_KEY)
      + '&mdn=' + encodeURIComponent(norm);
    let resp, text;
    try {
      resp = await fetch(relayUrl(env, url), { method: 'GET', headers: relayHeaders(env) });
      text = await resp.text();
    } catch (e) {
      out = { http_status: null, body: null, state: 'error', error: 'port-status exception: ' + (e && e.message || e) };
    }
    if (!out) {
      let body = null;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      out = {
        http_status: resp.status, body, state: normalizeHostPortState(resp.status, body), mdn10: norm,
        error: resp.ok ? null : 'Teltik port-status HTTP ' + resp.status,
      };
    }
  }
  await logPortStatusCarrierApi(env, meta.iccid, redactedUrl, out);
  return out;
}

// Resolve the Teltik-known MDN for a SIM (latest raw Teltik inbound SMS
// payload destination; DB current MDN only as fallback). Never throws.
export async function resolveTeltikKnownMdn(env, sim) {
  let latestTeltikSms = null;
  if (sim && sim.id) {
    try {
      const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + latestTeltikSmsQuery(sim.id), { headers: sbHeaders(env) });
      const rows = resp.ok ? await resp.json() : null;
      latestTeltikSms = Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch { latestTeltikSms = null; }
  }
  return pickTeltikKnownMdn(latestTeltikSms, (sim && sim.db_current_mdn) || null);
}

// Full check for one SIM: resolve Teltik-known MDN, read port-status, record.
// Wrong-MDN/error reads retry ONCE via get-phone-number-by-ICCID when it
// yields a different MDN; both attempts are recorded for auditing.
// sim: { id, iccid, vendor, gateway_host, db_current_mdn }.
// Returns { state, http_status, mdn, mdn_source, attempts, retried, error }.
export async function checkAndRecordTeltikHostPort(env, sim, { source } = {}) {
  const picked = await resolveTeltikKnownMdn(env, sim);
  const base = {
    sim_id: sim.id || null, iccid: sim.iccid || null,
    vendor: sim.vendor || null, gateway_host: sim.gateway_host || 'teltik', source,
  };

  let attempt = 1;
  let mdn = picked ? picked.mdn : null;
  let mdnSource = picked ? picked.source : null;
  let read = await readTeltikPortStatus(env, mdn, { iccid: sim.iccid });
  await recordHostingPortCheck(env, buildHostingPortCheckRow({
    ...base, mdn: read.mdn10 || mdn, mdn_source: mdnSource, attempt,
    http_status: read.http_status, state: read.state, raw: read.body, error: read.error,
  }));

  // Retry path: read failed and Teltik may know the line by another MDN.
  let retried = false;
  if (read.state === 'error' && sim.iccid && env.TELTIK_API_KEY) {
    try {
      const lookupUrl = 'https://api.smsgateway.xyz/v1/get-phone-number/?apikey='
        + encodeURIComponent(env.TELTIK_API_KEY) + '&iccid=' + encodeURIComponent(sim.iccid);
      const resp = await fetch(relayUrl(env, lookupUrl), { method: 'GET', headers: relayHeaders(env) });
      const json = resp.ok ? await resp.json().catch(() => null) : null;
      const lookedUp = toTeltik10Digit(json && (json.msisdn || json.mdn || json.phone_number));
      if (lookedUp.length === 10 && lookedUp !== toTeltik10Digit(mdn)) {
        attempt = 2;
        retried = true;
        mdn = lookedUp;
        mdnSource = 'teltik_get_phone_number_retry';
        read = await readTeltikPortStatus(env, mdn, { iccid: sim.iccid });
        await recordHostingPortCheck(env, buildHostingPortCheckRow({
          ...base, mdn: lookedUp, mdn_source: mdnSource, attempt,
          http_status: read.http_status, state: read.state, raw: read.body, error: read.error,
        }));
      }
    } catch { /* retry lookup is best-effort */ }
  }

  return {
    sim_id: sim.id, state: read.state, http_status: read.http_status,
    mdn: read.mdn10 || mdn || null, mdn_source: mdnSource,
    attempts: attempt, retried, error: read.error || null,
  };
}

// Sweep all (or the given) Teltik-hosted SIMs with bounded concurrency.
// Used by the dashboard 12h cron, the operator manual run and the Sims bulk
// action — all three record through the same recorder above.
// ponytail: hard cap MAX_SIMS per run; slice + follow-up run if fleet outgrows it.
export async function runHostingPortSweep(env, { simIds = null, source = 'manual_sweep', concurrency = 5, maxSims = 200 } = {}) {
  // gatewayHostOf() semantics in PostgREST: explicit teltik host, or no
  // explicit host and teltik vendor.
  let query = 'sims?select=id,iccid,vendor,gateway_host,status,sim_numbers(e164)'
    + '&sim_numbers.valid_to=is.null'
    + '&or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))';
  if (Array.isArray(simIds) && simIds.length > 0) {
    query += '&id=in.(' + simIds.map(Number).filter(Number.isFinite).join(',') + ')';
  } else {
    query += '&status=eq.active'; // full sweeps only track live lines
  }
  let sims = [];
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + query + '&limit=1000', { headers: sbHeaders(env) });
    const rows = resp.ok ? await resp.json() : null;
    if (Array.isArray(rows)) sims = rows;
  } catch (e) {
    return { ok: false, error: 'sims_query_failed: ' + (e && e.message || e) };
  }

  const truncated = sims.length > maxSims;
  if (truncated) sims = sims.slice(0, maxSims);

  const summary = {
    ok: true, source, total: sims.length, truncated,
    online: 0, offline: 0, unknown: 0, error: 0, wrong_mdn_retries: 0,
    results: [],
  };
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, sims.length || 1) }, async () => {
    while (idx < sims.length) {
      const sim = sims[idx++];
      const r = await checkAndRecordTeltikHostPort(env, {
        id: sim.id, iccid: sim.iccid, vendor: sim.vendor, gateway_host: sim.gateway_host || 'teltik',
        db_current_mdn: (sim.sim_numbers && sim.sim_numbers[0] && sim.sim_numbers[0].e164) || null,
      }, { source });
      summary[r.state] = (summary[r.state] || 0) + 1;
      if (r.retried) summary.wrong_mdn_retries++;
      summary.results.push({ sim_id: sim.id, iccid: sim.iccid, state: r.state, retried: r.retried, error: r.error });
    }
  });
  await Promise.all(workers);
  return summary;
}
