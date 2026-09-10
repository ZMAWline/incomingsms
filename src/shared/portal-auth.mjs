// =========================================================
// Shared portal auth: PBKDF2 password hashing, HMAC-signed session tokens,
// and the dashboard's role/permission matrix.
//
// Consolidated from src/otp-portal/auth.mjs and src/teltik-portal/auth.mjs,
// which were copies of one another that had already diverged (118 vs 120
// lines). The crypto below is byte-for-byte the otp-portal version, which is
// the one running in production — stored password hashes stay valid.
//
// The "don't import across worker directories" note in those files is about
// worker-to-worker imports; src/shared is the sanctioned home for code several
// workers need, same as gateway-host.mjs.
//
// Pure functions only, no IO. Unit-tested directly (tests/portal-auth.test.mjs).
// =========================================================

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

// SHA-256 hex. Session and invite tokens are stored HASHED, so a read of
// dashboard_sessions / dashboard_invites never yields a usable credential.
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return u8ToB64url(new Uint8Array(sig));
}

// --- Dashboard session tokens ---------------------------------------------
// Format: dsh_<b64url(sessionId)>.<sig>
//
// Unlike the single-login portals, the dashboard has real users, so the token
// carries a session id and the row in dashboard_sessions is the authority on
// expiry and revocation. The HMAC is still worth having: a forged or tampered
// cookie is rejected by local crypto and never reaches Supabase, preserving the
// otp-portal property that bad credentials can't drive DB load.
//
// The session id is opaque and random; it is the DB lookup key. Its SHA-256 is
// what gets stored, so the token cannot be reconstructed from the table.
export async function signDashboardSession(secret, sessionId) {
  const payload = String(sessionId);
  const sig = await hmacSign(secret, payload);
  return 'dsh_' + u8ToB64url(new TextEncoder().encode(payload)) + '.' + sig;
}

// Returns the session id when the signature checks out, else null. Does not
// check expiry or revocation — that is the dashboard_sessions row's job.
export async function readDashboardSession(secret, token) {
  if (!secret || !token || typeof token !== 'string' || !token.startsWith('dsh_')) return null;
  const rest = token.slice('dsh_'.length);
  const dot = rest.lastIndexOf('.');
  if (dot < 1) return null;
  let payload;
  try { payload = new TextDecoder().decode(b64urlToU8(rest.slice(0, dot))); } catch { return null; }
  const expected = await hmacSign(secret, payload);
  if (!constantTimeEqual(rest.slice(dot + 1), expected)) return null;
  return payload || null;
}

// --- Roles ----------------------------------------------------------------

export const ROLES = { ADMIN: 'admin', OPERATOR: 'operator', VIEWER: 'viewer' };

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

export function isValidRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_RANK, String(role));
}

// --- Route permission matrix ----------------------------------------------
//
// IMPORTANT: this deliberately does NOT trust the HTTP method to tell reads
// from writes. The action routes below (/api/activate, /api/cancel,
// /api/suspend, /api/restore, /api/rotate-sim, /api/fix-sim,
// /api/send-test-sms, /api/sim-online, /api/debug-cancel) each carry a
// `request.method === 'POST'` guard in src/dashboard/index.js as of
// 2026-09-09 — but that guard is one edit away from being dropped, and it was
// absent entirely before then. Keeping this layer path-first means a route
// that loses (or never gains) its method guard still cannot be reached by a
// viewer with a bare GET.
//
// So the classification is path-first and fails safe: anything not explicitly
// listed as a read requires operator. A newly added route is therefore closed
// to viewers by default, and adding a read route is a conscious edit here.

// Admin-only regardless of method — managing who (or what) can log in.
// /api/keys mints and revokes agent API keys, which are credentials in exactly
// the sense a user account is; src/dashboard/api-keys.mjs adds the second half
// of that fence, refusing the route to API keys of any role so a leaked key
// cannot mint its own replacement.
const ADMIN_ONLY_ALL = ['/api/users', '/api/invites', '/api/keys'];

// Money. Readable by anyone logged in, mutable only by admins.
const ADMIN_ONLY_WRITE = [
  '/api/billing/', '/api/billing-ledger', '/api/bill-audit/',
  '/api/qbo', '/api/plan-rates', '/api/reseller-rates',
  '/api/reseller-keys', '/api/reseller-credentials',
];

// Routes that act no matter which method is used (see note above).
const ALWAYS_MUTATING = [
  '/api/activate', '/api/cancel', '/api/debug-cancel', '/api/delete-sim',
  '/api/fix-sim', '/api/restore', '/api/rotate-sim', '/api/suspend',
  '/api/send-test-sms', '/api/bulk-send-test-sms', '/api/sim-online',
  '/api/sim-action', '/api/set-sim-status', '/api/reset-to-provisioning',
];

// Safe reads a viewer may perform. Everything absent from this list needs
// operator or above, including carrier-query routes (/api/helix-query,
// /api/atomic-query, /api/teltik-query, /api/wing-check): those are read-only
// at the carrier but still spend quota and write audit logs.
const READ_ROUTES = [
  '/api/stats', '/api/sims', '/api/messages', '/api/sms-usage', '/api/resellers',
  '/api/gateways', '/api/gateway-defective-slots', '/api/imei-pool', '/api/errors',
  '/api/error-logs', '/api/utilization', '/api/rotation-health', '/api/rotation-reviews',
  '/api/rotation-audit', '/api/bad-rentals', '/api/activation-runs', '/api/sim-webhooks',
  '/api/pending-items', '/api/hosting-port-status/jobs', '/api/remediator/status',
  '/api/billing/preview', '/api/billing/download-invoice', '/api/billing/rental-export',
  '/api/billing-ledger', '/api/bill-audit/results', '/api/bill-audit/uploads',
  '/api/bill-audit/export', '/api/qbo-invoices', '/api/plan-rates', '/api/reseller-rates',
];

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function matches(pathname, list) {
  const p = String(pathname || '');
  return list.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : r + '/'));
}

// The minimum role required for (method, pathname). Never throws.
export function requiredRole(method, pathname) {
  const p = String(pathname || '');
  if (matches(p, ADMIN_ONLY_ALL)) return ROLES.ADMIN;

  const isWrite = WRITE_METHODS.has(String(method || '').toUpperCase())
    || matches(p, ALWAYS_MUTATING);

  if (isWrite) {
    return matches(p, ADMIN_ONLY_WRITE) ? ROLES.ADMIN : ROLES.OPERATOR;
  }
  return matches(p, READ_ROUTES) ? ROLES.VIEWER : ROLES.OPERATOR;
}

// True when `role` is permitted to make this request. Unknown role => false.
export function canAccess(role, method, pathname) {
  const have = ROLE_RANK[String(role)];
  if (!have) return false;
  return have >= ROLE_RANK[requiredRole(method, pathname)];
}
