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
// are keyed by the Teltik-known MDN resolved by the ONE shared resolver
// (shared/teltik-known-mdn.mjs: raw inbound-SMS payload MDN → READ-ONLY Teltik
// inventory → DB current MDN), never by ICCID, and never write the resolved
// Teltik MDN back onto the SIM.
// =========================================================

import {
  resolveTeltikKnownMdn as resolveSharedTeltikKnownMdn,
  teltikInventoryLookup,
  isInventoryMdnSource,
  retryMdnSource,
} from './teltik-known-mdn.mjs';

export const CHECK_SOURCES = ['cron', 'manual_bulk', 'manual_sweep', 'single_query', 'bad_rental_remediator', 'teltik_portal'];

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

// Teltik/relay calls can hang until the Worker invocation itself is killed —
// then the batch never finishes and the job's progress/failure PATCH never
// runs (the production stuck-job mode: running, batches=0, next_offset=0).
// Bounding every vendor fetch turns a hang into a normal caught exception,
// which records as an 'error' attempt and lets the batch move on.
export const VENDOR_FETCH_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, opts = {}, timeoutMs = VENDOR_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('vendor fetch timeout after ' + timeoutMs + 'ms')), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
      resp = await fetchWithTimeout(relayUrl(env, url), { method: 'GET', headers: relayHeaders(env) });
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

// Resolve the Teltik-known MDN for a SIM. Thin wrapper over THE shared
// resolver (payload MDN → Teltik inventory → DB current MDN); kept under this
// name because callers and tests import it from here. Never throws.
export async function resolveTeltikKnownMdn(env, sim) {
  return resolveSharedTeltikKnownMdn(env, sim || {});
}

// Full check for one SIM: resolve Teltik-known MDN, read port-status, record.
// The first attempt already prefers a Teltik inventory MDN over the DB current
// MDN, so the retry below only exists for the case where the first read was
// keyed by something the inventory never confirmed (payload MDN, or a DB MDN
// resolved without any inventory lookup). Both attempts are recorded.
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

  // Retry path: the read failed and Teltik may know the line by another MDN.
  // Skipped when the first attempt was ALREADY keyed by an inventory MDN, or
  // when resolution ran the inventory and it came up empty (db_current_mdn_
  // unconfirmed) — repeating the same read-only lookup can only return the
  // same answer, and every extra vendor call costs a subrequest.
  const inventoryAlreadyRan = isInventoryMdnSource(mdnSource)
    || Boolean(picked && picked.inventory && picked.inventory.ran);
  let retried = false;
  if (read.state === 'error' && !inventoryAlreadyRan && sim.iccid && env.TELTIK_API_KEY) {
    const lookup = await teltikInventoryLookup(env, { iccid: sim.iccid, mdn: sim.db_current_mdn || null });
    if (lookup.mdn10 && lookup.mdn10 !== toTeltik10Digit(mdn)) {
      attempt = 2;
      retried = true;
      mdn = lookup.mdn10;
      mdnSource = retryMdnSource(lookup.source);
      read = await readTeltikPortStatus(env, mdn, { iccid: sim.iccid });
      await recordHostingPortCheck(env, buildHostingPortCheckRow({
        ...base, mdn: lookup.mdn10, mdn_source: mdnSource, attempt,
        http_status: read.http_status, state: read.state, raw: read.body, error: read.error,
      }));
    }
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
// Full sweeps page by { offset, maxSims } over a stable id ordering so callers
// (Workers-page manual run) can walk the whole fleet in bounded batches;
// summary reports { offset, next_offset, has_more, total_available } for that.
// ponytail: hard cap MAX_SIMS per run; cron stays a single capped slice.
export async function runHostingPortSweep(env, { simIds = null, source = 'manual_sweep', concurrency = 5, maxSims = 200, offset = 0 } = {}) {
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  if (!Number.isInteger(maxSims) || maxSims < 1) maxSims = 200;
  // gatewayHostOf() semantics in PostgREST: explicit teltik host, or no
  // explicit host and teltik vendor.
  let query = 'sims?select=id,iccid,vendor,gateway_host,status,sim_numbers(e164)'
    + '&sim_numbers.valid_to=is.null'
    + '&or=(gateway_host.eq.teltik,and(gateway_host.is.null,vendor.eq.teltik))';
  const fullSweep = !(Array.isArray(simIds) && simIds.length > 0);
  if (!fullSweep) {
    query += '&id=in.(' + simIds.map(Number).filter(Number.isFinite).join(',') + ')&limit=1000';
  } else {
    // Full sweeps only track live lines. Stable id order + offset paging so
    // batch N+1 never re-checks batch N; fetch maxSims+1 to detect has_more.
    query += '&status=eq.active&order=id.asc&offset=' + offset + '&limit=' + (maxSims + 1);
  }
  let sims = [];
  let totalAvailable = null;
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/' + query, {
      headers: { ...sbHeaders(env), Prefer: 'count=exact' },
    });
    const rows = resp.ok ? await resp.json() : null;
    if (Array.isArray(rows)) sims = rows;
    const range = resp.headers && resp.headers.get ? resp.headers.get('content-range') : null;
    const m = range && range.match(/\/(\d+)\s*$/);
    if (m) totalAvailable = Number(m[1]);
  } catch (e) {
    return { ok: false, error: 'sims_query_failed: ' + (e && e.message || e) };
  }

  const truncated = sims.length > maxSims;
  if (truncated) sims = sims.slice(0, maxSims);

  const summary = {
    ok: true, source, total: sims.length, truncated,
    offset, next_offset: offset + sims.length,
    has_more: fullSweep && truncated,
    total_available: totalAvailable,
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

// --- Rotating cron sweep ----------------------------------------------------
// The dashboard's 12h cron used to call runHostingPortSweep(env,
// {source:'cron'}) with no offset, so `offset` defaulted to 0 on every
// single invocation forever — the same ~200 lowest-id active Teltik sims got
// re-checked every run and the cron never advanced to the rest of the
// fleet. runRotatingCronSweep persists a next-offset in a singleton
// Postgres row (hosting_port_cron_state) so repeated calls actually walk
// the whole fleet, wrapping back to 0 once a full pass completes — the same
// offset/has_more contract runHostingPortSweep already returns for the
// (separately persisted) async job queue below, just a lighter-weight
// single-row state instead of a job lifecycle, since this path has no
// queued/running/done states of its own to track.
const CRON_STATE_ROW_ID = 1;

async function getCronSweepOffset(env) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_cron_state?id=eq.'
      + CRON_STATE_ROW_ID + '&select=next_offset&limit=1', { headers: sbHeaders(env) });
    const rows = resp.ok ? await resp.json() : null;
    return (Array.isArray(rows) && rows[0] && Number.isInteger(rows[0].next_offset)) ? rows[0].next_offset : 0;
  } catch (e) {
    console.log('[HostPort] getCronSweepOffset error: ' + (e && e.message || e));
    return 0;
  }
}

async function saveCronSweepOffset(env, offset) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_cron_state?id=eq.' + CRON_STATE_ROW_ID, {
      method: 'PATCH',
      headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ next_offset: offset, updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) console.log('[HostPort] saveCronSweepOffset failed HTTP ' + resp.status);
  } catch (e) {
    console.log('[HostPort] saveCronSweepOffset error: ' + (e && e.message || e));
  }
}

// Runs one bounded slice of the full fleet starting from the persisted
// offset, then advances (or wraps) that offset for next time. A sweep-query
// failure (summary.ok === false) leaves the offset untouched so the next
// run retries the same slice rather than skipping it.
export async function runRotatingCronSweep(env, { source = 'cron', maxSims = 200, concurrency = 5 } = {}) {
  const offset = await getCronSweepOffset(env);
  const summary = await runHostingPortSweep(env, { source, offset, maxSims, concurrency });
  if (summary.ok !== false) {
    await saveCronSweepOffset(env, summary.has_more ? summary.next_offset : 0);
  }
  return summary;
}

// --- Durable full-sweep jobs ----------------------------------------------
// The Workers-page "Hosting Port Check" enqueues one hosting_port_status_jobs
// row and returns immediately; the dashboard's 1-minute scheduled tick drains
// the oldest pending job one bounded batch per tick via
// processHostingPortJobs(). Offsets/totals persist after every batch, so the
// sweep never depends on a browser staying open and a crashed batch resumes
// where it stopped. Lifecycle: queued (ready for next batch) -> running
// (batch in flight) -> queued -> ... -> done | failed | cancelled.
// ponytail: optimistic-PATCH claim + updated_at lease, no queue infra; move
// to Cloudflare Queues if batch cadence ever needs to beat one per minute.

export const JOB_LEASE_MS = 3 * 60 * 1000; // stale-running takeover; > max batch runtime

// Async job batches must finish one scheduled tick well inside Cloudflare's
// per-invocation subrequest budget AND wall-clock limit. Each SIM costs ~4-6
// subrequests (MDN lookup, port-status, check insert, api-log mirror,
// optional retry), so a 200-SIM batch blows the ~1000-subrequest cap and the
// progress PATCH itself dies — the job then sits 'running' with nothing
// persisted. 10 SIMs ≈ 60 subrequests and, with VENDOR_FETCH_TIMEOUT_MS
// bounding every vendor call, a worst-case batch still finishes inside the
// tick. Sync manual/bulk runs keep their own caps.
export const ASYNC_JOB_MAX_SIMS = 10;
// Async batches also run at lower sweep concurrency than manual runs: keeps
// simultaneous open vendor connections small so a scheduled tick stays under
// runtime/subrequest pressure even when Teltik is slow.
export const ASYNC_JOB_CONCURRENCY = 3;

const EMPTY_JOB_TOTALS = { checked: 0, online: 0, offline: 0, unknown: 0, error: 0, wrong_mdn_retries: 0 };

// Enqueue a full-sweep job. One pending sweep at a time: if a queued/running
// job already exists, returns it instead of stacking duplicates.
export async function enqueueHostingPortJob(env, { source = 'manual_sweep', maxSims = ASYNC_JOB_MAX_SIMS, createdBy = null } = {}) {
  if (!Number.isInteger(maxSims) || maxSims < 1) maxSims = ASYNC_JOB_MAX_SIMS;
  maxSims = Math.min(maxSims, ASYNC_JOB_MAX_SIMS);
  try {
    const pendingResp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs'
      + '?select=id,status&status=in.(queued,running)&order=created_at.asc&limit=1', { headers: sbHeaders(env) });
    const pending = pendingResp.ok ? await pendingResp.json() : null;
    if (Array.isArray(pending) && pending[0]) {
      return { ok: true, job_id: pending[0].id, status: pending[0].status, already_pending: true };
    }
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs', {
      method: 'POST',
      headers: { ...sbHeaders(env), Prefer: 'return=representation' },
      body: JSON.stringify({ source, max_sims: maxSims, created_by: createdBy }),
    });
    const rows = resp.ok ? await resp.json() : null;
    if (!Array.isArray(rows) || !rows[0]) return { ok: false, error: 'job insert failed HTTP ' + resp.status };
    return { ok: true, job_id: rows[0].id, status: rows[0].status, already_pending: false };
  } catch (e) {
    return { ok: false, error: 'enqueue exception: ' + (e && e.message || e) };
  }
}

// Recent jobs, newest first — Workers page uses this to rediscover an
// in-flight sweep after a page reload.
export async function listHostingPortJobs(env, { limit = 5 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) limit = 5;
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs'
      + '?select=*&order=created_at.desc&limit=' + limit, { headers: sbHeaders(env) });
    const rows = resp.ok ? await resp.json() : null;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function getHostingPortJob(env, jobId) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs?id=eq.'
      + encodeURIComponent(jobId) + '&limit=1', { headers: sbHeaders(env) });
    const rows = resp.ok ? await resp.json() : null;
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch {
    return null;
  }
}

// The refetched row only counts as "our PATCH applied" if it reflects the key
// fields we just sent — otherwise a concurrent tick's PATCH is what we're
// looking at (lost claim race) and the caller must back off.
function rowMatchesPatch(row, patch) {
  if (!row) return false;
  for (const k of ['status', 'next_offset', 'batches']) {
    if (patch[k] !== undefined && row[k] !== patch[k]) return false;
  }
  // Timestamp compared by value: PostgREST may echo '+00:00' where we sent 'Z'.
  if (patch.updated_at !== undefined
    && Date.parse(row.updated_at) !== Date.parse(patch.updated_at)) return false;
  return true;
}

async function patchHostingPortJob(env, filter, patch) {
  try {
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs?' + filter, {
      method: 'PATCH',
      headers: { ...sbHeaders(env), Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return null;
    const rows = await resp.json().catch(() => null);
    if (Array.isArray(rows) && rows[0]) return rows[0];
    // Live PostgREST ignores return=representation on PATCH here — 204/empty
    // body AND 200 [] have both been seen even when the row DID update, and
    // Content-Range '*/*' has appeared on applied patches too, so no response
    // shape short-circuits. Always refetch by id and trust the row only if it
    // matches the patch we just sent — a lost race shows the rival's fields
    // and fails rowMatchesPatch.
    const id = /(?:^|&)id=eq\.([^&]+)/.exec(filter);
    if (!id) return null;
    const row = await getHostingPortJob(env, decodeURIComponent(id[1]));
    return rowMatchesPatch(row, patch) ? row : null;
  } catch {
    return null;
  }
}

// Drain pending jobs: claim the oldest claimable job (queued, or running with
// a stale lease) and run ONE bounded batch, persisting next_offset/totals so
// the next scheduled tick continues exactly where this one stopped.
export async function processHostingPortJobs(env, { maxJobs = 1, leaseMs = JOB_LEASE_MS } = {}) {
  const out = { claimed: 0, batches: 0, finished: 0, failed: 0 };
  for (let n = 0; n < maxJobs; n++) {
    const staleIso = new Date(Date.now() - leaseMs).toISOString();
    const claimable = 'or=(status.eq.queued,and(status.eq.running,updated_at.lt.' + staleIso + '))';
    let job = null;
    try {
      const resp = await fetch(env.SUPABASE_URL + '/rest/v1/hosting_port_status_jobs?select=*&'
        + claimable + '&order=created_at.asc&limit=1', { headers: sbHeaders(env) });
      const rows = resp.ok ? await resp.json() : null;
      job = Array.isArray(rows) && rows[0] ? rows[0] : null;
    } catch { job = null; }
    if (!job) break;

    // Optimistic claim: the PATCH filter repeats the claimable condition, so
    // only one concurrent tick wins; losers get an empty result and move on.
    const nowIso = new Date().toISOString();
    const claimed = await patchHostingPortJob(env, 'id=eq.' + job.id + '&' + claimable, {
      status: 'running', started_at: job.started_at || nowIso, updated_at: nowIso,
    });
    if (!claimed) continue;
    out.claimed++;

    // Clamp at processing time too: heals jobs already in the table with a
    // larger max_sims (pre-clamp 200, or 25 from before the cap was lowered),
    // which risk never finishing a batch under the subrequest cap.
    let summary;
    try {
      summary = await runHostingPortSweep(env, {
        source: CHECK_SOURCES.includes(claimed.source) ? claimed.source : 'manual_sweep',
        offset: claimed.next_offset || 0,
        maxSims: Math.min(claimed.max_sims || ASYNC_JOB_MAX_SIMS, ASYNC_JOB_MAX_SIMS),
        concurrency: ASYNC_JOB_CONCURRENCY,
      });
    } catch (e) {
      summary = { ok: false, error: 'sweep exception: ' + (e && e.message || e) };
    }
    const doneIso = new Date().toISOString();
    if (!summary.ok) {
      out.failed++;
      await patchHostingPortJob(env, 'id=eq.' + job.id, {
        status: 'failed', error: summary.error || 'sweep failed', finished_at: doneIso, updated_at: doneIso,
      });
      continue;
    }

    const prev = { ...EMPTY_JOB_TOTALS, ...(claimed.totals || {}) };
    const totals = {
      checked: prev.checked + (summary.total || 0),
      online: prev.online + (summary.online || 0),
      offline: prev.offline + (summary.offline || 0),
      unknown: prev.unknown + (summary.unknown || 0),
      error: prev.error + (summary.error || 0),
      wrong_mdn_retries: prev.wrong_mdn_retries + (summary.wrong_mdn_retries || 0),
    };
    const done = summary.has_more !== true;
    const saved = await patchHostingPortJob(env, 'id=eq.' + job.id, {
      status: done ? 'done' : 'queued',
      next_offset: summary.next_offset,
      total_available: summary.total_available != null ? summary.total_available : claimed.total_available,
      totals,
      batches: (claimed.batches || 0) + 1,
      error: null,
      finished_at: done ? doneIso : null,
      updated_at: doneIso,
    });
    if (!saved) {
      // Progress PATCH failed after the batch ran: without this the job stays
      // 'running' forever (the original production stuck-job mode). Mark it
      // failed; if even that PATCH dies, the (now 3-min) lease reclaims it.
      out.failed++;
      await patchHostingPortJob(env, 'id=eq.' + job.id, {
        status: 'failed', error: 'progress_persist_failed after batch ' + ((claimed.batches || 0) + 1),
        finished_at: doneIso, updated_at: doneIso,
      });
      continue;
    }
    out.batches++;
    if (done) out.finished++;
  }
  return out;
}
