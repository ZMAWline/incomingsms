// Regression test for the b11b2839/bea426e6 stuck-retry bug (PR #69 live
// activation follow-up): handleActivationRunRetry used to call
// env.ACTIVATION_QUEUE.send(...) directly, but ACTIVATION_QUEUE is a queue
// producer binding that only exists on the bulk-activator/bulk-activator-test
// workers (see src/bulk-activator/wrangler.toml) — dashboard/dashboard-test
// have no such binding. Every retry click threw after patching the item row
// to status='queued', so items sat "queued" forever with no message ever
// delivered to the queue and the run's aggregate counts never refreshed.
//
// Fix: dashboard now forwards the retry to bulk-activator's new /retry route
// over the existing BULK_ACTIVATOR service binding — the same pattern already
// used by handleActivateSims for the initial-submit path.
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

function makeSandbox(routes) {
  const calls = [];
  const bindingCalls = [];
  const sandbox = {
    console, Response, URL, URLSearchParams,
    async fetch(url, init) {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
      for (const [pattern, handler] of routes) {
        if (u.includes(pattern)) return handler(u, init);
      }
      return new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractFn(SRC, 'async function supabaseGet(env, path, extraHeaders) {'),
    extractFn(SRC, 'async function handleActivationRunRetry(request, env, corsHeaders) {'),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, calls, bindingCalls };
}

const RUN = { id: 'run-1', source: 'json', status: 'failed' };
const ITEM = {
  id: 'item-1', run_id: 'run-1', iccid: '89012804332468992577', imei: '359729444337382',
  reseller_id: 3, vendor: 'atomic', status: 'failed', attempt: 1, max_attempts: 3,
};

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

test('retry never calls env.ACTIVATION_QUEUE directly — it has no such binding', () => {
  // Static guard: no live env.ACTIVATION_QUEUE.send()/sendBatch() call in the
  // function body (an explanatory code comment mentioning the old bug is fine,
  // so comment-only lines are stripped before matching).
  const fn = extractFn(SRC, 'async function handleActivationRunRetry(request, env, corsHeaders) {');
  const codeOnly = fn.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(
    !/env\.ACTIVATION_QUEUE\s*\.\s*(send|sendBatch)\s*\(/.test(codeOnly),
    'dashboard has no ACTIVATION_QUEUE binding — retry must delegate to bulk-activator instead'
  );
});

test('retry forwards eligible items to bulk-activator over the BULK_ACTIVATOR service binding', async () => {
  const { sandbox, calls } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([RUN]), { status: 200 })],
    ['/activation_job_items', (u) => u.includes('run_id=eq.run-1')
      ? new Response(JSON.stringify([ITEM]), { status: 200 })
      : new Response('[]', { status: 200 })],
  ]);

  const bulkActivator = makeBulkActivatorBinding(() =>
    new Response(JSON.stringify({ ok: true, retried: 1, run_id: 'run-1' }), { status: 200 }));

  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    BULK_RUN_SECRET: 'test-secret',
    BULK_ACTIVATOR: bulkActivator,
  };

  const fakeRequest = { json: async () => ({ run_id: 'run-1', item_ids: ['item-1'] }) };

  const res = await sandbox.handleActivationRunRetry(fakeRequest, env, {});
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true, retried: 1, run_id: 'run-1' });

  assert.equal(bulkActivator.calls.length, 1, 'exactly one call forwarded to bulk-activator');
  assert.match(bulkActivator.calls[0].url, /^https:\/\/bulk-activator\/retry\?secret=test-secret$/);
  assert.equal(bulkActivator.calls[0].method, 'POST');
  assert.equal(bulkActivator.calls[0].body.run_id, 'run-1');
  assert.deepEqual(bulkActivator.calls[0].body.items, [ITEM]);
});

test('retry returns 500 with a clear error when BULK_RUN_SECRET is not configured', async () => {
  const { sandbox } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([RUN]), { status: 200 })],
    ['/activation_job_items', () => new Response(JSON.stringify([ITEM]), { status: 200 })],
  ]);

  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };
  const fakeRequest = { json: async () => ({ run_id: 'run-1', item_ids: ['item-1'] }) };

  const res = await sandbox.handleActivationRunRetry(fakeRequest, env, {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.match(body.error, /BULK_RUN_SECRET/);
});

test('retry propagates bulk-activator\'s error status and body verbatim', async () => {
  const { sandbox } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([RUN]), { status: 200 })],
    ['/activation_job_items', () => new Response(JSON.stringify([ITEM]), { status: 200 })],
  ]);

  const bulkActivator = makeBulkActivatorBinding(() =>
    new Response(JSON.stringify({ ok: false, error: 'Retry failed: boom', retried: 0, run_id: 'run-1' }), { status: 502 }));

  const env = {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv',
    BULK_RUN_SECRET: 'test-secret', BULK_ACTIVATOR: bulkActivator,
  };
  const fakeRequest = { json: async () => ({ run_id: 'run-1', item_ids: ['item-1'] }) };

  const res = await sandbox.handleActivationRunRetry(fakeRequest, env, {});
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /boom/);
});
