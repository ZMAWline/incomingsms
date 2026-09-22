// Runs the real ATOMIC port-in poller against a fake Supabase and a fake
// mdn-rotator binding, and checks the back-off schedule and max-age stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAtomicPortinPoller,
  portinPollDecision,
  portinPollSchedule,
} from '../src/details-finalizer/atomic-portin-poller.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function sim(id, { submittedAgo, checkedAgo, statusCode = null, description = null }) {
  return {
    id,
    iccid: `8901280000000000${String(id).padStart(3, '0')}`,
    msisdn: `555000${String(id).padStart(4, '0')}`,
    gateway_host: 'skyline',
    created_at: ago(30 * DAY),
    atomic_portin_status_code: statusCode,
    atomic_portin_description: description,
    atomic_portin_checked_at: checkedAgo === undefined ? null : ago(checkedAgo),
    sim_numbers: [{ valid_from: ago(submittedAgo) }],
  };
}

// portinStatus answers are keyed by MSISDN; anything unlisted is pending.
function harness(sims, { portinStatus = {}, env: extraEnv = {} } = {}) {
  const calls = { selects: [], patches: [], inserts: [], carrier: [] };
  const deps = {
    async supabaseSelect(env, path) {
      calls.selects.push(path);
      if (path.startsWith('sims?')) return sims;
      if (path.startsWith('sim_numbers?')) {
        const id = Number(/sim_id=eq\.(\d+)/.exec(path)[1]);
        const s = sims.find(x => x.id === id);
        return [{ e164: `+1${s.msisdn}` }];
      }
      throw new Error(`unexpected select ${path}`);
    },
    async supabasePatch(env, path, body) { calls.patches.push({ path, body }); },
    async supabaseInsert(env, table, rows) { calls.inserts.push({ table, rows }); },
    async closeCurrentNumber() { throw new Error('number should not roll'); },
    async insertNewNumber() { throw new Error('number should not roll'); },
    async logTeltikApiCall() {},
  };
  const env = {
    ADMIN_RUN_SECRET: 'test-secret',
    MDN_ROTATOR: {
      async fetch(url) {
        const u = new URL(url);
        calls.carrier.push(u.pathname);
        if (u.pathname === '/atomic-portin-status') {
          const msisdn = u.searchParams.get('msisdn');
          const body = portinStatus[msisdn] || { statusCode: '01', description: 'Pending', result: { reasonCode: 'OP' } };
          return Response.json(body);
        }
        if (u.pathname === '/atomic-inquiry') {
          const s = sims.find(x => x.iccid === u.searchParams.get('iccid'));
          return Response.json({ ok: true, statusCode: '00', attStatus: 'Active', msisdn: s.msisdn, ban: '123456789' });
        }
        throw new Error(`unexpected mdn-rotator call ${url}`);
      },
    },
    ...extraEnv,
  };
  const poller = createAtomicPortinPoller(deps);
  return { calls, run: () => poller.runAtomicPortinStatusFinalizer(env, 50) };
}

const polledSimIds = (calls) => calls.patches
  .filter(p => 'atomic_portin_checked_at' in p.body)
  .map(p => Number(/id=eq\.(\d+)/.exec(p.path)[1]));

test('a fresh SIM that was never checked is polled', async () => {
  const h = harness([sim(1, { submittedAgo: 1 * MIN })]);
  const out = await h.run();
  assert.equal(out.checked, 1);
  assert.deepEqual(h.calls.carrier, ['/atomic-portin-status']);
  assert.deepEqual(polledSimIds(h.calls), [1]);
});

test('a SIM in its first 2 hours checked 3 minutes ago is skipped', async () => {
  const h = harness([sim(1, { submittedAgo: 30 * MIN, checkedAgo: 3 * MIN })]);
  const out = await h.run();
  assert.equal(out.skipped, 1);
  assert.equal(out.checked, 0);
  assert.deepEqual(h.calls.carrier, []);
});

test('a SIM in its first 2 hours is polled on every 5-minute tick, even a few seconds early', async () => {
  const h = harness([sim(1, { submittedAgo: 90 * MIN, checkedAgo: 5 * MIN - 5_000 })]);
  const out = await h.run();
  assert.equal(out.checked, 1);
});

test('a SIM at 5 hours is skipped 10 minutes after its last check and polled after 40', async () => {
  const h = harness([
    sim(1, { submittedAgo: 5 * HOUR, checkedAgo: 10 * MIN }),
    sim(2, { submittedAgo: 5 * HOUR, checkedAgo: 40 * MIN }),
  ]);
  const out = await h.run();
  assert.equal(out.skipped, 1);
  assert.equal(out.checked, 1);
  assert.deepEqual(polledSimIds(h.calls), [2]);
});

test('a SIM older than 24 hours waits 6 hours between checks', () => {
  const schedule = portinPollSchedule({});
  const now = Date.now();
  assert.equal(portinPollDecision(sim(1, { submittedAgo: 3 * DAY, checkedAgo: 5 * HOUR }), schedule, now), 'wait');
  assert.equal(portinPollDecision(sim(1, { submittedAgo: 3 * DAY, checkedAgo: 6 * HOUR }), schedule, now), 'due');
});

test('a SIM at 15 days is marked and escalated, not polled', async () => {
  const h = harness([sim(7, { submittedAgo: 15 * DAY, checkedAgo: 7 * HOUR, statusCode: '01', description: 'Pending' })]);
  const out = await h.run();
  assert.equal(out.expired, 1);
  assert.equal(out.checked, 0);
  assert.deepEqual(h.calls.carrier, [], 'no carrier call');

  assert.equal(h.calls.inserts.length, 1);
  const { table, rows: [row] } = h.calls.inserts[0];
  assert.equal(table, 'system_errors');
  assert.equal(row.source, 'details-finalizer');
  assert.equal(row.action, 'atomic_portin_max_age');
  assert.equal(row.sim_id, 7);
  assert.equal(row.status, 'open');
  assert.match(row.error_message, /14 days/);
  assert.match(row.error_message, /01 — Pending/);
  assert.equal(row.error_details.submitted_at_source, 'sim_numbers.valid_from');

  const [patch] = h.calls.patches;
  assert.equal(patch.path, 'sims?id=eq.7');
  assert.equal(patch.body.port_in_pending, false);
  assert.equal(patch.body.status_reason, 'atomic_portin_max_age');
  assert.match(patch.body.last_activation_error, /polling stopped/);
});

test('ATOMIC_PORTIN_MAX_AGE_DAYS overrides the 14-day stop', async () => {
  const h = harness([sim(1, { submittedAgo: 15 * DAY, checkedAgo: 7 * HOUR })], { env: { ATOMIC_PORTIN_MAX_AGE_DAYS: '30' } });
  const out = await h.run();
  assert.equal(out.expired, 0);
  assert.equal(out.checked, 1);
});

test('terminal CO still finalizes the SIM to active', async () => {
  const s = sim(3, { submittedAgo: 20 * MIN });
  const h = harness([s], {
    portinStatus: { [s.msisdn]: { statusCode: '00', description: 'Success', result: { reasonCode: 'CO', reasonDescription: 'Completed', MSISDN: s.msisdn } } },
  });
  const out = await h.run();
  assert.equal(out.terminal, 1);
  assert.equal(out.results[0].finalized, true);
  assert.deepEqual(h.calls.carrier, ['/atomic-portin-status', '/atomic-inquiry']);
  const final = h.calls.patches.find(p => p.body.status === 'active');
  assert.ok(final, 'SIM patched to active');
  assert.equal(final.body.port_in_pending, false);
  assert.equal(final.body.rotation_status, 'success');
  assert.equal(final.body.att_ban, '123456789');
});

test('the sims query skips recently checked rows and orders stalest first', async () => {
  const h = harness([]);
  await h.run();
  const [path] = h.calls.selects;
  assert.match(path, /vendor=eq\.atomic&status=eq\.provisioning&port_in_pending=eq\.true/);
  assert.match(path, /sim_numbers\(valid_from\)/);
  assert.match(path, /sim_numbers\.valid_to=is\.null/);
  assert.match(path, /or=\(atomic_portin_checked_at\.is\.null,atomic_portin_checked_at\.lt\./);
  assert.match(path, /order=atomic_portin_checked_at\.asc\.nullsfirst/);
});
