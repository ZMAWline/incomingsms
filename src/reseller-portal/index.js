import { computeBillingBreakdown, estDateFromDate } from '../shared/billing.js';

const COOKIE_NAME = 'rp_session';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

const ATT_VENDORS = new Set(['wing_iot', 'atomic', 'helix']);
const TMOBILE_VENDORS = new Set(['teltik']);
function vendorToCarrier(vendor) {
  if (!vendor) return null;
  if (ATT_VENDORS.has(vendor)) return 'AT&T';
  if (TMOBILE_VENDORS.has(vendor)) return 'T-Mobile';
  return null;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

async function sbGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
}

async function sbGetAll(env, pathWithoutLimit) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes('?') ? '&' : '?';
    const url = pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;
    const resp = await sbGet(env, url);
    if (!resp.ok) throw new Error('PostgREST: ' + resp.status + ' ' + (await resp.text()));
    const batch = await resp.json();
    if (!Array.isArray(batch)) return batch;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

function getKeyFromRequest(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]+)'));
  if (m) return decodeURIComponent(m[1]);
  return null;
}

async function authenticate(request, env) {
  const key = getKeyFromRequest(request);
  if (!key || !key.startsWith('rsk_')) return null;
  const resp = await sbGet(env,
    'reseller_api_keys?select=id,reseller_id,enabled,resellers(name)' +
    '&api_key=eq.' + encodeURIComponent(key) +
    '&limit=1'
  );
  if (!resp.ok) return null;
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  if (!row.enabled) return null;
  return { resellerId: String(row.reseller_id), keyId: row.id, name: row.resellers?.name || String(row.reseller_id) };
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function unauthorized() { return jsonResp({ error: 'unauthorized' }, 401); }
function notFound() { return jsonResp({ error: 'not found' }, 404); }
function badRequest(msg) { return jsonResp({ error: msg }, 400); }

async function handleLogin(url, env) {
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing ?key=', { status: 400 });
  const fakeReq = new Request('http://x/', { headers: { Authorization: 'Bearer ' + key } });
  const auth = await authenticate(fakeReq, env);
  if (!auth) return new Response('Invalid or revoked key', { status: 401 });
  const cookie =
    `${COOKIE_NAME}=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
  return new Response(null, {
    status: 302,
    headers: { Location: '/', 'Set-Cookie': cookie },
  });
}

async function handleMe(auth) {
  return jsonResp({ reseller_id: Number(auth.resellerId), name: auth.name });
}

async function handleSims(auth, env) {
  const rows = await sbGetAll(env,
    'reseller_sims?select=sim_id,active,created_at,sims(iccid,vendor,msisdn,status,activated_at,rotation_interval_hours)' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&order=active.desc,sim_id.asc'
  );
  const out = (Array.isArray(rows) ? rows : []).map(r => ({
    sim_id: r.sim_id,
    active: r.active,
    assigned_at: r.created_at,
    iccid: r.sims?.iccid || null,
    carrier: vendorToCarrier(r.sims?.vendor),
    msisdn: r.sims?.msisdn || null,
    status: r.sims?.status || null,
    activated_at: r.sims?.activated_at || null,
    rotation_interval_hours: r.sims?.rotation_interval_hours || null,
  }));
  return jsonResp(out);
}

async function handleInvoices(auth, env) {
  const resp = await sbGet(env,
    'qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,created_at,qbo_customer_map!inner(reseller_id)' +
    '&qbo_customer_map.reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&order=week_start.desc'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  const out = (Array.isArray(rows) ? rows : []).map(r => ({
    id: r.id,
    week_start: r.week_start,
    week_end: r.week_end,
    sim_count: r.sim_count,
    total: r.total,
    status: r.status,
    paid_at: r.paid_at,
    created_at: r.created_at,
  }));
  return jsonResp(out);
}

async function handleInvoiceDetail(invoiceId, auth, env) {
  const resp = await sbGet(env,
    'qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,created_at,qbo_customer_map!inner(reseller_id)' +
    '&id=eq.' + encodeURIComponent(invoiceId) +
    '&qbo_customer_map.reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&limit=1'
  );
  if (!resp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const rows = await resp.json();
  if (!Array.isArray(rows) || rows.length === 0) return notFound();
  const inv = rows[0];

  const breakdown = await computeBillingBreakdown(env, {
    resellerId: auth.resellerId,
    start: inv.week_start,
    end: inv.week_end,
  });

  return jsonResp({
    invoice: {
      id: inv.id,
      week_start: inv.week_start,
      week_end: inv.week_end,
      as_billed_sim_count: inv.sim_count,
      as_billed_total: inv.total,
      status: inv.status,
      paid_at: inv.paid_at,
      created_at: inv.created_at,
    },
    breakdown: {
      days: breakdown.days,
      daily_rate: breakdown.daily_rate,
      block_rate: breakdown.block_rate,
      note: 'Reconstructed from current SMS records. The invoiced total above is what you were billed; if SMS data was backfilled or rotation history changed after invoicing, individual day counts may differ slightly from what was billed.',
    },
  });
}

async function handleSimLifetime(simId, auth, env) {
  const ownResp = await sbGet(env,
    'reseller_sims?select=sim_id,active,created_at,sims(iccid,vendor,msisdn,status,activated_at,rotation_interval_hours)' +
    '&reseller_id=eq.' + encodeURIComponent(auth.resellerId) +
    '&sim_id=eq.' + encodeURIComponent(simId) +
    '&limit=1'
  );
  // Note: vendor is fetched for billing-block calc below; the API only exposes derived carrier.
  if (!ownResp.ok) return jsonResp({ error: 'lookup failed' }, 500);
  const ownRows = await ownResp.json();
  if (!Array.isArray(ownRows) || ownRows.length === 0) return notFound();
  const rs = ownRows[0];
  const assignedAt = rs.created_at;
  const assignedDate = assignedAt ? assignedAt.slice(0, 10) : null;
  const sim = rs.sims || {};
  const vendor = sim.vendor;
  const intervalH = sim.rotation_interval_hours || 48;

  const dailyResp = await sbGet(env,
    'sim_sms_daily?select=est_date,sms_count&sim_id=eq.' + encodeURIComponent(simId) +
    (assignedDate ? '&est_date=gte.' + assignedDate : '') +
    '&order=est_date.asc&limit=10000'
  );
  const dailyRows = dailyResp.ok ? await dailyResp.json() : [];
  const totalSms = (Array.isArray(dailyRows) ? dailyRows : []).reduce((s, d) => s + (d.sms_count || 0), 0);
  const activeDays = (Array.isArray(dailyRows) ? dailyRows : []).filter(d => (d.sms_count || 0) > 0).length;
  const smsDaysSet = new Set((Array.isArray(dailyRows) ? dailyRows : []).filter(d => (d.sms_count || 0) > 0).map(d => d.est_date));

  let billableUnits = activeDays;
  let unitLabel = 'SMS-days';
  if (vendor === 'teltik') {
    unitLabel = 'rotation blocks';
    const rotResp = await sbGetAll(env,
      'sim_numbers?select=valid_from&sim_id=eq.' + encodeURIComponent(simId) +
      (assignedAt ? '&valid_from=gte.' + encodeURIComponent(assignedAt) : '') +
      '&order=valid_from.asc'
    );
    const rotations = (Array.isArray(rotResp) ? rotResp : []).map(r => new Date(r.valid_from));
    let blocks = 0;
    const intervalMs = intervalH * 3600 * 1000;
    for (let i = 0; i < rotations.length; i++) {
      const rotStart = rotations[i];
      const rotNext = rotations[i + 1];
      const blockEnd = new Date(Math.min(
        rotStart.getTime() + intervalMs,
        rotNext ? rotNext.getTime() : Number.POSITIVE_INFINITY
      ));
      const startEst = estDateFromDate(rotStart);
      const endEstInclusive = estDateFromDate(new Date(blockEnd.getTime() - 1000));
      let hasSms = false;
      let cur = startEst;
      while (cur <= endEstInclusive) {
        if (smsDaysSet.has(cur)) { hasSms = true; break; }
        const t = new Date(cur + 'T12:00:00Z');
        t.setUTCDate(t.getUTCDate() + 1);
        cur = estDateFromDate(t);
      }
      if (hasSms) blocks += 1;
    }
    billableUnits = blocks;
  }

  return jsonResp({
    sim_id: Number(simId),
    iccid: sim.iccid || null,
    carrier: vendorToCarrier(vendor),
    current_msisdn: sim.msisdn || null,
    status: sim.status || null,
    activated_at: sim.activated_at || null,
    assigned_at: assignedAt,
    currently_active: rs.active,
    total_sms_lifetime: totalSms,
    billable_units_lifetime: billableUnits,
    unit_label: unitLabel,
  });
}

function loginHtml(error) {
  const msg = error ? `<div class="text-red-400 text-sm mb-3">${error}</div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reseller Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
</head><body class="bg-slate-900 text-slate-200 min-h-screen flex items-center justify-center font-sans">
<div class="max-w-md w-full bg-slate-800 rounded-lg p-8 shadow-xl">
<h1 class="text-2xl font-semibold mb-2">Reseller Portal</h1>
<p class="text-slate-400 text-sm mb-6">Sign in with the access link emailed to you. The link sets a session cookie valid for 30 days.</p>
${msg}
<div class="text-slate-500 text-xs">If you've lost your link, contact your account manager to reissue it.</div>
</div></body></html>`;
}

function portalHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Reseller Portal</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}</style>
</head><body class="bg-slate-900 text-slate-200 min-h-screen">
<div class="max-w-7xl mx-auto px-6 py-6">
  <header class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-semibold" id="reseller-name">Reseller Portal</h1>
      <p class="text-slate-400 text-sm">Read-only view of your SIM activity and past invoices.</p>
    </div>
    <div class="text-xs text-slate-500" id="reseller-meta"></div>
  </header>

  <nav class="border-b border-slate-700 mb-6 flex gap-1">
    <button data-tab="sims" class="tab-btn px-4 py-2 text-sm font-medium border-b-2 border-cyan-400 text-cyan-300">SIMs</button>
    <button data-tab="invoices" class="tab-btn px-4 py-2 text-sm font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200">Invoices</button>
  </nav>

  <section id="tab-sims" class="tab-panel">
    <div class="mb-3 flex items-center gap-3">
      <input id="sim-filter" type="text" placeholder="Filter by ICCID or MSISDN" class="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm w-72">
      <span class="text-slate-500 text-xs" id="sim-summary"></span>
    </div>
    <div id="sims-active"></div>
    <h3 class="mt-8 mb-2 text-slate-400 text-sm font-medium uppercase tracking-wide">Previously assigned</h3>
    <div id="sims-historical"></div>
  </section>

  <section id="tab-invoices" class="tab-panel hidden">
    <div id="invoices-list"></div>
  </section>
</div>

<div id="modal-root" class="fixed inset-0 bg-black/60 hidden items-center justify-center z-50 p-4"></div>

<script>
const fmtUsd = n => '$' + Number(n || 0).toFixed(2);
const fmtDate = s => s ? new Date(s).toISOString().slice(0,10) : '';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let allSims = [];

function showModal(html) {
  const r = document.getElementById('modal-root');
  r.innerHTML = '<div class="bg-slate-800 rounded-lg max-w-4xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl">' +
    '<div class="flex justify-end mb-2"><button onclick="closeModal()" class="text-slate-400 hover:text-slate-100 text-xl leading-none">×</button></div>' +
    html + '</div>';
  r.classList.remove('hidden');
  r.classList.add('flex');
}
function closeModal() {
  const r = document.getElementById('modal-root');
  r.classList.add('hidden');
  r.classList.remove('flex');
  r.innerHTML = '';
}
document.getElementById('modal-root').addEventListener('click', e => { if (e.target.id === 'modal-root') closeModal(); });

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.dataset.tab === name) {
      b.classList.add('border-cyan-400','text-cyan-300');
      b.classList.remove('border-transparent','text-slate-400');
    } else {
      b.classList.remove('border-cyan-400','text-cyan-300');
      b.classList.add('border-transparent','text-slate-400');
    }
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  if (name === 'invoices') loadInvoices();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

async function api(path) {
  const r = await fetch(path, { credentials: 'include' });
  if (r.status === 401) { window.location.href = '/'; return null; }
  if (!r.ok) throw new Error('API ' + r.status);
  return r.json();
}

function renderSimTable(sims, container) {
  if (!sims.length) { container.innerHTML = '<div class="text-slate-500 text-sm py-4">None</div>'; return; }
  const rows = sims.map(s => '<tr class="hover:bg-slate-800 cursor-pointer" onclick="openLifetime(' + s.sim_id + ')">' +
    '<td class="px-3 py-2 text-slate-300 font-mono text-xs">' + esc(s.iccid) + '</td>' +
    '<td class="px-3 py-2 text-slate-300">' + esc(s.carrier || '—') + '</td>' +
    '<td class="px-3 py-2 text-slate-300 font-mono">' + esc(s.msisdn || '—') + '</td>' +
    '<td class="px-3 py-2 text-slate-300">' + esc(s.status) + '</td>' +
    '<td class="px-3 py-2 text-slate-400 text-xs">' + fmtDate(s.assigned_at) + '</td>' +
    '</tr>').join('');
  container.innerHTML =
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-800 text-slate-400 text-xs uppercase">' +
    '<tr><th class="px-3 py-2 text-left">ICCID</th><th class="px-3 py-2 text-left">Carrier</th><th class="px-3 py-2 text-left">MSISDN</th><th class="px-3 py-2 text-left">Status</th><th class="px-3 py-2 text-left">Assigned</th></tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + rows + '</tbody></table></div>';
}

function applySimFilter() {
  const q = document.getElementById('sim-filter').value.trim().toLowerCase();
  const filt = q ? allSims.filter(s => (s.iccid||'').toLowerCase().includes(q) || (s.msisdn||'').toLowerCase().includes(q)) : allSims;
  const active = filt.filter(s => s.active);
  const hist = filt.filter(s => !s.active);
  renderSimTable(active, document.getElementById('sims-active'));
  renderSimTable(hist, document.getElementById('sims-historical'));
  document.getElementById('sim-summary').textContent = active.length + ' active, ' + hist.length + ' previously assigned';
}

async function loadSims() {
  const sims = await api('/api/sims');
  if (!sims) return;
  allSims = sims;
  applySimFilter();
}
document.getElementById('sim-filter').addEventListener('input', applySimFilter);

async function loadInvoices() {
  const invoices = await api('/api/invoices');
  if (!invoices) return;
  const list = document.getElementById('invoices-list');
  if (!invoices.length) { list.innerHTML = '<div class="text-slate-500 text-sm">No invoices yet.</div>'; return; }
  const rows = invoices.map(inv => {
    const isPaid = inv.status === 'paid';
    const badge = isPaid
      ? '<span class="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300">Paid' + (inv.paid_at ? ' ' + fmtDate(inv.paid_at) : '') + '</span>'
      : '<span class="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-600/40 text-slate-300">Unpaid</span>';
    return '<tr class="hover:bg-slate-800 cursor-pointer" onclick="openInvoice(' + inv.id + ')">' +
      '<td class="px-3 py-2 text-slate-300">' + esc(inv.week_start) + ' — ' + esc(inv.week_end) + '</td>' +
      '<td class="px-3 py-2 text-slate-300 text-right">' + esc(inv.sim_count) + '</td>' +
      '<td class="px-3 py-2 text-slate-100 font-medium text-right">' + fmtUsd(inv.total) + '</td>' +
      '<td class="px-3 py-2">' + badge + '</td>' +
      '<td class="px-3 py-2 text-cyan-400 text-xs">View →</td>' +
      '</tr>';
  }).join('');
  list.innerHTML =
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-800 text-slate-400 text-xs uppercase">' +
    '<tr><th class="px-3 py-2 text-left">Period</th><th class="px-3 py-2 text-right">Billable units</th><th class="px-3 py-2 text-right">Invoiced</th><th class="px-3 py-2 text-left">Status</th><th class="px-3 py-2"></th></tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + rows + '</tbody></table></div>';
}

async function openInvoice(id) {
  showModal('<div class="text-slate-400">Loading…</div>');
  const data = await api('/api/invoices/' + id);
  if (!data) return;
  const inv = data.invoice;
  const days = data.breakdown.days || [];
  const dayRows = days.map(d => '<tr><td class="px-3 py-2 text-slate-300">' + esc(d.date) + '</td>' +
    '<td class="px-3 py-2 text-slate-300 text-right">' + esc(d.sim_count) + '</td>' +
    '<td class="px-3 py-2 text-slate-300 text-right">' + fmtUsd(d.rate) + '</td>' +
    '<td class="px-3 py-2 text-slate-100 text-right">' + fmtUsd(d.amount) + '</td></tr>').join('');
  const isPaid = inv.status === 'paid';
  const badge = isPaid
    ? '<span class="px-2 py-1 text-xs font-medium rounded-full bg-emerald-500/20 text-emerald-300 ml-2 align-middle">Paid' + (inv.paid_at ? ' ' + fmtDate(inv.paid_at) : '') + '</span>'
    : '<span class="px-2 py-1 text-xs font-medium rounded-full bg-slate-600/40 text-slate-300 ml-2 align-middle">Unpaid</span>';
  showModal(
    '<h2 class="text-lg font-semibold mb-1">Invoice ' + esc(inv.week_start) + ' — ' + esc(inv.week_end) + badge + '</h2>' +
    '<div class="mb-4 flex gap-6 text-sm">' +
      '<div><div class="text-slate-500">Invoiced amount</div><div class="text-2xl font-semibold text-cyan-300">' + fmtUsd(inv.as_billed_total) + '</div></div>' +
      '<div><div class="text-slate-500">Billable units</div><div class="text-2xl font-semibold text-slate-200">' + esc(inv.as_billed_sim_count) + '</div></div>' +
    '</div>' +
    '<div class="text-xs text-slate-400 mb-3 italic">' + esc(data.breakdown.note) + '</div>' +
    '<div class="overflow-x-auto rounded-lg border border-slate-700"><table class="w-full text-sm"><thead class="bg-slate-900 text-slate-400 text-xs uppercase">' +
      '<tr><th class="px-3 py-2 text-left">Date (EST)</th><th class="px-3 py-2 text-right">Units</th><th class="px-3 py-2 text-right">Rate</th><th class="px-3 py-2 text-right">Amount</th></tr>' +
    '</thead><tbody class="divide-y divide-slate-800">' + (dayRows || '<tr><td colspan="4" class="px-3 py-4 text-slate-500 text-center">No billable activity in this period.</td></tr>') + '</tbody></table></div>'
  );
}

async function openLifetime(simId) {
  showModal('<div class="text-slate-400">Loading…</div>');
  const d = await api('/api/sims/' + simId + '/lifetime');
  if (!d) return;
  showModal(
    '<h2 class="text-lg font-semibold mb-1">SIM ' + esc(d.iccid) + '</h2>' +
    '<div class="text-slate-500 text-xs mb-4">Carrier ' + esc(d.carrier || '—') + ' · Status ' + esc(d.status) + ' · ' + (d.currently_active ? 'Currently active' : 'Previously assigned') + '</div>' +
    '<div class="grid grid-cols-2 gap-4 mb-4">' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Total SMS lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.total_sms_lifetime) + '</div></div>' +
      '<div class="bg-slate-900 rounded p-4"><div class="text-slate-500 text-xs uppercase mb-1">Billable ' + esc(d.unit_label) + ' lifetime</div><div class="text-2xl font-semibold text-cyan-300">' + esc(d.billable_units_lifetime) + '</div></div>' +
    '</div>' +
    '<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">' +
      '<dt class="text-slate-500">MSISDN (current)</dt><dd class="text-slate-200 font-mono">' + esc(d.current_msisdn || '—') + '</dd>' +
      '<dt class="text-slate-500">Activated</dt><dd class="text-slate-200">' + fmtDate(d.activated_at) + '</dd>' +
      '<dt class="text-slate-500">Assigned to you</dt><dd class="text-slate-200">' + fmtDate(d.assigned_at) + '</dd>' +
    '</dl>' +
    '<div class="text-xs text-slate-500 mt-4 italic">Lifetime totals are computed from the date this SIM was assigned to your account onward.</div>'
  );
}

(async () => {
  const me = await api('/api/me');
  if (!me) return;
  document.getElementById('reseller-name').textContent = me.name + ' — Portal';
  document.getElementById('reseller-meta').textContent = 'Account #' + me.reseller_id;
  loadSims();
})();
</script>
</body></html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }

    if (url.pathname === '/login') {
      return handleLogin(url, env);
    }

    const auth = await authenticate(request, env);

    // API routes — must be authenticated
    if (url.pathname.startsWith('/api/')) {
      if (!auth) return unauthorized();
      if (url.pathname === '/api/me') return handleMe(auth, env);
      if (url.pathname === '/api/sims') return handleSims(auth, env);
      if (url.pathname === '/api/invoices') return handleInvoices(auth, env);
      let m;
      if ((m = url.pathname.match(/^\/api\/invoices\/(\d+)$/))) return handleInvoiceDetail(m[1], auth, env);
      if ((m = url.pathname.match(/^\/api\/sims\/(\d+)\/lifetime$/))) return handleSimLifetime(m[1], auth, env);
      return notFound();
    }

    // HTML routes
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!auth) {
        return new Response(loginHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response(portalHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response('not found', { status: 404 });
  },
};
