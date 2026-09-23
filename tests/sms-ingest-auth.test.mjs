// sms-ingest auth: the secret is accepted from a header (preferred) or, for
// older gateway/forward configs, from ?secret= or /s/<secret> with a one-line
// deprecation warning. Runs the real worker from src/sms-ingest/index.js.
//
// A request that passes auth with a malformed JSON body gets 400 "Invalid
// JSON" before any database call, which is how these tests tell "authorized"
// from "rejected" without mocking Supabase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/sms-ingest/index.js';

const SECRET = 'ingest-test-secret-123';
const ENV = { GATEWAY_SECRET: SECRET };

function post(path, headers = {}) {
  return new Request('https://sms-ingest.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{not json',
  });
}

async function run(req, env = ENV) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const res = await worker.fetch(req, env, { waitUntil() {} });
    return { res, warnings };
  } finally {
    console.warn = orig;
  }
}

test('X-Ingest-Secret header is accepted with no deprecation warning', async () => {
  const { res, warnings } = await run(post('/', { 'X-Ingest-Secret': SECRET }));
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'Invalid JSON');
  assert.deepEqual(warnings, []);
});

test('Authorization: Bearer is accepted with no deprecation warning', async () => {
  const { res, warnings } = await run(post('/', { Authorization: 'Bearer ' + SECRET }));
  assert.equal(res.status, 400);
  assert.deepEqual(warnings, []);
});

test('legacy x-gateway-secret header is still accepted', async () => {
  const { res, warnings } = await run(post('/', { 'x-gateway-secret': SECRET }));
  assert.equal(res.status, 400);
  assert.deepEqual(warnings, []);
});

test('?secret= still works and logs one deprecation line without the secret', async () => {
  const { res, warnings } = await run(post('/?secret=' + SECRET));
  assert.equal(res.status, 400);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /deprecated/);
  assert.ok(!warnings[0].includes(SECRET), 'the warning must not print the secret');
});

test('/s/<secret> and /s/<secret>/gw/<id> still work and log a deprecation line', async () => {
  for (const p of ['/s/' + SECRET, '/s/' + SECRET + '/gw/4']) {
    const { res, warnings } = await run(post(p));
    assert.equal(res.status, 400, p);
    assert.equal(warnings.length, 1, p);
    assert.ok(!warnings[0].includes(SECRET));
  }
});

test('wrong, near-miss, and missing secrets are rejected', async () => {
  const bad = [
    post('/', { 'X-Ingest-Secret': 'wrong' }),
    post('/', { 'X-Ingest-Secret': SECRET + 'x' }),
    post('/', { 'X-Ingest-Secret': SECRET.slice(0, -1) }),
    post('/', { Authorization: 'Basic ' + SECRET }),
    post('/', { Authorization: 'Bearer wrong' }),
    post('/?secret=wrong'),
    post('/s/wrong'),
    post('/'),
  ];
  for (const req of bad) {
    const { res } = await run(req);
    assert.equal(res.status, 401, req.url);
  }
});

test('a wrong header secret is not rescued by a right URL secret', async () => {
  const { res } = await run(post('/?secret=' + SECRET, { 'X-Ingest-Secret': 'wrong' }));
  assert.equal(res.status, 401);
});

test('GATEWAY_SECRET unset rejects everything, including an empty secret', async () => {
  for (const env of [{}, { GATEWAY_SECRET: '' }]) {
    assert.equal((await run(post('/', { 'X-Ingest-Secret': SECRET }), env)).res.status, 401);
    assert.equal((await run(post('/?secret='), env)).res.status, 401);
  }
});

test('non-POST is 405 before auth', async () => {
  const res = await worker.fetch(new Request('https://sms-ingest.test/'), ENV, {});
  assert.equal(res.status, 405);
});
