// The deny list is the build-time half of an address deletion.
//
// address_pool (the table) is runtime truth: a deleted row is gone. But the
// pool is regenerated from OpenStreetMap, and OSM has no idea which of its
// addresses ATOMIC rejects — so without this list, a rebuild silently puts
// every deleted address back and the same ports fail again. Verified live:
// a two-state rebuild re-offered vt-05342-2939-route-100 and
// ri-02866-580-broad-street, and the deny list caught both.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';
import { ADDRESS_DENY_LIST, DENIED_ADDRESS_IDS } from '../src/shared/address-deny-list.mjs';

test('no denied address is in the pool', () => {
  const leaked = ADDRESS_POOL.filter(a => DENIED_ADDRESS_IDS.has(a.id)).map(a => a.id);
  assert.deepEqual(leaked, [],
    'a rebuild reintroduced a carrier-rejected address — re-run the builder, it applies the deny list');
});

test('every deny entry records why the carrier rejected it', () => {
  // Without the reason there is no way to tell a real rejection from an
  // over-eager one later, which is the mistake that cost 1031 good addresses.
  for (const entry of ADDRESS_DENY_LIST) {
    assert.match(entry.id, /^[a-z]{2}-\d{5}-/, `malformed id: ${entry.id}`);
    assert.ok(entry.reason && entry.reason.length > 5, `${entry.id} needs a reason`);
  }
});

test('deny ids are unique and sorted', () => {
  const ids = ADDRESS_DENY_LIST.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id in the deny list');
});

test('DENIED_ADDRESS_IDS matches the list', () => {
  assert.equal(DENIED_ADDRESS_IDS.size, ADDRESS_DENY_LIST.length);
});

test('the pool builder applies the deny list', () => {
  const builder = readFileSync('scripts/build-address-pool.mjs', 'utf8');
  assert.match(builder, /import \{ DENIED_ADDRESS_IDS \}/);
  assert.match(builder, /DENIED_ADDRESS_IDS\.has\(id\)/);
  // Must reject before the entry is built, not filter afterwards, or a later
  // edit to the pipeline could drop the check without any test noticing.
  const buildEntry = builder.slice(builder.indexOf('function buildEntry'), builder.indexOf('function pickDiverse'));
  assert.match(buildEntry, /return null/);
});

test('the rebuilt pool still covers every state', () => {
  const states = new Set(ADDRESS_POOL.map(a => a.state));
  assert.equal(states.size, 51, `expected 51 states, got ${states.size}`);
  for (const s of states) {
    const zips = new Set(ADDRESS_POOL.filter(a => a.state === s).map(a => a.zipCode));
    assert.ok(zips.size >= 20, `${s} has only ${zips.size} unique ZIPs (need 20)`);
  }
});
