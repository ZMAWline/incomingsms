// =========================================================
// Server-side bulk jobs for the SIMs and Errors pages' per-SIM bulk buttons.
//
// The browser used to loop over the selected SIMs itself, one fetch per SIM.
// Locking the phone or backgrounding the tab suspended the loop and every
// remaining SIM failed with "Failed to fetch" (2026-04-28: ~50 SIMs in one
// Assign + Notify run). Now the browser posts the whole list once:
//
//   POST /api/bulk-jobs            store the job + one item per SIM, send one
//                                  queue message per item, return { job_id }
//   GET  /api/bulk-jobs            the caller's jobs (?status=running to find
//                                  one still in flight after a page reload)
//   GET  /api/bulk-jobs/:id        job + finished items (?since=<cursor> for
//                                  only the ones finished since the last poll)
//   POST /api/bulk-jobs/:id/cancel cancel every item not yet started
//
// The dashboard's own queue consumer (consumeBulkJobBatch) runs each item by
// replaying its API call(s) through the real request dispatcher as the user
// who started the job. Every existing handler, the role matrix, the legacy
// vendor switch and the audit log apply exactly as they did when the browser
// made the call, so there is no second copy of any SIM action here.
//
// An item is a short list of steps ({ path, body, optional }) run in order;
// the first required step that fails stops the item. Assign + Notify is
// [assign-reseller, sim-online]; a carrier query on a Teltik-hosted SIM adds
// an optional teltik-host-check step. The browser formats each item's stored
// responses into the same per-SIM lines it printed before.
// =========================================================

import { sbGet, sbPost, sbPatch, sbDelete, sbRpc } from '../shared/supabase-rest.mjs';
import { canAccess } from '../shared/portal-auth.mjs';
import { withAuditLog } from './audit-log.mjs';

// The routes a bulk job may replay. Each is an existing per-SIM POST route the
// bulk buttons already called one SIM at a time.
export const BULK_JOB_PATHS = [
  '/api/sim-action',
  '/api/suspend',
  '/api/restore',
  '/api/assign-reseller',
  '/api/sim-online',
  '/api/delete-sim',
  '/api/atomic-query',
  '/api/teltik-query',
  '/api/helix-query',
  '/api/wing-check',
  '/api/teltik-host-check',
];

export const MAX_ITEMS = 1000;
export const MAX_STEPS = 3;
export const MAX_SPACING_MS = 2000;
const MAX_STEP_BODY_BYTES = 4096;
// Stored responses are for the per-SIM result line, not an archive; the full
// carrier exchange is already in carrier_api_logs.
const MAX_RESULT_BYTES = 16384;
const QUEUE_SEND_BATCH = 100;
// How far back each poll re-reads past its cursor; see handleGet.
const CURSOR_OVERLAP_MS = 30000;
const INTERNAL_ORIGIN = 'https://bulk-job.internal';

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...(corsHeaders || {}), 'Content-Type': 'application/json' },
  });
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// Returns { job, items } ready to insert, or { error } naming the first
// problem. `user` is the authenticated principal making the request.
export function validateBulkJobRequest(body, user) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  const kind = String(body.kind || '');
  if (!/^[a-z0-9:_-]{1,60}$/.test(kind)) return { error: 'kind must be 1-60 of a-z 0-9 : _ -' };
  const title = String(body.title || '').trim();
  if (!title || title.length > 200) return { error: 'title is required (max 200 characters)' };
  const spacing = body.spacing_ms == null ? 0 : body.spacing_ms;
  if (!Number.isInteger(spacing) || spacing < 0 || spacing > MAX_SPACING_MS) {
    return { error: 'spacing_ms must be an integer 0-' + MAX_SPACING_MS };
  }
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    return { error: 'items must be an array of 1-' + MAX_ITEMS };
  }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isPlainObject(it)) return { error: 'items[' + i + '] must be an object' };
    if (it.sim_id != null && !Number.isInteger(it.sim_id)) return { error: 'items[' + i + '].sim_id must be an integer' };
    if (it.label != null && (typeof it.label !== 'string' || it.label.length > 200)) {
      return { error: 'items[' + i + '].label must be a string of at most 200 characters' };
    }
    if (!Array.isArray(it.steps) || it.steps.length === 0 || it.steps.length > MAX_STEPS) {
      return { error: 'items[' + i + '].steps must be an array of 1-' + MAX_STEPS };
    }
    const steps = [];
    for (let s = 0; s < it.steps.length; s++) {
      const st = it.steps[s];
      const where = 'items[' + i + '].steps[' + s + ']';
      if (!isPlainObject(st)) return { error: where + ' must be an object' };
      if (!BULK_JOB_PATHS.includes(st.path)) return { error: where + '.path is not a bulk-job route: ' + String(st.path) };
      if (!isPlainObject(st.body)) return { error: where + '.body must be an object' };
      if (JSON.stringify(st.body).length > MAX_STEP_BODY_BYTES) return { error: where + '.body is too large' };
      if (!canAccess(user.role, 'POST', st.path)) {
        return { error: 'forbidden', status: 403, message: 'Your role (' + user.role + ') may not call ' + st.path };
      }
      steps.push({ path: st.path, body: st.body, optional: st.optional === true });
    }
    out.push({ seq: i, sim_id: it.sim_id == null ? null : it.sim_id, label: it.label || null, steps });
  }
  return { job: { kind, title, spacing_ms: spacing }, items: out };
}

// The job records who started it so the consumer can act as them. API keys
// never get here (/api/bulk-jobs is on API_KEY_DENIED_ROUTES).
export function creatorFields(user) {
  if (user.username === 'break-glass' && !user.id) {
    return { created_by: 'break-glass', created_by_user_id: null, created_by_role: user.role, auth_type: 'break_glass' };
  }
  return { created_by: user.username, created_by_user_id: user.id, created_by_role: user.role, auth_type: 'session' };
}

async function handleCreate(request, env, user, corsHeaders) {
  if (!env.BULK_JOBS_QUEUE) return json({ ok: false, error: 'BULK_JOBS_QUEUE binding is missing' }, 501, corsHeaders);
  if (user.authType === 'api_key') return json({ ok: false, error: 'forbidden', reason: 'api_key_denied' }, 403, corsHeaders);
  const body = await request.json().catch(() => null);
  const v = validateBulkJobRequest(body, user);
  if (v.error) return json({ ok: false, error: v.error, message: v.message }, v.status || 400, corsHeaders);

  const jobId = crypto.randomUUID();
  await sbPost(env, 'bulk_jobs', {
    id: jobId, ...v.job, total_items: v.items.length, ...creatorFields(user),
  }, { prefer: 'return=minimal' });
  try {
    for (let i = 0; i < v.items.length; i += 500) {
      await sbPost(env, 'bulk_job_items',
        v.items.slice(i, i + 500).map(it => ({ job_id: jobId, ...it })),
        { prefer: 'return=minimal' });
    }
  } catch (e) {
    // Nothing is queued yet, so a half-written job is simply removed.
    await sbDelete(env, 'bulk_jobs?id=eq.' + jobId, { prefer: 'return=minimal' }).catch(() => {});
    throw e;
  }

  let sent = 0;
  try {
    for (; sent < v.items.length; sent += QUEUE_SEND_BATCH) {
      await env.BULK_JOBS_QUEUE.sendBatch(
        v.items.slice(sent, sent + QUEUE_SEND_BATCH).map(it => ({ body: { job_id: jobId, seq: it.seq } })));
    }
  } catch (e) {
    // Items already queued still run; the rest never will, so cancel them and
    // say so rather than leaving the job 'running' forever.
    const error = 'queue send failed after ' + sent + ' of ' + v.items.length + ' items: ' + (e && e.message || e);
    await sbPatch(env, 'bulk_job_items?job_id=eq.' + jobId + '&seq=gte.' + sent + '&status=eq.pending',
      { status: 'cancelled', finished_at: new Date().toISOString(), result: { error } }, { prefer: 'return=minimal' });
    await sbPatch(env, 'bulk_jobs?id=eq.' + jobId, { error }, { prefer: 'return=minimal' });
    await sbRpc(env, 'settle_bulk_job', { p_job_id: jobId });
    return json({ ok: false, job_id: jobId, error }, 502, corsHeaders);
  }
  return json({ ok: true, job_id: jobId, total_items: v.items.length }, 202, corsHeaders);
}

const JOB_COLUMNS = 'id,kind,title,status,total_items,created_by,cancel_requested,error,created_at,finished_at';

async function handleList(url, env, user, corsHeaders) {
  const status = url.searchParams.get('status');
  let path = 'bulk_jobs?select=' + JOB_COLUMNS + '&created_by=eq.' + encodeURIComponent(user.username);
  if (status) {
    if (!['running', 'done', 'cancelled', 'failed'].includes(status)) return json({ ok: false, error: 'bad status' }, 400, corsHeaders);
    path += '&status=eq.' + status;
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 10, 1), 50);
  const jobs = await sbGet(env, path + '&order=created_at.desc&limit=' + limit);
  return json({ ok: true, jobs }, 200, corsHeaders);
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
}

async function handleGet(jobId, url, env, corsHeaders) {
  let job = await sbGet(env, 'bulk_jobs?id=eq.' + jobId + '&select=' + JOB_COLUMNS, { single: true });
  if (!job) return json({ ok: false, error: 'not found' }, 404, corsHeaders);
  // Settling on read closes a job whose last item died with its consumer:
  // no later queue message would ever do it.
  if (job.status === 'running') {
    job.status = await sbRpc(env, 'settle_bulk_job', { p_job_id: jobId }) || job.status;
  }
  let path = 'bulk_job_items?job_id=eq.' + jobId
    + '&status=in.(done,failed,cancelled)&select=seq,sim_id,label,status,result,finished_at'
    + '&order=finished_at.asc,seq.asc&limit=' + MAX_ITEMS;
  // `since` is the cursor this route returned last time: the newest
  // finished_at seen. finished_at is stamped by the consumer before its PATCH
  // commits, so a row can land after a poll already returned a later one.
  // Re-reading a trailing window catches those late rows; the browser dedupes
  // by seq.
  const since = url.searchParams.get('since');
  if (since) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) return json({ ok: false, error: 'bad since' }, 400, corsHeaders);
    path += '&finished_at=gte.' + encodeURIComponent(new Date(t - CURSOR_OVERLAP_MS).toISOString());
  }
  const items = await sbGet(env, path);
  // Never move the cursor backwards, even if the window only held older rows.
  const newest = items.length ? items[items.length - 1].finished_at : null;
  const cursor = newest && (!since || Date.parse(newest) > Date.parse(since)) ? newest : since;
  return json({ ok: true, job, items, cursor }, 200, corsHeaders);
}

async function handleCancel(jobId, env, corsHeaders) {
  const now = new Date().toISOString();
  await sbPatch(env, 'bulk_jobs?id=eq.' + jobId + '&status=eq.running', { cancel_requested: true }, { prefer: 'return=minimal' });
  await sbPatch(env, 'bulk_job_items?job_id=eq.' + jobId + '&status=eq.pending',
    { status: 'cancelled', finished_at: now }, { prefer: 'return=minimal' });
  const status = await sbRpc(env, 'settle_bulk_job', { p_job_id: jobId });
  return json({ ok: true, status }, 200, corsHeaders);
}

// Route entry point. Returns a Response for /api/bulk-jobs paths, else null.
// The caller has already applied the role matrix and the API-key fence.
export async function handleBulkJobRoutes(request, env, url, user, corsHeaders) {
  const p = url.pathname;
  if (p !== '/api/bulk-jobs' && !p.startsWith('/api/bulk-jobs/')) return null;
  try {
    if (p === '/api/bulk-jobs') {
      if (request.method === 'POST') return await handleCreate(request, env, user, corsHeaders);
      if (request.method === 'GET') return await handleList(url, env, user, corsHeaders);
      return json({ ok: false, error: 'method not allowed' }, 405, corsHeaders);
    }
    const m = p.match(/^\/api\/bulk-jobs\/([^/]+)(\/cancel)?$/);
    if (!m || !isUuid(m[1])) return json({ ok: false, error: 'not found' }, 404, corsHeaders);
    if (m[2] && request.method === 'POST') return await handleCancel(m[1], env, corsHeaders);
    if (!m[2] && request.method === 'GET') return await handleGet(m[1], url, env, corsHeaders);
    return json({ ok: false, error: 'method not allowed' }, 405, corsHeaders);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, 500, corsHeaders);
  }
}

// --- Queue consumer --------------------------------------------------------

// The principal the job's items run as, re-read for every batch so disabling
// a user or switching break-glass off stops their remaining items.
export async function resolveJobUser(env, job) {
  if (job.auth_type === 'break_glass') {
    if (String(env.DASHBOARD_BREAK_GLASS || '').toLowerCase() !== 'on') return null;
    return { id: null, username: 'break-glass', role: job.created_by_role, sessionId: null };
  }
  if (!job.created_by_user_id) return null;
  const u = await sbGet(env, 'dashboard_users?id=eq.' + job.created_by_user_id
    + '&select=id,username,role,status', { single: true });
  if (!u || u.status !== 'active') return null;
  return { id: u.id, username: u.username, role: u.role, sessionId: null };
}

function capResult(body) {
  const text = JSON.stringify(body === undefined ? null : body);
  if (text.length <= MAX_RESULT_BYTES) return body;
  return {
    truncated: true,
    ok: isPlainObject(body) ? body.ok : undefined,
    error: isPlainObject(body) ? body.error : undefined,
    bytes: text.length,
  };
}

// One step: an internal POST through the real dispatcher, audited like the
// browser's call was. `dispatch` is handleDashboardRequest, passed in to keep
// this module free of a circular import.
export async function runStep(env, ctx, dispatch, user, step) {
  const request = new Request(INTERNAL_ORIGIN + step.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(step.body || {}),
  });
  const res = await withAuditLog(request, env, ctx,
    (req, e, c, audit) => dispatch(req, e, c, audit, user));
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = { ok: false, error: 'non-JSON response: ' + text.slice(0, 200) }; }
  const ok = res.ok && !(isPlainObject(body) && body.ok === false);
  return { path: step.path, status: res.status, ok, body: capResult(body) };
}

// Runs every step of an item in order; the first required step that fails
// stops the item. Optional steps are recorded but never fail it.
export async function runItemSteps(env, ctx, dispatch, user, steps) {
  const results = [];
  let ok = true;
  for (const step of steps) {
    let r;
    try {
      r = await runStep(env, ctx, dispatch, user, step);
    } catch (e) {
      r = { path: step.path, status: 0, ok: false, body: { ok: false, error: String(e && e.message || e) } };
    }
    results.push(r);
    if (!r.ok && !step.optional) { ok = false; break; }
  }
  return { ok, steps: results };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Queue handler body. One message = one item ({ job_id, seq }). Every
// message is acked unless something failed before the item was claimed; a
// retry after the claim finds the item no longer pending and does nothing.
export async function consumeBulkJobBatch(batch, env, ctx, dispatch) {
  const jobs = new Map();
  for (const msg of batch.messages) {
    try {
      await runQueuedItem(env, ctx, dispatch, msg.body, jobs);
      msg.ack();
    } catch (e) {
      console.log('[BulkJobs] item ' + JSON.stringify(msg.body) + ' failed before completion: ' + (e && e.message || e));
      msg.retry();
    }
  }
}

async function runQueuedItem(env, ctx, dispatch, body, jobs) {
  const jobId = body && body.job_id;
  const seq = body && body.seq;
  if (!isUuid(jobId) || !Number.isInteger(seq)) {
    console.log('[BulkJobs] dropping malformed message ' + JSON.stringify(body));
    return;
  }
  let entry = jobs.get(jobId);
  if (!entry) {
    const job = await sbGet(env, 'bulk_jobs?id=eq.' + jobId + '&select=*', { single: true });
    entry = { job, user: job ? await resolveJobUser(env, job) : null };
    jobs.set(jobId, entry);
  }
  if (!entry.job) return;                               // job deleted

  const claimed = await sbRpc(env, 'claim_bulk_job_item', { p_job_id: jobId, p_seq: seq });
  const item = Array.isArray(claimed) ? claimed[0] : null;
  if (!item) return;                                    // cancelled or already run

  let outcome;
  if (!entry.user) {
    outcome = { ok: false, error: 'The user who started this job is no longer active; item not run.' };
  } else {
    outcome = await runItemSteps(env, ctx, dispatch, entry.user, item.steps);
  }
  await sbPatch(env, 'bulk_job_items?job_id=eq.' + jobId + '&seq=eq.' + seq, {
    status: outcome.ok ? 'done' : 'failed',
    result: outcome,
    finished_at: new Date().toISOString(),
  }, { prefer: 'return=minimal' });
  await sbRpc(env, 'settle_bulk_job', { p_job_id: jobId });
  if (entry.job.spacing_ms > 0) await sleep(entry.job.spacing_ms);
}
