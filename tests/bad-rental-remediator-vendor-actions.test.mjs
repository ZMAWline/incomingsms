// Tests for INC-21 / INC-16e — vendor restore/refresh actions.
//
// One integration test per safe vendor action covers:
//   - calls the vendor endpoint with the correct method + payload (and never
//     a forbidden surface: Atomic doesn't reconnectSubscriber/deactivate/swap,
//     Wing never PUTs the ABIR plan, Helix doesn't 4.8/4.9/4.10/4.16/Cancel,
//     Teltik doesn't /change-number/sim-swap/forward-url),
//   - Teltik MDN10 enforcement at the API client boundary (no E.164 leaves
//     the worker),
//   - 24h cooldown idempotency: a re-call within the cooldown window returns
//     the cached vendor request_id with status='cached' and DOES NOT issue a
//     second vendor HTTP request,
//   - the §H.2 forbidden-action property still holds after the SAFE_ACTIONS
//     vocabulary expanded (asserts none of FORBIDDEN_ACTIONS sneaked into
//     SAFE_ACTIONS).
//
// The §C gate is tested in tests/bad-rental-remediator-verify.test.mjs; this
// file deliberately stops at the executor boundary (gate runs at the worker
// layer over the executor result).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeAction, SAFE_ACTIONS, actionKvKey,
} from '../src/bad-rental-remediator/actions.mjs';
import { FORBIDDEN_ACTIONS } from '../src/bad-rental-remediator/classifier.mjs';
import { mdn10 } from '../src/bad-rental-remediator/teltik.mjs';

// ---------------------------------------------------------
// Vendor-aware fake env
// ---------------------------------------------------------

function makeEnv({ kv = {}, vendorResponses = {}, helixToken = 'tok-abc', envOverride = {} } = {}) {
  const calls = {
    fetch: [],
    atomic: [],
    wing: [],
    helix: [],
    teltik: [],
    kvReads: [],
    kvWrites: [],
  };

  const respond = (key) => {
    const r = vendorResponses[key];
    if (!r) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify(r.body == null ? {} : r.body), { status: r.status || 200 });
  };

  const fakeFetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    calls.fetch.push({ url: u, method });

    if (u.includes('solutionsatt-atomic.telgoo5.com')) {
      const body = JSON.parse(init.body);
      const rt = body.wholeSaleApi.wholeSaleRequest.requestType;
      calls.atomic.push({ requestType: rt, request: body.wholeSaleApi.wholeSaleRequest });
      return respond('atomic:' + rt);
    }
    if (u.includes('restapi19.att.com')) {
      calls.wing.push({ method, url: u, body: init && init.body ? JSON.parse(init.body) : null });
      return respond('wing:' + method);
    }
    if (u.includes('/hxtoken')) {
      return new Response(JSON.stringify({ access_token: helixToken }), { status: 200 });
    }
    if (u.includes('/api/mobility-subscriber/reset-ota')) {
      calls.helix.push({ endpoint: 'reset-ota', body: JSON.parse(init.body) });
      return respond('helix:reset-ota');
    }
    if (u.includes('/api/mobility-subscriber/status')) {
      calls.helix.push({ endpoint: 'status', body: JSON.parse(init.body) });
      return respond('helix:status');
    }
    if (u.includes('api.smsgateway.xyz/v1/reset-network')) {
      const qsMdn = new URL(u).searchParams.get('mdn');
      calls.teltik.push({ endpoint: 'reset-network', mdn: qsMdn, url: u });
      return respond('teltik:reset-network');
    }
    if (u.includes('api.smsgateway.xyz/v1/reset-port')) {
      const qsMdn = new URL(u).searchParams.get('mdn');
      calls.teltik.push({ endpoint: 'reset-port', mdn: qsMdn, url: u });
      return respond('teltik:reset-port');
    }
    return new Response('{}', { status: 200 });
  };

  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    ATOMIC_API_URL: 'https://solutionsatt-atomic.telgoo5.com:22712',
    ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p',
    WING_IOT_USERNAME: 'wu', WING_IOT_API_KEY: 'wk',
    HX_API_BASE: 'https://hx.example',
    HX_TOKEN_URL: 'https://hx.example/hxtoken',
    HX_CLIENT_ID: 'cid', HX_AUDIENCE: 'aud',
    HX_GRANT_USERNAME: 'gu', HX_GRANT_PASSWORD: 'gp',
    TELTIK_API_KEY: 'tk',
    REMEDIATOR_KV: {
      async get(key) { calls.kvReads.push(key); return kv[key] === undefined ? null : kv[key]; },
      async put(key, val, _opts) { calls.kvWrites.push({ key, val }); kv[key] = val; },
    },
    ...envOverride,
  };

  const orig = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return { env, calls, kv, restore: () => { globalThis.fetch = orig; } };
}

const ATOMIC_OK = { body: { wholeSaleApi: { wholeSaleResponse: { statusCode: '00', description: 'ok', partnerTransactionId: 'atomic-req-1' } } } };
const WING_OK   = { body: { iccid: '8901', communicationPlan: 'Wing Tel Inc - NON ABIR SMS MO/MT US' } };
const HELIX_OK  = { body: { requestId: 'helix-req-9' } };
const TELTIK_OK = { body: { request_id: 'tel-req-7' } };

// ---------------------------------------------------------
// Atomic resendOtaProfile (A1)
// ---------------------------------------------------------

test('atomic_ota: POSTs resendOtaProfile with MSISDN+sim, returns vendor request id', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'atomic:resendOtaProfile': { status: 200, ...ATOMIC_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'atomic_ota',
      sim: { id: 'sim-1', current_mdn_e164: '+15550001111', iccid: '8901-A' },
      report: { id: 7 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'ok');
    assert.equal(res.vendorRequestId, 'atomic-req-1');
    assert.equal(calls.atomic.length, 1);
    assert.equal(calls.atomic[0].requestType, 'resendOtaProfile');
    assert.equal(calls.atomic[0].request.MSISDN, '+15550001111');
    assert.equal(calls.atomic[0].request.sim, '8901-A');
  } finally { restore(); }
});

test('atomic_ota: 24h cooldown idempotency — second call returns cached request_id, no second HTTP', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'atomic:resendOtaProfile': { status: 200, ...ATOMIC_OK } },
  });
  try {
    const ctx = {
      action: 'atomic_ota',
      sim: { id: 'sim-1', current_mdn_e164: '+15550001111', iccid: '8901-A' },
      report: { id: 7 }, attemptNo: 1,
    };
    const first = await executeAction(env, ctx);
    assert.equal(first.status, 'ok');
    const second = await executeAction(env, ctx);
    assert.equal(second.status, 'cached');
    assert.equal(second.vendorRequestId, 'atomic-req-1');
    assert.equal(calls.atomic.length, 1, 'second call must not hit vendor');
  } finally { restore(); }
});

// ---------------------------------------------------------
// Atomic restoreSubscriber CR (A3)
// ---------------------------------------------------------

test('atomic_restore: POSTs restoreSubscriber reasonCode=CR (never reconnect/deactivate/swap)', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'atomic:restoreSubscriber': { status: 200, ...ATOMIC_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'atomic_restore',
      sim: { id: 'sim-2', current_mdn_e164: '+15550002222' },
      report: { id: 9 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.atomic.length, 1);
    assert.equal(calls.atomic[0].requestType, 'restoreSubscriber');
    assert.equal(calls.atomic[0].request.MSISDN, '+15550002222');
    assert.equal(calls.atomic[0].request.reasonCode, 'CR');
    const forbidden = ['reconnectSubscriber', 'deactivateSubscriber', 'swapMSISDN', 'suspendSubscriber', 'UpdateSubscriberInfo'];
    for (const f of forbidden) {
      assert.equal(calls.atomic.find(c => c.requestType === f), undefined,
        'restore must not invoke ' + f);
    }
  } finally { restore(); }
});

test('atomic_restore: 24h cooldown idempotency keyed on MSISDN', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'atomic:restoreSubscriber': { status: 200, ...ATOMIC_OK } },
  });
  try {
    const ctx = {
      action: 'atomic_restore',
      sim: { id: 'sim-2', current_mdn_e164: '+15550002222' },
      report: { id: 9 }, attemptNo: 1,
    };
    await executeAction(env, ctx);
    const second = await executeAction(env, ctx);
    assert.equal(second.status, 'cached');
    assert.equal(calls.atomic.length, 1);
  } finally { restore(); }
});

// ---------------------------------------------------------
// Wing PUT dialable plan (W7)
// ---------------------------------------------------------

test('wing_put_dialable: PUT NON-ABIR plan, never the ABIR (non-dialable) plan', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'wing:PUT': { status: 200, ...WING_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'wing_put_dialable',
      sim: { id: 'sim-3', iccid: '8901-W' },
      report: { id: 11 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.wing.length, 1);
    assert.equal(calls.wing[0].method, 'PUT');
    assert.ok(calls.wing[0].url.endsWith('/v1/devices/8901-W'));
    assert.equal(calls.wing[0].body.communicationPlan, 'Wing Tel Inc - NON ABIR SMS MO/MT US');
    // hard property: no Wing call ever contains the ABIR non-dialable plan
    for (const c of calls.wing) {
      assert.ok(!JSON.stringify(c.body || {}).includes('ABIR 25Mbps'),
        'wing_put_dialable must never PUT the ABIR plan from the remediator');
    }
  } finally { restore(); }
});

test('wing_put_dialable: 24h cooldown idempotency keyed on ICCID', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'wing:PUT': { status: 200, ...WING_OK } },
  });
  try {
    const ctx = {
      action: 'wing_put_dialable',
      sim: { id: 'sim-3', iccid: '8901-W' },
      report: { id: 11 }, attemptNo: 1,
    };
    await executeAction(env, ctx);
    const second = await executeAction(env, ctx);
    assert.equal(second.status, 'cached');
    assert.equal(calls.wing.length, 1);
  } finally { restore(); }
});

// ---------------------------------------------------------
// Helix OTA refresh (H3 / 4.11)
// ---------------------------------------------------------

test('helix_ota: PATCH /reset-ota with [{ban, subscriberNumber, iccid}], cached Helix token', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'helix:reset-ota': { status: 200, ...HELIX_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'helix_ota',
      sim: { id: 'sim-4', current_mdn_e164: '5550004444', iccid: '8901-H', att_ban: 'BAN-1' },
      report: { id: 13 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    const helix = calls.helix.filter(c => c.endpoint === 'reset-ota');
    assert.equal(helix.length, 1);
    assert.equal(helix[0].body[0].ban, 'BAN-1');
    assert.equal(helix[0].body[0].subscriberNumber, '5550004444');
    assert.equal(helix[0].body[0].iccid, '8901-H');
  } finally { restore(); }
});

test('helix_ota: 24h cooldown idempotency, second call cached', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'helix:reset-ota': { status: 200, ...HELIX_OK } },
  });
  try {
    const ctx = {
      action: 'helix_ota',
      sim: { id: 'sim-4', current_mdn_e164: '5550004444', iccid: '8901-H', att_ban: 'BAN-1' },
      report: { id: 13 }, attemptNo: 1,
    };
    await executeAction(env, ctx);
    const second = await executeAction(env, ctx);
    assert.equal(second.status, 'cached');
    assert.equal(calls.helix.filter(c => c.endpoint === 'reset-ota').length, 1);
  } finally { restore(); }
});

// ---------------------------------------------------------
// Helix Unsuspend CR/35 (H4 / 4.6)
// ---------------------------------------------------------

test('helix_unsuspend: PATCH /status with reasonCode=CR reasonCodeId=35, never Cancel/Resume-on-cancel', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'helix:status': { status: 200, ...HELIX_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'helix_unsuspend',
      sim: { id: 'sim-5', current_mdn_e164: '5550005555' },
      report: { id: 15 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    const status = calls.helix.filter(c => c.endpoint === 'status');
    assert.equal(status.length, 1);
    const p = status[0].body[0];
    assert.equal(p.subscriberNumber, '5550005555');
    assert.equal(p.reasonCode, 'CR');
    assert.equal(p.reasonCodeId, 35);
    assert.equal(p.subscriberState, 'Active');
    // hard property: never the cancel-shaped payload
    assert.notEqual(p.reasonCode, 'CAN');
    assert.notEqual(p.reasonCode, 'BBL');
    assert.notEqual(p.subscriberState, 'Cancel');
    assert.notEqual(p.subscriberState, 'Resume On Cancel');
  } finally { restore(); }
});

// ---------------------------------------------------------
// Teltik reset-network (T3 first try)
// ---------------------------------------------------------

test('teltik_reset_network: GETs /v1/reset-network with 10-digit MDN (E.164 collapsed at boundary)', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'teltik:reset-network': { status: 200, ...TELTIK_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'teltik_reset_network',
      sim: { id: 'sim-6', current_mdn_e164: '+13044123064' },
      report: { id: 17 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.teltik.length, 1);
    assert.equal(calls.teltik[0].endpoint, 'reset-network');
    assert.equal(calls.teltik[0].mdn, '3044123064', 'must pass 10-digit MDN, never E.164');
    // hard property: no Teltik call URL ever contains the +1 / E.164 form
    for (const c of calls.teltik) {
      assert.ok(!c.url.includes('%2B') && !c.url.includes('+1'),
        'Teltik URL must not contain E.164 +1: ' + c.url);
    }
  } finally { restore(); }
});

// ---------------------------------------------------------
// Teltik reset-port (T4/T5, 409=success)
// ---------------------------------------------------------

test('teltik_reset_port: GETs /v1/reset-port with 10-digit MDN', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'teltik:reset-port': { status: 200, ...TELTIK_OK } },
  });
  try {
    const res = await executeAction(env, {
      action: 'teltik_reset_port',
      sim: { id: 'sim-7', current_mdn_e164: '+13044129999' },
      report: { id: 19 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(calls.teltik[0].endpoint, 'reset-port');
    assert.equal(calls.teltik[0].mdn, '3044129999');
  } finally { restore(); }
});

test('teltik_reset_port: 409 treated as success (already in flight)', async () => {
  const { env, restore } = makeEnv({
    vendorResponses: { 'teltik:reset-port': { status: 409, body: { error: 'already in flight' } } },
  });
  try {
    const res = await executeAction(env, {
      action: 'teltik_reset_port',
      sim: { id: 'sim-8', current_mdn_e164: '+13044121111' },
      report: { id: 21 }, attemptNo: 1,
    });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'ok');
    assert.equal(res.evidence.treated_as, 'already_in_flight');
  } finally { restore(); }
});

test('teltik_reset_port: 24h cooldown idempotency keyed on MDN10', async () => {
  const { env, calls, restore } = makeEnv({
    vendorResponses: { 'teltik:reset-port': { status: 200, ...TELTIK_OK } },
  });
  try {
    const ctx = {
      action: 'teltik_reset_port',
      sim: { id: 'sim-9', current_mdn_e164: '+13044121234' },
      report: { id: 23 }, attemptNo: 1,
    };
    await executeAction(env, ctx);
    const second = await executeAction(env, ctx);
    assert.equal(second.status, 'cached');
    assert.equal(calls.teltik.length, 1);
  } finally { restore(); }
});

test('teltik mdn10: collapses +1 / E.164 / formatted to 10 digits', () => {
  assert.equal(mdn10('+13044123064'), '3044123064');
  assert.equal(mdn10('13044123064'),  '3044123064');
  assert.equal(mdn10('(304) 412-3064'), '3044123064');
  assert.equal(mdn10('3044123064'),    '3044123064');
});

// ---------------------------------------------------------
// Per-action KV emergency disable for the new vendor actions
// (the existing test in actions.test.mjs loops SAFE_ACTIONS, but we re-assert
// here so a regression in the new executors is caught by this file alone.)
// ---------------------------------------------------------

test('KV emergency disable short-circuits every INC-16e vendor action', async () => {
  const newActions = [
    'atomic_ota', 'atomic_restore',
    'wing_put_dialable',
    'helix_ota', 'helix_unsuspend',
    'teltik_reset_network', 'teltik_reset_port',
  ];
  for (const action of newActions) {
    const kv = {}; kv[actionKvKey(action)] = 'true';
    const { env, calls, restore } = makeEnv({ kv });
    try {
      const res = await executeAction(env, {
        action,
        sim: { id: 1, current_mdn_e164: '+15550000000', iccid: 'I1', att_ban: 'B1' },
        report: { id: 1 }, attemptNo: 1,
      });
      assert.equal(res.status, 'disabled_by_kv', action + ' should be disabled by KV');
      assert.equal(calls.atomic.length + calls.wing.length + calls.helix.length + calls.teltik.length, 0,
        action + ' must not hit any vendor when KV-disabled');
    } finally { restore(); }
  }
});

// ---------------------------------------------------------
// SAFE_ACTIONS x FORBIDDEN_ACTIONS — property check (after vocabulary growth)
// ---------------------------------------------------------

test('forbidden-action property: no FORBIDDEN_ACTIONS leaked into SAFE_ACTIONS after INC-16e', () => {
  for (const f of FORBIDDEN_ACTIONS) {
    assert.ok(!SAFE_ACTIONS.includes(f),
      'forbidden action ' + f + ' must never appear in SAFE_ACTIONS');
  }
});

// ---------------------------------------------------------
// Bad-input rejection on missing identifiers
// ---------------------------------------------------------

test('vendor executors reject when required identifiers are missing', async () => {
  const { env, restore } = makeEnv();
  try {
    const cases = [
      { action: 'atomic_ota',           sim: { id: 1 } },                                    // no msisdn/iccid
      { action: 'atomic_restore',       sim: { id: 1 } },                                    // no msisdn
      { action: 'wing_put_dialable',    sim: { id: 1 } },                                    // no iccid
      { action: 'helix_ota',            sim: { id: 1, current_mdn_e164: '5551112222' } },    // no ban/iccid
      { action: 'helix_unsuspend',      sim: { id: 1 } },                                    // no subscriberNumber
      { action: 'teltik_reset_network', sim: { id: 1 } },                                    // no mdn
      { action: 'teltik_reset_port',    sim: { id: 1 } },                                    // no mdn
    ];
    for (const c of cases) {
      const res = await executeAction(env, { ...c, report: { id: 1 }, attemptNo: 1 });
      assert.equal(res.ok, false, c.action + ' should fail bad_input');
      assert.equal(res.status, 'bad_input', c.action + ' wrong status: ' + res.status);
    }
  } finally { restore(); }
});
