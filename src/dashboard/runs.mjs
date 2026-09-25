// =========================================================
// GET /api/runs — the Runs page list: bulk activation runs and server-side
// bulk SIM actions in one newest-first list (the dashboard_runs view in
// supabase/migrations/20260925_dashboard_runs_view.sql). Each row carries
// run_type so the page opens the matching detail view:
//   activation -> GET /api/activation-runs/:id
//   bulk       -> GET /api/bulk-jobs/:id?all=1
// =========================================================

import { sbGet } from '../shared/supabase-rest.mjs';

const TYPES = ['activation', 'bulk'];
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
  if (type && !TYPES.includes(type)) return json({ ok: false, error: 'type must be activation or bulk' }, 400, corsHeaders);
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
