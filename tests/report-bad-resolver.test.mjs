// INC-3 — report-bad identifier resolver contract tests.
//
// Contract enforced by `src/reseller-portal/report-bad-resolver.js`:
//   ACCEPT:  reseller_rental_id (string), e164 (current MDN of owned SIM).
//   REJECT:  sim_id, iccid, rental_id (internal), historical/original MDN.
//
// These tests mock PostgREST via a sbGet stub fed canned table rows; the
// resolver is exercised directly (pure module).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const bundle = '/tmp/report-bad-resolver.bundle.test.' + process.pid + '.mjs';

execFileSync('npx', ['--yes', 'esbuild',
  'src/shared/report-bad-resolver.js',
  '--bundle', '--format=esm', '--outfile=' + bundle, '--log-level=error',
], { cwd: repo });

const { resolveRentalForReport } = await import(bundle + '?cache=' + Date.now());

// ---- canned dataset ------------------------------------------------------
// Reseller 3 owns SIM 3500 (current MDN +17752002752, original was +18126100326)
// with rental 47111 (reseller_rental_id "1617922").
// Reseller 4 owns SIM 7777 (current MDN +14155550199) with rental 99001.

const RENTALS = [
  // INC-25 followup: rental on SIM 3500 now points to the CURRENT sim_number
  // (id 70362, e164 +17752002752) — used to assert ACCEPT current MDN.
  { id: 47111, reseller_id: 3, sim_id: 3500, sim_number_id: 70362, e164: '+17752002752', minted_at: '2026-05-29T22:08:59Z', reseller_rental_id: '1617922' },
  { id: 99001, reseller_id: 4, sim_id: 7777, sim_number_id: 88001, e164: '+14155550100', minted_at: '2026-05-30T00:00:00Z', reseller_rental_id: 'extra-1' },
];

const SIM_NUMBERS = [
  // current (valid_to NULL)
  { id: 70362, sim_id: 3500, e164: '+17752002752', valid_to: null },
  { id: 88002, sim_id: 7777, e164: '+14155550199', valid_to: null },
  // historical
  { id: 60362, sim_id: 3500, e164: '+18126100326', valid_to: '2026-05-30T00:00:00Z' },
  { id: 88001, sim_id: 7777, e164: '+14155550100', valid_to: '2026-05-30T12:00:00Z' },
];

const RESELLER_SIMS = [
  { reseller_id: 3, sim_id: 3500 },
  { reseller_id: 4, sim_id: 7777 },
];

// Tiny PostgREST-ish parser: route by table name, apply the filters the
// resolver actually uses (eq, in.(…), is.null), return matching rows.
function makeSbGet(tables) {
  return async function sbGet(_env, urlPath) {
    const [tableAndQuery] = [urlPath];
    const qIndex = tableAndQuery.indexOf('?');
    const table = qIndex === -1 ? tableAndQuery : tableAndQuery.slice(0, qIndex);
    const params = qIndex === -1 ? '' : tableAndQuery.slice(qIndex + 1);
    const filters = {};
    const orClauses = [];
    let limit = Infinity;
    for (const kv of params.split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = decodeURIComponent(kv.slice(0, eq));
      const v = decodeURIComponent(kv.slice(eq + 1));
      if (k === 'select' || k === 'order') continue;
      if (k === 'limit') { limit = Number(v); continue; }
      if (k === 'or') { orClauses.push(v); continue; }
      filters[k] = v;
    }
    let rows = (tables[table] || []).slice();
    for (const [col, expr] of Object.entries(filters)) {
      if (expr.startsWith('eq.')) {
        const target = expr.slice(3);
        rows = rows.filter(r => String(r[col]) === target);
      } else if (expr.startsWith('gte.')) {
        // ISO timestamps compare correctly as strings.
        const target = expr.slice(4);
        rows = rows.filter(r => r[col] != null && String(r[col]) >= target);
      } else if (expr === 'is.null') {
        rows = rows.filter(r => r[col] == null);
      } else if (expr.startsWith('in.(')) {
        const inner = expr.slice(4, -1);
        const set = new Set(inner.split(',').map(decodeURIComponent));
        rows = rows.filter(r => set.has(String(r[col])));
      } else {
        throw new Error('unhandled filter in test sbGet: ' + col + '=' + expr);
      }
    }
    for (const clause of orClauses) {
      const inner = clause.replace(/^\(/, '').replace(/\)$/, '');
      const parts = inner.split(',');
      rows = rows.filter(r => parts.some(p => {
        const m = p.match(/^([^.]+)\.eq\.(.+)$/);
        if (!m) return false;
        return String(r[m[1]]) === m[2];
      }));
    }
    if (Number.isFinite(limit)) rows = rows.slice(0, limit);
    return {
      ok: true,
      json: async () => rows.map(r => ({ ...r })),
    };
  };
}

const env = {};

function makeTables() {
  return {
    rentals: RENTALS.slice(),
    sim_numbers: SIM_NUMBERS.slice(),
    reseller_sims: RESELLER_SIMS.slice(),
    webhook_deliveries: [],
  };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n    ' + (e.stack || e.message)); fail++; }
}

console.log('report-bad resolver contract:');

await t('REJECT sim_id', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { sim_id: 3500 }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /sim_id/);
});

await t('REJECT iccid', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { iccid: '89014103211118510720' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /iccid/);
});

await t('REJECT internal rental_id', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { rental_id: 47111 }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /rental_id/);
});

await t('REJECT historical/original MDN', async () => {
  // +18126100326 is SIM 3500's ORIGINAL MDN — sim_numbers row has valid_to set.
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { e164: '+18126100326' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.match(r.message, /no active SIM/);
});

await t('REJECT mixed sim_id+e164', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { sim_id: 3500, e164: '+17752002752' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /sim_id/);
});

await t('REJECT missing identifier', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, {}, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /required/);
});

await t('ACCEPT reseller_rental_id within scope', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { reseller_rental_id: '1617922' }, sb);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rental_id, 47111);
  assert.equal(r.sim_id, 3500);
});

await t('REJECT reseller_rental_id cross-reseller leak', async () => {
  // Reseller 4 cannot resolve reseller 3's rental id.
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 4, { reseller_rental_id: '1617922' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

await t('ACCEPT current MDN of owned SIM', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { e164: '+17752002752' }, sb);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rental_id, 47111);
  assert.equal(r.sim_id, 3500);
  assert.equal(r.e164, '+17752002752');
});

await t('REJECT current MDN owned by a different reseller', async () => {
  // +14155550199 is reseller 4's current MDN; reseller 3 cannot reach it.
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { e164: '+14155550199' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

await t('NORMALIZE e164 (digits-only input gets +)', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { e164: '17752002752' }, sb);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.e164, '+17752002752');
});

await t('REJECT implausible e164', async () => {
  const sb = makeSbGet(makeTables());
  const r = await resolveRentalForReport(env, 3, { e164: '12' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_request');
  assert.match(r.message, /plausible/);
});

await t('AMBIGUOUS — two owned SIMs share the same current MDN', async () => {
  const tables = makeTables();
  // Add a second SIM owned by reseller 3 that shares the same current MDN.
  tables.sim_numbers.push({ sim_id: 9999, e164: '+17752002752', valid_to: null });
  tables.reseller_sims.push({ reseller_id: 3, sim_id: 9999 });
  tables.rentals.push({ id: 60001, reseller_id: 3, sim_id: 9999, sim_number_id: 70000, e164: '+17752002752', minted_at: '2026-05-31T00:00:00Z', reseller_rental_id: 'extra-2' });
  const sb = makeSbGet(tables);
  const r = await resolveRentalForReport(env, 3, { e164: '+17752002752' }, sb);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ambiguous');
  assert.match(r.message, /reseller_rental_id/);
});

// INC-25 followup — report #3 shape: current MDN is on an owned SIM, but no
// rental row exists for that current MDN. The latest rental on the SIM is
// historical (different e164, different sim_number_id). The resolver must
// NOT fall back to the historical rental; it must return unresolved so the
// handler can flag the report `escalated / intake_unresolved_current_mdn_no_rental`.
await t('REPORT-3 shape: current MDN with no matching rental → unresolved (no historical fallback)', async () => {
  const tables = makeTables();
  // SIM 3501 — current MDN +18465776590 (sim_number 68411), historical MDN
  // +12345678249 (sim_number 60361). Reseller owns the SIM. Only rental on
  // SIM points to the historical sim_number.
  tables.sim_numbers.push({ id: 68411, sim_id: 3501, e164: '+18465776590', valid_to: null });
  tables.sim_numbers.push({ id: 60361, sim_id: 3501, e164: '+12345678249', valid_to: '2026-05-30T08:15:11.756Z' });
  tables.reseller_sims.push({ reseller_id: 3, sim_id: 3501 });
  tables.rentals.push({ id: 47116, reseller_id: 3, sim_id: 3501, sim_number_id: 60361, e164: '+12345678249', minted_at: '2026-05-30T00:00:00Z', reseller_rental_id: 'r3-historical' });

  const sb = makeSbGet(tables);
  const r = await resolveRentalForReport(env, 3, { e164: '+18465776590' }, sb);

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.unresolved, true, 'expected unresolved=true');
  assert.equal(r.intake_state, 'current_mdn_no_rental_row');
  assert.equal(r.rental_id, null, 'must NOT attach to historical rental 47116');
  assert.equal(r.sim_id, 3501);
  assert.equal(r.sim_number_id, 68411, 'should report the CURRENT sim_number_id, not the historical 60361');
  assert.equal(r.e164, '+18465776590');
});

// ---------------------------------------------------------------------------
// SELF-HEAL (2026-06-12) — `intake_unresolved_current_mdn_no_rental` recovery.
//
// When the current-MDN e164 resolves to an owned SIM but no rentals row
// matches the current sim_number, the resolver must FIRST look for proof in
// webhook_deliveries: the most recent delivered `number.online` row for that
// SIM (last 14 days) whose payload number matches the reported e164 and whose
// stored response_body carries the reseller's rentalId. If found, it backfills
// the rentals row (persist-rental.mjs semantics, on_conflict
// reseller_id,sim_number_id), re-runs the rental lookup, and resolves with
// `self_healed: 'rental_backfilled_from_delivery'`. Otherwise it escalates
// exactly as before (REPORT-3 shape above stays pinned).
// ---------------------------------------------------------------------------

const healEnv = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fake',
};

// SIM 3501 — current MDN +18465776590 (sim_number 68411), historical rental
// only (same shape as the REPORT-3 test above).
function addNoRentalShape(tables) {
  tables.sim_numbers.push({ id: 68411, sim_id: 3501, e164: '+18465776590', valid_from: '2026-05-30T08:15:11.756Z', valid_to: null });
  tables.sim_numbers.push({ id: 60361, sim_id: 3501, e164: '+12345678249', valid_to: '2026-05-30T08:15:11.756Z' });
  tables.reseller_sims.push({ reseller_id: 3, sim_id: 3501 });
  tables.rentals.push({ id: 47116, reseller_id: 3, sim_id: 3501, sim_number_id: 60361, e164: '+12345678249', minted_at: '2026-05-30T00:00:00Z', reseller_rental_id: 'r3-historical' });
}

function makeDelivery(over = {}) {
  return {
    id: 9001,
    reseller_id: 3,
    sim_id: 3501,
    event_type: 'number.online',
    status: 'delivered',
    delivered_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
    payload: { event_type: 'number.online', data: { sim_id: 3501, number: '+18465776590', carrier: 'att' } },
    response_body: '{"success":true,"message":"Rental created","rentalId":1799001}',
    ...over,
  };
}

// Fake fetch for the persist-rental path (sims + sim_numbers lookups and the
// rentals upsert). Captures writes and reflects the upsert back into the
// canned tables so the resolver's re-run lookup can see the new rental row.
function makeHealFetch(tables, writes) {
  return async function fakeFetch(url, init) {
    const u = String(url);
    const resp = (status, rows) => ({ ok: status < 400, status, json: async () => rows, text: async () => JSON.stringify(rows) });
    if (u.includes('/rest/v1/sims?')) {
      return resp(200, [{ id: 3501, carrier: 'att', vendor: 'atomic' }]);
    }
    if (u.includes('/rest/v1/sim_numbers?')) {
      return resp(200, [{ id: 68411, sim_id: 3501, e164: '+18465776590', valid_from: '2026-05-30T08:15:11.756Z', valid_to: null }]);
    }
    if (u.includes('/rest/v1/rentals')) {
      const body = JSON.parse(init.body);
      writes.push({ url: u, init, body });
      tables.rentals.push({ id: 50001, minted_at: new Date().toISOString(), ...body });
      return resp(201, []);
    }
    return resp(404, []);
  };
}

await t('SELF-HEAL: no rental + delivered number.online with rentalId → backfills and resolves', async () => {
  const tables = makeTables();
  addNoRentalShape(tables);
  tables.webhook_deliveries.push(makeDelivery());
  const writes = [];
  const sb = makeSbGet(tables);

  const r = await resolveRentalForReport(healEnv, 3, { e164: '+18465776590' }, sb, { fetchImpl: makeHealFetch(tables, writes) });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.unresolved, true, 'must not escalate when delivery proof exists: ' + JSON.stringify(r));
  assert.equal(r.self_healed, 'rental_backfilled_from_delivery');
  assert.equal(r.rental_id, 50001, 'must resolve to the freshly backfilled rental');
  assert.equal(r.sim_id, 3501);
  assert.equal(r.sim_number_id, 68411);
  assert.equal(r.e164, '+18465776590');
  // The rentals upsert must follow persist-rental semantics.
  assert.equal(writes.length, 1, 'exactly one rentals upsert');
  assert.match(writes[0].url, /on_conflict=reseller_id%2Csim_number_id|on_conflict=reseller_id,sim_number_id/);
  assert.equal(writes[0].body.reseller_id, 3);
  assert.equal(writes[0].body.sim_number_id, 68411);
  assert.equal(writes[0].body.reseller_rental_id, '1799001');
});

await t('SELF-HEAL: no rental + NO delivery → escalates unchanged (unresolved)', async () => {
  const tables = makeTables();
  addNoRentalShape(tables);
  const writes = [];
  const sb = makeSbGet(tables);

  const r = await resolveRentalForReport(healEnv, 3, { e164: '+18465776590' }, sb, { fetchImpl: makeHealFetch(tables, writes) });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.unresolved, true);
  assert.equal(r.intake_state, 'current_mdn_no_rental_row');
  assert.equal(r.rental_id, null);
  assert.equal(r.self_healed, undefined, 'must not claim self-heal');
  assert.equal(writes.length, 0, 'no rentals write');
});

await t('SELF-HEAL: no rental + delivery without rentalId in body → escalates unchanged', async () => {
  const tables = makeTables();
  addNoRentalShape(tables);
  tables.webhook_deliveries.push(makeDelivery({ response_body: '{"success":true}' }));
  const writes = [];
  const sb = makeSbGet(tables);

  const r = await resolveRentalForReport(healEnv, 3, { e164: '+18465776590' }, sb, { fetchImpl: makeHealFetch(tables, writes) });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.unresolved, true);
  assert.equal(r.intake_state, 'current_mdn_no_rental_row');
  assert.equal(r.rental_id, null);
  assert.equal(writes.length, 0, 'no rentals write');
});

await t('SELF-HEAL: delivery older than 14 days → escalates unchanged', async () => {
  const tables = makeTables();
  addNoRentalShape(tables);
  tables.webhook_deliveries.push(makeDelivery({
    delivered_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), // 20 days ago
  }));
  const writes = [];
  const sb = makeSbGet(tables);

  const r = await resolveRentalForReport(healEnv, 3, { e164: '+18465776590' }, sb, { fetchImpl: makeHealFetch(tables, writes) });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.unresolved, true);
  assert.equal(writes.length, 0, 'no rentals write');
});

await t('SELF-HEAL: delivery for a DIFFERENT number on the SIM → escalates unchanged', async () => {
  const tables = makeTables();
  addNoRentalShape(tables);
  tables.webhook_deliveries.push(makeDelivery({
    payload: { event_type: 'number.online', data: { sim_id: 3501, number: '+12345678249', carrier: 'att' } },
  }));
  const writes = [];
  const sb = makeSbGet(tables);

  const r = await resolveRentalForReport(healEnv, 3, { e164: '+18465776590' }, sb, { fetchImpl: makeHealFetch(tables, writes) });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.unresolved, true);
  assert.equal(writes.length, 0, 'no rentals write');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
