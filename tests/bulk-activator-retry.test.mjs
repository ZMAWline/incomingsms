// Tests for POST /retry, added to fix the b11b2839/bea426e6 stuck-retry bug:
// dashboard's handleActivationRunRetry used to call env.ACTIVATION_QUEUE.send()
// directly, but that binding only exists on this worker (bulk-activator /
// bulk-activator-test), not on dashboard/dashboard-test. /retry is the
// service-binding target dashboard now forwards retries to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/bulk-activator/index.js';

test('/retry returns 401 JSON when secret missing', async () => {
  const req = new Request('https://bulk-activator/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: 'run-1', items: [] }),
  });
  const res = await worker.fetch(req, { BULK_RUN_SECRET: 'correct' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Unauthorized');
});

test('/retry returns JSON error when run_id or items are missing', async () => {
  const env = { BULK_RUN_SECRET: 'test-secret' };

  const noRunId = await worker.fetch(new Request('https://bulk-activator/retry?secret=test-secret', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: 'x' }] }),
  }), env);
  assert.equal((await noRunId.json()).error, 'run_id required');

  const noItems = await worker.fetch(new Request('https://bulk-activator/retry?secret=test-secret', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: 'run-1', items: [] }),
  }), env);
  assert.equal((await noItems.json()).error, 'items array required');
});

function makeSupabaseMock() {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    requests.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes('/activation_job_items') && init?.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    if (u.includes('/activation_job_items') && (!init || init.method === undefined)) {
      // recomputeActivationRunCounts read
      return new Response(JSON.stringify([{ status: 'queued' }]), { status: 200 });
    }
    if (u.includes('/activation_runs') && init?.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    return new Response('[]', { status: 200 });
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

test('/retry resets each item to queued, re-sends it to ACTIVATION_QUEUE, and recomputes run counts', async () => {
  const { requests, restore } = makeSupabaseMock();
  try {
    const sentBatches = [];
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async (msgs) => { sentBatches.push(msgs); } },
    };
    const items = [
      { id: 'item-1', iccid: '89012804332468992577', imei: '359729444337382', reseller_id: 3, vendor: 'atomic', attempt: 1 },
    ];
    const req = new Request('https://bulk-activator/retry?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: 'run-1', items }),
    });

    const res = await worker.fetch(req, env);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, retried: 1, run_id: 'run-1' });

    const patches = requests.filter(r => r.url.includes('/activation_job_items?id=eq.item-1') && r.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body.status, 'queued');
    assert.equal(patches[0].body.attempt, 2, 'attempt is incremented from the item\'s current value');
    assert.equal(patches[0].body.error_message, null, 'stale error is cleared on retry');

    assert.equal(sentBatches.length, 1);
    assert.equal(sentBatches[0].length, 1);
    assert.equal(sentBatches[0][0].body.iccid, '89012804332468992577');
    assert.equal(sentBatches[0][0].body.job_run_id, 'run-1', 'job_run_id carries the activation_runs.id so the queue consumer updates the right item');

    const runPatches = requests.filter(r => r.url.includes('/activation_runs?id=eq.run-1') && r.method === 'PATCH');
    assert.equal(runPatches.length, 1, 'run counts are recomputed after retrying');
  } finally {
    restore();
  }
});
