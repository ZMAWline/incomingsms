// The quickbooks Worker reaches QuickBooks only through the owner's Composio
// connection (Composio tool execution), and the TrustOTP weekly run relies on
// QuickBooks emailing an invoice on create: it records 'sent' only when a
// read-back says EmailSent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runTrustotpWeeklyInvoice } from '../src/shared/trustotp-weekly-invoice.mjs';

// Loaded via a data: URL import (same trick as teltik-worker-rotation-lane.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
const workerSrc = (await readFile(new URL('../src/quickbooks/index.js', import.meta.url), 'utf8'))
  .replace(/'\.\.\/shared\/([^']+)'/g, (_, f) => JSON.stringify(new URL(`../src/shared/${f}`, import.meta.url).href));
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const qbEnv = {
  COMPOSIO_API_KEY: 'uak_test', COMPOSIO_ORG_ID: 'ok_1', COMPOSIO_PROJECT_ID: 'pr_1',
  COMPOSIO_USER_ID: 'consumer-1', COMPOSIO_CONNECTED_ACCOUNT_ID: 'ca_1',
};

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
}

const ok = (data) => new Response(JSON.stringify({ successful: true, error: null, data }), { status: 200 });
const call = (path, init) => worker.fetch(new Request(`https://quickbooks${path}`, init), qbEnv);

test('invoice/create runs QUICKBOOKS_CREATE_INVOICE on the configured connected account', async () => {
  await withFetch(() => ok({ Id: '1500', DocNumber: 'INV-1', EmailStatus: 'EmailSent', TotalAmt: 10 }), async (calls) => {
    const res = await call('/invoice/create', {
      method: 'POST',
      body: JSON.stringify({
        customerId: '42', docNumber: 'INV-1', txnDate: '2026-10-01', dueDate: '2026-10-01', requestId: 'INV-1',
        customerMemo: 'memo', lineItems: [{ itemId: '7', description: '2026-09-25', quantity: 3, rate: 1.1, amount: 3.3 }],
      }),
    });
    assert.equal(res.status, 200);
    const inv = await res.json();
    assert.equal(inv.id, '1500');
    assert.equal(inv.emailStatus, 'EmailSent');

    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, 'https://backend.composio.dev/api/v3/tools/execute/QUICKBOOKS_CREATE_INVOICE');
    assert.equal(c.headers['x-user-api-key'], 'uak_test');
    assert.equal(c.headers['x-project-id'], 'pr_1');
    assert.equal(c.body.connected_account_id, 'ca_1');
    assert.equal(c.body.user_id, 'consumer-1');
    const a = c.body.arguments;
    assert.equal(a.customer_id, '42');
    assert.equal(a.requestid, 'INV-1');
    assert.equal(a.allow_online_credit_card_payment, false);
    assert.deepEqual(a.customer_memo, { value: 'memo' });
    assert.deepEqual(a.lines[0].SalesItemLineDetail, { ItemRef: { value: '7' }, UnitPrice: 1.1, Qty: 3 });
  });
});

test('a failed Composio call surfaces as a worker error, not an empty result', async () => {
  await withFetch(() => new Response(JSON.stringify({ successful: false, error: 'boom', data: {} }), { status: 200 }), async () => {
    const res = await call('/invoice/query?doc_number=INV-1');
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /QUICKBOOKS_QUERY_ENTITIES failed/);
  });
});

test('invoice read-back maps email status and delivery time; the send route is gone', async () => {
  await withFetch(() => ok({ Id: '1450', DocNumber: 'INV-2', EmailStatus: 'EmailSent', DeliveryInfo: { DeliveryTime: '2026-09-14T14:19:40-07:00' } }), async (calls) => {
    const inv = await (await call('/invoice/1450')).json();
    assert.equal(calls[0].body.arguments.invoice_id, '1450');
    assert.equal(inv.emailStatus, 'EmailSent');
    assert.equal(inv.deliveredAt, '2026-09-14T14:19:40-07:00');
  });
  const res = await call('/invoice/1450/send', { method: 'POST' });
  assert.equal(res.status, 404);
});

// ---- TrustOTP weekly run ----

function weeklyEnv(emailStatus, qboPaths, created = []) {
  return {
    SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'k',
    computeBillingBreakdown: async (_env, opts) => ({
      billing_mode: opts.billing_mode,
      mapping: { id: 1, qbo_customer_id: '42' },
      days: [
        { date: '2026-09-25', carrier: 'att', sim_count: 2, rate: 1.1, amount: 2.2 },
        { date: '2026-09-25', carrier: 'tmobile', sim_count: 3, rate: 1, amount: 3, repeat: true },
      ],
      total_sim_days: 5, total_amount: 5.2,
    }),
    QUICKBOOKS: {
      async fetch(url, init) {
        const req = new Request(url, init);
        const path = new URL(url).pathname;
        qboPaths.push(path);
        if (path === '/invoice/query') return Response.json([]);
        if (path === '/items/search') return Response.json([{ id: '7', name: 'US Business phone Rental', active: true }]);
        if (path === '/invoice/create') { created.push(await req.json()); return Response.json({ id: '1500', docNumber: 'INV-X' }); }
        if (path === '/invoice/1500') return Response.json({ id: '1500', docNumber: 'INV-X', emailStatus, deliveredAt: emailStatus === 'EmailSent' ? '2026-10-02T13:00:00-04:00' : undefined });
        return Response.json({ error: 'Not found' }, { status: 404 });
      },
    },
  };
}

function supabase(calls) {
  if (calls.at(-1).method === 'GET') return Promise.resolve(Response.json([]));
  if (calls.at(-1).method === 'POST') return Promise.resolve(Response.json([{ id: 9 }]));
  return Promise.resolve(new Response(null, { status: 204 }));
}

test('weekly run records sent only after QuickBooks reports EmailSent', async () => {
  const qboPaths = [];
  await withFetch((c) => supabase([c]), async (calls) => {
    const out = await runTrustotpWeeklyInvoice(weeklyEnv('EmailSent', qboPaths), { dry_run: false, latestEnd: '2026-09-24' });
    assert.equal(out.sent, true);
    assert.equal(out.emailStatus, 'EmailSent');
    assert.ok(!qboPaths.some((p) => p.endsWith('/send')));
    const patch = calls.find((c) => c.method === 'PATCH').body;
    assert.equal(patch.status, 'sent');
    assert.equal(patch.sent_at, '2026-10-02T13:00:00-04:00');
  });
});

test('weekly run throws and does not mark sent when QuickBooks did not email it', async () => {
  const qboPaths = [];
  await withFetch((c) => supabase([c]), async (calls) => {
    await assert.rejects(
      runTrustotpWeeklyInvoice(weeklyEnv('NotSet', qboPaths), { dry_run: false, latestEnd: '2026-09-24' }),
      /was not emailed: EmailStatus=NotSet/,
    );
    const patches = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    assert.ok(patches.every((p) => p.status !== 'sent'));
  });
});

test('weekly run bills in rental mode with carrier line descriptions', async () => {
  const qboPaths = [];
  const created = [];
  let mode;
  const env = weeklyEnv('EmailSent', qboPaths, created);
  const inner = env.computeBillingBreakdown;
  env.computeBillingBreakdown = async (e, opts) => { mode = opts.billing_mode; return inner(e, opts); };
  await withFetch((c) => supabase([c]), async () => {
    await runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-09-24' });
  });
  assert.equal(mode, 'rental');
  assert.equal(created[0].lineItems[0].description, '2026-09-25 ATT rentals');
  assert.equal(created[0].lineItems[1].description, '2026-09-25 TMOBILE repeat rentals');
});

test('weekly run refuses to invoice when a fallback rate was used', async () => {
  const env = weeklyEnv('EmailSent', []);
  const inner = env.computeBillingBreakdown;
  env.computeBillingBreakdown = async (e, opts) => ({ ...(await inner(e, opts)), rate_fallback_used: true });
  await assert.rejects(runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-09-24' }), /fallback rate/);
});
