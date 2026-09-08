// =========================================================
// Dashboard multi-user auth: login, invites, sessions, user administration.
//
// Kept out of index.js (9.6k lines) so the change to the request gate there
// stays a few lines. Crypto and the role matrix live in shared/portal-auth.mjs.
//
// Cookie is SameSite=Strict, not Lax, deliberately. Many dashboard action
// routes have no method guard (GET /api/cancel really cancels — see the
// ALWAYS_MUTATING list in portal-auth.mjs), and Lax still sends cookies on
// cross-site top-level GET navigations. Under Lax, a link someone is tricked
// into clicking would carry their session and perform the action. Strict costs
// nothing here: nobody deep-links into an internal operator tool from
// elsewhere.
// =========================================================

import {
  ROLES, hashPassword, verifyPassword, foldUsername, randomHex, sha256Hex,
  signDashboardSession, readDashboardSession, isValidRole, canAccess,
} from '../shared/portal-auth.mjs';

export const AUTH_COOKIE = 'dsh_auth';
const DEFAULT_TTL_MINUTES = 720;          // 12h
const INVITE_TTL_HOURS = 168;             // 7 days
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;
const MIN_PASSWORD_LENGTH = 12;

function sbHeaders(env, extra) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function sb(env, path, init) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...(init || {}),
    headers: sbHeaders(env, init && init.headers),
  });
}

async function sbRows(env, path) {
  try {
    const r = await sb(env, path);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  });
}

function ttlMinutes(env) {
  const n = Number(env.DASHBOARD_SESSION_TTL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MINUTES;
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setCookie(value, maxAgeSeconds) {
  return `${AUTH_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearCookie() {
  return `${AUTH_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

// --- session resolution ---------------------------------------------------

// Resolve the logged-in user from the cookie, or null. The HMAC is checked
// locally first so a forged/garbage cookie never reaches Supabase.
export async function resolveUser(env, request) {
  if (!env.DASHBOARD_SESSION_SECRET) return null;
  const token = getCookie(request, AUTH_COOKIE);
  if (!token) return null;
  const sessionId = await readDashboardSession(env.DASHBOARD_SESSION_SECRET, token);
  if (!sessionId) return null;

  const rows = await sbRows(env,
    'dashboard_sessions?id=eq.' + encodeURIComponent(sessionId)
    + '&select=id,expires_at,revoked_at,dashboard_users(id,username,role,status)&limit=1');
  const s = rows[0];
  if (!s || s.revoked_at) return null;
  if (!s.expires_at || Date.parse(s.expires_at) < Date.now()) return null;

  const u = s.dashboard_users;
  if (!u || u.status !== 'active') return null;
  return { id: u.id, username: u.username, role: u.role, sessionId: s.id };
}

// Break-glass: the legacy shared Basic password still works while
// DASHBOARD_BREAK_GLASS is not 'off', and counts as admin. This is the escape
// hatch if the session path breaks, and the way the first admin bootstraps
// itself before any user exists. Turn it off once real accounts exist.
export function breakGlassUser(env, request) {
  if (String(env.DASHBOARD_BREAK_GLASS || '').toLowerCase() === 'off') return null;
  if (!env.DASHBOARD_AUTH) return null;
  const header = request.headers.get('Authorization') || '';
  const [scheme, credentials] = header.split(' ');
  if (scheme !== 'Basic' || !credentials) return null;
  let decoded;
  try { decoded = atob(credentials); } catch { return null; }
  if (decoded !== env.DASHBOARD_AUTH) return null;
  return { id: null, username: 'break-glass', role: ROLES.ADMIN, sessionId: null };
}

// --- login / logout / me --------------------------------------------------

async function handleLogin(request, env) {
  const body = await readBody(request);
  const username = foldUsername(body && body.username);
  const password = (body && typeof body.password === 'string') ? body.password : '';
  const deny = () => json({ ok: false, error: 'Invalid username or password' }, 401);

  if (!env.DASHBOARD_SESSION_SECRET) return json({ ok: false, error: 'Login not configured' }, 503);
  if (!username || !password) return deny();

  const rows = await sbRows(env,
    'dashboard_users?username_folded=eq.' + encodeURIComponent(username)
    + '&select=id,username,password_hash,role,status,failed_login_count,locked_until&limit=1');
  const user = rows[0];

  // Same response shape whether or not the account exists, so login cannot be
  // used to enumerate usernames.
  if (!user || user.status !== 'active') return deny();
  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    return json({ ok: false, error: 'Account temporarily locked. Try again later.' }, 429);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const failed = (user.failed_login_count || 0) + 1;
    const patch = { failed_login_count: failed };
    if (failed >= MAX_FAILED_LOGINS) {
      patch.locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
      patch.failed_login_count = 0;
    }
    await sb(env, 'dashboard_users?id=eq.' + user.id, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
    });
    return deny();
  }

  const sessionId = randomHex(32);
  const expiresAt = new Date(Date.now() + ttlMinutes(env) * 60000).toISOString();
  const created = await sb(env, 'dashboard_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: sessionId, user_id: user.id, expires_at: expiresAt,
      user_agent: (request.headers.get('User-Agent') || '').slice(0, 300),
    }),
  });
  if (!created.ok) return json({ ok: false, error: 'Could not start session' }, 500);

  await sb(env, 'dashboard_users?id=eq.' + user.id, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() }),
  });

  const token = await signDashboardSession(env.DASHBOARD_SESSION_SECRET, sessionId);
  return json({ ok: true, user: { username: user.username, role: user.role } }, 200,
    { 'Set-Cookie': setCookie(token, ttlMinutes(env) * 60) });
}

async function handleLogout(request, env, user) {
  if (user && user.sessionId) {
    await sb(env, 'dashboard_sessions?id=eq.' + encodeURIComponent(user.sessionId), {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

// --- invites --------------------------------------------------------------

async function handleCreateInvite(request, env, user) {
  const body = await readBody(request);
  const role = String((body && body.role) || '').trim();
  const username = (body && body.username) ? String(body.username).trim() : null;
  if (!isValidRole(role)) return json({ ok: false, error: 'role must be admin, operator, or viewer' }, 400);

  const token = randomHex(24);
  const r = await sb(env, 'dashboard_invites', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      token_hash: await sha256Hex(token),
      username, role,
      created_by: user && user.id ? user.id : null,
      expires_at: new Date(Date.now() + INVITE_TTL_HOURS * 3600000).toISOString(),
    }),
  });
  if (!r.ok) return json({ ok: false, error: 'Could not create invite' }, 500);

  // The raw token is returned exactly once, here. Only its hash is stored.
  return json({ ok: true, token, expires_in_hours: INVITE_TTL_HOURS,
    accept_path: '/accept-invite?token=' + encodeURIComponent(token) });
}

async function handleAcceptInvite(request, env) {
  const body = await readBody(request);
  const token = String((body && body.token) || '');
  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');

  if (!token || !username) return json({ ok: false, error: 'Invite link and username are required' }, 400);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ ok: false, error: 'Password must be at least ' + MIN_PASSWORD_LENGTH + ' characters' }, 400);
  }

  const rows = await sbRows(env,
    'dashboard_invites?token_hash=eq.' + encodeURIComponent(await sha256Hex(token))
    + '&select=id,role,expires_at,consumed_at&limit=1');
  const inv = rows[0];
  if (!inv || inv.consumed_at) return json({ ok: false, error: 'This invite is no longer valid' }, 400);
  if (!inv.expires_at || Date.parse(inv.expires_at) < Date.now()) {
    return json({ ok: false, error: 'This invite has expired' }, 400);
  }

  const folded = foldUsername(username);
  if (!folded) return json({ ok: false, error: 'Username is required' }, 400);
  const existing = await sbRows(env,
    'dashboard_users?username_folded=eq.' + encodeURIComponent(folded) + '&select=id&limit=1');
  if (existing.length) return json({ ok: false, error: 'That username is taken' }, 409);

  const createdUser = await sb(env, 'dashboard_users', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      username, username_folded: folded,
      password_hash: await hashPassword(password),
      role: inv.role, status: 'active',
    }),
  });
  if (!createdUser.ok) return json({ ok: false, error: 'Could not create the account' }, 500);
  const newUser = (await createdUser.json())[0];

  // Consume only after the user exists, and only if still unconsumed, so two
  // simultaneous redemptions of one link cannot both create an account.
  const consumed = await sb(env,
    'dashboard_invites?id=eq.' + inv.id + '&consumed_at=is.null',
    {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ consumed_at: new Date().toISOString(), consumed_by: newUser.id }),
    });
  const consumedRows = consumed.ok ? await consumed.json() : [];
  if (!consumedRows.length) {
    await sb(env, 'dashboard_users?id=eq.' + newUser.id, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return json({ ok: false, error: 'This invite was already used' }, 409);
  }

  return json({ ok: true, username: newUser.username, role: newUser.role });
}

// --- user administration --------------------------------------------------

async function activeAdminCount(env, excludeId) {
  const rows = await sbRows(env,
    'dashboard_users?role=eq.admin&status=eq.active&select=id&limit=1000');
  return rows.filter((r) => r.id !== excludeId).length;
}

async function handleListUsers(env) {
  const users = await sbRows(env,
    'dashboard_users?select=id,username,role,status,created_at,last_login_at,locked_until'
    + '&order=created_at.asc&limit=1000');
  const invites = await sbRows(env,
    'dashboard_invites?consumed_at=is.null&select=id,username,role,created_at,expires_at'
    + '&order=created_at.desc&limit=200');
  return json({ ok: true, users, pending_invites: invites });
}

async function handleUpdateUser(request, env, actor, userId) {
  const body = await readBody(request);
  const patch = {};

  if (body && typeof body.status === 'string') {
    if (!['active', 'disabled'].includes(body.status)) {
      return json({ ok: false, error: 'status must be active or disabled' }, 400);
    }
    patch.status = body.status;
  }
  if (body && typeof body.role === 'string') {
    if (!isValidRole(body.role)) return json({ ok: false, error: 'invalid role' }, 400);
    patch.role = body.role;
  }
  if (!Object.keys(patch).length) return json({ ok: false, error: 'nothing to update' }, 400);

  const rows = await sbRows(env, 'dashboard_users?id=eq.' + encodeURIComponent(userId)
    + '&select=id,role,status&limit=1');
  const target = rows[0];
  if (!target) return json({ ok: false, error: 'user not found' }, 404);

  // Never allow the last active admin to be disabled or demoted — that would
  // lock everyone out of user management with no way back in short of
  // break-glass.
  const losingAdmin = target.role === 'admin' && target.status === 'active'
    && ((patch.status && patch.status !== 'active') || (patch.role && patch.role !== 'admin'));
  if (losingAdmin && (await activeAdminCount(env, target.id)) === 0) {
    return json({ ok: false, error: 'This is the last active admin. Promote another admin first.' }, 409);
  }

  const r = await sb(env, 'dashboard_users?id=eq.' + encodeURIComponent(userId), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch),
  });
  if (!r.ok) return json({ ok: false, error: 'Could not update user' }, 500);

  // Disabling or demoting must take effect immediately, not at token expiry.
  if (patch.status === 'disabled' || patch.role) {
    await sb(env, 'dashboard_sessions?user_id=eq.' + encodeURIComponent(userId) + '&revoked_at=is.null', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });
  }
  return json({ ok: true });
}

// --- router ---------------------------------------------------------------
//
// Returns a Response for anything auth-related, or null to let index.js carry
// on with its own routes.
export async function handleAuthRoutes(request, env, url, user) {
  const p = url.pathname;
  const method = request.method;

  if (p === '/auth/login' && method === 'POST') return handleLogin(request, env);
  if (p === '/auth/accept-invite' && method === 'POST') return handleAcceptInvite(request, env);
  if (p === '/auth/logout' && method === 'POST') return handleLogout(request, env, user);
  if (p === '/auth/me') {
    if (!user) return json({ ok: false, authenticated: false }, 401);
    return json({ ok: true, authenticated: true, username: user.username, role: user.role });
  }

  if (!user || !canAccess(user.role, method, p)) return null; // gate handles the 403

  if (p === '/api/users' && method === 'GET') return handleListUsers(env);
  if (p === '/api/invites' && method === 'POST') return handleCreateInvite(request, env, user);
  if (p.startsWith('/api/users/') && method === 'POST') {
    const id = p.slice('/api/users/'.length).split('/')[0];
    if (id) return handleUpdateUser(request, env, user, id);
  }
  return null;
}
