// INC-2 rental-billing logic test.
//
// rentals.js is a worker-bundle ESM module (.js, imported by esbuild/wrangler),
// so Node cannot import it directly under the CommonJS package. We bundle it to
// a temp ESM file with esbuild first, then exercise the pure logic with a mocked
// global fetch standing in for PostgREST. This validates the plan's open
// questions without touching a live DB:
//   Q1 (dedup)    — capture idempotency is a DB UNIQUE constraint; here we prove
//                   the compute side counts one rental per row (no per-send fan-out).
//   Q2 (zero-SMS) — rentals are billed purely on existence + rental_date, with
//                   no SMS input, so a zero-SMS lifetime is still billable.
//   plus: forward-only cutover filter, flat per-carrier rate, effective-dating.

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const bundle = '/tmp/rentals.bundle.test.mjs';

// Build a fresh bundle so the test always reflects current source.
execFileSync('npx', ['--yes', 'esbuild', 'src/shared/rentals.js', '--bundle',
  '--format=esm', '--outfile=' + bundle, '--log-level=error'], { cwd: repo });

const { computeRentalBilling, carrierForVendor, RENTAL_CUTOVER_DATE } = await import(bundle);

// --- fetch mock: route PostgREST paths to canned datasets -----------------
function makeEnv(tables) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const table = u.split('/rest/v1/')[1].split('?')[0];
    const rows = tables[table] || [];
    return { ok: true, status: 200, json: async () => rows, text: async () => '' };
  };
  return { SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: 'k' };
}

let passed = 0;
function ok(name) { passed++; console.log('  ok -', name); }

// --- carrier bucket mapping -----------------------------------------------
assert.equal(carrierForVendor('teltik'), 'tmobile');
assert.equal(carrierForVendor('atomic'), 'att');
assert.equal(carrierForVendor('helix'), 'att');
assert.equal(carrierForVendor('wing_iot'), 'att');
ok('carrierForVendor collapses vendors to att/tmobile buckets');

// --- main scenario: flat rate, cutover, dedup-by-row, zero-SMS ------------
{
  const env = makeEnv({
    resellers: [{ id: 7, name: 'TrustOTP' }],
    qbo_customer_map: [{ id: 1, qbo_customer_id: 'q', qbo_display_name: 'TrustOTP', daily_rate: '9.99' }],
    reseller_rental_rates: [
      { carrier: 'att', effective_from: '2026-05-22', effective_to: null, rate: '1.1000' },
      { carrier: 'tmobile', effective_from: '2026-05-22', effective_to: null, rate: '1.6000' },
    ],
    // PostgREST already filters rental_date >= effectiveStart; we hand back only
    // in-window rows (the worker query does the gte/lte). 3 att + 2 tmobile.
    rentals: [
      { carrier: 'att', rental_date: '2026-05-22', reseller_rental_id: 'a1' },
      { carrier: 'att', rental_date: '2026-05-22', reseller_rental_id: 'a2' },
      { carrier: 'att', rental_date: '2026-05-23', reseller_rental_id: 'a3' },
      { carrier: 'tmobile', rental_date: '2026-05-23', reseller_rental_id: 't1' },
      { carrier: 'tmobile', rental_date: '2026-05-24', reseller_rental_id: 't2' },
    ],
  });

  const r = await computeRentalBilling(env, { resellerId: 7, start: '2026-05-01', end: '2026-05-31' });

  assert.equal(r.billing_mode, 'rental');
  assert.equal(r.total_rentals, 5, 'one billable unit per rental row (no per-send fan-out)');
  // 3*1.10 + 2*1.60 = 3.30 + 3.20 = 6.50
  assert.equal(r.total_amount, 6.5, 'flat per-carrier rate applied, SMS volume irrelevant');
  assert.equal(r.rate_fallback_used, false, 'configured rates used, not qbo daily_rate fallback');
  // Per 2026-06-01 decision (decision-log.md): no clamp — effectiveStart = the
  // requested start. The cutover is operational, not a calculator limit.
  assert.equal(r.cutover, '2026-05-01');
  ok('flat-rate rental billing: 3 AT&T @1.10 + 2 T-Mobile @1.60 = $6.50');
}

// --- effective-dating: a rate change picks the rule active on rental_date --
{
  const env = makeEnv({
    resellers: [{ id: 7, name: 'TrustOTP' }],
    qbo_customer_map: [{ id: 1, daily_rate: '0' }],
    reseller_rental_rates: [
      { carrier: 'att', effective_from: '2026-05-22', effective_to: '2026-05-23', rate: '1.1000' },
      { carrier: 'att', effective_from: '2026-05-24', effective_to: null, rate: '1.2500' },
    ],
    rentals: [
      { carrier: 'att', rental_date: '2026-05-22', reseller_rental_id: 'a1' }, // old rate
      { carrier: 'att', rental_date: '2026-05-25', reseller_rental_id: 'a2' }, // new rate
    ],
  });
  const r = await computeRentalBilling(env, { resellerId: 7, start: '2026-05-22', end: '2026-05-31' });
  // 1.10 + 1.25 = 2.35
  assert.equal(r.total_amount, 2.35, 'each rental priced by the rate effective on its rental_date');
  ok('effective-dated rate change applied per rental_date');
}

// --- missing rate falls back to qbo daily_rate and flags it ----------------
{
  const env = makeEnv({
    resellers: [{ id: 7, name: 'TrustOTP' }],
    qbo_customer_map: [{ id: 1, daily_rate: '2.00' }],
    reseller_rental_rates: [], // no rules configured
    rentals: [{ carrier: 'att', rental_date: '2026-05-22', reseller_rental_id: 'a1' }],
  });
  const r = await computeRentalBilling(env, { resellerId: 7, start: '2026-05-22', end: '2026-05-31' });
  assert.equal(r.total_amount, 2.0, 'falls back to qbo daily_rate when no rental rate configured');
  assert.equal(r.rate_fallback_used, true, 'fallback is flagged so a misconfig is visible, not silent');
  ok('missing rental rate falls back to daily_rate and sets rate_fallback_used');
}

console.log(`\nrentals.test.mjs: ${passed} checks passed`);
