// Guard tests for importTeltikLines: Teltik HOSTS SIMs whose service provider
// is Atomic/Wing/etc., so its all-lines API can return foreign ICCIDs. Import
// must never write to an existing sims row (SIM #639 clobber) and must not
// auto-create AT&T-looking unknowns as teltik/tmobile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// package.json is "type":"commonjs", so node would parse the worker's .js as
// CJS and the named ESM exports fail to resolve. The worker file is
// self-contained (zero imports), so load it as ESM via a data: URL instead.
const src = await readFile(new URL('../src/teltik-worker/index.js', import.meta.url), 'utf8');
const { importTeltikLines, looksLikeAttIccid } =
  await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const ENV = {
  TELTIK_API_KEY: 'fake',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake',
};

const TELTIK_ICCID = '8901260012345678901';
const ATT_ICCID = '8901410312345678901';

// Routes fetch by URL. `existingSim` = row returned by the all-sims precompute
// (id/iccid/vendor); `lineIccid` = the ICCID Teltik's all-lines returns.
function mockFetch(existingSim, lineIccid, writes) {
  return async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/v1/all-lines')) {
      return new Response(JSON.stringify([{ mdn: '19175550100', iccid: lineIccid }]), { status: 200 });
    }
    if (u.includes('/rest/v1/sims')) {
      if (method === 'GET') {
        // Post-insert id lookup vs the all-sims precompute.
        if (u.includes('iccid=eq.')) return new Response(JSON.stringify([{ id: 99 }]), { status: 200 });
        return new Response(JSON.stringify(existingSim ? [existingSim] : []), { status: 200 });
      }
      writes.push({ table: 'sims', method, body: init.body });
      return new Response('[]', { status: 201 });
    }
    if (u.includes('/rest/v1/sim_numbers')) {
      if (method === 'GET') return new Response('[]', { status: 200 });
      writes.push({ table: 'sim_numbers', method, body: init.body });
      return new Response('[]', { status: 201 });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  };
}

async function runImport(existingSim, lineIccid) {
  const writes = [];
  const orig = globalThis.fetch;
  globalThis.fetch = mockFetch(existingSim, lineIccid, writes);
  try {
    const result = await importTeltikLines(ENV);
    return { result, writes };
  } finally {
    globalThis.fetch = orig;
  }
}

test('looksLikeAttIccid flags 890141 prefix only', () => {
  assert.equal(looksLikeAttIccid(ATT_ICCID), true);
  assert.equal(looksLikeAttIccid(TELTIK_ICCID), false);
  assert.equal(looksLikeAttIccid(''), false);
});

test('existing foreign-vendor SIM: no writes at all (no #639 clobber)', async () => {
  const { result, writes } = await runImport({ id: 639, iccid: ATT_ICCID, vendor: 'atomic' }, ATT_ICCID);
  assert.equal(result.skipped_foreign_vendor, 1);
  assert.equal(result.imported, 0);
  assert.deepEqual(writes, []);
});

test('existing teltik SIM: sims row not upserted, sim_numbers synced', async () => {
  const { result, writes } = await runImport({ id: 7, iccid: TELTIK_ICCID, vendor: 'teltik' }, TELTIK_ICCID);
  assert.equal(result.updated, 1);
  // Only allowed sims write is the INC-5 msisdn-lockstep PATCH — never an
  // insert/upsert that could touch vendor/carrier/gateway fields.
  const simsWrites = writes.filter(w => w.table === 'sims');
  assert.ok(simsWrites.every(w => w.method === 'PATCH' && Object.keys(JSON.parse(w.body)).join(',') === 'msisdn'), JSON.stringify(simsWrites));
  assert.equal(writes.filter(w => w.table === 'sim_numbers' && w.method === 'POST').length, 1);
});

test('unknown AT&T-looking ICCID: skipped, not created as teltik', async () => {
  const { result, writes } = await runImport(null, ATT_ICCID);
  assert.equal(result.skipped_att_unknown, 1);
  assert.equal(result.imported, 0);
  assert.deepEqual(writes, []);
});

test('unknown teltik-prefix ICCID: created via plain insert, not upsert', async () => {
  const { result, writes } = await runImport(null, TELTIK_ICCID);
  assert.equal(result.imported, 1);
  const simsWrites = writes.filter(w => w.table === 'sims' && w.method === 'POST');
  assert.equal(simsWrites.length, 1);
  const row = JSON.parse(simsWrites[0].body)[0];
  assert.equal(row.vendor, 'teltik');
  assert.equal(row.carrier, 'tmobile');
});
