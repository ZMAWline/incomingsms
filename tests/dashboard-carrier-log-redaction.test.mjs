// Regression test: Activation Run item carrier logs must never reach the
// dashboard UI with raw secrets. carrier_api_logs.request_body stores the
// full ATOMIC wholeSaleApi request, which includes the ATOMIC session
// credentials (session.userName/token/pin) and, for port-ins, the
// subscriber's real port PIN/account number under
// wholeSaleRequest.old_service_provider.billingAccountPassword /
// billingAccountNumber (see buildAtomicPortInRequest in
// src/shared/activation-bulk.mjs). handleActivationRunDetail is the only
// place these rows leave the backend, so it must redact them there —
// showCarrierLogsModal in the dashboard renders request_body/response_body_json
// verbatim with no redaction of its own.

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

function extractConst(source, name) {
  const start = source.indexOf('const ' + name + ' =');
  assert.notEqual(start, -1, 'const not found: ' + name);
  const end = source.indexOf(';', start) + 1;
  return source.slice(start, end);
}

function makeSandbox(routes) {
  const calls = [];
  const sandbox = {
    console, Response, URL, URLSearchParams,
    async fetch(url, init) {
      const u = String(url);
      calls.push({ url: u, headers: (init && init.headers) || {} });
      for (const [pattern, handler] of routes) {
        if (u.includes(pattern)) return handler(u);
      }
      return new Response('[]', { status: 200 });
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractConst(SRC, 'REDACTED_HEADER_KEYS'),
    extractConst(SRC, 'REDACTED_BODY_FIELDS'),
    extractFn(SRC, 'function redactHeaders(h) {'),
    extractFn(SRC, 'function redactBody(b) {'),
    extractFn(SRC, 'async function supabaseGet(env, path, extraHeaders) {'),
    extractFn(SRC, 'async function handleActivationRunDetail(env, corsHeaders, runId, url) {'),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, calls };
}

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv' };

const RUN = { id: 'run-1', source: 'json', status: 'done', created_at: '2026-08-24T12:00:00Z' };
const ITEM = { id: 'item-1', run_id: 'run-1', iccid: '89012804332468992577', status: 'done' };

const RAW_CARRIER_LOG = {
  id: 1,
  iccid: '89012804332468992577',
  vendor: 'atomic',
  step: 'portin',
  request_url: 'https://atomic.example/activate',
  request_method: 'POST',
  request_body: {
    wholeSaleApi: {
      session: { userName: 'atomic_user', token: 'super-secret-token', pin: '9999' },
      wholeSaleRequest: {
        requestType: 'portinRequest',
        MSISDN: '2125550101',
        old_service_provider: {
          billingAccountNumber: 'ACCT12345',
          billingAccountPassword: '1234',
          firstName: 'Old', lastName: 'Carrier',
        },
      },
    },
  },
  response_status: 200,
  response_ok: true,
  response_body_json: { wholeSaleApi: { wholeSaleResponse: { Result: { MSISDN: '2125550101' } } } },
  created_at: '2026-08-24T12:01:00Z',
};

test('carrier log request_body redacts ATOMIC session credentials and the subscriber port PIN/account number', async () => {
  const { sandbox } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([RUN]), { status: 200 })],
    ['/activation_job_items', (u) => u.includes('run_id=eq.run-1')
      ? new Response(JSON.stringify([ITEM]), { status: 200, headers: { 'content-range': '0-0/1' } })
      : new Response('[]', { status: 200 })],
    ['/carrier_api_logs', () => new Response(JSON.stringify([RAW_CARRIER_LOG]), { status: 200 })],
  ]);

  const url = new sandbox.URL('https://dashboard.test/api/activation-runs/run-1');
  const res = await sandbox.handleActivationRunDetail(ENV, {}, 'run-1', url);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.carrier_logs.length, 1);
  const log = body.carrier_logs[0];
  const session = log.request_body.wholeSaleApi.session;
  const oldProvider = log.request_body.wholeSaleApi.wholeSaleRequest.old_service_provider;

  assert.equal(session.token, '[REDACTED]', 'ATOMIC session token must be redacted');
  assert.equal(session.pin, '[REDACTED]', 'ATOMIC session PIN must be redacted');
  assert.equal(session.userName, '[REDACTED]', 'ATOMIC session username must be redacted');
  assert.equal(oldProvider.billingAccountPassword, '[REDACTED]', 'the subscriber\'s real port PIN must be redacted');
  assert.equal(oldProvider.billingAccountNumber, '[REDACTED]', 'the subscriber\'s port account number must be redacted');

  // Non-sensitive fields must survive redaction so the log is still useful.
  assert.equal(log.request_body.wholeSaleApi.wholeSaleRequest.MSISDN, '2125550101');
  assert.equal(oldProvider.firstName, 'Old');
  assert.equal(log.vendor, 'atomic');
  assert.equal(log.step, 'portin');
});

test('carrier log with no sensitive fields is returned unchanged aside from the redaction pass being a no-op', async () => {
  const cleanLog = {
    id: 2,
    iccid: '89012804332468992577',
    vendor: 'wing_iot',
    step: 'activation',
    request_url: 'https://wing.example/devices/x',
    request_method: 'PUT',
    request_body: { communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US', status: 'ACTIVATED' },
    response_status: 200,
    response_ok: true,
    response_body_json: { status: 'ACTIVATED' },
    created_at: '2026-08-24T12:02:00Z',
  };
  const { sandbox } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([RUN]), { status: 200 })],
    ['/activation_job_items', (u) => u.includes('run_id=eq.run-1')
      ? new Response(JSON.stringify([ITEM]), { status: 200, headers: { 'content-range': '0-0/1' } })
      : new Response('[]', { status: 200 })],
    ['/carrier_api_logs', () => new Response(JSON.stringify([cleanLog]), { status: 200 })],
  ]);

  const url = new sandbox.URL('https://dashboard.test/api/activation-runs/run-1');
  const res = await sandbox.handleActivationRunDetail(ENV, {}, 'run-1', url);
  const body = await res.json();

  assert.deepEqual(body.carrier_logs[0].request_body, cleanLog.request_body);
  assert.deepEqual(body.carrier_logs[0].response_body_json, cleanLog.response_body_json);
});
