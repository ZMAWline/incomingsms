// atomic_portin_outcomes history rows: the real poller writes one on CO, on a
// terminal failure and on the max-age stop; a failed write never breaks
// finalization; the dashboard route returns the rows; PINs never land in them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAtomicPortinPoller } from '../src/details-finalizer/atomic-portin-poller.mjs';
import { buildPortinOutcomeRow, portinHumanReason, scrubPortinResponse } from '../src/shared/atomic-portin-outcomes.mjs';
import { readFileSync } from 'node:fs';
import { handlePortinOutcomes, loadLatestPortinOutcomes } from '../src/dashboard/portin-outcomes.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function sim(id, { submittedAgo = 10 * MIN, statusCode = null, description = null } = {}) {
  return {
    id,
    iccid: `8901280000000000${String(id).padStart(3, '0')}`,
    msisdn: `555000${String(id).padStart(4, '0')}`,
    gateway_host: 'skyline',
    created_at: ago(30 * DAY),
    atomic_portin_status_code: statusCode,
    atomic_portin_description: description,
    atomic_portin_checked_at: null,
    sim_numbers: [{ valid_from: ago(submittedAgo) }],
  };
}

function harness(sims, portinStatus, { failOutcomeInsert = false } = {}) {
  const calls = { patches: [], inserts: [] };
  const deps = {
    async supabaseSelect(env, path) {
      if (path.startsWith('sims?')) return sims;
      if (path.startsWith('sim_numbers?')) {
        const id = Number(/sim_id=eq\.(\d+)/.exec(path)[1]);
        return [{ e164: `+1${sims.find(x => x.id === id).msisdn}` }];
      }
      throw new Error(`unexpected select ${path}`);
    },
    async supabasePatch(env, path, body) { calls.patches.push({ path, body }); },
    async supabaseInsert(env, table, rows) {
      if (failOutcomeInsert && table === 'atomic_portin_outcomes') throw new Error('db down');
      calls.inserts.push({ table, rows });
    },
    async closeCurrentNumber() { throw new Error('number should not roll'); },
    async insertNewNumber() { throw new Error('number should not roll'); },
    async logTeltikApiCall() {},
  };
  const env = {
    ADMIN_RUN_SECRET: 'test-secret',
    MDN_ROTATOR: {
      async fetch(url) {
        const u = new URL(url);
        if (u.pathname === '/atomic-portin-status') return Response.json(portinStatus);
        if (u.pathname === '/atomic-inquiry') {
          const s = sims.find(x => x.iccid === u.searchParams.get('iccid'));
          return Response.json({ ok: true, statusCode: '00', attStatus: 'Active', msisdn: s.msisdn });
        }
        throw new Error(`unexpected call ${url}`);
      },
    },
  };
  const poller = createAtomicPortinPoller(deps);
  return { calls, run: () => poller.runAtomicPortinStatusFinalizer(env, 50) };
}

const outcomeRows = (calls) => calls.inserts.filter(i => i.table === 'atomic_portin_outcomes').flatMap(i => i.rows);

test('CO completion writes a completed outcomes row after finalizing', async () => {
  const h = harness([sim(1)], { statusCode: '00', description: 'Success', result: { reasonCode: 'CO', MSISDN: '5550000001' } });
  const out = await h.run();
  assert.equal(out.terminal, 1);
  const rows = outcomeRows(h.calls);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'completed');
  assert.equal(rows[0].source, 'portin_status');
  assert.equal(rows[0].sim_id, 1);
  assert.equal(rows[0].iccid, sim(1).iccid);
  assert.equal(rows[0].carrier_code, '00');
  assert.equal(rows[0].carrier_reason_code, 'CO');
  assert.ok(rows[0].recorded_at);
  assert.ok(h.calls.patches.some(p => p.body.status === 'active'), 'SIM still finalized to active');
});

test('948 writes a failed row with the human reason', async () => {
  const h = harness([sim(2)], { statusCode: '948', description: 'Error!!Port Request Does Not Exist' });
  await h.run();
  const [row] = outcomeRows(h.calls);
  assert.equal(row.outcome, 'failed');
  assert.equal(row.carrier_code, '948');
  assert.equal(row.carrier_description, 'Port Request Does Not Exist');
  assert.equal(row.raw_response.description, 'Error!!Port Request Does Not Exist');
});

test('951 keeps the losing carrier reason, not the wrapper text', async () => {
  const h = harness([sim(3)], {
    statusCode: '951',
    description: 'Portin status fail.Conflict ~ statusReasonCode - 6B ~ statusReasonDescription - T-Mobile Number Transfer PIN is required or incorrect',
    result: { reasonCode: 'CT' },
  });
  await h.run();
  const [row] = outcomeRows(h.calls);
  assert.equal(row.outcome, 'failed');
  assert.equal(row.carrier_reason_code, 'CT');
  assert.equal(row.carrier_description, 'T-Mobile Number Transfer PIN is required or incorrect');
});

test('max-age stop writes an abandoned row', async () => {
  const h = harness([sim(4, { submittedAgo: 15 * DAY, statusCode: '01', description: 'Pending' })], {});
  const out = await h.run();
  assert.equal(out.expired, 1);
  const [row] = outcomeRows(h.calls);
  assert.equal(row.outcome, 'abandoned');
  assert.equal(row.source, 'max_age');
  assert.equal(row.carrier_code, '01');
  assert.match(row.carrier_description, /14 days/);
});

test('a failed outcomes write does not break finalization', async () => {
  const h = harness([sim(5)], { statusCode: '00', description: 'Success', result: { reasonCode: 'CO' } }, { failOutcomeInsert: true });
  const out = await h.run();
  assert.equal(out.errors, 0);
  assert.equal(out.terminal, 1);
  assert.equal(out.results[0].finalized, true);
  assert.ok(h.calls.patches.some(p => p.body.status === 'active' && p.body.port_in_pending === false));

  const h2 = harness([sim(6)], { statusCode: '948', description: 'Error!!Port Request Does Not Exist' }, { failOutcomeInsert: true });
  const out2 = await h2.run();
  assert.equal(out2.errors, 0);
  assert.ok(h2.calls.patches.some(p => p.body.port_in_pending === false));
});

test('PIN, password and account number are scrubbed from the raw response', () => {
  const raw = {
    statusCode: '951',
    pin: '584486',
    wholeSaleApi: { session: { userName: 'u', password: 'secret', pin: '1234' } },
    subscriber: { portPin: '999', accountNumber: '992388721', port_account_number: '1', zip: '10001' },
    list: [{ PIN: '1' , keep: 'yes' }],
  };
  const scrubbed = scrubPortinResponse(raw);
  const text = JSON.stringify(scrubbed);
  for (const secret of ['584486', 'secret', '1234', '999', '992388721']) assert.ok(!text.includes(secret), secret);
  assert.equal(scrubbed.subscriber.zip, '10001');
  assert.equal(scrubbed.list[0].keep, 'yes');
  const row = buildPortinOutcomeRow({ iccid: '89', outcome: 'failed', source: 'portin_request', description: 'x', raw });
  assert.ok(!JSON.stringify(row).includes('584486'));
  assert.ok(!JSON.stringify(row).includes('992388721'));
});

test('portinHumanReason handles empty and plain descriptions', () => {
  assert.equal(portinHumanReason(null), null);
  assert.equal(portinHumanReason('Sim does not belong to this MVNO'), 'Sim does not belong to this MVNO');
});

test('GET /api/sims/:id/portin-outcomes returns the rows newest first', async () => {
  const worker = readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
  const route = new RegExp(/url\.pathname\.match\(\/(.+)\/\);\n.*\n\s+return handlePortinOutcomes/.exec(worker)[1]);
  assert.equal('/api/sims/42/portin-outcomes'.match(route)[1], '42');
  assert.equal('/api/sims/abc/portin-outcomes'.match(route), null);
  const seen = [];
  const rows = [
    { id: 2, sim_id: 42, outcome: 'failed', carrier_description: 'Account number required or incorrect', recorded_at: '2026-09-20T00:00:00Z' },
    { id: 1, sim_id: 42, outcome: 'failed', carrier_description: 'Port Request Does Not Exist', recorded_at: '2026-09-10T00:00:00Z' },
  ];
  const fakeFetch = async (url) => { seen.push(url); return Response.json(rows); };
  const res = await handlePortinOutcomes({ SUPABASE_URL: 'https://db', SUPABASE_SERVICE_ROLE_KEY: 'k' }, {}, '42', fakeFetch);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sim_id, 42);
  assert.deepEqual(body.outcomes, rows);
  assert.match(seen[0], /atomic_portin_outcomes\?select=.*&sim_id=eq\.42&order=recorded_at\.desc/);
});

test('loadLatestPortinOutcomes keeps the newest row per SIM and survives a DB error', async () => {
  const rows = [
    { sim_id: 1, outcome: 'failed', recorded_at: '2026-09-20T00:00:00Z' },
    { sim_id: 1, outcome: 'completed', recorded_at: '2026-09-01T00:00:00Z' },
    { sim_id: 2, outcome: 'completed', recorded_at: '2026-09-02T00:00:00Z' },
  ];
  const env = { SUPABASE_URL: 'https://db', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const latest = await loadLatestPortinOutcomes(env, [1, 2], async () => Response.json(rows));
  assert.equal(latest.get(1).outcome, 'failed');
  assert.equal(latest.get(2).outcome, 'completed');
  const empty = await loadLatestPortinOutcomes(env, [1], async () => new Response('x', { status: 500 }));
  assert.equal(empty.size, 0);
});
