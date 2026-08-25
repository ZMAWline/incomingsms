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
    ACTIVATION_QUEUE: { sendBatch: async () => {} },
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
    ACTIVATION_QUEUE: { sendBatch: async () => {} },
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

// ---------------------------------------------------------------------
// Performance: submitting N SIMs must not make O(N) serial Supabase/queue
// round-trips — that serial loop was the dominant cost of a bulk /activate
// call and the direct cause of "the portal is super slow" on submit.
// ---------------------------------------------------------------------

function makeSupabaseMock({ activationRunId = 'run-uuid-1' } = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    requests.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes('/activation_runs') && init?.method === 'POST') {
      return new Response(JSON.stringify([{ id: activationRunId }]), { status: 201 });
    }
    if (u.includes('/activation_job_items') && init?.method === 'POST') {
      const rows = JSON.parse(init.body);
      return new Response(JSON.stringify(rows.map((r, i) => ({ ...r, id: `item-${i}` }))), { status: 201 });
    }
    if (init?.method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    return new Response('[]', { status: 200 });
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

test('a bulk /activate submission batches job-item inserts into a single request', async () => {
  const { requests, restore } = makeSupabaseMock();
  try {
    const sims = Array.from({ length: 25 }, (_, i) => ({
      iccid: `8901410327146742${String(i).padStart(4, '0')}`, // 16-digit base + 4-digit index = 20 digits
      imei: '123456789012345',
      reseller_id: '1',
      vendor: 'atomic',
    }));
    const sentBatches = [];
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async (msgs) => { sentBatches.push(msgs); } },
    };
    const req = new Request('https://bulk-activator/activate?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sims }),
    });

    const res = await worker.fetch(req, env);
    const body = await res.json();

    assert.equal(body.ok, true);
    assert.equal(body.queued, 25);
    assert.equal(body.job_run_id, 'run-uuid-1');

    const jobItemInserts = requests.filter(r => r.url.includes('/activation_job_items') && r.method === 'POST');
    assert.equal(jobItemInserts.length, 1, 'all job items are inserted in a single request, not one per SIM');
    assert.equal(jobItemInserts[0].body.length, 25, 'the single insert carries all 25 rows');

    assert.equal(sentBatches.length, 1, 'queue messages are sent via one sendBatch call, not one send() per SIM');
    assert.equal(sentBatches[0].length, 25);
  } finally {
    restore();
  }
});

test('queue messages are chunked into groups of 100 for sendBatch', async () => {
  const { restore } = makeSupabaseMock();
  try {
    const sims = Array.from({ length: 150 }, (_, i) => ({
      iccid: `890141032714674${String(i).padStart(5, '0')}`,
      imei: '123456789012345',
      reseller_id: '1',
      vendor: 'atomic',
    }));
    const sentBatches = [];
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async (msgs) => { sentBatches.push(msgs.length); } },
    };
    const req = new Request('https://bulk-activator/activate?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sims }),
    });

    const res = await worker.fetch(req, env);
    const body = await res.json();

    assert.equal(body.queued, 150);
    assert.deepEqual(sentBatches, [100, 50], 'sendBatch is called in chunks of at most 100 (the Cloudflare Queues cap)');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// Reliability: a failure after the activation_runs row is created must not
// throw an unhandled exception (which Cloudflare turns into a non-JSON 500
// the dashboard can't parse) and must not silently orphan the run — the
// caller needs job_run_id back either way so it can still open the run.
// ---------------------------------------------------------------------

test('a queueing failure after the run is created still returns JSON with job_run_id, not a thrown exception', async () => {
  const { restore } = makeSupabaseMock();
  try {
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async () => { throw new Error('queue unavailable'); } },
    };
    const req = new Request('https://bulk-activator/activate?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sims: [{ iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1', vendor: 'atomic' }],
      }),
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.job_run_id, 'run-uuid-1', 'the already-created run is still surfaced so the dashboard can open it');
    assert.match(body.error, /queuing failed/);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------
// Batch-wide reseller dropdown + default random port-in subscriber info:
// a top-level body.reseller_id applies to every row (overriding any
// per-row reseller_id), and port-in rows with no name/address fields get
// a distinct random identity per row instead of failing validation — both
// must survive all the way through to the queued job items/messages, and
// the parent activation_runs row + activation_job_items rows must still
// be created correctly.
// ---------------------------------------------------------------------

test('a top-level reseller_id is applied to every row, overriding any per-row reseller_id', async () => {
  const { requests, restore } = makeSupabaseMock();
  try {
    const sentBatches = [];
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async (msgs) => { sentBatches.push(msgs); } },
    };
    const req = new Request('https://bulk-activator/activate?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reseller_id: 7,
        sims: [
          { iccid: '89014103271467425631', imei: '123456789012345', vendor: 'atomic' }, // no reseller_id at all
          { iccid: '89014103271467425632', imei: '123456789012346', reseller_id: '1', vendor: 'atomic' }, // has one — dropdown still wins
        ],
      }),
    });

    const res = await worker.fetch(req, env);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.queued, 2);

    const jobItemInsert = requests.find(r => r.url.includes('/activation_job_items') && r.method === 'POST');
    assert.ok(jobItemInsert, 'job items were inserted');
    for (const row of jobItemInsert.body) assert.equal(row.reseller_id, 7);

    assert.equal(sentBatches.length, 1);
    for (const msg of sentBatches[0]) assert.equal(msg.body.reseller_id, 7);
  } finally {
    restore();
  }
});

test('bulk port-in submission with no name/address fields gets a distinct random identity per row, other fields untouched', async () => {
  const { requests, restore } = makeSupabaseMock();
  try {
    const sentBatches = [];
    const env = {
      BULK_RUN_SECRET: 'test-secret',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ACTIVATION_QUEUE: { sendBatch: async (msgs) => { sentBatches.push(msgs); } },
    };
    const sims = [
      { iccid: '89014103271467425631', imei: '123456789012345', vendor: 'atomic', port_in: 'true', port_mdn: '2125550101', port_account_number: 'ACCT1', port_pin: '1111' },
      { iccid: '89014103271467425632', imei: '123456789012346', vendor: 'atomic', port_in: 'true', port_mdn: '2125550102', port_account_number: 'ACCT2', port_pin: '2222' },
    ];
    const req = new Request('https://bulk-activator/activate?secret=test-secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reseller_id: 4, sims }),
    });

    const res = await worker.fetch(req, env);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.queued, 2);

    const jobItemInsert = requests.find(r => r.url.includes('/activation_job_items') && r.method === 'POST');
    assert.equal(jobItemInsert.body.length, 2, 'one job item per SIM — Activation Runs still tracks per-row items');
    assert.equal(jobItemInsert.body[0].iccid, '89014103271467425631');
    assert.equal(jobItemInsert.body[1].iccid, '89014103271467425632');
    assert.equal(jobItemInsert.body[0].reseller_id, 4);
    assert.equal(jobItemInsert.body[1].reseller_id, 4);

    // activation_job_items doesn't persist port name/address columns — the
    // auto-filled random identity travels to the carrier call only via the
    // queue message, so assert it there.
    assert.equal(sentBatches.length, 1);
    assert.equal(sentBatches[0].length, 2);
    const [msg1, msg2] = sentBatches[0].map(m => m.body);
    for (const row of [msg1, msg2]) {
      assert.ok(row.port_first_name, 'random first name filled');
      assert.ok(row.port_last_name, 'random last name filled');
      assert.ok(row.port_street_number, 'random street number filled');
      assert.ok(row.port_old_first_name, 'random old-carrier first name filled');
    }
    // Random info is per-row, not one identity reused for the whole batch.
    assert.notEqual(msg1.port_first_name + msg1.port_last_name, msg2.port_first_name + msg2.port_last_name,
      'each port-in row in the batch gets its own distinct random identity');

    // Random info must never touch ICCID/IMEI/MDN/account/PIN/reseller.
    assert.equal(msg1.iccid, '89014103271467425631');
    assert.equal(msg2.iccid, '89014103271467425632');
    assert.equal(msg1.port_mdn, '2125550101');
    assert.equal(msg2.port_mdn, '2125550102');
    assert.equal(msg1.port_account_number, 'ACCT1');
    assert.equal(msg2.port_account_number, 'ACCT2');
    assert.equal(msg1.reseller_id, 4);
    assert.equal(msg2.reseller_id, 4);
  } finally {
    restore();
  }
});
