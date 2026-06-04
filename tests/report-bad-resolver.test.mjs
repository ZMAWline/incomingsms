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
const bundle = '/tmp/report-bad-resolver.bundle.test.mjs';

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
  { id: 47111, reseller_id: 3, sim_id: 3500, sim_number_id: 60362, e164: '+18126100326', minted_at: '2026-05-29T22:08:59Z', reseller_rental_id: '1617922' },
  { id: 99001, reseller_id: 4, sim_id: 7777, sim_number_id: 88001, e164: '+14155550100', minted_at: '2026-05-30T00:00:00Z', reseller_rental_id: 'extra-1' },
];

const SIM_NUMBERS = [
  // current (valid_to NULL)
  { sim_id: 3500, e164: '+17752002752', valid_to: null },
  { sim_id: 7777, e164: '+14155550199', valid_to: null },
  // historical
  { sim_id: 3500, e164: '+18126100326', valid_to: '2026-05-30T00:00:00Z' },
  { sim_id: 7777, e164: '+14155550100', valid_to: '2026-05-30T12:00:00Z' },
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
    let limit = Infinity;
    for (const kv of params.split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      const k = decodeURIComponent(kv.slice(0, eq));
      const v = decodeURIComponent(kv.slice(eq + 1));
      if (k === 'select' || k === 'order') continue;
      if (k === 'limit') { limit = Number(v); continue; }
      filters[k] = v;
    }
    let rows = (tables[table] || []).slice();
    for (const [col, expr] of Object.entries(filters)) {
      if (expr.startsWith('eq.')) {
        const target = expr.slice(3);
        rows = rows.filter(r => String(r[col]) === target);
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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
