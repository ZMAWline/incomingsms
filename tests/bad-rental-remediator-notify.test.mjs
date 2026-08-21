// notify.mjs — Slack notification for TH5 Teltik port-offline detection.
// Covers: no-webhook no-op, message posting for both alert kinds, per-key
// dedup via the fake KV, and that a Slack failure/exception never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyPortOffline, notifyOfflineFleetSummary } from '../src/bad-rental-remediator/notify.mjs';

const realFetch = globalThis.fetch;

function fakeKv() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value); },
  };
}

const SIM = { iccid: '89148000001234', current_mdn_e164: '+12125551234', gateway_host: 'teltik' };

test.afterEach(() => { globalThis.fetch = realFetch; });

test('no SLACK_WEBHOOK_URL: no-ops, never calls fetch', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  const res = await notifyPortOffline({ REMEDIATOR_KV: fakeKv() }, { kind: 'first_detection', sim: SIM });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no_webhook');
  assert.equal(called, false);
});

test('first_detection posts a Block Kit payload including the ICCID', async () => {
  let posted = null;
  globalThis.fetch = async (url, init) => {
    posted = { url: String(url), body: JSON.parse(init.body) };
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };
  const res = await notifyPortOffline(env, { kind: 'first_detection', sim: SIM, portStatus: 'offline' });
  assert.equal(res.ok, true);
  assert.equal(posted.url, env.SLACK_WEBHOOK_URL);
  const text = JSON.stringify(posted.body);
  assert.ok(text.includes(SIM.iccid));
  assert.ok(text.includes(SIM.current_mdn_e164));
  assert.ok(text.toLowerCase().includes('offline'));
});

test('still_offline_after_reset includes the prior reset count and a distinct header', async () => {
  let posted = null;
  globalThis.fetch = async (url, init) => {
    posted = JSON.parse(init.body);
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };
  const res = await notifyPortOffline(env, {
    kind: 'still_offline_after_reset', sim: SIM, portStatus: 'offline', priorResets: 1,
  });
  assert.equal(res.ok, true);
  const text = JSON.stringify(posted);
  assert.ok(text.includes('still offline after auto-reset'));
  assert.ok(text.includes('Prior reset attempts:* 1'));
});

test('second call for the same ICCID + kind within the TTL is deduped, no second post', async () => {
  let postCount = 0;
  globalThis.fetch = async () => { postCount++; return { ok: true, status: 200 }; };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };

  const first = await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  const second = await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.skipped, 'deduped');
  assert.equal(postCount, 1);
});

test('different kinds for the same ICCID are not deduped against each other', async () => {
  let postCount = 0;
  globalThis.fetch = async () => { postCount++; return { ok: true, status: 200 }; };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };

  await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  await notifyPortOffline(env, { kind: 'still_offline_after_reset', sim: SIM, priorResets: 1 });

  assert.equal(postCount, 2);
});

test('a Slack HTTP failure resolves ok:false instead of throwing', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };
  const res = await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
});

test('a fetch exception resolves ok:false instead of throwing', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', REMEDIATOR_KV: fakeKv() };
  const res = await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  assert.equal(res.ok, false);
});

test('missing REMEDIATOR_KV fails open — still posts (no dedup available)', async () => {
  let postCount = 0;
  globalThis.fetch = async () => { postCount++; return { ok: true, status: 200 }; };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x' };
  await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  await notifyPortOffline(env, { kind: 'first_detection', sim: SIM });
  assert.equal(postCount, 2);
});

// --- notifyOfflineFleetSummary ------------------------------------------
// Fleet-wide digest, independent of report processing: covers every
// currently-offline Teltik line, not just ones with an open bad-rental
// report attached. Sends twice a day (8 AM / 4 PM America/New_York) rather
// than on every 15-min cron tick — tests inject a fixed `now` to land
// inside or outside those windows instead of depending on the real clock.
// 2026-08-21 is within EDT (UTC-4), so 8:05 AM ET = 12:05 UTC and
// 4:05 PM ET = 20:05 UTC.

const MORNING_WINDOW = new Date('2026-08-21T12:05:00Z');   // 8:05 AM ET
const AFTERNOON_WINDOW = new Date('2026-08-21T20:05:00Z'); // 4:05 PM ET
const OUTSIDE_WINDOW = new Date('2026-08-21T14:00:00Z');   // 10:00 AM ET
const NEXT_DAY_MORNING_WINDOW = new Date('2026-08-22T12:05:00Z'); // 8:05 AM ET, next day

function fakeOfflineRpc(rows, { rpcOk = true } = {}) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_currently_offline') {
      if (!rpcOk) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, json: async () => rows };
    }
    throw new Error('unexpected fetch ' + u.pathname);
  };
}

test('notifyOfflineFleetSummary: no webhook configured is a no-op', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  const res = await notifyOfflineFleetSummary({ REMEDIATOR_KV: fakeKv() }, { now: MORNING_WINDOW });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no_webhook');
  assert.equal(called, false);
});

test('notifyOfflineFleetSummary: outside the 8 AM / 4 PM ET windows is a no-op, no Supabase call at all', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200 }; };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  const res = await notifyOfflineFleetSummary(env, { now: OUTSIDE_WINDOW });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'outside_digest_window');
  assert.equal(called, false, 'must not even query offline lines outside the digest window');
});

test('notifyOfflineFleetSummary: nothing offline posts nothing and does not consume the dedup window', async () => {
  const kv = fakeKv();
  globalThis.fetch = fakeOfflineRpc([]);
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: kv };
  const res = await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, 'none_offline');
  assert.equal(kv.store.size, 0, 'an empty check must not burn the digest dedup window');
});

test('notifyOfflineFleetSummary: posts one batch message listing offline lines, capped with a "+N more"', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ sim_id: i + 1, iccid: 'ICC' + i, mdn: '212555' + String(i).padStart(4, '0') }));
  let posted = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_currently_offline') return { ok: true, status: 200, json: async () => rows };
    posted = JSON.parse(init.body);
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  const res = await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  assert.equal(res.ok, true);
  assert.equal(res.offline_count, 20);
  const text = JSON.stringify(posted);
  assert.ok(text.includes('20 Teltik line'));
  assert.ok(text.includes('ICC0'), 'first line listed');
  assert.ok(text.includes('...and 5 more'), 'list capped at 15 with a remainder note');
});

test('notifyOfflineFleetSummary: a second call in the same window is deduped, no second post', async () => {
  const rows = [{ sim_id: 1, iccid: 'ICC1', mdn: '2125551111' }];
  let postCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_currently_offline') return { ok: true, status: 200, json: async () => rows };
    postCount++;
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  const first = await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  const second = await notifyOfflineFleetSummary(env, { now: new Date(MORNING_WINDOW.getTime() + 5 * 60000) });
  assert.equal(first.ok, true);
  assert.equal(second.skipped, 'deduped');
  assert.equal(second.offline_count, 1);
  assert.equal(postCount, 1);
});

test('notifyOfflineFleetSummary: the afternoon window is not deduped against the same day\'s morning window', async () => {
  const rows = [{ sim_id: 1, iccid: 'ICC1', mdn: '2125551111' }];
  let postCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_currently_offline') return { ok: true, status: 200, json: async () => rows };
    postCount++;
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  const afternoon = await notifyOfflineFleetSummary(env, { now: AFTERNOON_WINDOW });
  assert.equal(afternoon.skipped, undefined, 'afternoon digest sends on its own, independent of the morning one');
  assert.equal(postCount, 2);
});

test('notifyOfflineFleetSummary: the same window sends again on a new day', async () => {
  const rows = [{ sim_id: 1, iccid: 'ICC1', mdn: '2125551111' }];
  let postCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/rest/v1/rpc/get_teltik_currently_offline') return { ok: true, status: 200, json: async () => rows };
    postCount++;
    return { ok: true, status: 200 };
  };
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  const nextDay = await notifyOfflineFleetSummary(env, { now: NEXT_DAY_MORNING_WINDOW });
  assert.equal(nextDay.skipped, undefined);
  assert.equal(postCount, 2);
});

test('notifyOfflineFleetSummary: an RPC failure resolves ok:false instead of throwing', async () => {
  globalThis.fetch = fakeOfflineRpc([], { rpcOk: false });
  const env = { SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', REMEDIATOR_KV: fakeKv() };
  const res = await notifyOfflineFleetSummary(env, { now: MORNING_WINDOW });
  assert.equal(res.ok, false);
});
