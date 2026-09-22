// Behaviour tests for the teltik-worker 48-hour rotation lane.
//
// Runs the real worker (`POST /rotate` -> rotateTeltikSims ->
// rotateOneTeltikSim) against a stateful fake at the global-fetch level:
// Supabase, the Teltik change-number API (through the relay) and the reseller
// webhook all answer from one scripted fetch. No helper inside the worker is
// mocked, so these tests survive a refactor of its Supabase helpers.
//
// Loaded via a data: URL import (same trick as teltik-portal.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// A data: URL cannot resolve relative imports, so point every ../shared/ import
// at its absolute file URL.
const workerSrc = (await readFile(new URL('../src/teltik-worker/index.js', import.meta.url), 'utf8'))
  .replace(/'\.\.\/shared\/([^']+)'/g, (_, f) => JSON.stringify(new URL(`../src/shared/${f}`, import.meta.url).href));
const teltikWorker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

const SUPABASE = 'https://db.test';
const RELAY = 'https://relay.test';
const TELTIK = 'https://api.smsgateway.xyz';
const HOOK = 'https://reseller.test/hook';
const HOUR = 3_600_000;

const ENV = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ADMIN_RUN_SECRET: 'sekret',
  TELTIK_API_KEY: 'tk-test',
  RELAY_URL: RELAY,
  RELAY_KEY: 'rk',
  FETCH_TIMEOUT_CARRIER_MS: '20',
  TELTIK_ROTATE_CONCURRENCY: '1',
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

const ago = (ms) => new Date(Date.now() - ms).toISOString();

function teltikSim(id, overrides = {}) {
  return {
    id,
    iccid: `8901260000000000${String(id).padStart(3, '0')}`,
    msisdn: `34755500${String(id).padStart(2, '0')}`,
    status: 'active',
    last_mdn_rotated_at: ago(49 * HOUR),
    rotation_interval_hours: 48,
    rotation_hold_until: null,
    reseller_sims: [{ reseller_id: 7, active: true }],
    ...overrides,
  };
}

function hang(init) {
  return new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
}

// Stateful fake of Supabase + Teltik + the reseller webhook. `carrier(sim)`
// decides each change-number answer; default is a synchronous SUCCESS that
// hands out 6465550000 + sim id.
function harness(sims, { carrier, claim, dbWrite } = {}) {
  const db = new Map(sims.map(s => [s.id, { ...s }]));
  const calls = [];

  const defaultCarrier = (sim) => new Response(JSON.stringify({
    status: 'SUCCESS',
    requestId: `req-${sim.id}`,
    old_msisdn: `1${sim.msisdn}`,
    new_msisdn: `1646555${String(sim.id).padStart(4, '0')}`,
  }), { status: 200 });

  const defaultClaim = (row) => {
    // Mirrors claim_rotation_slot: interval check, then stamp the row.
    const last = row.last_mdn_rotated_at ? Date.parse(row.last_mdn_rotated_at) : 0;
    if (Date.now() - last < (row.rotation_interval_hours || 48) * HOUR) return false;
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
      if (target.startsWith(TELTIK)) {
        const u = new URL(target);
        calls.push({ kind: 'teltik', method, url: target, params: Object.fromEntries(u.searchParams), headers: init.headers });
        const sim = [...db.values()].find(s => s.iccid === u.searchParams.get('iccid'));
        return (carrier || defaultCarrier)(sim, init) ?? defaultCarrier(sim);
      }
      calls.push({ kind: 'webhook', method, url: target, body });
      return new Response(JSON.stringify({ rentalId: 88 }), { status: 200 });
    }

    assert.ok(url.startsWith(SUPABASE + '/rest/v1/'), 'unexpected URL ' + url);
    const path = url.slice((SUPABASE + '/rest/v1/').length);
    calls.push({ kind: 'db', method, path, body });
    const ok = (data, status = 200) => new Response(JSON.stringify(data), { status });

    if (path.startsWith('rpc/claim_rotation_slot')) {
      const row = db.get(body.p_sim_id);
      return ok(claim ? claim(row, body) : defaultClaim(row));
    }
    if (path.startsWith('rpc/increment_rotation_fail')) return ok(1);

    if (method === 'GET') {
      if (path.startsWith('sims?vendor=eq.teltik&status=eq.active')) {
        return ok([...db.values()].filter(s => s.status === 'active'));
      }
      if (path.includes('rotation_status=eq.failed')) return ok([]);
      if (path.startsWith('reseller_sims?')) {
        return ok([{ reseller_id: 7, resellers: { reseller_webhooks: [{ url: HOOK, enabled: true }] } }]);
      }
      return ok([]);
    }

    const override = dbWrite?.(method, path, body);
    if (override) return override;
    if (method === 'PATCH' && path.startsWith('sims?id=eq.')) {
      Object.assign(db.get(Number(/id=eq\.(\d+)/.exec(path)[1])), body);
    }
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  }

  globalThis.fetch = fakeFetch;

  return {
    db,
    calls,
    teltik: () => calls.filter(c => c.kind === 'teltik'),
    webhooks: () => calls.filter(c => c.kind === 'webhook'),
    db_: (pred) => calls.filter(c => c.kind === 'db' && pred(c)),
    sequence: () => calls
      .filter(c => c.kind !== 'db' || (c.method !== 'GET' && !/^(carrier_api_logs|webhook_deliveries)/.test(c.path)))
      .map(c => {
        if (c.kind === 'teltik') return 'TELTIK change-number';
        if (c.kind === 'webhook') return `WEBHOOK ${c.body.event_type}`;
        return `${c.method} ${c.path.split('?')[0]}${c.path.startsWith('sim_numbers?') ? ' (close)' : ''}`;
      }),
  };
}

async function runTick() {
  const res = await teltikWorker.fetch(new Request('https://x/rotate?secret=sekret', { method: 'POST' }), ENV, {});
  assert.equal(res.status, 200);
  return res.json();
}

// ---------------------------------------------------------------
// 3. The 48-hour lane
// ---------------------------------------------------------------

test('a due SIM runs claim -> change-number -> number rows -> sims -> webhooks, in that order', async () => {
  const h = harness([teltikSim(1)]);
  const result = await runTick();

  assert.equal(result.due, 1);
  assert.equal(result.rotated, 1);
  assert.equal(result.errors, 0);
  assert.deepEqual(h.sequence(), [
    'POST rpc/claim_rotation_slot',
    'TELTIK change-number',
    'PATCH sim_numbers (close)',
    'POST sim_numbers',
    'PATCH sims',
    'WEBHOOK number.offline',
    'WEBHOOK number.online',
    'PATCH sims',          // last_notified_at
  ]);
});

test('claim and change-number carry the right payloads through the relay', async () => {
  const h = harness([teltikSim(1)]);
  await runTick();

  const [claim] = h.db_(c => c.path.startsWith('rpc/claim_rotation_slot'));
  assert.deepEqual(claim.body, { p_sim_id: 1, p_force: false });

  const [call] = h.teltik();
  assert.equal(call.method, 'GET');
  assert.ok(call.url.startsWith(`${TELTIK}/v1/change-number/?`));
  assert.deepEqual(call.params, { apikey: 'tk-test', iccid: '8901260000000000001' });
  assert.equal(call.headers['x-relay-key'], 'rk');

  const [log] = h.db_(c => c.path === 'carrier_api_logs');
  assert.equal(log.body.step, 'change_number_initiate');
  assert.doesNotMatch(log.body.request_url, /tk-test/, 'API key is masked in the carrier log');
});

test('number rows and the sims row are written from the change-number answer', async () => {
  const h = harness([teltikSim(1)]);
  await runTick();

  const [close] = h.db_(c => c.method === 'PATCH' && c.path.startsWith('sim_numbers?'));
  assert.equal(close.path, 'sim_numbers?sim_id=eq.1&valid_to=is.null');
  const [open] = h.db_(c => c.method === 'POST' && c.path === 'sim_numbers');
  assert.deepEqual(open.body.map(r => [r.sim_id, r.e164, r.verification_status]), [[1, '+16465550001', 'verified']]);
  assert.equal(open.body[0].valid_from, close.body.valid_to);

  const [simPatch] = h.db_(c => c.method === 'PATCH' && c.path === 'sims?id=eq.1');
  assert.deepEqual({ ...simPatch.body, last_rotation_at: 'T' }, {
    msisdn: '6465550001',
    status: 'active',
    rotation_status: 'success',
    last_rotation_at: 'T',
    last_rotation_error: null,
    rotation_fail_count: 0,
    rotation_hold_until: null,
  });
});

test('the reseller gets number.offline for the old MDN, then number.online with a 48h online_until', async () => {
  const h = harness([teltikSim(1)]);
  await runTick();

  const [off, on] = h.webhooks();
  assert.equal(off.url, HOOK);
  assert.equal(off.body.event_type, 'number.offline');
  assert.equal(off.body.data.number, '+13475550001');
  assert.equal(off.body.data.carrier, 'T-Mobile');

  assert.equal(on.url, HOOK);
  assert.equal(on.body.event_type, 'number.online');
  assert.equal(on.body.data.number, '+16465550001');
  assert.equal(on.body.data.iccid, '8901260000000000001');
  const untilH = (Date.parse(on.body.data.online_until) - Date.now()) / HOUR;
  assert.ok(untilH > 24 && untilH <= 72, `online_until ~48h out, got ${untilH.toFixed(1)}h`);
});

test('a SIM not yet due is skipped with no claim and no carrier call; the due one rotates', async () => {
  const h = harness([teltikSim(1), teltikSim(2, { last_mdn_rotated_at: ago(47 * HOUR) })]);
  const result = await runTick();

  assert.equal(result.due, 1);
  assert.equal(result.rotated, 1);
  assert.deepEqual(h.teltik().map(c => c.params.iccid), ['8901260000000000001']);
  assert.deepEqual(h.db_(c => c.path.startsWith('rpc/')).map(c => c.body.p_sim_id), [1]);
  assert.equal(h.db.get(2).msisdn, '3475550002');
});

test('a SIM on a night-migration hold is skipped even though it is overdue', async () => {
  const h = harness([teltikSim(1, { rotation_hold_until: new Date(Date.now() + 3 * HOUR).toISOString() })]);
  const result = await runTick();

  assert.equal(result.due, 0);
  assert.equal(h.teltik().length, 0);
});

test('Teltik answers status=FAILED: increment_rotation_fail, no number rows, next SIM still rotates', async () => {
  const h = harness([teltikSim(1), teltikSim(2)], {
    carrier: (sim) => sim.id === 1
      ? new Response(JSON.stringify({ status: 'FAILED', error: 'Only 1 change per 48h' }), { status: 200 })
      : undefined,
  });
  const result = await runTick();

  assert.equal(result.errors, 1);
  assert.equal(result.rotated, 1);
  const [fail] = h.db_(c => c.path.startsWith('rpc/increment_rotation_fail'));
  assert.equal(fail.body.p_sim_id, 1);
  assert.match(fail.body.p_error, /status=FAILED: Only 1 change per 48h/);
  const opened = h.db_(c => c.method === 'POST' && c.path === 'sim_numbers');
  assert.deepEqual(opened.map(c => c.body[0].sim_id), [2]);
});

test('Supabase 500 on the sims PATCH after a number change: system_errors row, SIM failed-after-carrier, no second carrier call', async () => {
  const h = harness([teltikSim(1)], {
    dbWrite: (method, path, body) => method === 'PATCH' && path.startsWith('sims?id=eq.') && body.rotation_status === 'success'
      ? new Response('{"message":"boom"}', { status: 500 })
      : undefined,
  });
  const result = await runTick();

  assert.equal(result.rotated, 0);
  assert.equal(result.errors, 1);
  assert.deepEqual(result.failed_after_carrier, [{ sim_id: 1, iccid: '8901260000000000001' }]);

  const [err] = h.db_(c => c.method === 'POST' && c.path === 'system_errors');
  assert.ok(err, 'a system_errors row is written');
  assert.equal(err.body[0].source, 'teltik-worker');
  assert.equal(err.body[0].action, 'teltik_rotation_db_write_failed');
  assert.equal(err.body[0].severity, 'error');
  assert.equal(err.body[0].sim_id, 1);
  assert.equal(err.body[0].error_details.old_msisdn, '3475550001');
  assert.equal(err.body[0].error_details.new_msisdn, '6465550001');
  assert.equal(err.body[0].error_details.failures[0].status, 500);

  assert.equal(h.db_(c => c.path.startsWith('rpc/increment_rotation_fail')).length, 0,
    'no failed rotation_status, so the retry pass cannot burn another number');
  assert.equal(h.teltik().length, 1);

  await runTick();
  assert.equal(h.teltik().length, 1, 'the next tick does not call Teltik again for this SIM');
});

test('claim_rotation_slot returns false: no carrier call', async () => {
  const h = harness([teltikSim(1)], { claim: () => false });
  const result = await runTick();

  assert.equal(result.skipped, 1);
  assert.equal(h.teltik().length, 0);
  assert.deepEqual(h.sequence(), ['POST rpc/claim_rotation_slot']);
});

test('8 consecutive change-number timeouts trip the breaker and later SIMs are never claimed', async () => {
  const sims = Array.from({ length: 10 }, (_, i) => teltikSim(i + 1));
  const h = harness(sims, { carrier: (sim, init) => hang(init) });
  const result = await runTick();

  assert.equal(result.breaker_tripped, true);
  assert.equal(result.errors, 8);
  assert.equal(h.teltik().length, 8);
  assert.equal(h.db_(c => c.path.startsWith('rpc/claim_rotation_slot')).length, 8);
  const fails = h.db_(c => c.path.startsWith('rpc/increment_rotation_fail'));
  assert.equal(fails.length, 8);
  assert.match(fails[0].body.p_error, /timeout after 20ms/);
});

// ---------------------------------------------------------------
// 4. Idempotency
// ---------------------------------------------------------------

test('running the same tick twice rotates once: the second tick makes zero carrier calls', async () => {
  const h = harness([teltikSim(1)]);
  await runTick();
  assert.equal(h.teltik().length, 1);

  const second = await runTick();

  assert.equal(second.due, 0);
  assert.equal(h.teltik().length, 1);
  assert.equal(h.db_(c => c.method === 'POST' && c.path === 'sim_numbers').length, 1);
  assert.equal(h.webhooks().length, 2);
});
