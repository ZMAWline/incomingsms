// The QuickBooks OAuth callback is reachable without a dashboard login
// (dashboard /api/qbo/callback runs before the auth gate), so the quickbooks
// Worker must only accept a `state` it issued itself. Otherwise anyone could
// finish consent for their own QuickBooks company and have it stored as ours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canAccess, ROLES } from '../src/shared/portal-auth.mjs';

// Loaded via a data: URL import (same trick as teltik-worker-rotation-lane.test.mjs)
// because package.json is "type":"commonjs" but index.js uses ESM syntax.
const workerSrc = (await readFile(new URL('../src/quickbooks/index.js', import.meta.url), 'utf8'))
  .replace(/'\.\.\/shared\/([^']+)'/g, (_, f) => JSON.stringify(new URL(`../src/shared/${f}`, import.meta.url).href));
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;

function fakeKv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
  };
}

function env() {
  return { QBO_TOKENS: fakeKv(), QBO_CLIENT_ID: 'cid', QBO_CLIENT_SECRET: 'sec', QBO_REDIRECT_URI: 'https://dash/api/qbo/callback' };
}

const call = (e, path) => worker.fetch(new Request(`https://quickbooks${path}`), e);

test('callback without a state this Worker issued is rejected and stores nothing', async () => {
  const e = env();
  for (const q of ['?code=c&realmId=1', '?code=c&realmId=1&state=made-up']) {
    const res = await call(e, `/callback${q}`);
    assert.equal(res.status, 400);
  }
  assert.equal(e.QBO_TOKENS.m.has('tokens'), false);
});

test('auth-url issues a state that the callback accepts exactly once', async () => {
  const e = env();
  const { url } = await (await call(e, '/auth-url')).json();
  const state = new URL(url).searchParams.get('state');
  assert.equal(e.QBO_TOKENS.m.has(`oauth_state:${state}`), true);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    access_token: 'a', refresh_token: 'r', expires_in: 3600, x_refresh_token_expires_in: 86400,
  }), { status: 200 });
  try {
    const ok = await call(e, `/callback?code=c&realmId=9&state=${state}`);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(e.QBO_TOKENS.m.get('tokens')).realm_id, '9');

    const replay = await call(e, `/callback?code=c&realmId=9&state=${state}`);
    assert.equal(replay.status, 400);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/qbo/* is admin-only; /api/qbo-mappings keeps its old rules', () => {
  assert.equal(canAccess(ROLES.ADMIN, 'GET', '/api/qbo/connect'), true);
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/qbo/connect'), false);
  assert.equal(canAccess(ROLES.VIEWER, 'GET', '/api/qbo/status'), false);
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/qbo-mappings'), true);
});
