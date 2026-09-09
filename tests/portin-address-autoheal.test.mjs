// Auto-heal loop for carrier-rejected port-in addresses.
//
// Background: on 2026-09-08 eight port-ins failed with "streetName Is Invalid",
// "streetNumber Is Invalid" or "Invalid Zipcode". Every one of those addresses
// was ALREADY quarantined in address_pool_usage, flagged earlier by the Apex
// PPU path — pickRandomPortIdentity just never read the table. These tests pin
// both halves of the fix: don't draw a known-bad address, and quarantine a new
// one the moment the carrier rejects it.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';
import { pickRandomPortIdentity, isAddressRejection } from '../src/shared/activation-bulk.mjs';

const ACTIVATOR = readFileSync('src/bulk-activator/index.js', 'utf8');

/* ── picking ─────────────────────────────────────────────────────────────── */

const DB_POOL = [
  { id: 'zz-00001-1-alpha-street', streetNumber: '1', streetName: 'Alpha Street', zipCode: '00001' },
  { id: 'zz-00002-2-beta-road', streetNumber: '2', streetName: 'Beta Road', zipCode: '00002' },
];

test('pickRandomPortIdentity draws from the live pool when one is supplied', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(pickRandomPortIdentity(DB_POOL).port_address_id);
  assert.deepEqual([...ids].sort(), DB_POOL.map(a => a.id).sort());
});

test('a deleted address simply is not in the pool, so it can never be drawn', () => {
  // Membership IS the filter now — there is no flag to consult and no 90-day
  // window for a deleted address to come back through.
  const afterDelete = DB_POOL.slice(0, 1);
  for (let i = 0; i < 100; i++) {
    assert.equal(pickRandomPortIdentity(afterDelete).port_address_id, 'zz-00001-1-alpha-street');
  }
});

test('falls back to the code pool when the DB pool is empty or missing', () => {
  // Keeps TEST and any un-seeded environment working instead of failing every
  // activation.
  for (const arg of [undefined, null, []]) {
    const id = pickRandomPortIdentity(arg);
    assert.ok(id.port_street_name);
    assert.ok(ADDRESS_POOL.some(a => a.id === id.port_address_id));
  }
});

test('pickRandomPortIdentity returns the address id so a rejection can delete it', () => {
  const id = pickRandomPortIdentity();
  assert.ok(id.port_address_id);
  assert.ok(ADDRESS_POOL.some(a => a.id === id.port_address_id));
});

/* ── rejection detection ─────────────────────────────────────────────────── */

test('isAddressRejection matches the real carrier wordings', () => {
  const fn = isAddressRejection;

  // Observed verbatim in PROD carrier_api_logs.
  assert.equal(fn('Error!!streetName Is Invalid'), true);
  assert.equal(fn('Error!!streetNumber Is Invalid'), true);
  assert.equal(fn('Invalid Zipcode.'), true);
  assert.equal(fn('ATOMIC UpdateSubscriberInfo failed: City is blank.'), true);

  // Must NOT fire on failures that have nothing to do with the address —
  // redrawing would not fix these, and quarantining a good address shrinks the
  // pool for no reason.
  assert.equal(fn('Error!!Port Request Does Not Exist'), false);
  assert.equal(fn('Error!!A Resource Required By Service Is Not Available'), false);
  assert.equal(fn('Portin status fail.Conflict ~ statusReasonCode - 8A'), false);
  assert.equal(fn('This MSIDN is not eligible for the Portin.'), false);
  assert.equal(fn(''), false);
  assert.equal(fn(null), false);
});

/* ── the loop ────────────────────────────────────────────────────────────── */

function portInFn() {
  const start = ACTIVATOR.indexOf('async function activateViaAtomicPortIn');
  return ACTIVATOR.slice(start, ACTIVATOR.indexOf('\nfunction mapPortFields', start));
}

test('a rejected address is deleted, redrawn, and resubmitted', () => {
  const fn = portInFn();
  assert.match(fn, /MAX_ADDRESS_ATTEMPTS = 3/);
  assert.match(fn, /deletePoolAddress\(env, addressId/);
  assert.match(fn, /pickRandomPortIdentity\(poolAddresses\)/);
  assert.match(fn, /isAddressRejection\(description\)/);
});

test('a deletion always writes an audit row before removing the address', () => {
  const fn = ACTIVATOR.slice(
    ACTIVATOR.indexOf('async function deletePoolAddress'),
    ACTIVATOR.indexOf('/* ── Relay fetch helper')
  );
  assert.ok(
    fn.indexOf("address_pool_deletions") < fn.indexOf('supabaseDelete'),
    'audit row must be written before the delete, or a failed delete loses the reason'
  );
});

test('markAddressVerifyFailure only fires on a real address rejection', () => {
  // The guard that stops a carrier outage from costing 391 addresses in a day.
  const picker = readFileSync('src/shared/address-picker.mjs', 'utf8');
  assert.match(picker, /if \(!isAddressRejection\(errorMessage\)\)/);
  assert.match(picker, /return;/);
});

test('the retry loop only swaps street and zip', () => {
  // The subscriber name is already arbitrary. old_service_provider must keep
  // matching the losing carrier's records exactly or the port rejects, so it
  // must never be redrawn.
  const fn = portInFn();
  const swap = fn.slice(fn.indexOf('portFields = {'), fn.indexOf('addressId = fresh.port_address_id'));
  assert.match(swap, /streetNumber: fresh\.port_street_number/);
  assert.match(swap, /streetName: fresh\.port_street_name/);
  assert.match(swap, /zip: fresh\.port_zip/);
  for (const f of ['oldFirstName', 'oldLastName']) {
    assert.ok(!swap.includes(f + ':'), `${f} must not be redrawn`);
  }
});

test('the pool is loaded once per batch, not per row', () => {
  assert.match(ACTIVATOR, /const addresses = await loadAddressPool\(env\)/);
  const loop = ACTIVATOR.slice(
    ACTIVATOR.indexOf('for (let i = 0; i < sims.length; i++)'),
    ACTIVATOR.indexOf('validatedSims.push(checked.sim)')
  );
  assert.ok(!loop.includes('loadAddressPool'), 'must not reload inside the per-row loop');
});





test('a pool load failure falls back rather than blocking activations', () => {
  const loader = ACTIVATOR.slice(
    ACTIVATOR.indexOf('async function loadAddressPool'),
    ACTIVATOR.indexOf('async function deletePoolAddress')
  );
  assert.match(loader, /catch/);
  assert.match(loader, /return \[\]/);
});
