// Regression test: POST /activate on an auth failure used to return a plain
// "Unauthorized" text body (status 401, no Content-Type), unlike every other
// error path in this endpoint which returns JSON. The dashboard's /api/activate
// proxy treats any non-JSON worker response as a hard failure and forwards it
// as "Worker returned non-JSON response (401): Unauthorized" — surfacing to
// the operator as a confusing JSON error instead of a clear auth message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/bulk-activator/index.js';

test('/activate returns JSON (not plain text) when BULK_RUN_SECRET is missing', async () => {
  const req = new Request('https://bulk-activator/activate?secret=whatever', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sims: [] }),
  });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 401);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unauthorized');
});

test('/activate returns JSON (not plain text) when the secret does not match', async () => {
  const req = new Request('https://bulk-activator/activate?secret=wrong', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sims: [] }),
  });
  const res = await worker.fetch(req, { BULK_RUN_SECRET: 'correct' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unauthorized');
});
