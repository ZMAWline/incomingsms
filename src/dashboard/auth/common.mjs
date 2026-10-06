// =========================================================
// Dashboard multi-user auth: login, invites, sessions, user administration.
//
// Kept out of index.js (9.6k lines) so the change to the request gate there
// stays a few lines. Crypto and the role matrix live in shared/portal-auth.mjs.
//
// Cookie is SameSite=Strict, not Lax, deliberately. Lax still sends cookies on
// cross-site top-level GET navigations, so under Lax a link someone is tricked
// into clicking would carry their session. The dashboard action routes now
// require POST and the role gate in portal-auth.mjs is path-first
// (ALWAYS_MUTATING), so this is the third layer rather than the only one —
// keep it, it costs nothing: nobody deep-links into an internal operator tool
// from elsewhere.
// =========================================================

import { supabaseFetch } from '../../shared/fetch-timeout.mjs';

export const AUTH_COOKIE = 'dsh_auth';
export const DEFAULT_TTL_MINUTES = 720;          // 12h
export const INVITE_TTL_HOURS = 168;             // 7 days
export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 12;

function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

export async function sb(env, path, init) {
  return supabaseFetch(env, env.SUPABASE_URL + '/rest/v1/' + path, {
    ...(init || {}),
    headers: sbHeaders(env, init && init.headers),
  });
}

export async function sbRows(env, path) {
  try {
    const r = await sb(env, path);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

export function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

export function ttlMinutes(env) {
  const n = Number(env.DASHBOARD_SESSION_TTL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MINUTES;
}

export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const cookie = raw.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  if (!cookie) return null;
  try { return decodeURIComponent(cookie.slice(name.length + 1)); }
  catch { return null; }
}

export function isUnexpired(value, now = Date.now()) {
  if (typeof value !== 'string' || !value) return false;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

// Callers may already have changed a password or user record. Both HTTP
// errors and transport failures must return a truthful partial result.
export async function revokeSessions(env, filter) {
  try {
    const response = await sb(env, 'dashboard_sessions?' + filter, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
    return response.ok;
  } catch { return false; }
}

export function setCookie(value, maxAgeSeconds) {
  return `${AUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearCookie() {
  return `${AUTH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}
