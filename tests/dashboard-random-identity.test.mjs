// Port-in modal "Use random info" autofill.
//
// Extends the random-address autofill added for the port-in modal (see
// dashboard-random-address.test.mjs) with a fake name pool sourced from a
// FakeNameGenerator.com bulk export (GivenName,Surname only — no addresses,
// SSNs, or credit cards were in that export). Combines a subscriber name +
// address + independent losing-carrier (old_service_provider) name into one
// "identity" the operator can drop into the port-in identity block with a
// single click. Per the Atomic Wholesale API, subscriber and
// old_service_provider names are independent fields that don't need to
// match, so this draws two distinct random names by default. Still keeps
// account number, PIN, MDN, and other carrier credential fields untouched;
// an explicit "copy" control lets the operator force the old-carrier name to
// match the subscriber name instead.
//
// As in dashboard-random-address.test.mjs, we lift the real handler out of
// the source and run it in a vm since the dashboard worker is ESM inside a
// CommonJS package normally bundled by wrangler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';
import { NAME_POOL } from '../src/shared/name-pool.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'public', 'index.html'), 'utf8');

function extractFn(signature) {
  const start = SRC.indexOf(signature);
  assert.notEqual(start, -1, 'function not found in dashboard source: ' + signature);
  let depth = 0;
  let started = false;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    const c = SRC[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(start, i + 1);
    }
  }
  throw new Error('unterminated function: ' + signature);
}

function makeSandbox() {
  const sandbox = { console, Response, ADDRESS_POOL, NAME_POOL };
  vm.createContext(sandbox);
  vm.runInContext(extractFn('function handleRandomIdentity(corsHeaders) {'), sandbox);
  return sandbox;
}

// ---------------------------------------------------------
// Name pool data
// ---------------------------------------------------------

test('NAME_POOL is a non-empty list of {firstName, lastName} fake identities', () => {
  assert.ok(Array.isArray(NAME_POOL));
  assert.ok(NAME_POOL.length > 100, 'expected a substantial name pool, not a handful of entries');
  for (const entry of NAME_POOL.slice(0, 50)) {
    assert.equal(typeof entry.firstName, 'string');
    assert.equal(typeof entry.lastName, 'string');
    assert.ok(entry.firstName.trim().length > 0);
    assert.ok(entry.lastName.trim().length > 0);
  }
});

test('NAME_POOL has no duplicate first/last pairs', () => {
  const seen = new Set();
  for (const entry of NAME_POOL) {
    const key = entry.firstName.toLowerCase() + '|' + entry.lastName.toLowerCase();
    assert.ok(!seen.has(key), 'duplicate name pair: ' + key);
    seen.add(key);
  }
});

// ---------------------------------------------------------
// Route registration
// ---------------------------------------------------------

test('random-identity route is registered as a GET endpoint', () => {
  assert.match(SRC, /url\.pathname === '\/api\/random-identity' && request\.method === 'GET'/);
  assert.match(SRC, /return handleRandomIdentity\(corsHeaders\);/);
});

test('the route is registered after the operator Basic-auth gate (requires operator auth)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/random-identity'");
  const authGateIdx = SRC.indexOf('// Basic auth check');
  assert.notEqual(routeIdx, -1, 'route not registered');
  assert.notEqual(authGateIdx, -1, 'auth gate marker not found');
  assert.ok(routeIdx > authGateIdx, 'random-identity route must require operator auth, unlike the public export routes');
});

// ---------------------------------------------------------
// Handler behavior
// ---------------------------------------------------------

test('returns a combined name+address identity object', () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomIdentity({});
  assert.equal(resp.status, 200);
});

test('response shape has exactly the fields the port-in identity block needs, nothing else', async () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomIdentity({});
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.ok(body.identity, 'identity object missing');
  const keys = Object.keys(body.identity).sort();
  assert.deepEqual(keys, ['city', 'firstName', 'lastName', 'oldFirstName', 'oldLastName', 'state', 'streetDirection', 'streetName', 'streetNumber', 'zipCode']);
  // No PIN, account number, or MDN leaks in.
  assert.ok(!('pin' in body.identity));
  assert.ok(!('accountNumber' in body.identity));
  assert.ok(!('mdn' in body.identity));
});

test('the returned subscriber name, old-carrier name, and address all match real pool entries (no invented data)', async () => {
  const sandbox = makeSandbox();
  for (let i = 0; i < 20; i++) {
    const body = await sandbox.handleRandomIdentity({}).json();
    const nameMatch = NAME_POOL.find(e => e.firstName === body.identity.firstName && e.lastName === body.identity.lastName);
    assert.ok(nameMatch, 'returned subscriber name must come from the real NAME_POOL');
    const oldNameMatch = NAME_POOL.find(e => e.firstName === body.identity.oldFirstName && e.lastName === body.identity.oldLastName);
    assert.ok(oldNameMatch, 'returned old-carrier name must come from the real NAME_POOL');
    const addrMatch = ADDRESS_POOL.find(e =>
      e.streetNumber === body.identity.streetNumber &&
      e.streetName === body.identity.streetName &&
      e.city === body.identity.city &&
      e.state === body.identity.state &&
      e.zipCode === body.identity.zipCode);
    assert.ok(addrMatch, 'returned address must come from the real ADDRESS_POOL');
  }
});

test('the subscriber name and old-carrier name are independently drawn and need not match', async () => {
  const sandbox = makeSandbox();
  let sawDifferent = false;
  for (let i = 0; i < 20; i++) {
    const body = await sandbox.handleRandomIdentity({}).json();
    if (body.identity.firstName !== body.identity.oldFirstName || body.identity.lastName !== body.identity.oldLastName) {
      sawDifferent = true;
      break;
    }
  }
  assert.ok(sawDifferent, 'expected at least one draw with distinct subscriber/old-carrier names out of 20 tries');
});

test('CORS headers passed in are echoed back on the response', async () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomIdentity({ 'Access-Control-Allow-Origin': '*' });
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(resp.headers.get('Content-Type'), /application\/json/);
});

// ---------------------------------------------------------
// Frontend: "Use random info" control + wiring
// ---------------------------------------------------------

test('the port-in modal exposes a "Use random info" autofill control', () => {
  assert.match(HTML, /onclick="fillRandomPortIdentity\(event\)"/);
  assert.match(HTML, /Use random info/);
});

test('fillRandomPortIdentity fetches /random-identity and fills subscriber name/street/zip AND old-carrier name fields, never account/PIN', () => {
  assert.match(HTML, /async function fillRandomPortIdentity\(evt\)/);
  assert.match(HTML, /fetch\(API_BASE \+ '\/random-identity'\)/);
  assert.match(HTML, /getElementById\('activate-port-first-name'\)\.value = data\.identity\.firstName/);
  assert.match(HTML, /getElementById\('activate-port-last-name'\)\.value = data\.identity\.lastName/);
  assert.match(HTML, /getElementById\('activate-port-street-number'\)\.value = data\.identity\.streetNumber/);
  assert.match(HTML, /getElementById\('activate-port-street-name'\)\.value = data\.identity\.streetName/);
  assert.match(HTML, /getElementById\('activate-port-zip'\)\.value = data\.identity\.zipCode/);
  assert.match(HTML, /getElementById\('activate-port-old-first-name'\)\.value = data\.identity\.oldFirstName/);
  assert.match(HTML, /getElementById\('activate-port-old-last-name'\)\.value = data\.identity\.oldLastName/);

  const start = HTML.indexOf('async function fillRandomPortIdentity(evt) {');
  const end = HTML.indexOf('\n        }', start);
  const fnBody = HTML.slice(start, end);
  for (const forbidden of [
    'activate-port-account-number', 'activate-port-pin', 'activate-port-mdn',
  ]) {
    assert.ok(!fnBody.includes(forbidden), 'random-info autofill must never write to ' + forbidden);
  }
});

test('the original "Use random address" control is untouched and still never fills name/account/PIN', () => {
  // Regression guard: adding the identity button must not have folded name
  // autofill into the address-only control.
  assert.match(HTML, /onclick="fillRandomPortAddress\(event\)"/);
  const start = HTML.indexOf('async function fillRandomPortAddress(evt) {');
  const end = HTML.indexOf('\n        }', start);
  const fnBody = HTML.slice(start, end);
  for (const forbidden of [
    'activate-port-first-name', 'activate-port-last-name',
    'activate-port-account-number', 'activate-port-pin',
    'activate-port-old-first-name', 'activate-port-old-last-name',
  ]) {
    assert.ok(!fnBody.includes(forbidden), 'address-only autofill must never write to ' + forbidden);
  }
});

// ---------------------------------------------------------
// Frontend: explicit "copy to old carrier name" control
// ---------------------------------------------------------

test('the losing-carrier block exposes an explicit "copy subscriber name" control, not a silent overwrite', () => {
  assert.match(HTML, /onclick="copySubscriberNameToOldCarrier\(event\)"/);
  assert.match(HTML, /Copy subscriber name to old carrier name/);
  // Warn the operator this is not guaranteed to match real carrier records.
  assert.match(HTML, /does not guarantee a match/);
});

test('copySubscriberNameToOldCarrier only reads subscriber name fields and writes old-carrier name fields — no network call, no account/PIN access', () => {
  assert.match(HTML, /function copySubscriberNameToOldCarrier\(evt\)/);
  const start = HTML.indexOf('function copySubscriberNameToOldCarrier(evt) {');
  assert.notEqual(start, -1);
  const end = HTML.indexOf('\n        }', start);
  const fnBody = HTML.slice(start, end);

  assert.ok(!/fetch\(/.test(fnBody), 'copy control must be a pure DOM operation, not a carrier/API call');
  assert.ok(!fnBody.includes('activate-port-account-number'), 'copy control must never touch account number');
  assert.ok(!fnBody.includes('activate-port-pin'), 'copy control must never touch PIN');

  assert.match(fnBody, /getElementById\('activate-port-first-name'\)\.value/);
  assert.match(fnBody, /getElementById\('activate-port-last-name'\)\.value/);
  assert.match(fnBody, /getElementById\('activate-port-old-first-name'\)\.value = /);
  assert.match(fnBody, /getElementById\('activate-port-old-last-name'\)\.value = /);
});

// ---------------------------------------------------------
// Modal scrolling regression guard (from the prior random-address change)
// ---------------------------------------------------------

test('the activate modal panel is still height-capped and scrolls internally after this change', () => {
  assert.match(HTML, /id="activate-modal"[\s\S]{0,120}>\s*<div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-\[90vh\] flex flex-col">/);
});
