// Port-in modal "Use random address" autofill (t_incomingsms_eved_addr).
//
// The dashboard worker is ESM inside a CommonJS package and is normally
// bundled by wrangler, so — as in dashboard-escalation-export.test.mjs — we
// lift the real handler out of the source and run it in a vm. ADDRESS_POOL
// is imported normally since address-pool.mjs is a real .mjs module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ADDRESS_POOL } from '../src/shared/address-pool.mjs';

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
  const sandbox = { console, Response, ADDRESS_POOL };
  vm.createContext(sandbox);
  vm.runInContext(extractFn('function handleRandomAddress(corsHeaders) {'), sandbox);
  return sandbox;
}

// ---------------------------------------------------------
// Route registration
// ---------------------------------------------------------

test('random-address route is registered as a GET endpoint', () => {
  assert.match(SRC, /url\.pathname === '\/api\/random-address' && request\.method === 'GET'/);
  assert.match(SRC, /return handleRandomAddress\(corsHeaders\);/);
});

test('the route is registered after the operator Basic-auth gate (requires operator auth)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/random-address'");
  const authGateIdx = SRC.indexOf('// Basic auth check');
  assert.notEqual(routeIdx, -1, 'route not registered');
  assert.notEqual(authGateIdx, -1, 'auth gate marker not found');
  assert.ok(routeIdx > authGateIdx, 'random-address route must require operator auth, unlike the public export routes');
});

// ---------------------------------------------------------
// Handler behavior
// ---------------------------------------------------------

test('returns a single address object drawn from the existing address pool', () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomAddress({});
  assert.equal(resp.status, 200);
});

test('response shape has exactly the fields the port-in form needs, nothing else', async () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomAddress({});
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.ok(body.address, 'address object missing');
  const keys = Object.keys(body.address).sort();
  assert.deepEqual(keys, ['city', 'state', 'streetDirection', 'streetName', 'streetNumber', 'zipCode']);
  // No name, PIN, account number, or other subscriber/customer data leaks in.
  assert.ok(!('firstName' in body.address));
  assert.ok(!('lastName' in body.address));
  assert.ok(!('pin' in body.address));
  assert.ok(!('accountNumber' in body.address));
});

test('the returned address always matches an entry in the existing pool (no invented data source)', async () => {
  const sandbox = makeSandbox();
  for (let i = 0; i < 20; i++) {
    const body = await sandbox.handleRandomAddress({}).json();
    const match = ADDRESS_POOL.find(e =>
      e.streetNumber === body.address.streetNumber &&
      e.streetName === body.address.streetName &&
      e.city === body.address.city &&
      e.state === body.address.state &&
      e.zipCode === body.address.zipCode);
    assert.ok(match, 'returned address must come from the real ADDRESS_POOL, not be generated on the fly');
  }
});

test('CORS headers passed in are echoed back on the response', async () => {
  const sandbox = makeSandbox();
  const resp = sandbox.handleRandomAddress({ 'Access-Control-Allow-Origin': '*' });
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(resp.headers.get('Content-Type'), /application\/json/);
});

// ---------------------------------------------------------
// Frontend: autofill control + wiring
// ---------------------------------------------------------

test('the port-in modal exposes a "Use random address" autofill control', () => {
  assert.match(HTML, /onclick="fillRandomPortAddress\(event\)"/);
  assert.match(HTML, /Use random address/);
});

test('fillRandomPortAddress fetches the endpoint and only fills street/zip fields, never name/account/PIN', () => {
  assert.match(HTML, /async function fillRandomPortAddress\(evt\)/);
  assert.match(HTML, /fetch\(API_BASE \+ '\/random-address'\)/);
  assert.match(HTML, /getElementById\('activate-port-street-number'\)\.value = data\.address\.streetNumber/);
  assert.match(HTML, /getElementById\('activate-port-street-name'\)\.value = data\.address\.streetName/);
  assert.match(HTML, /getElementById\('activate-port-zip'\)\.value = data\.address\.zipCode/);

  // Extract just the fillRandomPortAddress function body and make sure it
  // never writes to the name/account-number/PIN/old-service-provider fields.
  const start = HTML.indexOf('async function fillRandomPortAddress(evt) {');
  const end = HTML.indexOf('\n        }', start);
  const fnBody = HTML.slice(start, end);
  for (const forbidden of [
    'activate-port-first-name', 'activate-port-last-name',
    'activate-port-account-number', 'activate-port-pin',
    'activate-port-old-first-name', 'activate-port-old-last-name',
  ]) {
    assert.ok(!fnBody.includes(forbidden), 'autofill must never write to ' + forbidden);
  }
});

// ---------------------------------------------------------
// Frontend: modal scrolling
// ---------------------------------------------------------

test('the activate modal panel is height-capped and scrolls internally', () => {
  assert.match(HTML, /id="activate-modal"[\s\S]{0,120}>\s*<div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-\[90vh\] flex flex-col">/);
});

test('the activate modal body scrolls independently of the fixed header/footer', () => {
  const start = HTML.indexOf('id="activate-modal"');
  const modalSlice = HTML.slice(start, start + 600);
  assert.match(modalSlice, /class="p-5 overflow-y-auto flex-1"/);
});
