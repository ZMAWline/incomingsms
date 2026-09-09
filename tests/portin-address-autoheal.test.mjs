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

test('pickRandomPortIdentity never draws an excluded address', () => {
  // Exclude all but one, then confirm every draw is that one.
  const keep = ADDRESS_POOL[42];
  const exclude = new Set(ADDRESS_POOL.filter(a => a.id !== keep.id).map(a => a.id));
  for (let i = 0; i < 100; i++) {
    const id = pickRandomPortIdentity(exclude);
    assert.equal(id.port_street_name, keep.streetName);
    assert.equal(id.port_address_id, keep.id);
  }
});

test('pickRandomPortIdentity returns the address id so a rejection can quarantine it', () => {
  const id = pickRandomPortIdentity();
  assert.ok(id.port_address_id, 'port_address_id must be present');
  assert.ok(ADDRESS_POOL.some(a => a.id === id.port_address_id));
});

test('excluding the whole pool falls back rather than throwing', () => {
  // A port submitted with a questionable address beats no port at all, and the
  // carrier is the final arbiter either way.
  const all = new Set(ADDRESS_POOL.map(a => a.id));
  const id = pickRandomPortIdentity(all);
  assert.ok(id.port_street_name, 'must still return an address');
});

test('accepts a plain array as well as a Set', () => {
  const keep = ADDRESS_POOL[7];
  const exclude = ADDRESS_POOL.filter(a => a.id !== keep.id).map(a => a.id);
  assert.equal(pickRandomPortIdentity(exclude).port_address_id, keep.id);
});

test('no exclusions behaves exactly as before', () => {
  for (const arg of [undefined, null, new Set(), []]) {
    assert.ok(pickRandomPortIdentity(arg).port_street_name);
  }
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

test('a rejected address is quarantined, redrawn, and resubmitted', () => {
  const fn = portInFn();
  assert.match(fn, /MAX_ADDRESS_ATTEMPTS = 3/);
  assert.match(fn, /markAddressVerifyFailure\(env, addressId, `portinRequest: \$\{description\}`\)/);
  assert.match(fn, /pickRandomPortIdentity\(quarantined\)/);
  assert.match(fn, /isAddressRejection\(description\)/);
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

test('the quarantine list is loaded once per batch, not per row', () => {
  assert.match(ACTIVATOR, /const excludeAddressIds = await loadQuarantinedAddressIds\(env\)/);
  const loop = ACTIVATOR.slice(
    ACTIVATOR.indexOf('for (let i = 0; i < sims.length; i++)'),
    ACTIVATOR.indexOf('validatedSims.push(checked.sim)')
  );
  assert.ok(!loop.includes('loadQuarantinedAddressIds'), 'must not reload inside the per-row loop');
});

test('quarantine respects the 90-day auto-retest used by the Apex PPU picker', () => {
  const loader = ACTIVATOR.slice(
    ACTIVATOR.indexOf('async function loadQuarantinedAddressIds'),
    ACTIVATOR.indexOf('/* ── Relay fetch helper')
  );
  assert.match(loader, /90 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(loader, /verify_failed_at=gte\./);
});

test('a quarantine lookup failure never blocks an activation', () => {
  const loader = ACTIVATOR.slice(
    ACTIVATOR.indexOf('async function loadQuarantinedAddressIds'),
    ACTIVATOR.indexOf('/* ── Relay fetch helper')
  );
  assert.match(loader, /catch/);
  assert.match(loader, /return new Set\(\)/);
});
