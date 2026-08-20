// Pure auth helpers for the teltik-portal worker: PBKDF2 password hashing/
// verification and HMAC-signed, expiring login-session tokens. No I/O, so
// testable under node:test with no bundling — copied from
// src/otp-portal/auth.mjs (same shape as src/storefront/auth.mjs) per this
// repo's convention of not importing across worker directories. Only the
// session-token prefix differs (tprts_ instead of otpps_) so a cookie from
// one portal is never mistaken for a session on the other.

export const PBKDF2_ITERATIONS = 100000;

function u8ToB64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToU8(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function u8ToB64url(u8) {
  return u8ToB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToU8(b64u) {
  const pad = (4 - (b64u.length % 4)) % 4;
  return b64ToU8(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
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

// ASCII-only lowercase fold for username matching — deliberately not
// String#toLocaleLowerCase (locale-dependent, e.g. Turkish dotless-i) and
// deliberately not touching non-ASCII bytes, so this can't be tricked into
// mapping two visually-different usernames onto the same folded value.
export function foldUsername(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function constantTimeEqual(a, b) {
  const A = String(a == null ? '' : a);
  const B = String(b == null ? '' : b);
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

async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return u8ToB64url(new Uint8Array(sig));
}

// HMAC-signed, expiring login-session tokens: tprts_<b64url(expiresAtMs)>.<sig>
// There's no user identity inside the payload — this worker has exactly one
// login (the shared password), so "signature checks out and isn't expired"
// is the entire claim. `nowMs` is injectable so expiry is testable without
// waiting on the clock.
export async function signSession(secret, ttlMs, nowMs = Date.now()) {
  const expiresAt = nowMs + ttlMs;
  const payload = String(expiresAt);
  const sig = await hmacSign(secret, payload);
  return 'tprts_' + u8ToB64url(new TextEncoder().encode(payload)) + '.' + sig;
}

export async function verifySession(secret, token, nowMs = Date.now()) {
  if (!secret || !token || !token.startsWith('tprts_')) return false;
  const rest = token.slice('tprts_'.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 1) return false;
  const payloadB64u = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  let payload;
  try { payload = new TextDecoder().decode(b64urlToU8(payloadB64u)); } catch { return false; }
  const expected = await hmacSign(secret, payload);
  if (!constantTimeEqual(sig, expected)) return false;
  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < nowMs) return false;
  return true;
}
