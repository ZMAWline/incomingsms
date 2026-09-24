// kasa-control switches real power outlets. Every route must require
// ADMIN_RUN_SECRET and fail closed (503) when it is not configured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/kasa-control/index.js';

const SECRET = 'kasa-test-secret';
const req = (path, headers = {}, method = 'GET') =>
  new Request('https://kasa-control' + path, { method, headers });

for (const [method, path] of [['GET', '/outlets'], ['POST', '/outlet'], ['POST', '/reboot-gateways'], ['GET', '/']]) {
  test(`${method} ${path}: secret unset -> 503`, async () => {
    const res = await worker.fetch(req(path, { Authorization: 'Bearer ' + SECRET }, method), {});
    assert.equal(res.status, 503);
  });

  test(`${method} ${path}: no credentials -> 401`, async () => {
    const res = await worker.fetch(req(path, {}, method), { ADMIN_RUN_SECRET: SECRET });
    assert.equal(res.status, 401);
  });

  test(`${method} ${path}: wrong secret -> 401`, async () => {
    const res = await worker.fetch(req(path, { Authorization: 'Bearer nope', 'X-Admin-Secret': 'nope' }, method), { ADMIN_RUN_SECRET: SECRET });
    assert.equal(res.status, 401);
  });
}

test('query-string secret is not accepted', async () => {
  const res = await worker.fetch(req('/reboot-gateways?secret=' + SECRET, {}, 'POST'), { ADMIN_RUN_SECRET: SECRET });
  assert.equal(res.status, 401);
});

test('right secret as Bearer passes the gate', async () => {
  const res = await worker.fetch(req('/no-such-route', { Authorization: 'Bearer ' + SECRET }), { ADMIN_RUN_SECRET: SECRET });
  assert.equal(res.status, 404);
});

test('right secret as X-Admin-Secret passes the gate', async () => {
  const res = await worker.fetch(req('/no-such-route', { 'X-Admin-Secret': SECRET }), { ADMIN_RUN_SECRET: SECRET });
  assert.equal(res.status, 404);
});

test('right secret reaches the /outlet handler (validation runs)', async () => {
  const r = new Request('https://kasa-control/outlet', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias: 'x', action: 'explode' }),
  });
  const res = await worker.fetch(r, { ADMIN_RUN_SECRET: SECRET });
  assert.equal(res.status, 400);
});
