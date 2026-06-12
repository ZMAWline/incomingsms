// Pure auth helpers for the storefront worker. Kept in a standalone module so
// tests (tests/storefront-auth.test.mjs) can exercise them under node:test
// without bundling the worker. Uses only WebCrypto, available in both Workers
// and Node >= 19 as globalThis.crypto.

export const PBKDF2_ITERATIONS = 100000;

function u8ToB64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToU8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveBits(password, salt, iterations) {
  const km = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    km, 256
  );
  return new Uint8Array(bits);
}

// Stored format: pbkdf2$<iterations>$<salt_b64>$<hash_b64>
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return ['pbkdf2', PBKDF2_ITERATIONS, u8ToB64(salt), u8ToB64(hash)].join('$');
}

export function constantTimeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A.charCodeAt(i) ^ B.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1000 || iterations > 10000000) return false;
  let salt;
  try { salt = b64ToU8(parts[2]); } catch { return false; }
  let got;
  try { got = u8ToB64(await deriveBits(password, salt, iterations)); } catch { return false; }
  return constantTimeEqual(got, parts[3]);
}

export function randomHex(nBytes = 32) {
  const u8 = crypto.getRandomValues(new Uint8Array(nBytes));
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}
