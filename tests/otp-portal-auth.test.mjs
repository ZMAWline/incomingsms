// otp-portal auth helpers — PBKDF2 hash/verify roundtrip, constant-time
// compare, and HMAC-signed login-session tokens. Pure WebCrypto, runs under
// node:test with no bundling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  foldUsername,
  randomHex,
  signSession,
  verifySession,
  PBKDF2_ITERATIONS,
} from '../src/otp-portal/auth.mjs';

test('hashPassword produces the documented format', async () => {
  const stored = await hashPassword('correct horse battery');
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(Number(parts[1]), PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 100000);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
  assert.equal(Buffer.from(parts[3], 'base64').length, 32);
});

test('hash/verify roundtrip succeeds', async () => {
  const stored = await hashPassword('s3cret-passw0rd');
  assert.equal(await verifyPassword('s3cret-passw0rd', stored), true);
});

test('wrong password fails verification', async () => {
  const stored = await hashPassword('s3cret-passw0rd');
  assert.equal(await verifyPassword('s3cret-passw0rd!', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('same password hashes to different strings (random salt)', async () => {
  const a = await hashPassword('same-password-123');
  const b = await hashPassword('same-password-123');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password-123', a), true);
  assert.equal(await verifyPassword('same-password-123', b), true);
});

test('malformed stored hashes are rejected, not thrown', async () => {
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', ''), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$abc$def'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2$5$AAAA$BBBB'), false); // iters too low
  assert.equal(await verifyPassword('x', 'md5$100000$AAAA$BBBB'), false); // wrong algo
  assert.equal(await verifyPassword('x', 'pbkdf2$100000$!!notb64!!$BBBB'), false);
});

test('constantTimeEqual compares correctly', () => {
  assert.equal(constantTimeEqual('abcdef', 'abcdef'), true);
  assert.equal(constantTimeEqual('abcdef', 'abcdeg'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('', ''), true);
  assert.equal(constantTimeEqual(null, ''), true);
  assert.equal(constantTimeEqual(undefined, 'x'), false);
});

test('constantTimeEqual itself is case-sensitive — the primitive does no folding; login-route username case-insensitivity comes from foldUsername (see below), not from this function', () => {
  assert.equal(constantTimeEqual('Yossi', 'Yossi'), true);
  assert.equal(constantTimeEqual('Yossi', 'yossi'), false);
  assert.equal(constantTimeEqual('YOSSI', 'yossi'), false);
});

test('foldUsername trims and lowercases ASCII only, for case-insensitive username matching', () => {
  assert.equal(foldUsername('Yossi'), 'yossi');
  assert.equal(foldUsername('YOSSI'), 'yossi');
  assert.equal(foldUsername('  Yossi  '), 'yossi');
  assert.equal(foldUsername(''), '');
  assert.equal(foldUsername(null), '');
  assert.equal(foldUsername(undefined), '');
  // Non-ASCII characters are left untouched (no locale-dependent folding,
  // e.g. no Turkish dotted/dotless-I surprises).
  assert.equal(foldUsername('İstanbul'), 'İstanbul');
});

test('randomHex returns hex of the requested byte length', () => {
  const t = randomHex(32);
  assert.match(t, /^[0-9a-f]{64}$/);
  const short = randomHex(16);
  assert.match(short, /^[0-9a-f]{32}$/);
  assert.notEqual(randomHex(32), randomHex(32));
});

// --- session tokens ----------------------------------------------------------

test('signSession/verifySession roundtrip succeeds before expiry', async () => {
  const secret = 'test-session-secret';
  const now = 1_700_000_000_000;
  const token = await signSession(secret, 60 * 60 * 1000, now);
  assert.match(token, /^otpps_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await verifySession(secret, token, now), true);
  assert.equal(await verifySession(secret, token, now + 59 * 60 * 1000), true, 'still valid just before TTL');
});

test('verifySession rejects an expired token', async () => {
  const secret = 'test-session-secret';
  const now = 1_700_000_000_000;
  const token = await signSession(secret, 60 * 60 * 1000, now);
  assert.equal(await verifySession(secret, token, now + 60 * 60 * 1000 + 1), false);
});

test('verifySession rejects a token signed with a different secret', async () => {
  const now = 1_700_000_000_000;
  const token = await signSession('secret-a', 60 * 60 * 1000, now);
  assert.equal(await verifySession('secret-b', token, now), false);
});

test('verifySession rejects tampered payloads and malformed tokens', async () => {
  const secret = 'test-session-secret';
  const now = 1_700_000_000_000;
  const token = await signSession(secret, 60 * 60 * 1000, now);
  const [, sig] = token.slice('otpps_'.length).split('.');
  const forged = 'otpps_' + Buffer.from(String(now + 999 * 3600_000)).toString('base64url') + '.' + sig;
  assert.equal(await verifySession(secret, forged, now), false);

  assert.equal(await verifySession(secret, '', now), false);
  assert.equal(await verifySession(secret, null, now), false);
  assert.equal(await verifySession(secret, 'not-a-real-token', now), false);
  assert.equal(await verifySession(secret, 'otpps_missing-dot', now), false);
  assert.equal(await verifySession('', token, now), false, 'no secret configured never verifies');
});
