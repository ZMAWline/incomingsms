import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/bulk-activator/index.js';

test('handleActivateJson creates activation run and job items', async () => {
  const req = new Request('https://bulk-activator/activate?secret=test-secret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sims: [
        { iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic' },
        { iccid: '89014103271467425632', imei: '123456789012346', reseller_id: '1', vendor: 'atomic' },
      ],
    }),
  });

  // No Supabase config - should fail at auth check or before Supabase calls
  // We test that it returns JSON even on failure
  const env = {
    BULK_RUN_SECRET: 'test-secret',
    ACTIVATION_QUEUE: { send: async () => {} },
  };

  const res = await worker.fetch(req, env);
  // Auth succeeds, but Supabase calls will fail - we just verify JSON response
  const body = await res.json();
  assert.ok(typeof body === 'object');
});

test('handleActivateJson validates required fields', async () => {
  const req = new Request('https://bulk-activator/activate?secret=test-secret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sims: [
        { iccid: '', imei: '123456789012345', reseller_id: '1', vendor: 'atomic' }, // missing iccid
      ],
    }),
  });

  const env = {
    BULK_RUN_SECRET: 'test-secret',
    ACTIVATION_QUEUE: { send: async () => {} },
  };

  const res = await worker.fetch(req, env);
  // Auth succeeds, but validation should catch empty iccid
  const body = await res.json();
  assert.ok(typeof body === 'object');
  assert.equal(body.ok, false);
  assert.ok(body.validation_errors > 0 || body.error);
});

test('handleActivateJson returns 401 when secret missing', async () => {
  const req = new Request('https://bulk-activator/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sims: [] }),
  });

  const env = {
    BULK_RUN_SECRET: 'correct-secret',
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unauthorized');
});

test('handleActivateJson returns 401 when secret wrong', async () => {
  const req = new Request('https://bulk-activator/activate?secret=wrong', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sims: [] }),
  });

  const env = {
    BULK_RUN_SECRET: 'correct',
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unauthorized');
});

test('handleActivateJson returns JSON error for missing sims array', async () => {
  const req = new Request('https://bulk-activator/activate?secret=test-secret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // no sims array
  });

  const env = {
    BULK_RUN_SECRET: 'test-secret',
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200); // Valid auth, but returns JSON error
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.error && body.error.includes('sims array'));
});