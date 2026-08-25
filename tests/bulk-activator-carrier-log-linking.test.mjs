// Regression tests for operator visibility into carrier logs from the
// Activation Runs item detail view.
//
// activation_job_items.carrier_log_id has existed since the PR #69 job
// tracking migration but was never written by any code path — the column
// was a dangling FK. Root cause of "activation succeeded but no carrier logs
// show" also included TEST simply missing the carrier_api_logs table
// (see supabase/migrations/20260824_carrier_api_logs_test_parity.sql), but
// even once that table exists, an operator opening an item still needs the
// carrier_log_id link populated to reliably associate the right log row —
// this locks in that logCarrierApiCall()'s inserted id now flows all the way
// through to the activation_job_items PATCH, on both the success path and
// the failure path (e.g. a port-in the carrier rejects on PIN, matching the
// real b6fdced3/9391548c T-Mobile PIN-rejection test run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/bulk-activator/index.js';

function makeQueueEnvMock({ carrierLogRowId = 555, atomicOk = true, atomicBody = null } = {}) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    requests.push({ url: u, method, body: init?.body ? JSON.parse(init.body) : null });

    // Existing-SIM check before activation.
    if (u.includes('/rest/v1/sims?select=id,mobility_subscription_id')) {
      return new Response('[]', { status: 200 });
    }
    // ATOMIC carrier call itself.
    if (u.includes('atomic.test')) {
      const body = atomicBody || (atomicOk
        ? { wholeSaleApi: { wholeSaleResponse: { Result: { MSISDN: '2125550101', BAN: 'BAN1' } } } }
        : { wholeSaleApi: { wholeSaleResponse: { description: 'Invalid PIN' } } });
      return new Response(JSON.stringify(body), { status: atomicOk ? 200 : 502 });
    }
    // logCarrierApiCall() insert — mirrors real PostgREST: only echoes the
    // inserted row (and thus its id) back when Prefer: return=representation
    // is sent; return=minimal would come back with an empty body, same as
    // production, so a regression back to return=minimal fails this test via
    // a null/undefined carrier_log_id downstream instead of passing silently.
    if (u.includes('/rest/v1/carrier_api_logs') && method === 'POST') {
      const prefer = (init?.headers || {})['Prefer'] || (init?.headers || {})['prefer'];
      if (prefer !== 'return=representation') return new Response(null, { status: 201 });
      return new Response(JSON.stringify([{ id: carrierLogRowId }]), { status: 201 });
    }
    // sims upsert (select then insert/patch).
    if (u.includes('/rest/v1/sims?select=id,activated_at')) {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/sims') && method === 'POST') {
      return new Response(JSON.stringify([{ id: 9001 }]), { status: 201 });
    }
    if (u.includes('/rest/v1/sims') && method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    // recomputeActivationRunCounts + updateJobItemStatus.
    if (u.includes('/rest/v1/activation_job_items') && method === 'GET') {
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/activation_job_items') && method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    if (u.includes('/rest/v1/activation_runs') && method === 'PATCH') {
      return new Response(null, { status: 204 });
    }
    return new Response('[]', { status: 200 });
  };
  return {
    requests,
    restore: () => { globalThis.fetch = originalFetch; },
    env: {
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ATOMIC_API_URL: 'https://atomic.test/activate',
      ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p',
    },
  };
}

// The queue consumer PATCHes the job item twice: once to 'processing' at the
// start, then once more to its terminal 'done'/'failed' status — take the
// last one, not the first.
function finalItemPatchFor(requests, iccid) {
  const patches = requests.filter(r =>
    r.url.includes('/rest/v1/activation_job_items') &&
    r.method === 'PATCH' &&
    r.url.includes('iccid=eq.' + encodeURIComponent(iccid))
  );
  return patches[patches.length - 1];
}

test('a successful ATOMIC port-in links the written carrier_api_logs row via carrier_log_id', async () => {
  const { requests, restore, env } = makeQueueEnvMock({ carrierLogRowId: 777 });
  try {
    const iccid = '89012804332468992577';
    const batch = {
      messages: [{
        body: {
          iccid, imei: '359729444337382', run_id: 'json_1', job_run_id: 'run-uuid-1',
          vendor: 'atomic',
          port_mdn: '2125550101', port_account_number: 'ACCT1', port_pin: '1234',
          port_first_name: 'Jane', port_last_name: 'Doe',
          port_street_number: '123', port_street_name: 'Main St', port_zip: '75001',
          port_old_first_name: 'Old', port_old_last_name: 'Carrier',
        },
        ack: () => {},
      }],
    };

    await worker.queue(batch, env);

    const patch = finalItemPatchFor(requests, iccid);
    assert.ok(patch, 'activation_job_items was PATCHed for this iccid');
    assert.equal(patch.body.status, 'done');
    assert.equal(patch.body.carrier_log_id, 777, 'the id returned by the carrier_api_logs insert is written back to the job item');
  } finally {
    restore();
  }
});

test('a carrier-rejected ATOMIC port-in (e.g. bad PIN) still links its carrier_log_id on the failed item', async () => {
  const { requests, restore, env } = makeQueueEnvMock({ carrierLogRowId: 888, atomicOk: false });
  try {
    const iccid = '89012804332469396042';
    const batch = {
      messages: [{
        body: {
          iccid, imei: '111111111111111', run_id: 'json_2', job_run_id: 'run-uuid-2',
          vendor: 'atomic',
          port_mdn: '2125550102', port_account_number: 'ACCT2', port_pin: '0000',
          port_first_name: 'Jane', port_last_name: 'Doe',
          port_street_number: '123', port_street_name: 'Main St', port_zip: '75001',
          port_old_first_name: 'Old', port_old_last_name: 'Carrier',
        },
        ack: () => {},
      }],
    };

    await worker.queue(batch, env);

    const patch = finalItemPatchFor(requests, iccid);
    assert.ok(patch, 'activation_job_items was PATCHed for this iccid');
    assert.equal(patch.body.status, 'failed');
    assert.equal(patch.body.carrier_log_id, 888, 'the rejected carrier call was still logged and its id linked, so the operator can see why it failed');
  } finally {
    restore();
  }
});
