import {
  ROLES, verifyPassword, foldUsername, randomHex,
  signDashboardSession, readDashboardSession, constantTimeEqual,
} from '../../shared/portal-auth.mjs';
import {
  AUTH_COOKIE, MAX_FAILED_LOGINS, LOCKOUT_MINUTES,
  sb, sbRows, json, ttlMinutes, getCookie, setCookie, clearCookie, readBody,
  isUnexpired, revokeSessions,
} from './common.mjs';

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
  if (!isUnexpired(s.expires_at)) return null;

  const u = s.dashboard_users;
  if (!u || u.status !== 'active') return null;
  return { id: u.id, username: u.username, role: u.role, sessionId: s.id };
}

// Break-glass: the legacy shared Basic password works only while
// DASHBOARD_BREAK_GLASS is exactly 'on' (any case), and counts as admin.
// Unset or any other value means off. This is the escape hatch if the session
// path breaks: set the flag to 'on', sign in, fix, then remove it again.
export function breakGlassUser(env, request) {
  if (String(env.DASHBOARD_BREAK_GLASS || '').toLowerCase() !== 'on') return null;
  if (!env.DASHBOARD_AUTH) return null;
  const header = request.headers.get('Authorization') || '';
  const [scheme, credentials] = header.split(' ');
  if (scheme !== 'Basic' || !credentials) return null;
  let decoded;
  try { decoded = atob(credentials); } catch { return null; }
  if (!constantTimeEqual(decoded, env.DASHBOARD_AUTH)) return null;
  console.log('[Auth] break-glass login used: ' + request.method + ' ' + new URL(request.url).pathname);
  return { id: null, username: 'break-glass', role: ROLES.ADMIN, sessionId: null };
}

// --- login / logout / me --------------------------------------------------

export async function handleLogin(request, env) {
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

export async function handleLogout(request, env, user) {
  if (user && user.sessionId) {
    const revoked = await revokeSessions(env, 'id=eq.' + encodeURIComponent(user.sessionId));
    if (!revoked) return json({ ok: false, error: 'Could not sign out. Try again.' }, 502);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
