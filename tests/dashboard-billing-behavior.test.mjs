import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/load-worker.mjs';

const worker = (await loadModule('src/dashboard/index.js')).default;
const env = {
  SUPABASE_URL: 'https://database.test', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  DASHBOARD_BREAK_GLASS: 'on', DASHBOARD_AUTH: 'test:password',
};
const realFetch = globalThis.fetch;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
let calls, respond;
beforeEach(() => {
  calls = [];
  respond = () => { throw new Error('Unexpected database request'); };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: new URL(String(url)), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, init };
    if (call.url.pathname === '/rest/v1/dashboard_audit_log') return new Response(null, { status: 204 });
    assert.equal(call.url.origin, env.SUPABASE_URL, 'test must never contact a carrier or live database');
    calls.push(call);
    return respond(call);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function request(path, { method = 'GET', body, authenticated = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated) headers.Authorization = 'Basic ' + btoa(env.DASHBOARD_AUTH);
  const pending = [];
  const response = await worker.fetch(new Request('https://dashboard.test' + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  return response;
}

test('billing routes preserve authentication after extraction', async () => {
  for (const path of ['/api/qbo-invoices', '/api/plan-rates', '/api/billing-ledger']) {
    assert.equal((await request(path, { authenticated: false })).status, 401);
  }
  assert.equal(calls.length, 0);
});

test('invoice history uses the real route and returns the customer name', async () => {
  respond = () => json([{ id: 7, total: 42, qbo_customer_map: { qbo_display_name: 'Acme' } }]);
  const response = await request('/api/qbo-invoices');
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].customer_name, 'Acme');
  assert.equal(calls[0].url.pathname, '/rest/v1/qbo_invoices');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('saved invoice download preserves the saved daily amounts and CSV escaping', async () => {
  respond = () => json([{
    id: 7, week_start: '2026-09-25', week_end: '2026-10-01', total: 3.55, sim_count: 3,
    qbo_customer_map: { qbo_display_name: 'Acme, "East"', daily_rate: 99 },
    daily_breakdown: [
      { date: '2026-09-25', sim_count: 2, rate: 1, amount: 2 },
      { date: '2026-09-26', sim_count: 1, rate: 1.55, amount: 1.55 },
    ],
  }]);
  const response = await request('/api/billing/download-invoice?invoice_id=7');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/csv');
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="invoiceAcmeEast2026092520261001.csv"');
  const csv = await response.text();
  assert.match(csv, /"Acme, ""East"""/);
  assert.match(csv, /"2","1.00","2.00"/);
  assert.match(csv, /"1","1.55","1.55"/);
  assert.doesNotMatch(csv, /99\.00/);
  assert.equal(calls.length, 1);
});

test('invalid invoice dates and IDs are rejected before querying', async () => {
  for (const query of [
    'invoice_id=1%26select=*',
    'reseller_id=1&start=2026-02-30&end=2026-03-01',
    'reseller_id=1&start=2026-10-02&end=2026-10-01',
  ]) assert.equal((await request('/api/billing/download-invoice?' + query)).status, 400);
  assert.equal(calls.length, 0);
});

test('a failed mapping delete is an upstream error, never success', async () => {
  respond = () => json({ message: 'database unavailable' }, 503);
  const response = await request('/api/qbo-mappings?id=7', { method: 'DELETE' });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /503/);
  assert.equal(calls[0].method, 'DELETE');
});

test('a new invoice is not downloaded when its history record fails to save', async () => {
  respond = call => {
    switch (call.url.pathname) {
      case '/rest/v1/resellers': return json([{ id: 1, name: 'Acme' }]);
      case '/rest/v1/qbo_customer_map': return json([{ id: 7, qbo_display_name: 'Acme', daily_rate: 1.55 }]);
      case '/rest/v1/reseller_sims': return json([{ sim_id: 1, sims: { vendor: 'atomic', sim_sms_daily: [{ est_date: '2026-10-01', sms_count: 1 }] } }]);
      case '/rest/v1/reseller_rates': return json([]);
      case '/rest/v1/qbo_invoices': return json({ message: 'write failed' }, 503);
      default: throw new Error('Unexpected request: ' + call.url);
    }
  };
  const response = await request('/api/billing/download-invoice?reseller_id=1&start=2026-10-01&end=2026-10-01');
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-type'), 'application/json');
  const save = calls.find(c => c.url.pathname === '/rest/v1/qbo_invoices');
  assert.equal(save.method, 'POST');
  assert.equal(save.body.total, 1.55);
  assert.equal(save.body.daily_breakdown[0].amount, 1.55);
});

test('valid zero-priced plan saves through the real pricing route', async () => {
  respond = call => {
    if (call.method === 'GET') return json([]);
    assert.equal(call.init.headers.Prefer, 'return=representation');
    return json([{ id: 8, ...call.body }]);
  };
  const response = await request('/api/plan-rates', { method: 'POST', body: {
    vendor: 'teltik', plan_name: 'Trial', rate: 0, effective_from: '2026-10-01',
  } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).rate, 0);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'POST']);
});

test('rate update checks the database result before returning success', async () => {
  respond = () => json({ message: 'constraint violation' }, 409);
  const response = await request('/api/plan-rates/7', { method: 'PATCH', body: { rate: 1.55 } });
  assert.equal(response.status, 502);
  assert.deepEqual(calls[0].body, { rate: 1.55 });
});

test('failed closure of an old rate stops creation of a replacement', async () => {
  respond = call => call.method === 'GET'
    ? json([{ id: 4, effective_from: '2026-09-01' }])
    : json({ message: 'write failed' }, 503);
  const response = await request('/api/reseller-rates', { method: 'POST', body: {
    reseller_id: 1, vendor: 'teltik', effective_from: '2026-10-01',
    tiers: [{ min_count: 0, max_count: null, rate: 1.55 }],
  } });
  assert.equal(response.status, 502);
  assert.deepEqual(calls.map(c => c.method), ['GET', 'PATCH']);
});

test('invalid prices and overlapping tiers never reach the database', async () => {
  for (const rate of ['1.5garbage', 'Infinity', -1, '', null]) {
    assert.equal((await request('/api/plan-rates', { method: 'POST', body: { vendor: 'teltik', plan_name: 'Test', rate } })).status, 400);
  }
  const response = await request('/api/reseller-rates', { method: 'POST', body: {
    reseller_id: 1, vendor: 'teltik', tiers: [
      { min_count: 0, max_count: 100, rate: 1.55 },
      { min_count: 100, max_count: null, rate: 1 },
    ],
  } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /overlap/);
  assert.equal(calls.length, 0);
});

test('ledger regeneration reports a rejected upsert instead of rows saved', async () => {
  respond = call => {
    if (call.url.pathname.endsWith('/plan_rates')) return json([{ vendor: 'teltik', rate: 20, plan_name: 'Test' }]);
    if (call.url.pathname.endsWith('/sims')) return json([{ id: 1, iccid: '8901', activated_at: new Date().toISOString().slice(0, 10), status: 'active' }]);
    if (call.url.pathname.endsWith('/billing_ledger') && call.method === 'POST') return json({ message: 'write failed' }, 503);
    throw new Error('Unexpected request: ' + call.url);
  };
  const response = await request('/api/billing-ledger/regenerate?vendor=teltik', { method: 'POST' });
  assert.equal(response.status, 502);
  assert.equal(calls.at(-1).method, 'POST');
});

test('API typos return JSON errors instead of the app HTML', async () => {
  const response = await request('/api/does-not-exist');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
  assert.equal(calls.length, 0);
});
