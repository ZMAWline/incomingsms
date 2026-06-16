// Storefront auth helpers — PBKDF2 hash/verify roundtrip and the constant-time
// compare. Pure WebCrypto, runs under node:test with no bundling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  constantTimeEqual,
  randomHex,
  PBKDF2_ITERATIONS,
} from '../src/storefront/auth.mjs';

test('hashPassword produces the documented format', async () => {
  const stored = await hashPassword('correct horse battery');
  const parts = stored.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2');
  assert.equal(Number(parts[1]), PBKDF2_ITERATIONS);
  assert.equal(PBKDF2_ITERATIONS, 100000);
  // salt is 16 bytes → 24 base64 chars; hash is 32 bytes → 44 base64 chars
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
});

test('randomHex returns hex of the requested byte length', () => {
  const t = randomHex(32);
  assert.match(t, /^[0-9a-f]{64}$/);
  const apiToken = randomHex(16);
  assert.match(apiToken, /^[0-9a-f]{32}$/);
  assert.notEqual(randomHex(32), randomHex(32));
});
