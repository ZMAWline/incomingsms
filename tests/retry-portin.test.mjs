// Tests for bulk-activator's POST /retry-portin.
//
// The round-trip test is the important one: /retry-portin replays a port-in by
// reading the original request body back out of carrier_api_logs, so if the
// builder's payload shape ever drifts from the parser, a retry would silently
// submit a port-in with blank subscriber or old-carrier fields. The carrier
// rejects those (streetName Is Invalid, Account number required), so the drift
// would look like a carrier problem rather than our bug.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildAtomicPortInRequest, parseAtomicPortInRequest } from '../src/shared/activation-bulk.mjs';

const ACTIVATOR = readFileSync('src/bulk-activator/index.js', 'utf8');

const ORIGINAL = {
  iccid: '89012804332469394146',
  imei: '359729444337381',
  portMdn: '8624064421',
  portAccountNumber: '992388721',
  portPin: '584486',
  firstName: 'Dana',
  lastName: 'Whitfield',
  streetNumber: '1251',
  streetName: 'Muldoon Road',
  zip: '99504',
  oldFirstName: 'Robin',
  oldLastName: 'Alvarez',
};

test('parseAtomicPortInRequest round-trips every field the builder writes', () => {
  const body = buildAtomicPortInRequest({ session: { userName: 'u', token: 't', pin: 'p' }, ...ORIGINAL });
  assert.deepEqual(parseAtomicPortInRequest(body), ORIGINAL);
});

test('round-trip keeps subscriber and old_service_provider names independent', () => {
  // These are different people by design — the subscriber taking the line vs
  // the losing carrier's account holder. A parser that collapsed them would
  // send the wrong name to the losing carrier and the port would reject.
  const body = buildAtomicPortInRequest({ session: {}, ...ORIGINAL });
  const parsed = parseAtomicPortInRequest(body);
  assert.equal(parsed.firstName, 'Dana');
  assert.equal(parsed.oldFirstName, 'Robin');
  assert.notEqual(parsed.firstName, parsed.oldFirstName);
});

test('parseAtomicPortInRequest does not return partnerTransactionId', () => {
  // It identifies one attempt. The builder mints a fresh one per call, and the
  // skill's Unknowns list does not confirm that replaying an id is safe.
  const body = buildAtomicPortInRequest({ session: {}, ...ORIGINAL });
  assert.equal('partnerTransactionId' in parseAtomicPortInRequest(body), false);
});

test('parseAtomicPortInRequest rejects a body that is not a portinRequest', () => {
  assert.equal(parseAtomicPortInRequest(null), null);
  assert.equal(parseAtomicPortInRequest({}), null);
  assert.equal(
    parseAtomicPortInRequest({ wholeSaleApi: { wholeSaleRequest: { requestType: 'portinStatus', MSISDN: '8624064421' } } }),
    null,
    'a portinStatus body carries no credentials and must not be mistaken for a retryable request'
  );
});

/* ── endpoint wiring and guards ──────────────────────────────────────────── */

function retryPortInFn() {
  const start = ACTIVATOR.indexOf('async function handleRetryPortInJson');
  assert.notEqual(start, -1, 'handleRetryPortInJson not found');
  return ACTIVATOR.slice(start, ACTIVATOR.indexOf('\n/* ──', start));
}

test('/retry-portin is routed and secret-gated', () => {
  assert.match(ACTIVATOR, /url\.pathname === '\/retry-portin'/);
  assert.match(retryPortInFn(), /secret !== env\.BULK_RUN_SECRET/);
});

test('/retry-portin refuses to resubmit when a port already exists', () => {
  const fn = retryPortInFn();
  // Guard 1 — our own record of the last attempt succeeding.
  assert.match(fn, /lastReqStatus === '00'/);
  assert.match(fn, /would duplicate it/);
  // Guard 2 — the carrier's own view, independent of what we recorded.
  assert.match(fn, /lastStatus\.statusCode !== '948'/);
  assert.match(fn, /not resubmitting over an existing port request/);
});

test('/retry-portin skips SIMs whose credentials are unrecoverable', () => {
  const fn = retryPortInFn();
  assert.match(fn, /no portinRequest was ever logged/);
  assert.match(fn, /unrecoverable and must be re-supplied/);
});

test('/retry-portin never returns the recovered port credentials', () => {
  const fn = retryPortInFn();
  // Everything pushed into `results` is echoed to the caller. The credentials
  // must only ever reach the queue payload.
  const resultPushes = [...fn.matchAll(/results\.push\(\{[^}]*\}\)/g)].map(m => m[0]);
  assert.ok(resultPushes.length > 0, 'expected results.push calls to inspect');
  for (const push of resultPushes) {
    for (const secret of ['port_pin', 'portPin', 'port_account_number', 'portAccountNumber']) {
      assert.ok(!push.includes(secret), `results.push must not carry ${secret}: ${push}`);
    }
  }
});

test('/retry-portin sends the full port field set to the queue', () => {
  // The whole point: activateViaAtomic branches on port_mdn/account/pin, so a
  // message missing them falls through to a plain Activate and burns a new MDN.
  const fn = retryPortInFn();
  for (const field of [
    'port_mdn', 'port_account_number', 'port_pin',
    'port_first_name', 'port_last_name',
    'port_street_number', 'port_street_name', 'port_zip',
    'port_old_first_name', 'port_old_last_name',
  ]) {
    assert.ok(fn.includes(field), `queue payload must carry ${field}`);
  }
});

test('the plain /retry path is documented as unsafe for port-ins', () => {
  // activation_job_items has no port-in columns, so /retry rebuilds a message
  // without them. Keep the warning attached to the code that has the trap.
  assert.match(ACTIVATOR, /Never point \/retry at a port-in SIM/);
});
