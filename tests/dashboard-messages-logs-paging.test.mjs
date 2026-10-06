// GET /api/messages pages on the server; GET /api/error-logs defaults to the
// last 90 days and pages back with ?before. The real handlers are lifted out
// of src/dashboard/index.js and run in a vm with a scripted fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as requestHelpers from '../src/dashboard/request.mjs';
import { splitSearchTerms } from '../src/shared/search-terms.mjs';

const SRC = fs.readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');

function extract(signature) {
  const start = SRC.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0;
  for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error('unterminated: ' + signature);
}

function makeSandbox(respond = () => null) {
  const calls = [];
  const sandbox = {
    ...requestHelpers, splitSearchTerms, console, Response, URL, Date,
    async fetch(u) {
      const s = String(u);
      calls.push(s);
      return respond(s) || new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    "const MESSAGE_SORTS = ['received_at', 'to_number', 'from_number', 'body'];",
    extract('async function supabaseGet(env, path, extraHeaders) {'),
    extract('async function handleMessages(env, corsHeaders, url) {'),
    extract('async function handleErrorLogs(env, corsHeaders, url) {'),
  ].join('\n\n'), sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
const u = (p) => new URL('https://dashboard' + p);
const msg = (id) => ({ id, to_number: 't', from_number: 'f', body: 'b', received_at: '2026-10-06T00:00:00Z', sim_id: 1, sims: { iccid: '89' } });

test('the source keeps MESSAGE_SORTS as the vm copy above', () => {
  assert.match(SRC, /const MESSAGE_SORTS = \['received_at', 'to_number', 'from_number', 'body'\];/);
});

test('messages default to page 1 of 50, newest first, reading one extra row', async () => {
  const { sandbox, calls } = makeSandbox();
  const resp = await sandbox.handleMessages(ENV, {}, u('/api/messages'));
  assert.equal(resp.status, 200);
  assert.deepEqual(await resp.json(), { rows: [], page: 1, page_size: 50, has_more: false });
  assert.match(calls[0], /order=received_at\.desc,id\.desc&limit=51&offset=0$/);
});

test('page 3 of 25 sorted by sender ascending reads offset 50', async () => {
  const { sandbox, calls } = makeSandbox();
  await sandbox.handleMessages(ENV, {}, u('/api/messages?page=3&page_size=25&sort=from_number&dir=asc'));
  assert.match(calls[0], /order=from_number\.asc,id\.asc&limit=26&offset=50$/);
});

test('the extra row sets has_more and is not returned', async () => {
  const { sandbox } = makeSandbox((s) => s.includes('inbound_sms?') ? new Response(JSON.stringify([msg(3), msg(2), msg(1)])) : null);
  const body = await (await sandbox.handleMessages(ENV, {}, u('/api/messages?page_size=2'))).json();
  assert.deepEqual(body.rows.map(r => r.id), [3, 2]);
  assert.equal(body.rows[0].iccid, '89');
  assert.equal(body.has_more, true);
});

test('search is paged too', async () => {
  const { sandbox, calls } = makeSandbox();
  await sandbox.handleMessages(ENV, {}, u('/api/messages?search=hello&page=2&page_size=10'));
  const q = calls.find(c => c.includes('inbound_sms?'));
  assert.match(q, /or=\(/);
  assert.match(q, /limit=11&offset=10$/);
});

for (const [qs, why] of [
  ['page=0', 'page'], ['page_size=501', 'page_size'], ['page_size=abc', 'page_size'],
  ['sort=raw', 'sort'], ['dir=sideways', 'dir'],
]) {
  test(`messages reject a bad ${why} (${qs}) with 400 and no query`, async () => {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleMessages(ENV, {}, u('/api/messages?' + qs));
    assert.equal(resp.status, 400);
    assert.equal(calls.length, 0);
  });
}

test('SIM logs default to the last 90 days, 20 newest', async () => {
  const { sandbox, calls } = makeSandbox();
  const before = Date.now();
  await sandbox.handleErrorLogs(ENV, {}, u('/api/error-logs?iccid=8901'));
  const q = new URL(calls[0]);
  const gte = q.searchParams.getAll('created_at').find(v => v.startsWith('gte.')).slice(4);
  const ageDays = (before - Date.parse(gte)) / 86400000;
  assert.ok(ageDays > 89.99 && ageDays < 90.01, String(ageDays));
  assert.equal(q.searchParams.get('limit'), '20');
  assert.equal(q.searchParams.get('order'), 'created_at.desc');
});

test('Load more pages below the oldest row shown; days=all drops the floor', async () => {
  const { sandbox, calls } = makeSandbox();
  await sandbox.handleErrorLogs(ENV, {}, u('/api/error-logs?iccid=8901&days=all&before=2026-07-01T10:00:00Z'));
  const filters = new URL(calls[0]).searchParams.getAll('created_at');
  assert.deepEqual(filters, ['lt.2026-07-01T10:00:00.000Z']);
});

for (const qs of ['iccid=8901&days=0', 'iccid=8901&days=x', 'iccid=8901&before=yesterday']) {
  test(`SIM logs reject ${qs} with 400`, async () => {
    const { sandbox, calls } = makeSandbox();
    const resp = await sandbox.handleErrorLogs(ENV, {}, u('/api/error-logs?' + qs));
    assert.equal(resp.status, 400);
    assert.equal(calls.length, 0);
  });
}
