// SIM stats (src/dashboard/sim-stats.mjs): bounded RPC calls, and a failed
// lookup reported as unavailable rather than as valid zero counts.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadSimStats, simStatFields, statSourceFor } from '../src/dashboard/sim-stats.mjs';

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; });

// `respond(fn, simIds, init)` answers each RPC call; calls are recorded.
function stubRpc(respond) {
  const calls = [];
  console.error = () => {};
  globalThis.fetch = async (u, init) => {
    const fn = String(u).split('/rpc/')[1];
    const simIds = JSON.parse(init.body).sim_ids;
    calls.push({ fn, simIds });
    return respond(fn, simIds, init);
  };
  return calls;
}

const atomic = (id) => ({ id, vendor: 'atomic', gateway_host: null });
const teltik = (id) => ({ id, vendor: 'teltik', gateway_host: 'teltik' });

test('SMS rows map to counts; a SIM with no SMS row is a valid zero', async () => {
  stubRpc((fn) => fn === 'get_sms_counts_24h'
    ? json([{ sim_id: 1, sms_count: '7', last_received: '2026-10-06T10:00:00Z' }])
    : json([{ sim_id: 2, last_state: 'online', checks_24h: 4, online_24h: 3, checks_7d: 20, online_7d: 18 }]));
  const stats = await loadSimStats(ENV, [atomic(1), teltik(2)]);
  assert.deepEqual(stats.unavailable, []);
  const one = simStatFields(1, stats);
  assert.equal(one.sms_count, 7);
  assert.equal(one.last_sms_received, '2026-10-06T10:00:00Z');
  assert.equal(one.hosting_port_checks_24h, 0, 'a non-Teltik SIM has no checks');
  const two = simStatFields(2, stats);
  assert.equal(two.sms_count, 0);
  assert.equal(two.hosting_port_state, 'online');
  assert.equal(two.hosting_port_online_24h, 3);
  assert.deepEqual(two.stats_unavailable, []);
});

test('ids are chunked by 500 and only Teltik-hosted SIMs get the hosting RPC', async () => {
  const calls = stubRpc(() => json([]));
  const sims = Array.from({ length: 1200 }, (_, i) => (i < 3 ? teltik(i + 1) : atomic(i + 1)));
  await loadSimStats(ENV, sims);
  const sms = calls.filter(c => c.fn === 'get_sms_counts_24h');
  assert.deepEqual(sms.map(c => c.simIds.length).sort((a, b) => a - b), [200, 500, 500]);
  const hp = calls.filter(c => c.fn === 'get_hosting_port_status_summary');
  assert.deepEqual(hp.map(c => c.simIds), [[1, 2, 3]]);
});

test('no SIMs means no RPC calls', async () => {
  const calls = stubRpc(() => json([]));
  const stats = await loadSimStats(ENV, []);
  assert.equal(calls.length, 0);
  assert.deepEqual(stats.unavailable, []);
});

test('a failed SMS RPC is unavailable, not zero, and leaves hosting stats intact', async () => {
  stubRpc((fn) => fn === 'get_sms_counts_24h'
    ? json({ code: 'PGRST000', message: 'db down' }, 503)
    : json([{ sim_id: 2, last_state: 'offline', checks_24h: 1, online_24h: 0, checks_7d: 1, online_7d: 0 }]));
  const stats = await loadSimStats(ENV, [teltik(2)]);
  assert.deepEqual(stats.unavailable, ['sms']);
  const f = simStatFields(2, stats);
  assert.equal(f.sms_count, null);
  assert.equal(f.last_sms_received, null);
  assert.equal(f.hosting_port_state, 'offline');
  assert.deepEqual(f.stats_unavailable, ['sms']);
});

test('a network error on the hosting RPC nulls its counts instead of zeroing them', async () => {
  stubRpc((fn) => {
    if (fn === 'get_hosting_port_status_summary') throw new TypeError('fetch failed');
    return json([]);
  });
  const stats = await loadSimStats(ENV, [teltik(2)]);
  assert.deepEqual(stats.unavailable, ['hosting_port']);
  const f = simStatFields(2, stats);
  assert.equal(f.hosting_port_state, null);
  assert.equal(f.hosting_port_checks_24h, null);
  assert.equal(f.hosting_port_online_7d, null);
  assert.equal(f.sms_count, 0, 'SMS stats still loaded');
});

test('a slow RPC is cut off by the Supabase timeout and reported unavailable', async () => {
  stubRpc((fn, ids, init) => fn === 'get_sms_counts_24h'
    ? new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    : json([]));
  const started = Date.now();
  const stats = await loadSimStats({ ...ENV, FETCH_TIMEOUT_SUPABASE_MS: '30' }, [atomic(1)]);
  assert.ok(Date.now() - started < 2000, 'returned promptly after the timeout');
  assert.deepEqual(stats.unavailable, ['sms']);
});

test('one failed chunk makes the whole group unavailable, never a partial map', async () => {
  stubRpc((fn, ids) => (ids[0] === 501 ? json({ message: 'boom' }, 500) : json(ids.map(id => ({ sim_id: id, sms_count: 1 })))));
  const stats = await loadSimStats(ENV, Array.from({ length: 600 }, (_, i) => atomic(i + 1)));
  assert.deepEqual(stats.unavailable, ['sms']);
  assert.equal(simStatFields(1, stats).sms_count, null);
});

test('a non-array RPC body is a failure, not an empty result', async () => {
  stubRpc(() => json({ unexpected: true }));
  const stats = await loadSimStats(ENV, [atomic(1)]);
  assert.deepEqual(stats.unavailable, ['sms']);
});

test('each derived column maps to the stats group that feeds it', () => {
  for (const col of ['sms_count', 'last_sms_received', 'no_sms_12h']) assert.equal(statSourceFor(col), 'sms');
  for (const col of ['hosting_port_state', 'hosting_port_source', 'hosting_port_checked_at', 'hosting_port_online_24h', 'hosting_port_checks_24h']) {
    assert.equal(statSourceFor(col), 'hosting_port');
  }
});
