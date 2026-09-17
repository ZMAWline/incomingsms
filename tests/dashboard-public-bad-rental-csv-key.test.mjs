// GET /public/bad-rental-escalations-today.csv — shared-key gate.
//
// The route deliberately runs BEFORE the operator auth gate so a report feed
// can fetch it without a login session. The CSV carries reseller names,
// customer MDNs, ICCIDs and rental ids, so "no login session" must not mean
// "no credential": callers present the shared BAD_RENTAL_CSV_KEY, the same way
// /api/gateway-status takes GATEWAY_STATUS_API_KEY (X-Api-Key header or ?key=).
//
// The dashboard worker is ESM inside a CommonJS package and is normally bundled
// by wrangler, so — as in dashboard-escalation-export.test.mjs — we lift the
// real functions out of the source and run them in a vm with a scripted fetch.
// The assertions run against the shipped handler, not a copy of its rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { constantTimeEqual } from '../src/shared/portal-auth.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

const CSV_PATH = '/public/bad-rental-escalations-today.csv';
const KEY = 'right-key-6f2a9c4e8b1d';

// Slice one top-level function out of the source by brace matching.
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

// Everything the handler needs: the NY-day export region plus its helpers.
function extractEscalationRegion() {
  const start = SRC.indexOf('const ESCALATION_EXPORT_TZ =');
  assert.notEqual(start, -1, 'escalation export region not found');
  const handler = extractFn('async function handleBadRentalEscalationExport(env, corsHeaders, url) {');
  const end = SRC.indexOf(handler) + handler.length;
  assert.ok(end > start, 'handler must live inside the escalation export region');
  return SRC.slice(start, end);
}

// Every Supabase read answers with an empty list: the CSV then has a header row
// and no data rows, which is all these auth assertions need.
function makeSandbox() {
  const calls = [];
  const sandbox = {
    console,
    Response,
    Request,
    URL,
    constantTimeEqual,
    async fetch(url) {
      calls.push(String(url));
      return new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    extractFn('async function supabaseGet(env, path, extraHeaders) {'),
    extractFn('function csvEscape(value) {'),
    extractFn('async function handlePublicBadRentalEscalationToday(request, env) {'),
    extractEscalationRegion(),
  ].join('\n\n'), sandbox);
  return { sandbox, calls };
}

const BASE_ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const ENV = { ...BASE_ENV, BAD_RENTAL_CSV_KEY: KEY };

function req({ header, query } = {}) {
  const url = new URL('https://dashboard' + CSV_PATH);
  if (query !== undefined) url.searchParams.set('key', query);
  const headers = {};
  if (header !== undefined) headers['X-Api-Key'] = header;
  return new Request(url.toString(), { headers });
}

async function call(env, request) {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handlePublicBadRentalEscalationToday(request, env);
  return { resp, calls };
}

// --- fails closed ---------------------------------------------------------

test('503 when BAD_RENTAL_CSV_KEY is unset — never falls open to an unauthenticated CSV', async () => {
  const { resp, calls } = await call(BASE_ENV, req({ header: KEY }));
  assert.equal(resp.status, 503);
  assert.match(resp.headers.get('Content-Type'), /application\/json/);
  const body = await resp.json();
  assert.match(body.error, /BAD_RENTAL_CSV_KEY/, 'the error names the missing secret');
  assert.equal(calls.length, 0, 'no Supabase read happens before the key check');
});

test('503 when BAD_RENTAL_CSV_KEY is set to an empty string', async () => {
  const { resp } = await call({ ...BASE_ENV, BAD_RENTAL_CSV_KEY: '' }, req({ header: KEY }));
  assert.equal(resp.status, 503);
});

// --- rejects bad credentials ---------------------------------------------

test('401 when no key is presented at all', async () => {
  const { resp, calls } = await call(ENV, req());
  assert.equal(resp.status, 401);
  assert.equal((await resp.json()).error, 'unauthorized');
  assert.equal(calls.length, 0, 'no customer data is fetched for an unauthenticated caller');
});

test('401 for a wrong key in the header', async () => {
  const { resp, calls } = await call(ENV, req({ header: 'wrong-key-6f2a9c4e8b1d' }));
  assert.equal(resp.status, 401);
  assert.equal(calls.length, 0);
});

test('401 for a wrong key in the query param', async () => {
  const { resp } = await call(ENV, req({ query: 'wrong-key-6f2a9c4e8b1d' }));
  assert.equal(resp.status, 401);
});

test('401 for a key that is a prefix of the real one — no partial match', async () => {
  const { resp } = await call(ENV, req({ header: KEY.slice(0, -1) }));
  assert.equal(resp.status, 401);
});

test('401 body leaks no CSV data and no reseller/MDN/ICCID fields', async () => {
  const { resp } = await call(ENV, req({ header: 'nope' }));
  const text = await resp.text();
  assert.equal(text, JSON.stringify({ error: 'unauthorized' }));
  for (const column of ['reseller', 'current_mdn', 'iccid', 'rental_id']) {
    assert.ok(!text.includes(column), 'unauthorized response must not carry ' + column);
  }
});

// --- accepts the real key -------------------------------------------------

test('200 CSV for the correct key in the X-Api-Key header', async () => {
  const { resp, calls } = await call(ENV, req({ header: KEY }));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('Content-Type'), /text\/csv/);
  assert.match(resp.headers.get('Content-Disposition'), /\.csv/);
  const text = await resp.text();
  const header = text.split('\n')[0];
  assert.ok(header.includes('reseller'), 'the real export header is returned');
  assert.ok(header.includes('current_mdn'));
  assert.ok(calls.some(c => c.includes('/rental_reports?select=')), 'the authorized call reaches Supabase');
});

test('200 CSV for the correct key in the ?key= query param', async () => {
  const { resp } = await call(ENV, req({ query: KEY }));
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('Content-Type'), /text\/csv/);
  const header = (await resp.text()).split('\n')[0];
  assert.ok(header.includes('iccid'), 'same export as the header-authenticated call');
});

test('a correct header key wins even when the query param is wrong', async () => {
  const { resp } = await call(ENV, req({ header: KEY, query: 'wrong' }));
  assert.equal(resp.status, 200);
});

// --- route wiring ---------------------------------------------------------

test('the route still runs before the operator auth gate and passes the request through', () => {
  const routeIdx = SRC.indexOf("url.pathname === '" + CSV_PATH + "'");
  const authGateIdx = SRC.indexOf('// --- Authentication ---');
  assert.notEqual(routeIdx, -1, 'route not registered');
  assert.notEqual(authGateIdx, -1, 'auth gate marker not found');
  assert.ok(routeIdx < authGateIdx, 'route must stay before the Basic-auth gate — it has no login session');
  assert.match(SRC, /return handlePublicBadRentalEscalationToday\(request, env\);/,
    'the handler needs the request to read the shared key');
});

test('the handler never passes the caller URL into the export — still today-only', async () => {
  const url = new URL('https://dashboard' + CSV_PATH);
  url.searchParams.set('key', KEY);
  url.searchParams.set('start', '2020-01-01');
  url.searchParams.set('end', '2026-12-31');
  const { resp, calls } = await call(ENV, new Request(url.toString()));
  assert.equal(resp.status, 200);
  const reportCall = decodeURIComponent(calls.find(c => c.includes('/rental_reports?select=')));
  assert.ok(!reportCall.includes('2020-01-01'), 'caller-supplied start is ignored');
  assert.ok(!reportCall.includes('2026-12-31'), 'caller-supplied end is ignored');
});
