import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PBKDF2_ITERATIONS, ROLES,
  hashPassword, verifyPassword, foldUsername, constantTimeEqual, randomHex, sha256Hex,
  signDashboardSession, readDashboardSession,
  isValidRole, requiredRole, canAccess,
} from '../src/shared/portal-auth.mjs';

// --- password hashing -----------------------------------------------------

test('password hash round-trips and rejects the wrong password', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, new RegExp('^pbkdf2\\$' + PBKDF2_ITERATIONS + '\\$'));
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('two hashes of the same password differ (salted)', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('verifyPassword rejects malformed stored values instead of throwing', async () => {
  for (const bad of [null, undefined, '', 'nonsense', 'pbkdf2$x$y', 'bcrypt$1$a$b',
    'pbkdf2$999$c2FsdA==$aGFzaA==', 'pbkdf2$99999999999$c2FsdA==$aGFzaA==']) {
    assert.equal(await verifyPassword('any', bad), false, String(bad));
  }
});

// --- helpers --------------------------------------------------------------

test('foldUsername folds ASCII case only, and trims', () => {
  assert.equal(foldUsername('  Admin '), 'admin');
  assert.equal(foldUsername('TESTER'), 'tester');
  // Non-ASCII is left alone on purpose so two distinct usernames can't collide.
  assert.equal(foldUsername('İ'), 'İ');
  assert.equal(foldUsername(null), '');
});

test('constantTimeEqual compares correctly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'ab'), false);
  assert.equal(constantTimeEqual(null, ''), true);
});

test('randomHex and sha256Hex shapes', async () => {
  assert.match(randomHex(16), /^[0-9a-f]{32}$/);
  assert.notEqual(randomHex(16), randomHex(16));
  const h = await sha256Hex('token');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await sha256Hex('token'));
  assert.notEqual(h, await sha256Hex('token2'));
});

// --- session tokens -------------------------------------------------------

test('session token round-trips and yields the session id', async () => {
  const sid = randomHex(32);
  const token = await signDashboardSession('secret', sid);
  assert.match(token, /^dsh_/);
  assert.equal(await readDashboardSession('secret', token), sid);
});

test('session token rejects tampering, wrong secret, and junk', async () => {
  const sid = randomHex(32);
  const token = await signDashboardSession('secret', sid);
  assert.equal(await readDashboardSession('other-secret', token), null);
  assert.equal(await readDashboardSession('secret', token.slice(0, -3) + 'aaa'), null);
  assert.equal(await readDashboardSession('secret', 'dsh_nope'), null);
  assert.equal(await readDashboardSession('secret', 'otpps_x.y'), null);
  assert.equal(await readDashboardSession('', token), null);
  assert.equal(await readDashboardSession('secret', null), null);
});

test('a forged session id cannot be swapped in under a valid-looking token', async () => {
  const real = await signDashboardSession('secret', 'session-a');
  const sig = real.slice(real.lastIndexOf('.'));
  const forgedPayload = Buffer.from('session-b').toString('base64url');
  assert.equal(await readDashboardSession('secret', 'dsh_' + forgedPayload + sig), null);
});

// --- role matrix ----------------------------------------------------------

test('isValidRole', () => {
  assert.equal(isValidRole('admin'), true);
  assert.equal(isValidRole('operator'), true);
  assert.equal(isValidRole('viewer'), true);
  assert.equal(isValidRole('root'), false);
  assert.equal(isValidRole(''), false);
});

test('viewer can read the safe list', () => {
  for (const p of ['/api/sims', '/api/stats', '/api/messages', '/api/rotation-health',
    '/api/qbo-invoices', '/api/billing/download-invoice', '/api/bad-rentals']) {
    assert.equal(canAccess(ROLES.VIEWER, 'GET', p), true, p);
  }
});

// THE case that must never regress: these routes have no method guard in
// src/dashboard/index.js, so a bare GET performs a real carrier action. A
// method-based permission model would hand them to viewers.
test('viewer cannot reach method-guardless action routes via GET', () => {
  for (const p of ['/api/activate', '/api/cancel', '/api/suspend', '/api/restore',
    '/api/rotate-sim', '/api/fix-sim', '/api/send-test-sms', '/api/sim-online',
    '/api/debug-cancel', '/api/delete-sim']) {
    assert.equal(canAccess(ROLES.VIEWER, 'GET', p), false, p);
    assert.equal(requiredRole('GET', p), ROLES.OPERATOR, p);
  }
});

test('viewer cannot write anything', () => {
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(canAccess(ROLES.VIEWER, m, '/api/sims'), false, m);
  }
});

test('operator can run SIM actions but not money or user management', () => {
  assert.equal(canAccess(ROLES.OPERATOR, 'POST', '/api/activate'), true);
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/cancel'), true);
  assert.equal(canAccess(ROLES.OPERATOR, 'POST', '/api/hosting-port-status/run'), true);
  // money: readable, not writable
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/qbo-invoices'), true);
  assert.equal(canAccess(ROLES.OPERATOR, 'POST', '/api/billing/create-invoice'), false);
  assert.equal(canAccess(ROLES.OPERATOR, 'POST', '/api/reseller-keys/revoke'), false);
  // user management: closed entirely, even for reads
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/users'), false);
  assert.equal(canAccess(ROLES.OPERATOR, 'POST', '/api/invites'), false);
});

test('admin can do everything', () => {
  for (const p of ['/api/users', '/api/invites', '/api/billing/create-invoice',
    '/api/cancel', '/api/sims', '/api/anything-new']) {
    for (const m of ['GET', 'POST', 'DELETE']) {
      assert.equal(canAccess(ROLES.ADMIN, m, p), true, m + ' ' + p);
    }
  }
});

// Fail-safe default: a route nobody classified must not fall open to viewers.
test('unclassified routes require operator, never viewer', () => {
  assert.equal(requiredRole('GET', '/api/some-future-route'), ROLES.OPERATOR);
  assert.equal(canAccess(ROLES.VIEWER, 'GET', '/api/some-future-route'), false);
  assert.equal(canAccess(ROLES.OPERATOR, 'GET', '/api/some-future-route'), true);
});

test('unknown or missing role is denied everything', () => {
  for (const r of ['root', 'superuser', '', null, undefined]) {
    assert.equal(canAccess(r, 'GET', '/api/sims'), false, String(r));
  }
});

test('prefix matching does not leak across similarly-named routes', () => {
  // /api/users must not make /api/users-export admin-only by accident, nor
  // should /api/sims match /api/sims-secret.
  assert.equal(requiredRole('GET', '/api/users-export'), ROLES.OPERATOR);
  assert.equal(requiredRole('GET', '/api/sims/123'), ROLES.VIEWER);
  assert.equal(requiredRole('GET', '/api/simsomething'), ROLES.OPERATOR);
});
