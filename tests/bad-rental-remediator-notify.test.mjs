// notify.mjs — Slack notification for TH5 Teltik port-offline detection.
// Covers: no-webhook no-op, message posting for both alert kinds, per-key
// dedup via the fake KV, and that a Slack failure/exception never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyPortOffline } from '../src/bad-rental-remediator/notify.mjs';

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
