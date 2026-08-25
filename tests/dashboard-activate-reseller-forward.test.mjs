// Regression test: the dashboard's "activate to reseller" dropdown sends a
// single top-level reseller_id in the /api/activate POST body. handleActivateSims
// is a thin proxy over the BULK_ACTIVATOR service binding — it must forward
// reseller_id verbatim to bulk-activator's /activate route (which applies it
// to every row — see bulk-activator-job-tracking.test.mjs), the same way it
// already forwards sims/vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'function not found: ' + signature);
  let depth = 0, started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated function: ' + signature);
}

function makeBulkActivatorBinding(responder) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      return responder(url, init);
    },
  };
}

function makeSandbox() {
  const sandbox = { console, Response, URL, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SRC, 'async function handleActivateSims(request, env, corsHeaders) {'), sandbox);
  return sandbox;
}

test('handleActivateSims forwards reseller_id from the request body to bulk-activator', async () => {
  const sandbox = makeSandbox();
  const bulkActivator = makeBulkActivatorBinding(() =>
    new Response(JSON.stringify({ ok: true, queued: 2, job_run_id: 'run-1' }), { status: 200 }));

  const env = { BULK_RUN_SECRET: 'test-secret', BULK_ACTIVATOR: bulkActivator };
  const fakeRequest = {
    method: 'POST',
    json: async () => ({
      vendor: 'atomic',
      reseller_id: '4',
      sims: [
        { iccid: '89014103271467425631', imei: '123456789012345' },
        { iccid: '89014103271467425632', imei: '123456789012346' },
      ],
    }),
  };

  const res = await sandbox.handleActivateSims(fakeRequest, env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  assert.equal(bulkActivator.calls.length, 1);
  assert.match(bulkActivator.calls[0].url, /^https:\/\/bulk-activator\/activate\?secret=test-secret$/);
  assert.equal(bulkActivator.calls[0].body.reseller_id, '4');
  assert.equal(bulkActivator.calls[0].body.sims.length, 2);
});

test('handleActivateSims still works when reseller_id is omitted (row-level/legacy callers)', async () => {
  const sandbox = makeSandbox();
  const bulkActivator = makeBulkActivatorBinding(() =>
    new Response(JSON.stringify({ ok: true, queued: 1, job_run_id: 'run-2' }), { status: 200 }));

  const env = { BULK_RUN_SECRET: 'test-secret', BULK_ACTIVATOR: bulkActivator };
  const fakeRequest = {
    method: 'POST',
    json: async () => ({
      vendor: 'atomic',
      sims: [{ iccid: '89014103271467425631', imei: '123456789012345', reseller_id: '1' }],
    }),
  };

  const res = await sandbox.handleActivateSims(fakeRequest, env, {});
  assert.equal(res.status, 200);
  assert.equal(bulkActivator.calls[0].body.reseller_id, undefined);
  assert.equal(bulkActivator.calls[0].body.sims[0].reseller_id, '1');
});
