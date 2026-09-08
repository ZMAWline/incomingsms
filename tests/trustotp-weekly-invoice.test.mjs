// Tests for the TrustOTP weekly QuickBooks invoice automation.
// Run with: node --test tests/trustotp-weekly-invoice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextUninvoicedWeek, runTrustotpWeeklyInvoice } from '../src/shared/trustotp-weekly-invoice.mjs';

function json(obj, ok = true) {
  return new Response(JSON.stringify(obj), { status: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
}

// Build an env whose computeBillingBreakdown returns deterministic days, and whose
// fetch is a controllable fake for Composio + Supabase.
function makeEnv({ days, existingQbo = null, existingLocal = false, totalSimDays = 14, totalAmount = 21840.0, mappingId = 3 } = {}) {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const u = String(url);

    // --- Composio tool_router session execute (MUST come before session create check) ---
    if (u.includes('/tool_router/session/') && u.includes('/execute')) {
      const b = opts.body ? JSON.parse(opts.body) : {};
      const slug = b.tool_slug;
      if (slug === 'QUICKBOOKS_QUERY_ENTITIES') {
        return json({ data: { QueryResponse: { Invoice: existingQbo ? [existingQbo] : [] } } });
      }
      if (slug === 'QUICKBOOKS_CREATE_INVOICE') {
        return json({ data: { Invoice: { Id: '9999', DocNumber: b.arguments.doc_number, TotalAmt: totalAmount } } });
      }
      if (slug === 'QUICKBOOKS_READ_INVOICE') {
        return json({ data: { Invoice: { Id: '9999', DocNumber: 'INV-20260821-20260827', CustomerRef: { name: 'HYPPE TECH', value: '39' }, TxnDate: '2026-08-27', Line: [{}, {}], TotalAmt: totalAmount, Balance: totalAmount, EmailStatus: 'NotSet', EInvoiceStatus: 'NotSent' } } });
      }
      return json({ data: {} });
    }
    // --- Composio tool_router session create (exact URL match) ---
    if (u === 'https://backend.composio.dev/api/v3.1/tool_router/session' && (!opts.method || opts.method === 'POST')) {
      return json({ id: 'trs_test' });
    }
    if (u.includes('/rest/v1/qbo_invoices')) {
      if (opts.method === 'POST') return new Response(null, { status: 201 });
      return json(existingLocal ? [{ id: 5, qbo_invoice_id: '1202', status: 'created' }] : [], true);
    }
    return json({ error: 'unexpected ' + u }, true);
  };
  const env = {
    COMPOSIO_API_KEY: 'uak_test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'svc_test',
    SUPABASE_ANON_KEY: 'anon_test',
    computeBillingBreakdown: async () => ({ mapping: { id: mappingId }, days, total_sim_days: totalSimDays, total_amount: totalAmount }),
  };
  return { env, calls, fakeFetch };
}

const SAMPLE_DAYS = [
  { date: '2026-08-21', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-22', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-23', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-24', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-25', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-26', sim_count: 2, rate: 5.0, amount: 10.0 },
  { date: '2026-08-27', sim_count: 2, rate: 5.0, amount: 10.0 },
];

test('computeNextUninvoicedWeek: derives next week after latestEnd', () => {
  const r = computeNextUninvoicedWeek('2026-08-20');
  assert.equal(r.start, '2026-08-21');
  assert.equal(r.end, '2026-08-27');
});

test('computeNextUninvoicedWeek: null latestEnd returns a valid 7-day week', () => {
  const r = computeNextUninvoicedWeek(null);
  assert.match(r.start, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.end, /^\d{4}-\d{2}-\d{2}$/);
  const s = new Date(r.start + 'T00:00:00Z');
  const e = new Date(r.end + 'T00:00:00Z');
  assert.equal((e - s) / 86400000, 6);
});

test('dry_run: returns lines and does NOT call QUICKBOOKS_CREATE_INVOICE', async () => {
  const { env, calls, fakeFetch } = makeEnv({ days: SAMPLE_DAYS });
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const r = await runTrustotpWeeklyInvoice(env, { dry_run: true, latestEnd: '2026-08-20' });
    assert.ok(r.dry_run);
    assert.equal(r.docNumber, 'INV-20260821-20260827');
    assert.equal(r.totalSimDays, 14);
    assert.equal(r.lineCount, 7);
    const createCall = calls.find((c) => c.body && c.body.tool_slug === 'QUICKBOOKS_CREATE_INVOICE');
    assert.equal(createCall, undefined, 'create must not be called in dry_run');
  } finally {
    globalThis.fetch = orig;
  }
});

test('duplicate guard: skips when QuickBooks already has the DocNumber', async () => {
  const { env, calls, fakeFetch } = makeEnv({ days: SAMPLE_DAYS, existingQbo: { Id: '1202', DocNumber: 'INV-20260821-20260827', TotalAmt: 21840 } });
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const r = await runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-08-20' });
    assert.ok(r.skipped);
    assert.equal(r.reason, 'duplicate_docnumber_qbo');
    const createCall = calls.find((c) => c.body && c.body.tool_slug === 'QUICKBOOKS_CREATE_INVOICE');
    assert.equal(createCall, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('duplicate guard: skips when local qbo_invoices already has the week', async () => {
  const { env, calls, fakeFetch } = makeEnv({ days: SAMPLE_DAYS, existingLocal: true });
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const r = await runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-08-20' });
    assert.ok(r.skipped);
    assert.equal(r.reason, 'duplicate_local');
    const createCall = calls.find((c) => c.body && c.body.tool_slug === 'QUICKBOOKS_CREATE_INVOICE');
    assert.equal(createCall, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('created invoice is UNSENT (no bill_email / online payment / send)', async () => {
  const { env, calls, fakeFetch } = makeEnv({ days: SAMPLE_DAYS });
  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const r = await runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-08-20' });
    assert.ok(r.created);
    assert.ok(r.readback);
    const createCall = calls.find((c) => c.body && c.body.tool_slug === 'QUICKBOOKS_CREATE_INVOICE');
    assert.ok(createCall, 'create must be called when not duplicate');
    const args = createCall.body.arguments;
    assert.equal(args.bill_email, undefined, 'must not set bill_email');
    assert.equal(args.allow_ipn_payment, false, 'must disable IPN payment');
    assert.equal(args.allow_online_payment, false, 'must disable online payment/eInvoicing');
    assert.equal(args.allow_online_ach_payment, false, 'must disable ACH payment');
    assert.equal(args.allow_online_credit_card_payment, false, 'must disable credit card payment');
    assert.equal(args.send, undefined, 'must not send');
    assert.equal(args.customer_id, '39');
    assert.equal(args.lines.length, 7);
    assert.equal(args.lines[0].SalesItemLineDetail.ItemRef.value, '7');
    // local record status must be 'created', never 'sent'
    const insert = calls.find((c) => String(c.url).includes('/rest/v1/qbo_invoices') && c.method === 'POST');
    assert.ok(insert, 'must record in qbo_invoices');
    assert.equal(insert.body.status, 'created');
  } finally {
    globalThis.fetch = orig;
  }
});

test('no billable sim-days yields a skip (not a create)', async () => {
  const { env, calls } = makeEnv({ days: [], totalSimDays: 0, totalAmount: 0 });
  const orig = globalThis.fetch;
  globalThis.fetch = env.fakeFetch;
  try {
    const r = await runTrustotpWeeklyInvoice(env, { dry_run: false, latestEnd: '2026-08-20' });
    assert.ok(r.skipped);
    assert.equal(r.reason, 'no_billable_sim_days');
  } finally {
    globalThis.fetch = orig;
  }
});

test('Friday cron string is present in dashboard wrangler.toml', async () => {
  const fs = await import('node:fs');
  const toml = fs.readFileSync(new URL('../src/dashboard/wrangler.toml', import.meta.url), 'utf8');
  assert.ok(toml.includes('"0 17 * * 5"'), 'wrangler.toml must include the Friday 17:00 UTC cron');
});

test('dashboard wires the Friday cron to the TrustOTP invoice runner', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ runTrustotpWeeklyInvoice \} from ['"]\.\.\/shared\/trustotp-weekly-invoice\.mjs['"]/);
  assert.match(src, /event\.cron === '0 17 \* \* 5'/);
  assert.match(src, /runScheduledTrustotpInvoice\(env\)/);
});

test('dashboard no longer binds the retired QuickBooks worker', async () => {
  const fs = await import('node:fs');
  const toml = fs.readFileSync(new URL('../src/dashboard/wrangler.toml', import.meta.url), 'utf8');
  const src = fs.readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(toml, /binding = "QUICKBOOKS"/);
  assert.doesNotMatch(src, /env\.QUICKBOOKS|handleQboRoute/);
});

test('retired QuickBooks worker no longer stores OAuth tokens', async () => {
  const fs = await import('node:fs');
  const quickbooksToml = fs.readFileSync(new URL('../src/quickbooks/wrangler.toml', import.meta.url), 'utf8');
  const quickbooksSrc = fs.readFileSync(new URL('../src/quickbooks/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(quickbooksToml, /QBO_TOKENS/);
  assert.doesNotMatch(quickbooksSrc, /QBO_TOKENS/);
  assert.match(quickbooksSrc, /legacy_quickbooks_worker_retired/);
});
