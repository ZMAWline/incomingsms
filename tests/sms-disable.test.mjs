// TEMPORARY outbound-SMS kill switch (src/shared/sms-availability.mjs):
// Skyline gateways are powered off, so every send path must refuse/skip with
// a clear "SMS not available right now" instead of calling the gateway —
// and the underlying send code must stay intact for re-enable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { smsSendingEnabled, SMS_UNAVAILABLE_MESSAGE } from '../src/shared/sms-availability.mjs';
import { startVerify } from '../src/bad-rental-remediator/verify-runner.mjs';

// package.json is "type":"commonjs", so node parses the worker's .js as CJS.
// Load it as ESM via a data: URL, rewriting its relative shared import to an
// absolute file: URL first (data: modules can't resolve relative specifiers).
const sharedUrl = new URL('../src/shared/sms-availability.mjs', import.meta.url).href;
const gatewaySrc = (await readFile(new URL('../src/skyline-gateway/index.js', import.meta.url), 'utf8'))
  .replace('"../shared/sms-availability.mjs"', JSON.stringify(sharedUrl));
const skylineGateway = (await import('data:text/javascript;base64,' + Buffer.from(gatewaySrc).toString('base64'))).default;

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return calls;
}

function sendSmsRequest() {
  return new Request('https://skyline-gateway/send-sms?secret=s3cret', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ gateway_id: 1, port: '1A', to: '+15551234567', message: 'hi' }),
  });
}

test('switch defaults to disabled, env override re-enables', () => {
  assert.equal(smsSendingEnabled({}), false);
  assert.equal(smsSendingEnabled(undefined), false);
  assert.equal(smsSendingEnabled({ SMS_SENDING_ENABLED: 'true' }), true);
});

test('gateway /send-sms is blocked with a clear message and never touches gateway/DB', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubFetch(() => { throw new Error('no outbound calls expected'); });

  const res = await skylineGateway.fetch(sendSmsRequest(), { SKYLINE_SECRET: 's3cret' });
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'sms_unavailable');
  assert.equal(body.error, SMS_UNAVAILABLE_MESSAGE);
  assert.equal(calls.length, 0);
});

test('gateway send path stays intact behind the switch (env override reaches gateway lookup)', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  // Gateway lookup returns no rows -> handler proceeds past the guard and
  // fails with its normal "Gateway not found", proving the send code is live.
  const calls = stubFetch(() => new Response('[]', { status: 200 }));

  const env = {
    SKYLINE_SECRET: 's3cret',
    SMS_SENDING_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake',
  };
  const res = await skylineGateway.fetch(sendSmsRequest(), env);
  const body = await res.json();

  assert.equal(res.status, 404);
  assert.equal(body.error, 'Gateway not found');
  assert.ok(calls.length >= 1, 'expected the handler to attempt the gateway DB lookup');
});

const SIM = { id: 2, current_mdn_e164: '+15551234567', gateway_id: 7, port: '1A' };

test('verify sequence skips the SMS step without escalating or writing anything', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = stubFetch(() => { throw new Error('no supabase writes expected'); });

  const env = {
    SKYLINE_GATEWAY: { fetch: () => { throw new Error('gateway must not be called'); } },
    SKYLINE_SECRET: 's3cret',
  };
  const out = await startVerify(env, { report: { id: 1 }, sim: SIM, attemptNo: 1 });

  assert.equal(out.ok, false);
  assert.equal(out.status, 'sms_unavailable');
  assert.equal(out.error, SMS_UNAVAILABLE_MESSAGE);
  // No escalation PATCH, no failed-attempt insert, no gateway call.
  assert.equal(calls.length, 0);
});

test('verify send path stays intact behind the switch (env override sends nonce)', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(() => new Response('{}', { status: 200 })); // supabase PATCH/insert stubs

  let gatewayCalls = 0;
  const env = {
    SKYLINE_GATEWAY: {
      fetch: async () => {
        gatewayCalls++;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
    SKYLINE_SECRET: 's3cret',
    SMS_SENDING_ENABLED: 'true',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake',
  };
  const out = await startVerify(env, { report: { id: 1 }, sim: SIM, attemptNo: 1 });

  assert.equal(out.ok, true);
  assert.equal(out.status, 'verify_pending');
  assert.equal(gatewayCalls, 1);
});
