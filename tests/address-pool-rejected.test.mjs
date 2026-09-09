// Keeps carrier-rejected addresses out of the port-in identity pool.
//
// pickRandomPortIdentity indexes ADDRESS_POOL directly, so the runtime
// self-quarantine built for the Apex PPU path (address_pool_usage +
// markAddressVerifyFailure) does not cover it. An address ATOMIC rejects stays
// in rotation until it is deleted from address-pool.mjs by hand, and
// scripts/build-address-pool.mjs will reintroduce it on the next regeneration.
// This test is what catches that.

import { test } from 'node:test';
import assert from 'node:assert';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';
import { pickRandomPortIdentity } from '../src/shared/activation-bulk.mjs';

// Rejected by ATOMIC on portinRequest, 2026-09-04.
const CARRIER_REJECTED = [
  { streetNumber: '5106', streetName: 'Little Caillou Road', zipCode: '70344', error: 'streetName Is Invalid' },
  { streetNumber: '2939', streetName: 'Route 100', zipCode: '05342', error: 'streetName Is Invalid' },
  { streetNumber: '6700', streetName: 'Juniper Bay Road', zipCode: '29544', error: 'streetName Is Invalid' },
  { streetNumber: '3120', streetName: 'East Azure Avenue', zipCode: '89081', error: 'streetNumber Is Invalid' },
  { streetNumber: '5616', streetName: 'Ox Road', zipCode: '22039', error: 'streetNumber Is Invalid' },
  { streetNumber: '125', streetName: '3rd Avenue South', zipCode: '57226', error: 'streetNumber Is Invalid' },
  { streetNumber: '110', streetName: 'Hinton Waters Avenue', zipCode: '36350', error: 'streetNumber Is Invalid' },
  { streetNumber: '212', streetName: 'West Main Street', zipCode: '97550', error: 'Invalid Zipcode' },
];

for (const bad of CARRIER_REJECTED) {
  test(`ADDRESS_POOL excludes ${bad.streetNumber} ${bad.streetName} ${bad.zipCode} (${bad.error})`, () => {
    const hit = ADDRESS_POOL.find(a =>
      a.streetNumber === bad.streetNumber &&
      a.streetName === bad.streetName &&
      a.zipCode === bad.zipCode);
    assert.equal(hit, undefined,
      `ATOMIC rejected this address with "${bad.error}". Delete it from src/shared/address-pool.mjs — ` +
      'a regeneration from OSM reintroduces it.');
  });
}

test('the exclusion check would actually catch a bad address', () => {
  // Guards against the matcher silently never matching anything.
  const real = ADDRESS_POOL[0];
  const hit = ADDRESS_POOL.find(a =>
    a.streetNumber === real.streetNumber &&
    a.streetName === real.streetName &&
    a.zipCode === real.zipCode);
  assert.ok(hit, 'matcher must find an address that IS in the pool');
});

test('pool is still large enough to draw from', () => {
  assert.ok(ADDRESS_POOL.length > 1500, `pool down to ${ADDRESS_POOL.length} — regenerate before it thins out`);
});

test('pickRandomPortIdentity never returns a rejected address', () => {
  const rejected = new Set(CARRIER_REJECTED.map(b => `${b.streetNumber}|${b.streetName}|${b.zipCode}`));
  for (let i = 0; i < 3000; i++) {
    const id = pickRandomPortIdentity();
    assert.ok(
      !rejected.has(`${id.port_street_number}|${id.port_street_name}|${id.port_zip}`),
      `drew a carrier-rejected address: ${id.port_street_number} ${id.port_street_name} ${id.port_zip}`
    );
  }
});

test('pickRandomPortIdentity keeps subscriber and old-carrier names distinct', () => {
  // They are different people by design. If they collapse, the losing carrier
  // sees a name that does not match its records and rejects the port.
  for (let i = 0; i < 200; i++) {
    const id = pickRandomPortIdentity();
    assert.notEqual(
      `${id.port_first_name} ${id.port_last_name}`,
      `${id.port_old_first_name} ${id.port_old_last_name}`
    );
  }
});
