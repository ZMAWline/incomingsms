// Teltik inbound-SMS matching: Teltik HOSTS foreign-vendor SIMs (Atomic etc.)
// whose payload MDN can be stale, so the webhook must prefer the ICCID carried
// in the alias/nickname (matched against sims.iccid, any vendor) and only fall
// back to the MDN → sim_numbers lookup when no usable ICCID is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// package.json is "type":"commonjs" — load the worker as ESM via data: URL
// (same trick as teltik-import-guard.test.mjs).
const src = await readFile(new URL('../src/teltik-worker/index.js', import.meta.url), 'utf8');
const { processTeltikSmsItem, extractIccidFromAlias } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake',
};

const ATOMIC_ICCID = '89014103279999999999';

// Routes fetch by URL. opts.simByIccid = row for sims?iccid=eq lookup;
// opts.simIdByMdn = sim_id for sim_numbers?e164=eq lookup; opts.webhookUrl
// enables the reseller-webhook leg. `calls` records writes + webhook posts.
function mockFetch(opts, calls) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/rest/v1/sims?')) {
      return new Response(JSON.stringify(opts.simByIccid ? [opts.simByIccid] : []), { status: 200 });
    }
    if (u.includes('/rest/v1/sim_numbers')) {
      calls.push({ kind: 'mdn_lookup', url: u });
      return new Response(JSON.stringify(opts.simIdByMdn ? [{ sim_id: opts.simIdByMdn }] : []), { status: 200 });
    }
    if (u.includes('/rest/v1/inbound_sms')) {
      if (method === 'GET') return new Response('[]', { status: 200 }); // no dupes
      calls.push({ kind: 'inbound_insert', body: JSON.parse(init.body) });
      return new Response('[]', { status: 201 });
    }
    if (u.includes('/rest/v1/reseller_sims')) {
      if (!opts.webhookUrl) return new Response('[]', { status: 200 });
      return new Response(JSON.stringify([{
        reseller_id: 5,
        resellers: { reseller_webhooks: [{ url: opts.webhookUrl, enabled: true }] },
      }]), { status: 200 });
    }
    if (u.includes('/rest/v1/webhook_deliveries')) {
      if (method === 'GET') return new Response('[]', { status: 200 }); // not yet delivered
      return new Response('[]', { status: 201 });
    }
    if (opts.webhookUrl && u.includes(opts.webhookUrl)) {
      calls.push({ kind: 'reseller_webhook', body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

async function run(payload, opts = {}) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(opts, calls);
  try {
    const res = await processTeltikSmsItem(payload, ENV);
    return { res, calls };
  } finally {
    globalThis.fetch = orig;
  }
}

test('extractIccidFromAlias: finds ICCID inside surrounding text', () => {
  assert.equal(extractIccidFromAlias(`Booth 4 - ${ATOMIC_ICCID} (atomic)`), ATOMIC_ICCID);
  assert.equal(extractIccidFromAlias('8901260012345678901'), '8901260012345678901');
});

test('extractIccidFromAlias: no false match on phone numbers or embedded runs', () => {
  assert.equal(extractIccidFromAlias('Line 9175550100'), null);          // 10-digit MDN
  assert.equal(extractIccidFromAlias('order 891234567890'), null);       // 12 digits, too short
  assert.equal(extractIccidFromAlias(`1${ATOMIC_ICCID}12345`), null);    // embedded in longer run
  assert.equal(extractIccidFromAlias(''), null);
  assert.equal(extractIccidFromAlias(null), null);
});

test('nickname ICCID matches sims.iccid even when payload MDN points elsewhere', async () => {
  const { calls } = await run(
    { destination: '19175550100', origin: '32665', message: 'FB code 123', nickname: `Atomic ${ATOMIC_ICCID}` },
    { simByIccid: { id: 42, iccid: ATOMIC_ICCID }, simIdByMdn: 777 } // 777 = stale MDN owner
  );
  const ins = calls.find(c => c.kind === 'inbound_insert');
  assert.equal(ins.body[0].sim_id, 42);
  // MDN lookup must not even run when the ICCID matched
  assert.equal(calls.some(c => c.kind === 'mdn_lookup'), false);
});

test('fallback by MDN still works when payload has no alias/nickname', async () => {
  const { calls } = await run(
    { destination: '19175550100', origin: '32665', message: 'hi' },
    { simIdByMdn: 7 }
  );
  const ins = calls.find(c => c.kind === 'inbound_insert');
  assert.equal(ins.body[0].sim_id, 7);
});

test('alias text without a valid ICCID falls back to MDN, no false match', async () => {
  const { calls } = await run(
    { destination: '19175550100', origin: '32665', message: 'hi', nickname: 'Booth 12 - 9175550100' },
    { simIdByMdn: 7 }
  );
  const ins = calls.find(c => c.kind === 'inbound_insert');
  assert.equal(ins.body[0].sim_id, 7);
});

test('reseller webhook carries resolved iccid instead of null', async () => {
  const { calls } = await run(
    { destination: '19175550100', origin: '32665', message: 'code', nickname: ATOMIC_ICCID },
    { simByIccid: { id: 42, iccid: ATOMIC_ICCID }, webhookUrl: 'https://reseller.example.com/hook' }
  );
  const hook = calls.find(c => c.kind === 'reseller_webhook');
  assert.equal(hook.body.data.iccid, ATOMIC_ICCID);
  assert.equal(hook.body.data.sim_id, 42);
});

test('unknown alias ICCID: MDN fallback used, extracted iccid still forwarded', async () => {
  const { calls } = await run(
    { destination: '19175550100', origin: '32665', message: 'code', nickname: ATOMIC_ICCID },
    { simByIccid: null, simIdByMdn: 7, webhookUrl: 'https://reseller.example.com/hook' }
  );
  const ins = calls.find(c => c.kind === 'inbound_insert');
  assert.equal(ins.body[0].sim_id, 7);
  const hook = calls.find(c => c.kind === 'reseller_webhook');
  assert.equal(hook.body.data.iccid, ATOMIC_ICCID);
});
