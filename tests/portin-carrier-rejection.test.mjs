// A rejected port-in must fail, not report success.
//
// ATOMIC answers a REJECTED port with HTTP 200 and the real verdict in the
// body. The port-in path checked only `res.ok`, so every rejection was recorded
// as a successful submission: SIM -> provisioning with port_in_pending=true,
// job item -> done, and the only trace was a carrier_api_logs row nobody read.
// That is how 53 SIMs accumulated looking healthy while no port existed.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const ACTIVATOR = readFileSync('src/bulk-activator/index.js', 'utf8');

function portInFn() {
  const start = ACTIVATOR.indexOf('async function activateViaAtomicPortIn');
  assert.notEqual(start, -1);
  return ACTIVATOR.slice(start, ACTIVATOR.indexOf('\nfunction mapPortFields', start));
}

test('a non-00 carrier statusCode throws instead of returning success', () => {
  const fn = portInFn();
  assert.match(fn, /carrierStatusCode !== '00'/);
  assert.match(fn, /throw new CarrierActivationError/);
  assert.match(fn, /ATOMIC port-in rejected \(statusCode/);
});

test('the rejection carries the carrier’s own description, not just a code', () => {
  // The operator-facing value is the text: "streetName Is Invalid" tells you to
  // fix the address, "Port Request Does Not Exist" tells you to resubmit.
  const fn = portInFn();
  const guard = fn.slice(fn.indexOf('const wholeSaleResponse'), fn.indexOf('const result = wholeSaleResponse'));
  assert.match(guard, /wholeSaleResponse\?\.description/);
});

test('the check runs after the address auto-heal loop, not inside it', () => {
  // Inside the loop it would throw on the first address rejection and skip the
  // redraw entirely, undoing the auto-heal.
  const fn = portInFn();
  assert.ok(
    fn.indexOf('MAX_ADDRESS_ATTEMPTS') < fn.indexOf("carrierStatusCode !== '00'"),
    'the retry loop must get its attempts before the rejection throws'
  );
});

test('a missing statusCode still succeeds', () => {
  // Only an explicit non-00 is a rejection. A response we cannot parse must not
  // fail a port that the carrier may well have accepted — the portinStatus poll
  // is the backstop for that case.
  const fn = portInFn();
  assert.match(fn, /carrierStatusCode !== null && carrierStatusCode !== '00'/);
});

test('an accepted port still records provisioning, not active', () => {
  // A port is accepted asynchronously; only the finalizer's portinStatus poll
  // may promote it to active.
  const fn = portInFn();
  const ret = fn.slice(fn.indexOf('  return {'));
  assert.match(ret, /status: 'provisioning'/);
  assert.match(ret, /portInPending: true/);
});

test('the new-number path keeps its own stricter MSISDN check', () => {
  // The two paths validate differently on purpose: a new-number activate is
  // synchronous and must echo an MSISDN; a port-in is not.
  const start = ACTIVATOR.indexOf('  // New-number activation path.');
  const activate = ACTIVATOR.slice(start, ACTIVATOR.indexOf('async function activateViaAtomicPortIn'));
  assert.match(activate, /returned no MSISDN/);
});
