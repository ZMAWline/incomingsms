// Regression test: the queue() consumer's "already activated" idempotency
// guard used to check only whether sims.msisdn / mobility_subscription_id was
// non-empty. sim-canceller sets status='canceled' without clearing those
// columns, so a canceled SIM being re-activated (e.g. re-ported to a new MDN)
// was silently skipped — msg.ack() with just a console.log, no DB update, no
// carrier_api_logs row, no Atomic call. The dashboard still reported
// "Queued N SIM(s)" because the message reached the queue fine; the silent
// skip happened one step later, inside the consumer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/bulk-activator/index.js';

function mockEnv(sims) {
  const calls = { carrierApiLogs: [], simPatches: [] };
  const table = { sims };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    const path = u.split('/rest/v1/')[1];
    const [tableName, qs] = path.split('?');

    if (tableName === 'sims' && method === 'GET') {
      const iccidMatch = /iccid=eq\.([^&]+)/.exec(qs || '');
      const iccid = iccidMatch ? decodeURIComponent(iccidMatch[1]) : null;
      const rows = table.sims.filter(s => s.iccid === iccid);
      return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
    }
    if (tableName === 'sims' && method === 'PATCH') {
      const body = JSON.parse(init.body);
      calls.simPatches.push(body);
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    }
    if (tableName === 'carrier_api_logs' && method === 'POST') {
      calls.carrierApiLogs.push(JSON.parse(init.body));
      return { ok: true, status: 201, json: async () => [], text: async () => '' };
    }
    // Any other call (e.g. the actual Atomic port-in POST) — record and fail
    // the test loudly rather than silently succeeding, since these tests must
    // never perform a live carrier call.
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  };
  return {
    env: { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' },
    calls,
  };
}

function makeBatch(body) {
  const acked = { count: 0 };
  return {
    batch: { messages: [{ body, ack: () => { acked.count++; } }] },
    acked,
  };
}

test('queue consumer does NOT skip a canceled SIM with a stale msisdn', async () => {
  const { env, calls } = mockEnv([
    { id: 770, iccid: '89014104334606221029', mobility_subscription_id: null, msisdn: '3022376083', vendor: 'atomic', status: 'canceled' },
  ]);
  const { batch, acked } = makeBatch({
    iccid: '89014104334606221029',
    imei: '357364091116839',
    reseller_id: 1,
    run_id: 'test_run',
    vendor: 'atomic',
    port_mdn: '9297431592',
    port_account_number: '201732496',
    port_pin: '364551',
    // Missing required subscriber/old_service_provider fields — the port-in
    // guard in activateViaAtomicPortIn will refuse and record an error. That's
    // fine for this test: what matters is that it gets THAT far (i.e. is not
    // silently skipped by the "already activated" check) rather than acking
    // with zero DB/log trace, which was the actual production symptom.
  });

  await worker.queue(batch, env);

  assert.equal(acked.count, 1, 'message should still be acked (error path acks to avoid infinite retry)');
  assert.equal(calls.carrierApiLogs.length, 0, 'no carrier call expected — port-in guard refuses before the HTTP call');
  assert.equal(calls.simPatches.length, 1, 'sim row should be updated with an error, not silently left untouched');
  assert.equal(calls.simPatches[0].status, 'error');
  assert.match(calls.simPatches[0].last_activation_error, /missing required field/);
});

test('queue consumer DOES skip a SIM that is genuinely still active', async () => {
  const { env, calls } = mockEnv([
    { id: 771, iccid: '89014104334606221030', mobility_subscription_id: null, msisdn: '3022376084', vendor: 'atomic', status: 'active' },
  ]);
  const { batch, acked } = makeBatch({
    iccid: '89014104334606221030',
    imei: '357364091116840',
    reseller_id: 1,
    run_id: 'test_run',
    vendor: 'atomic',
  });

  await worker.queue(batch, env);

  assert.equal(acked.count, 1);
  assert.equal(calls.carrierApiLogs.length, 0);
  assert.equal(calls.simPatches.length, 0, 'active SIM should be skipped without any patch attempt');
});
