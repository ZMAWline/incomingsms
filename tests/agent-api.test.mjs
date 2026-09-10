// Agent API: the role fence and the audit trail's pure logic.
//
// The fence tests are the executable half of docs/agent-api.md's "what an
// operator key can and cannot do" table. If someone reclassifies a route, one
// of these fails rather than the docs quietly going stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requiredRole, canAccess } from '../src/shared/portal-auth.mjs';
import { shouldAudit, redact, extractSubject, principal } from '../src/dashboard/audit-log.mjs';
import { generateApiKey, keyEnvLabel, readApiKeyHeader, hasApiKeyHeader } from '../src/dashboard/api-keys.mjs';

// --- the role fence -------------------------------------------------------

const OPERATOR_ROUTES = [
  ['POST', '/api/atomic-query'], ['POST', '/api/helix-query'], ['POST', '/api/wing-check'],
  ['POST', '/api/teltik-query'], ['POST', '/api/teltik-host-check'], ['POST', '/api/sim-action'],
  ['POST', '/api/atomic-sub-action'], ['POST', '/api/atomic-swap-sim'], ['POST', '/api/atomic-swap-imei'],
  ['POST', '/api/suspend'], ['POST', '/api/restore'], ['POST', '/api/activate'],
  ['POST', '/api/fix-sim'], ['POST', '/api/hosting-port-status/run'], ['POST', '/api/send-test-sms'],
  ['GET', '/api/audit-log'],
];

test('every documented agent route is reachable by an operator', () => {
  for (const [method, path] of OPERATOR_ROUTES) {
    assert.ok(canAccess('operator', method, path), `operator blocked from ${method} ${path}`);
    assert.ok(!canAccess('viewer', method, path), `viewer reached ${method} ${path}`);
  }
});

test('the read routes the agent lists SIMs with are reachable', () => {
  for (const path of ['/api/sims', '/api/errors', '/api/error-logs', '/api/hosting-port-status/jobs']) {
    assert.ok(canAccess('operator', 'GET', path), `operator blocked from GET ${path}`);
  }
});

test('key management is admin-only whatever the method', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal(requiredRole(method, '/api/keys'), 'admin');
    assert.equal(requiredRole(method, '/api/keys/revoke'), 'admin');
  }
  assert.ok(!canAccess('operator', 'GET', '/api/keys'));
  assert.ok(canAccess('admin', 'POST', '/api/keys'));
});

test('reading money and credential routes is operator, changing them is admin', () => {
  // Deliberate, and unchanged by this work: GET /api/reseller-keys masks the
  // key before returning it, so an operator may read the list.
  for (const path of ['/api/reseller-keys', '/api/reseller-credentials', '/api/plan-rates', '/api/billing-ledger']) {
    assert.equal(requiredRole('GET', path), path === '/api/plan-rates' || path === '/api/billing-ledger' ? 'viewer' : 'operator');
    assert.equal(requiredRole('POST', path), 'admin');
  }
});

test('the blocked list stays blocked to an operator', () => {
  for (const [method, path] of [
    ['GET', '/api/users'], ['POST', '/api/invites'], ['POST', '/api/plan-rates'],
    ['POST', '/api/reseller-rates'], ['POST', '/api/reseller-keys'],
    ['POST', '/api/reseller-credentials'], ['POST', '/api/billing/create-invoice'],
  ]) {
    assert.equal(requiredRole(method, path), 'admin', `${method} ${path} is no longer admin-only`);
  }
});

// --- key format -----------------------------------------------------------

test('keys are zmaw_<env>_<32 base62> and carry the worker env', () => {
  assert.equal(keyEnvLabel({ DASHBOARD_ENV: 'test' }), 'test');
  assert.equal(keyEnvLabel({ DASHBOARD_ENV: 'live' }), 'live');
  // An unset var must not mint a key that claims to be the harmless one.
  assert.equal(keyEnvLabel({}), 'live');

  const key = generateApiKey({ DASHBOARD_ENV: 'test' });
  assert.match(key, /^zmaw_test_[0-9A-Za-z]{32}$/);
  assert.notEqual(key, generateApiKey({ DASHBOARD_ENV: 'test' }));
});

test('both auth headers are accepted, Basic is left to break-glass', () => {
  const req = (h) => ({ headers: { get: (k) => h[k] ?? null } });
  assert.equal(readApiKeyHeader(req({ Authorization: 'Bearer zmaw_test_abc' })), 'zmaw_test_abc');
  assert.equal(readApiKeyHeader(req({ 'X-Api-Key': '  zmaw_live_abc  ' })), 'zmaw_live_abc');
  assert.equal(readApiKeyHeader(req({ Authorization: 'Basic dXNlcjpwdw==' })), null);
  assert.equal(hasApiKeyHeader(req({})), false);
  assert.equal(hasApiKeyHeader(req({ Authorization: 'Bearer anything' })), true);
});

// --- audit selection ------------------------------------------------------

test('acting requests are audited and polling GETs are not', () => {
  assert.ok(shouldAudit('POST', '/api/sim-action'));
  assert.ok(shouldAudit('DELETE', '/api/qbo-invoices/7'));
  // Carrier reads cost quota, so they are audited despite the method.
  assert.ok(shouldAudit('GET', '/api/wing-check'));
  assert.ok(shouldAudit('GET', '/api/keys'));

  assert.ok(!shouldAudit('GET', '/api/sims'));
  assert.ok(!shouldAudit('GET', '/api/stats'));
  assert.ok(!shouldAudit('GET', '/api/audit-log'));      // reading the log is not an act
  assert.ok(!shouldAudit('OPTIONS', '/api/sim-action'));
  assert.ok(!shouldAudit('POST', '/auth/login'));        // passwords never reach this table
});

// --- redaction ------------------------------------------------------------

test('credential-shaped field names are redacted, payload fields are not', () => {
  const out = redact({
    iccid: '89012804332468992577',
    sim_id: 5345,
    apikey: 'zmaw_live_secret',
    password: 'hunter2',
    session: { token: 'abc', userName: 'u' },
    nested: [{ TELTIK_API_KEY: 'x', action: 'rotate' }],
  });
  assert.equal(out.iccid, '89012804332468992577');
  assert.equal(out.sim_id, 5345);
  assert.equal(out.apikey, '[REDACTED]');
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.session.token, '[REDACTED]');
  assert.equal(out.nested[0].TELTIK_API_KEY, '[REDACTED]');
  assert.equal(out.nested[0].action, 'rotate');
});

// --- subject extraction ---------------------------------------------------

test('the identifiers an operator searches by are lifted out of any body shape', () => {
  assert.deepEqual(extractSubject({ sim_id: 5345, action: 'ota_refresh' }),
    { sim_id: '5345', iccid: null, mdn: null, action: 'ota_refresh' });

  // Bulk routes take arrays; keep the head and the count.
  assert.equal(extractSubject({ sim_ids: [1, 2, 3] }).sim_id, '1 +2');

  // /api/atomic-query's single `identifier` is an ICCID or an MDN by shape.
  assert.equal(extractSubject({ identifier: '89012804332468992577' }).iccid, '89012804332468992577');
  assert.equal(extractSubject({ identifier: '3855869698' }).mdn, '3855869698');

  // /api/activate nests them.
  assert.equal(extractSubject({ sims: [{ iccid: '8901' }, { iccid: '8902' }] }).iccid, '8901 +1');

  assert.equal(extractSubject({ sim_id: 1, op: 'suspend' }).action, 'suspend');
  assert.deepEqual(extractSubject(null), { sim_id: null, iccid: null, mdn: null, action: null });
});

// --- actor attribution ----------------------------------------------------

test('the actor is the authenticated principal, never a body field', () => {
  assert.deepEqual(principal({ username: 'apikey:agent-test', role: 'operator', authType: 'api_key' }),
    { actor: 'apikey:agent-test', actor_type: 'api_key', role: 'operator' });
  assert.deepEqual(principal({ id: 'u1', username: 'Zalmen', role: 'admin' }),
    { actor: 'Zalmen', actor_type: 'user', role: 'admin' });
  assert.deepEqual(principal({ id: null, username: 'break-glass', role: 'admin' }),
    { actor: 'break-glass', actor_type: 'break_glass', role: 'admin' });
  assert.deepEqual(principal(null),
    { actor: 'anonymous', actor_type: 'anonymous', role: null });

  // A real user who happens to be named 'break-glass' is still a user: the
  // discriminator is the absent dashboard_users row, not the name.
  assert.equal(principal({ id: 'u9', username: 'break-glass', role: 'admin' }).actor_type, 'user');
});
