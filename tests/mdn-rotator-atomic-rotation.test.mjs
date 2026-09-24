// Behaviour tests for the mdn-rotator ATOMIC rotation lane.
//
// Runs the real worker (`/run` -> processRotationBatch -> rotateAtomicSim)
// against a stateful fake at the global-fetch level: every Supabase call,
// ATOMIC carrier call and reseller webhook goes through one scripted fetch.
// Nothing in the worker is mocked, so these tests keep passing when the
// Supabase helpers inside the worker are refactored, as long as the requests
// on the wire stay the same.
//
// Loaded via a data: URL import (same trick as mdn-rotator-change-imei.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SHARED_MODULES = [
  ['../shared/subscriber-sync.js', 'src/shared/subscriber-sync.js', true],
  ['../shared/address-picker.mjs', 'src/shared/address-picker.mjs', false],
  ['../shared/persist-rental.mjs', 'src/shared/persist-rental.mjs', false],
  ['../shared/gateway-host.mjs', 'src/shared/gateway-host.mjs', false],
  ['../shared/activation-bulk.mjs', 'src/shared/activation-bulk.mjs', false],
  ['../shared/sim-swap.mjs', 'src/shared/sim-swap.mjs', false],
  ['../shared/fetch-timeout.mjs', 'src/shared/fetch-timeout.mjs', false],
  ['../shared/supabase-rest.mjs', 'src/shared/supabase-rest.mjs', false],
  ['../shared/legacy-vendors.mjs', 'src/shared/legacy-vendors.mjs', false],
];

async function toDataUrl(relPath) {
  const src = (await readFile(new URL('../' + relPath, import.meta.url), 'utf8'))
    .replace("'./fetch-timeout.mjs'", JSON.stringify(new URL('../src/shared/fetch-timeout.mjs', import.meta.url).href));
  return 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}

let workerSrc = await readFile(new URL('../src/mdn-rotator/index.js', import.meta.url), 'utf8');
for (const [specifier, relPath, asDataUrl] of SHARED_MODULES) {
  const abs = asDataUrl ? await toDataUrl(relPath) : new URL('../' + relPath, import.meta.url).href;
  workerSrc = workerSrc.replace(`'${specifier}'`, JSON.stringify(abs));
}
const mdnRotator = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const SUPABASE = 'https://db.test';
const RELAY = 'https://relay.test';
const ATOMIC = 'https://solutionsatt-atomic.telgoo5.com:22712';
const HOOK = 'https://reseller.test/hook';
const HOUR = 3_600_000;

const ENV = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ADMIN_RUN_SECRET: 'sekret',
  ATOMIC_USERNAME: 'ezbiz',
  ATOMIC_TOKEN: 'atok',
  ATOMIC_PIN: '1234',
  RELAY_URL: RELAY,
  RELAY_KEY: 'rk',
  FETCH_TIMEOUT_CARRIER_MS: '20',
  // Helix token comes from KV so the batch never calls the Helix token URL.
  TOKEN_CACHE: { get: async () => 'helix-token', put: async () => {} },
};

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, error: console.error, warn: console.warn };
beforeEach(() => {
  if (!process.env.DEBUG_TESTS) console.log = console.error = console.warn = () => {};
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

function atomicSim(id, overrides = {}) {
  return {
    id,
    iccid: `8901410300000000${String(id).padStart(3, '0')}`,
    mobility_subscription_id: null,
    msisdn: `21255500${String(id).padStart(2, '0')}`,
    vendor: 'atomic',
    status: 'active',
    last_mdn_rotated_at: new Date(Date.now() - 30 * HOUR).toISOString(),
    activated_at: '2026-01-01T00:00:00.000Z',
    activation_zip: '11238',
    rotation_eligible: true,
    canary_apex_ppu: false,
    reseller_sims: [{ reseller_id: 7 }],
    ...overrides,
  };
}

function atomicResponse(body) {
  return new Response(JSON.stringify({ wholeSaleApi: { wholeSaleResponse: body } }), { status: 200 });
}

// A request that never answers: it rejects only when fetchWithTimeout aborts
// it, with the signal's reason, exactly as a real hung socket would.
function hang(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
}

// Stateful fake of Supabase + ATOMIC + the reseller webhook.
// `carrier(req, sim)` decides each ATOMIC answer; default is a clean rotation
// that hands out 3105550000 + sim id.
function harness(sims, { carrier, claim, staleCandidates = false } = {}) {
  const db = new Map(sims.map(s => [s.id, { ...s }]));
  const snapshot = sims.map(s => ({ ...s }));
  const numbers = new Map(sims.map(s => [s.id, `+1${s.msisdn}`]));
  const calls = [];

  const simByMsisdnOrIccid = (req) =>
    [...db.values()].find(s => s.iccid === req.sim || s.msisdn === req.MSISDN);

  const defaultCarrier = (req, sim) => {
    if (req.requestType === 'subsriberInquiry') {
      return atomicResponse({ statusCode: '00', Result: { msisdn: sim.msisdn, address: { zipCode: '11238', state: 'NY' } } });
    }
    if (req.requestType === 'swapMSISDN') {
      return atomicResponse({ statusCode: '00', Result: { MSISDN: `310555${String(sim.id).padStart(4, '0')}` } });
    }
    throw new Error('unexpected ATOMIC request ' + req.requestType);
  };

  const defaultClaim = (row) => {
    // Mirrors claim_rotation_slot: once per NY day, stamps the row.
    const last = row.last_mdn_rotated_at ? Date.parse(row.last_mdn_rotated_at) : 0;
    if (Date.now() - last < 20 * HOUR) return false;
    row.last_mdn_rotated_at = new Date().toISOString();
    row.rotation_status = 'rotating';
    return true;
  };

  async function fakeFetch(input, init = {}) {
    const url = String(input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;

    if (url.startsWith(RELAY + '/')) {
      const target = url.slice(RELAY.length + 1);
      const call = { kind: target.startsWith(ATOMIC) ? 'atomic' : 'webhook', method, url: target, body, headers: init.headers };
      calls.push(call);
      if (call.kind === 'atomic') {
        const req = body.wholeSaleApi.wholeSaleRequest;
        const sim = simByMsisdnOrIccid(req);
        const answer = (carrier || defaultCarrier)(req, sim, init);
        return answer === undefined ? defaultCarrier(req, sim) : answer;
      }
      return new Response(JSON.stringify({ rentalId: 77 }), { status: 200 });
    }

    assert.ok(url.startsWith(SUPABASE + '/rest/v1/'), 'unexpected URL ' + url);
    const path = url.slice((SUPABASE + '/rest/v1/').length);
    calls.push({ kind: 'db', method, path, body });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });

    if (path.startsWith('rpc/claim_rotation_slot')) {
      const row = db.get(body.p_sim_id);
      const granted = claim ? claim(row, body) : defaultClaim(row);
      return new Response(granted ? 'true' : 'false', { status: 200 });
    }
    if (path.startsWith('rpc/increment_rotation_fail')) return ok(1);

    if (method === 'GET') {
      if (path.startsWith('sims?select=id,iccid,mobility_subscription_id')) {
        return ok(staleCandidates ? snapshot : [...db.values()].filter(s => s.status === 'active'));
      }
      if (path.includes('rotation_status=eq.failed')) return ok([]);
      if (path.startsWith('sim_numbers?sim_id=eq.')) {
        const id = Number(/sim_id=eq\.(\d+)/.exec(path)[1]);
        return ok([{ e164: numbers.get(id) }]);
      }
      if (path.startsWith('reseller_sims?')) return ok([{ reseller_id: 7 }]);
      if (path.startsWith('reseller_webhooks?')) return ok([{ url: HOOK }]);
      return ok([]);
    }

    if (method === 'PATCH' && path.startsWith('sims?id=eq.')) {
      const id = Number(/id=eq\.(\d+)/.exec(path)[1]);
      Object.assign(db.get(id), body);
      return ok([{}]);
    }
    if (method === 'POST' && path === 'sim_numbers') {
      for (const r of body) numbers.set(r.sim_id, r.e164);
      return ok(body, 201);
    }
    return ok([], method === 'POST' ? 201 : 200);
  }

  globalThis.fetch = fakeFetch;

  return {
    db,
    calls,
    atomic: () => calls.filter(c => c.kind === 'atomic'),
    webhooks: () => calls.filter(c => c.kind === 'webhook'),
    db_: (pred) => calls.filter(c => c.kind === 'db' && pred(c)),
    // The significant writes and outbound calls, in order. Reads, carrier
    // logging and webhook bookkeeping are left out so the sequence is about
    // what the rotation does, not how it logs it.
    sequence: () => calls
      .filter(c => c.kind !== 'db' || (c.method !== 'GET' && !/^(carrier_api_logs|webhook_deliveries|rentals)/.test(c.path)))
      .map(c => {
        if (c.kind === 'atomic') return `ATOMIC ${c.body.wholeSaleApi.wholeSaleRequest.requestType}`;
        if (c.kind === 'webhook') return `WEBHOOK ${c.body.event_type}`;
        return `${c.method} ${c.path.split('?')[0]}${c.path.startsWith('sim_numbers?') ? ' (close)' : ''}`;
      }),
  };
}

async function runTick(qs = 'limit=10&concurrency=1') {
  const res = await mdnRotator.fetch(new Request(`https://x/run?secret=sekret&${qs}`), ENV, {});
  assert.equal(res.status, 200);
  return res.json();
}

// ---------------------------------------------------------------
// 1. One SIM end to end
// ---------------------------------------------------------------

test('ATOMIC rotation runs claim -> inquiry -> swap -> number rows -> sims -> webhooks, in that order', async () => {
  const h = harness([atomicSim(1)]);
  const result = await runTick();

  assert.equal(result.attempted, 1);
  assert.equal(result.ok_count, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(h.sequence(), [
    'POST rpc/claim_rotation_slot',
    'ATOMIC subsriberInquiry',
    'ATOMIC swapMSISDN',
    'WEBHOOK number.offline',
    'PATCH sim_numbers (close)',
    'POST sim_numbers',
    'PATCH sims',          // rotation timestamp + status
    'PATCH sims',          // msisdn mirror
    'WEBHOOK number.online',
    'PATCH sims',          // last_notified_at
  ]);
});

test('claim_rotation_slot and the ATOMIC calls carry the right payloads through the relay', async () => {
  const h = harness([atomicSim(1)]);
  await runTick();

  const [claim] = h.db_(c => c.path.startsWith('rpc/claim_rotation_slot'));
  assert.deepEqual(claim.body, { p_sim_id: 1, p_force: false });

  const [inq, swap] = h.atomic();
  for (const c of [inq, swap]) {
    assert.equal(c.method, 'POST');
    assert.equal(c.url, ATOMIC);
    assert.equal(c.headers['x-relay-key'], 'rk');
    assert.deepEqual(c.body.wholeSaleApi.session, { userName: 'ezbiz', token: 'atok', pin: '1234' });
  }
  assert.deepEqual(inq.body.wholeSaleApi.wholeSaleRequest,
    { requestType: 'subsriberInquiry', MSISDN: '', sim: '8901410300000000001' });
  assert.deepEqual(swap.body.wholeSaleApi.wholeSaleRequest,
    { requestType: 'swapMSISDN', MSISDN: '2125550001', zipCode: '11238' });
});

test('the old number row is closed, the new one opened, and the sims row marked rotated', async () => {
  const h = harness([atomicSim(1)]);
  await runTick();

  const [close] = h.db_(c => c.method === 'PATCH' && c.path.startsWith('sim_numbers?'));
  assert.equal(close.path, 'sim_numbers?sim_id=eq.1&valid_to=is.null');
  assert.ok(Date.parse(close.body.valid_to));

  const [open] = h.db_(c => c.method === 'POST' && c.path === 'sim_numbers');
  assert.equal(open.body.length, 1);
  assert.equal(open.body[0].sim_id, 1);
  assert.equal(open.body[0].e164, '+13105550001');
  assert.equal(open.body[0].verification_status, 'verified');

  const row = h.db.get(1);
  assert.equal(row.msisdn, '3105550001');
  assert.equal(row.status, 'active');
  assert.equal(row.rotation_status, 'success');
  assert.equal(row.rotation_fail_count, 0);
  assert.equal(row.last_rotation_error, null);
  assert.ok(row.last_notified_at, 'last_notified_at stamped after a delivered number.online');
});

test('the reseller gets number.offline for the old MDN, then number.online for the new one', async () => {
  const h = harness([atomicSim(1)]);
  await runTick();

  const [off, on] = h.webhooks();
  assert.equal(off.url, HOOK);
  assert.equal(off.method, 'POST');
  assert.equal(off.body.event_type, 'number.offline');
  assert.equal(off.body.data.number, '+12125550001');
  assert.equal(off.body.data.replaced_by, '+13105550001');
  assert.equal(off.body.data.online, false);

  assert.equal(on.url, HOOK);
  assert.equal(on.body.event_type, 'number.online');
  assert.equal(on.body.data.sim_id, 1);
  assert.equal(on.body.data.number, '+13105550001');
  assert.equal(on.body.data.iccid, '8901410300000000001');
  assert.equal(on.body.data.mobilitySubscriptionId, '3105550001');
  assert.equal(on.body.data.verified, true);
  assert.ok(Date.parse(on.body.data.online_until) > Date.now());
  assert.match(on.body.message_id, /^number\.online_[0-9a-f]{16}$/);
});

// ---------------------------------------------------------------
// 2. Failure paths
// ---------------------------------------------------------------

test('carrier rejects swapMSISDN: increment_rotation_fail called, stamp restored, no number rows, no webhook', async () => {
  const sim = atomicSim(1);
  const h = harness([sim], {
    carrier: (req) => req.requestType === 'swapMSISDN'
      ? atomicResponse({ statusCode: '01', description: 'MSISDN swap limit reached' })
      : undefined,
  });
  const result = await runTick();

  assert.equal(result.failed, 1);
  assert.equal(result.ok_count, 0);
  const [fail] = h.db_(c => c.path.startsWith('rpc/increment_rotation_fail'));
  assert.equal(fail.body.p_sim_id, 1);
  assert.match(fail.body.p_error, /ATOMIC swapMSISDN failed: MSISDN swap limit reached/);
  assert.ok(Date.parse(fail.body.p_today_start));

  assert.equal(h.db_(c => c.path.startsWith('sim_numbers') && c.method !== 'GET').length, 0);
  assert.equal(h.webhooks().length, 0);
  // No MDN was consumed, so the claim's stamp goes back to its prior value.
  assert.equal(h.db.get(1).last_mdn_rotated_at, sim.last_mdn_rotated_at);
});

test('after one SIM fails at the carrier the loop still rotates the next SIM', async () => {
  const h = harness([atomicSim(1), atomicSim(2)], {
    carrier: (req) => req.requestType === 'swapMSISDN' && req.MSISDN === '2125550001'
      ? atomicResponse({ statusCode: '01', description: 'MSISDN swap limit reached' })
      : undefined,
  });
  const result = await runTick();

  assert.equal(result.attempted, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.ok_count, 1);
  const opened = h.db_(c => c.method === 'POST' && c.path === 'sim_numbers');
  assert.deepEqual(opened.map(c => c.body[0].sim_id), [2]);
  assert.equal(h.db.get(2).msisdn, '3105550002');
  assert.equal(h.db.get(1).msisdn, '2125550001');
});

test('pre-swap inquiry rejected: no swapMSISDN is sent and the failure is counted', async () => {
  const h = harness([atomicSim(1)], {
    carrier: (req) => req.requestType === 'subsriberInquiry'
      ? atomicResponse({ statusCode: '99', description: 'Subscriber not found' })
      : undefined,
  });
  const result = await runTick();

  assert.equal(result.failed, 1);
  assert.deepEqual(h.atomic().map(c => c.body.wholeSaleApi.wholeSaleRequest.requestType), ['subsriberInquiry']);
  assert.equal(h.db_(c => c.path.startsWith('rpc/increment_rotation_fail')).length, 1);
});

test('carrier call times out: treated as a failure and increment_rotation_fail is called', async () => {
  const h = harness([atomicSim(1)], { carrier: (req, sim, init) => hang(init) });
  const result = await runTick();

  assert.equal(result.failed, 1);
  assert.equal(result.breaker_tripped, false);
  const [fail] = h.db_(c => c.path.startsWith('rpc/increment_rotation_fail'));
  assert.match(fail.body.p_error, /timeout after 20ms/);
  assert.equal(h.atomic().length, 1, 'the swap is never attempted after the inquiry hangs');
});

test('8 consecutive carrier timeouts trip the circuit breaker and the rest of the batch is left alone', async () => {
  const sims = Array.from({ length: 10 }, (_, i) => atomicSim(i + 1));
  const h = harness(sims, { carrier: (req, sim, init) => hang(init) });
  const result = await runTick('limit=10&concurrency=1');

  assert.equal(result.breaker_tripped, true);
  assert.equal(result.failed, 8);
  assert.equal(result.skipped_breaker, 2);
  assert.equal(h.atomic().length, 8);
  // SIMs 9 and 10 were never claimed, so their rotation slot is untouched.
  const claimed = h.db_(c => c.path.startsWith('rpc/claim_rotation_slot')).map(c => c.body.p_sim_id);
  assert.deepEqual(claimed, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a carrier application error resets the breaker streak', async () => {
  // 7 timeouts, 1 rejection, 7 timeouts: never 8 transport failures in a row.
  const sims = Array.from({ length: 15 }, (_, i) => atomicSim(i + 1));
  const h = harness(sims, {
    carrier: (req, sim, init) => sim.id === 8
      ? atomicResponse({ statusCode: '99', description: 'Subscriber not found' })
      : hang(init),
  });
  const result = await runTick('limit=15&concurrency=1');

  assert.equal(result.breaker_tripped, false);
  assert.equal(result.failed, 15);
  assert.equal(h.db_(c => c.path.startsWith('rpc/claim_rotation_slot')).length, 15);
});

test('swapMSISDN times out: SIM parked as provisioning/mdn_pending, not failed, no number rows', async () => {
  const sim = atomicSim(1);
  const h = harness([sim], {
    carrier: (req, s, init) => req.requestType === 'swapMSISDN' ? hang(init) : undefined,
  });
  const result = await runTick();

  // The swap may have happened at AT&T, so the finalizer reconciles it later.
  assert.equal(result.failed, 0);
  assert.equal(h.db_(c => c.path.startsWith('rpc/increment_rotation_fail')).length, 0);
  assert.equal(h.db_(c => c.path.startsWith('sim_numbers') && c.method !== 'GET').length, 0);
  assert.equal(h.webhooks().length, 0);
  const row = h.db.get(1);
  assert.equal(row.status, 'provisioning');
  assert.equal(row.rotation_status, 'mdn_pending');
  assert.match(row.last_rotation_error, /^swap uncertain: .*timeout after 20ms/);
  assert.notEqual(row.last_mdn_rotated_at, sim.last_mdn_rotated_at, 'claim stamp kept: an MDN may be consumed');
});

test('claim_rotation_slot returns false: no carrier call and no writes', async () => {
  const h = harness([atomicSim(1)], { claim: () => false });
  const result = await runTick();

  assert.equal(result.skipped, 1);
  assert.equal(result.ok_count, 0);
  assert.equal(h.atomic().length, 0);
  assert.equal(h.webhooks().length, 0);
  assert.deepEqual(h.sequence(), ['POST rpc/claim_rotation_slot']);
});

test('pre-swap inquiry timeout restores the claim stamp, counts as a failure and moves on to the next SIM', async () => {
  const s1 = atomicSim(1);
  const h = harness([s1, atomicSim(2)], {
    carrier: (req, s, init) => (s.id === 1 ? hang(init) : undefined),
  });
  const result = await runTick();
  assert.equal(h.db.get(1).last_mdn_rotated_at, s1.last_mdn_rotated_at);
  assert.equal(result.failed, 1);
  assert.equal(result.ok_count, 1, 'the second SIM still rotates');
  const [fail] = h.db_(c => c.path.startsWith('rpc/increment_rotation_fail'));
  assert.match(fail.body.p_error, /pre-swap inquiry network error: .*timeout after 20ms/);
});

// ---------------------------------------------------------------
// 4. Idempotency
// ---------------------------------------------------------------

test('running the same tick twice rotates once: the second tick makes zero carrier calls', async () => {
  const h = harness([atomicSim(1)]);
  await runTick();
  const firstAtomic = h.atomic().length;
  const firstClaims = h.db_(c => c.path.startsWith('rpc/claim_rotation_slot')).length;

  const second = await runTick();

  assert.equal(firstAtomic, 2);
  assert.equal(second.attempted, 0);
  assert.equal(h.atomic().length, firstAtomic);
  assert.equal(h.db_(c => c.path.startsWith('rpc/claim_rotation_slot')).length, firstClaims);
  assert.equal(h.db_(c => c.method === 'POST' && c.path === 'sim_numbers').length, 1);
});

test('a stale candidate read on the second tick is stopped by claim_rotation_slot, before any carrier call', async () => {
  const h = harness([atomicSim(1)], { staleCandidates: true });
  await runTick();
  const firstAtomic = h.atomic().length;

  const second = await runTick();

  assert.equal(second.attempted, 1);
  assert.equal(second.skipped, 1);
  assert.equal(h.atomic().length, firstAtomic);
  assert.equal(h.webhooks().length, 2, 'no extra webhooks on the second tick');
});
