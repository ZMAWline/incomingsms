// mdn-rotator /sim-action change_imei — Teltik-hosted SIMs must not be blocked
// with a 409 anymore. They skip the Skyline hardware write and go straight to
// the ATOMIC carrier-side swapImei call instead. Skyline-hosted SIMs keep the
// existing gateway-write path untouched. Mocks fetch and the SKYLINE_GATEWAY
// service binding; no live DB or vendor API involved. Loaded via a data: URL
// import (same trick as tests/teltik-portal.test.mjs) because package.json is
// "type":"commonjs" but index.js uses ESM syntax.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SHARED_MODULES = [
  // subscriber-sync.js uses ESM `export` syntax despite its .js extension, and
  // package.json says "type":"commonjs" — a plain file:// import makes Node's
  // loader treat it as CommonJS and fail on named-export interop. Inlining it
  // as its own data: URL sidesteps that (data: URLs load as ESM directly).
  ['../shared/subscriber-sync.js', 'src/shared/subscriber-sync.js', true],
  ['../shared/address-picker.mjs', 'src/shared/address-picker.mjs', false],
  ['../shared/persist-rental.mjs', 'src/shared/persist-rental.mjs', false],
  ['../shared/gateway-host.mjs', 'src/shared/gateway-host.mjs', false],
  ['../shared/activation-bulk.mjs', 'src/shared/activation-bulk.mjs', false],
  ['../shared/sim-swap.mjs', 'src/shared/sim-swap.mjs', false],
];

async function toDataUrl(relPath) {
  const src = await readFile(new URL('../' + relPath, import.meta.url), 'utf8');
  return 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}

let workerSrc = await readFile(new URL('../src/mdn-rotator/index.js', import.meta.url), 'utf8');
for (const [specifier, relPath, asDataUrl] of SHARED_MODULES) {
  const abs = asDataUrl ? await toDataUrl(relPath) : new URL('../' + relPath, import.meta.url).href;
  workerSrc = workerSrc.replace(`'${specifier}'`, JSON.stringify(abs));
}
const mdnRotator = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const realFetch = globalThis.fetch;

const ENV = {
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  ADMIN_RUN_SECRET: 'sekret',
  ATOMIC_USERNAME: 'ezbiz',
  ATOMIC_TOKEN: 'tok',
  ATOMIC_PIN: 'pin',
  SKYLINE_SECRET: 'sk',
};

function jsonRes(data, status = 200) {
  return { ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) };
}

function callSimAction(body, env = ENV) {
  return mdnRotator.fetch(
    new Request(`https://x/sim-action?secret=${env.ADMIN_RUN_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env
  );
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('change_imei: Teltik-hosted ATOMIC SIM skips Skyline gateway, calls ATOMIC swapImei', async () => {
  const sim = {
    id: 42, iccid: 'ICC-TELTIK', msisdn: '3322408354', vendor: 'atomic',
    gateway_host: 'teltik', gateway_id: null, port: null, status: 'active',
    imei: '111111111111111', activation_zip: '98104', sim_numbers: [{ e164: '+13322408354' }],
  };
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) {
      return jsonRes([sim]);
    }
    if (u.includes('solutionsatt-atomic.telgoo5.com')) {
      const body = JSON.parse(init.body);
      assert.equal(body.wholeSaleApi.wholeSaleRequest.requestType, 'swapImei');
      assert.equal(body.wholeSaleApi.wholeSaleRequest.MSISDN, '3322408354');
      assert.equal(body.wholeSaleApi.wholeSaleRequest.zipCode, '98104');
      assert.equal(body.wholeSaleApi.wholeSaleRequest.imei, '351756051523999');
      return jsonRes({ wholeSaleApi: { wholeSaleResponse: { requestType: 'swapImei', statusCode: '00', description: 'OK' } } });
    }
    if (u.includes('/rest/v1/carrier_api_logs')) {
      return jsonRes({}, 201);
    }
    if (u.includes('/rest/v1/sims') && init.method === 'PATCH') {
      return jsonRes([{ id: 42, imei: '351756051523999' }]);
    }
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 42, action: 'change_imei', new_imei: '351756051523999' });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.imei, '351756051523999');
  assert.equal(data.gateway_host, 'teltik');
  assert.equal(data.gateway_skipped, true);
  assert.match(data.message, /Skyline hardware update skipped/);
  assert.match(data.message, /Teltik-hosted/);
  assert.match(data.message, /ATOMIC carrier-side IMEI update.*succeeded/);
  // No Skyline gateway call should have been attempted.
  assert.ok(!calls.some((u) => u.includes('skyline')));
});

test('change_imei: Teltik-hosted, auto_imei is rejected (pool allocation is Skyline-only)', async () => {
  const sim = {
    id: 43, iccid: 'ICC-TELTIK-2', msisdn: '3322408355', vendor: 'atomic',
    gateway_host: 'teltik', gateway_id: null, port: null, status: 'active',
    imei: '111111111111112', activation_zip: '98104', sim_numbers: [{ e164: '+13322408355' }],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) return jsonRes([sim]);
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 43, action: 'change_imei', auto_imei: true });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /auto IMEI allocation/);
});

test('change_imei: Teltik-hosted, non-ATOMIC vendor has no carrier-side update wired up', async () => {
  const sim = {
    id: 44, iccid: 'ICC-TELTIK-3', msisdn: '3322408356', vendor: 'helix',
    gateway_host: 'teltik', gateway_id: null, port: null, status: 'active',
    imei: '111111111111113', activation_zip: '98104', sim_numbers: [{ e164: '+13322408356' }],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) return jsonRes([sim]);
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 44, action: 'change_imei', new_imei: '351756051523999' });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /no carrier-side IMEI update wired up/);
});

test('change_imei: Skyline-hosted SIM still writes IMEI to the Skyline gateway', async () => {
  const sim = {
    id: 45, iccid: 'ICC-SKYLINE', msisdn: '3322408357', vendor: 'atomic',
    gateway_host: 'skyline', gateway_id: 7, port: '1A', status: 'active',
    imei: '111111111111114', activation_zip: '98104', sim_numbers: [{ e164: '+13322408357' }],
  };
  let skylineSetImeiCalled = false;
  const env = {
    ...ENV,
    SKYLINE_GATEWAY: {
      fetch: async (url, init) => {
        skylineSetImeiCalled = true;
        const body = JSON.parse(init.body);
        assert.equal(body.gateway_id, 7);
        assert.equal(body.port, '1A');
        assert.equal(body.imei, '351756051523999');
        return { ok: true, text: async () => JSON.stringify({ ok: true }) };
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) return jsonRes([sim]);
    if (u.includes('/rest/v1/imei_pool') && init.method === 'PATCH') return jsonRes([]);
    if (u.includes('/rest/v1/imei_pool') && init.method === 'POST') return jsonRes([{ id: 1 }], 201);
    if (u.includes('/rest/v1/sims') && init.method === 'PATCH') return jsonRes([{ id: 45, imei: '351756051523999' }]);
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 45, action: 'change_imei', new_imei: '351756051523999' }, env);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.imei, '351756051523999');
  assert.equal(skylineSetImeiCalled, true, 'Skyline gateway set-imei must still be called for Skyline-hosted SIMs');
});

test('change_imei: rejects a malformed IMEI (not exactly 15 digits) before touching any host', async () => {
  const sim = {
    id: 46, iccid: 'ICC-BAD-IMEI', msisdn: '3322408358', vendor: 'atomic',
    gateway_host: 'teltik', gateway_id: null, port: null, status: 'active',
    imei: '111111111111115', activation_zip: '98104', sim_numbers: [{ e164: '+13322408358' }],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) return jsonRes([sim]);
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 46, action: 'change_imei', new_imei: '12345' });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, false);
  assert.match(data.error, /15 digits/);
});

test('change_imei: accepts a valid 15-digit IMEI for a Teltik-hosted SIM', async () => {
  const sim = {
    id: 47, iccid: 'ICC-GOOD-IMEI', msisdn: '3322408359', vendor: 'atomic',
    gateway_host: 'teltik', gateway_id: null, port: null, status: 'active',
    imei: '111111111111116', activation_zip: '98104', sim_numbers: [{ e164: '+13322408359' }],
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/rest/v1/sims') && (!init.method || init.method === 'GET')) return jsonRes([sim]);
    if (u.includes('solutionsatt-atomic.telgoo5.com')) {
      return jsonRes({ wholeSaleApi: { wholeSaleResponse: { requestType: 'swapImei', statusCode: '00', description: 'OK' } } });
    }
    if (u.includes('/rest/v1/carrier_api_logs')) return jsonRes({}, 201);
    if (u.includes('/rest/v1/sims') && init.method === 'PATCH') return jsonRes([{ id: 47, imei: '351756051523999' }]);
    throw new Error('Unexpected fetch: ' + u);
  };

  const res = await callSimAction({ sim_id: 47, action: 'change_imei', new_imei: '351756051523999' });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.imei, '351756051523999');
});
