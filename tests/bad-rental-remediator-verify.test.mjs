// Tests for INC-19 / INC-16c — §C SMS verification subsystem.
//
// Fixtures cover the five §C scenarios called out in the Definition of Done:
//   - send-success            → startVerify writes verify_pending + attempt row
//   - send-fail-then-success  → 1st attempt fails, 2nd succeeds
//   - send-fail-3x            → all 3 attempts fail → verify_send_failed escalated
//   - receive-match           → resolvePendingVerify finds nonce → verify_received
//   - receive-timeout         → 5min elapsed, no nonce → verify_receive_timeout
// Plus determinism + §C.4 predicate fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintNonce,
  buildVerifyBody,
  parseVerifyBody,
  cleanRecheckPredicate,
} from '../src/bad-rental-remediator/verify.mjs';
import {
  startVerify,
  resolvePendingVerify,
  preResolveGate,
} from '../src/bad-rental-remediator/verify-runner.mjs';

// ---------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------

test('mintNonce is deterministic for same (report_id, attempt_no)', async () => {
  const a = await mintNonce(12345, 1);
  const b = await mintNonce(12345, 1);
  const c = await mintNonce(12345, 2);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test('buildVerifyBody produces ≤160 chars and parseable shape', () => {
  const body = buildVerifyBody({ reportId: '99', simId: 'sim-abc', nonce: 'deadbeef' });
  assert.ok(body.length <= 160);
  assert.equal(body, 'IncomingSMS test 99 sim-abc deadbeef');
  const parsed = parseVerifyBody(body + ' trailing junk');
  assert.deepEqual(parsed, { reportId: '99', simId: 'sim-abc', nonce: 'deadbeef' });
});

test('buildVerifyBody rejects bad nonce length', () => {
  assert.throws(() => buildVerifyBody({ reportId: '1', simId: 's', nonce: 'short' }));
});

test('cleanRecheckPredicate: all clean → passed', () => {
  const out = cleanRecheckPredicate({
    vendorRead: { healthy: true },
    autoAction: { completed: true },
    webhookDelivered: true,
    smsReceived: true,
  });
  assert.equal(out.passed, true);
});

test('cleanRecheckPredicate: any false → reason set', () => {
  const base = {
    vendorRead: { healthy: true },
    autoAction: { completed: true },
    webhookDelivered: true,
    smsReceived: true,
  };
  assert.equal(cleanRecheckPredicate({ ...base, vendorRead: { healthy: false } }).reason, 'vendor_read_unhealthy');
  assert.equal(cleanRecheckPredicate({ ...base, autoAction: { completed: false } }).reason, 'auto_action_not_complete');
  assert.equal(cleanRecheckPredicate({ ...base, webhookDelivered: false }).reason, 'webhook_not_delivered');
  assert.equal(cleanRecheckPredicate({ ...base, smsReceived: false }).reason, 'sms_not_received');
});

test('cleanRecheckPredicate: situationExtras.requirePortOnline (T4/T5)', () => {
  const base = {
    vendorRead: { healthy: true },
    autoAction: { completed: true },
    webhookDelivered: true,
    smsReceived: true,
  };
  assert.equal(cleanRecheckPredicate({
    ...base, situationExtras: { requirePortOnline: true, portOnline: false },
  }).reason, 'port_not_online');
  assert.equal(cleanRecheckPredicate({
    ...base, situationExtras: { requirePortOnline: true, portOnline: true },
  }).passed, true);
});

// ---------------------------------------------------------
// Runner — fake env + collectors.
// ---------------------------------------------------------

function makeFakeEnv({ skylineResponses = [], inbound = [] } = {}) {
  const calls = { skyline: [], attempts: [], patches: [], supabaseGets: [] };
  const reports = new Map(); // id → row
  let skylineIdx = 0;

  const fakeFetch = async (url, init) => {
    const u = String(url);
    calls.supabaseGets.push({ url: u, init });

    if (u.includes('/rest/v1/rental_report_remediation_attempts') && init && init.method === 'POST') {
      calls.attempts.push(JSON.parse(init.body));
      return new Response('[]', { status: 201 });
    }
    if (u.includes('/rest/v1/rental_reports?id=eq.') && init && init.method === 'PATCH') {
      const id = decodeURIComponent(u.split('id=eq.')[1].split('&')[0]);
      const patch = JSON.parse(init.body);
      calls.patches.push({ id, patch });
      reports.set(id, { ...(reports.get(id) || {}), ...patch });
      return new Response('[]', { status: 200 });
    }
    if (u.includes('/rest/v1/sims?id=eq.')) {
      return new Response(JSON.stringify([{ current_mdn_e164: '+15551234567' }]), { status: 200 });
    }
    if (u.includes('/rest/v1/inbound_sms')) {
      // Honour basic to_number + body~nonce filter so receive-match vs timeout works.
      const params = new URL(u).searchParams;
      const to = (params.get('to_number') || '').replace('eq.', '');
      const bodyLike = (params.get('body') || '').replace('like.', '').replace(/\*/g, '');
      const after = (params.get('received_at') || '').replace('gt.', '');
      const matches = inbound.filter(r =>
        r.to_number === to
        && (!bodyLike || (r.body || '').includes(bodyLike))
        && (!after || (r.received_at || '') > after)
      );
      return new Response(JSON.stringify(matches.slice(0, 1)), { status: 200 });
    }
    if (u.includes('/rest/v1/rental_reports') && (!init || init.method !== 'PATCH')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const env = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srv',
    SKYLINE_SECRET: 'secret',
    SKYLINE_GATEWAY: {
      async fetch(req) {
        calls.skyline.push({ url: req.url, body: await req.text() });
        const r = skylineResponses[Math.min(skylineIdx, skylineResponses.length - 1)];
        skylineIdx++;
        return new Response(JSON.stringify(r.body || {}), { status: r.status || 200 });
      },
    },
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  return { env, calls, reports, restore: () => { globalThis.fetch = origFetch; } };
}

const SIM = {
  id: 'sim-1',
  current_mdn_e164: '+15551234567',
  gateway_id: 'gw1',
  port: 7,
};

// ---------------------------------------------------------
// §C scenarios
// ---------------------------------------------------------

test('§C send-success: writes verify_pending + verify_send_attempt row', async () => {
  const { env, calls, restore } = makeFakeEnv({
    skylineResponses: [{ status: 200, body: { ok: true, request_id: 'rq-1' } }],
  });
  try {
    const out = await startVerify(env, {
      report: { id: 42 },
      sim: SIM,
      attemptNo: 1,
      sleep: async () => {},
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 'verify_pending');
    assert.equal(calls.skyline.length, 1);
    assert.equal(calls.attempts.length, 1);
    assert.equal(calls.attempts[0].outcome, 'verify_send_attempt');
    const patch = calls.patches.find(p => p.patch.auto_remediation_state === 'verify_pending');
    assert.ok(patch, 'expected verify_pending patch');
    assert.ok(patch.patch.verify_pending_nonce);
    assert.ok(patch.patch.verify_pending_sent_at);
  } finally {
    restore();
  }
});

test('§C send-fail-then-success: 1st 500, 2nd 200 → verify_pending, 1 attempt row', async () => {
  const { env, calls, restore } = makeFakeEnv({
    skylineResponses: [
      { status: 502, body: { error: 'bad gateway' } },
      { status: 200, body: { ok: true } },
    ],
  });
  try {
    const out = await startVerify(env, {
      report: { id: 43 }, sim: SIM, attemptNo: 1, sleep: async () => {},
    });
    assert.equal(out.status, 'verify_pending');
    assert.equal(calls.skyline.length, 2);
    assert.equal(calls.attempts.filter(a => a.outcome === 'verify_send_attempt').length, 1);
  } finally {
    restore();
  }
});

test('§C send-fail-3x: all 500 → verify_send_failed + escalated', async () => {
  const { env, calls, restore } = makeFakeEnv({
    skylineResponses: [
      { status: 500, body: { error: 'down' } },
      { status: 500, body: { error: 'down' } },
      { status: 500, body: { error: 'down' } },
    ],
  });
  try {
    const out = await startVerify(env, {
      report: { id: 44 }, sim: SIM, attemptNo: 1, sleep: async () => {},
    });
    assert.equal(out.ok, false);
    assert.equal(out.status, 'verify_send_failed');
    assert.equal(calls.skyline.length, 3);
    assert.equal(calls.attempts[0].outcome, 'verify_send_failed');
    const esc = calls.patches.find(p => p.patch.auto_remediation_state === 'escalated');
    assert.equal(esc.patch.escalation_reason, 'verify_send_failed');
  } finally {
    restore();
  }
});

test('§C receive-match: nonce found in inbound_sms → verify_received, state cleared', async () => {
  const nonce = await mintNonce(45, 1);
  const sentAt = '2026-06-08T20:00:00.000Z';
  const { env, calls, restore } = makeFakeEnv({
    inbound: [{
      id: 9001,
      to_number: '+15551234567',
      from_number: '+15559998888',
      body: 'IncomingSMS test 45 sim-1 ' + nonce,
      received_at: '2026-06-08T20:00:30.000Z',
    }],
  });
  try {
    const report = {
      id: 45, sim_id: 'sim-1',
      verify_pending_nonce: nonce,
      verify_pending_sent_at: sentAt,
      verify_to_number: '+15551234567',
      verify_attempt_no: 1,
    };
    const r = await resolvePendingVerify(env, report);
    assert.equal(r, 'match');
    assert.equal(calls.attempts[0].outcome, 'verify_received');
    assert.equal(calls.attempts[0].evidence.inbound_sms_id, 9001);
    // A matched nonce is a definitive §C close: report → remediated/done, not
    // re-queued (re-queuing stranded verified reports behind the action cooldown).
    const clear = calls.patches.find(p => p.patch.verify_pending_nonce === null);
    assert.ok(clear);
    assert.equal(clear.patch.auto_remediation_state, 'done');
    assert.equal(clear.patch.status, 'remediated');
    assert.ok(clear.patch.closed_at, 'expected closed_at to be set on remediated close');
  } finally {
    restore();
  }
});

test('§C receive-timeout: no nonce, >5 min elapsed → verify_receive_timeout + escalated', async () => {
  const nonce = await mintNonce(46, 1);
  const { env, calls, restore } = makeFakeEnv({ inbound: [] });
  try {
    const report = {
      id: 46, sim_id: 'sim-1',
      verify_pending_nonce: nonce,
      verify_pending_sent_at: '2026-06-08T20:00:00.000Z',
      verify_to_number: '+15551234567',
      verify_attempt_no: 1,
    };
    const r = await resolvePendingVerify(env, report, {
      now: () => new Date('2026-06-08T20:06:00.000Z'),
    });
    assert.equal(r, 'timeout');
    assert.equal(calls.attempts[0].outcome, 'verify_receive_timeout');
    const esc = calls.patches.find(p => p.patch.auto_remediation_state === 'escalated');
    assert.equal(esc.patch.escalation_reason, 'verify_receive_timeout');
  } finally {
    restore();
  }
});

test('§C receive still-pending: no nonce, <5 min elapsed → still_pending, no writes', async () => {
  const nonce = await mintNonce(47, 1);
  const { env, calls, restore } = makeFakeEnv({ inbound: [] });
  try {
    const report = {
      id: 47, sim_id: 'sim-1',
      verify_pending_nonce: nonce,
      verify_pending_sent_at: '2026-06-08T20:00:00.000Z',
      verify_to_number: '+15551234567',
      verify_attempt_no: 1,
    };
    const r = await resolvePendingVerify(env, report, {
      now: () => new Date('2026-06-08T20:02:00.000Z'),
    });
    assert.equal(r, 'still_pending');
    assert.equal(calls.attempts.length, 0);
    assert.equal(calls.patches.length, 0);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------
// preResolveGate — universal gate
// ---------------------------------------------------------

test('preResolveGate: vendor unhealthy → no SMS sent, predicate_failed', async () => {
  const { env, calls, restore } = makeFakeEnv({});
  try {
    const r = await preResolveGate(env, {
      report: { id: 50 },
      sim: SIM,
      vendorRead: { healthy: false },
      autoAction: { completed: true },
      webhookDelivered: true,
      attemptNo: 1,
    });
    assert.equal(r.passed, false);
    assert.equal(r.status, 'predicate_failed');
    assert.equal(r.reason, 'vendor_read_unhealthy');
    assert.equal(calls.skyline.length, 0);
  } finally {
    restore();
  }
});

test('preResolveGate: clean + no pending → starts verify, returns verify_pending', async () => {
  const { env, calls, restore } = makeFakeEnv({
    skylineResponses: [{ status: 200, body: { ok: true } }],
  });
  try {
    const r = await preResolveGate(env, {
      report: { id: 51 },
      sim: SIM,
      vendorRead: { healthy: true },
      autoAction: { completed: true },
      webhookDelivered: true,
      attemptNo: 1,
    });
    assert.equal(r.passed, false);
    assert.equal(r.status, 'verify_pending');
    assert.equal(calls.skyline.length, 1);
  } finally {
    restore();
  }
});
