// =========================================================
// GET /api/runs — the Runs page list: bulk activation runs and server-side
// bulk SIM actions in one newest-first list (the dashboard_runs view in
// supabase/migrations/20260925_dashboard_runs_view.sql). Each row carries
// run_type so the page opens the matching detail view:
//   activation -> GET /api/activation-runs/:id
//   bulk       -> GET /api/bulk-jobs/:id?all=1
//   rotation   -> GET /api/runs/rotation/:id (handleRotationRunGet below)
// =========================================================

import { sbGet, sbGetAll } from '../shared/supabase-rest.mjs';

const TYPES = ['activation', 'bulk', 'rotation'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "running" covers both tables' in-flight states.
const STATUS_FILTERS = {
  running: 'in.(queued,processing,running)',
  done: 'eq.done',
  failed: 'eq.failed',
  cancelled: 'eq.cancelled',
};

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...(corsHeaders || {}), 'Content-Type': 'application/json' },
  });
}

export async function handleRunsList(url, env, corsHeaders) {
  const type = url.searchParams.get('type') || '';
  const status = url.searchParams.get('status') || '';
  if (type && !TYPES.includes(type)) return json({ ok: false, error: 'type must be activation, bulk or rotation' }, 400, corsHeaders);
  if (status && !STATUS_FILTERS[status]) return json({ ok: false, error: 'status must be running, done, failed or cancelled' }, 400, corsHeaders);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 100);
  const offset = Math.max(parseInt(url.searchParams.get('offset'), 10) || 0, 0);

  let path = 'dashboard_runs?select=*';
  if (type) path += '&run_type=eq.' + type;
  if (status) path += '&status=' + STATUS_FILTERS[status];
  path += '&order=created_at.desc&limit=' + limit + '&offset=' + offset;
  try {
    const { rows, count } = await sbGet(env, path, { count: 'exact' });
    return json({ ok: true, runs: rows, total: count ?? rows.length }, 200, corsHeaders);
  } catch (e) {
    // A failed upstream query is reported, never rendered as "no runs".
    return json({ ok: false, error: String(e && e.message || e) }, e && e.status ? 502 : 500, corsHeaders);
  }
}

// UTC instant of 00:00 America/New_York on a YYYY-MM-DD date (DST-safe:
// tries both offsets and keeps the one that lands on that NY date).
function nyMidnightIso(ymd) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  for (const off of ['04', '05']) {
    const iso = ymd + 'T' + off + ':00:00Z';
    const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
    if (p.year + '-' + p.month + '-' + p.day === ymd && p.hour === '00') return iso;
  }
  return ymd + 'T05:00:00Z';
}

function nextDay(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// GET /api/runs/rotation/:id — one night of MDN rotation for one vendor:
// the run row, every SIM that got a new number that NY day, and the SIMs
// whose last attempt that day failed and are still failing.
export async function handleRotationRunGet(id, env, corsHeaders) {
  if (!UUID_RE.test(id)) return json({ ok: false, error: 'invalid run id' }, 400, corsHeaders);
  try {
    const run = await sbGet(env, 'rotation_runs?select=*&id=eq.' + id + '&limit=1', { single: true });
    if (!run) return json({ ok: false, error: 'not found' }, 404, corsHeaders);
    const from = encodeURIComponent(nyMidnightIso(run.ny_date));
    const to = encodeURIComponent(nyMidnightIso(nextDay(run.ny_date)));
    const vendor = encodeURIComponent(run.vendor);
    const [numbers, failing] = await Promise.all([
      sbGetAll(env, `sim_numbers?select=sim_id,e164,valid_from,sims!inner(iccid,vendor)&sims.vendor=eq.${vendor}&valid_from=gte.${from}&valid_from=lt.${to}&order=valid_from.asc,id.asc`),
      sbGetAll(env, `sims?select=id,iccid,msisdn,status,rotation_fail_count,last_rotation_error,last_rotation_at&vendor=eq.${vendor}&rotation_status=eq.failed&last_rotation_at=gte.${from}&last_rotation_at=lt.${to}&order=last_rotation_at.desc`),
    ]);
    const rotated = numbers.map(n => ({ sim_id: n.sim_id, iccid: n.sims && n.sims.iccid, new_number: n.e164, at: n.valid_from }));
    return json({ ok: true, run, rotated, failing }, 200, corsHeaders);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) }, e && e.status ? 502 : 500, corsHeaders);
  }
}
