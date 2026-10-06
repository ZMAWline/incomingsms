// Dashboard auth routing. Feature handlers live in auth/; crypto and role
// policy remain in shared/portal-auth.mjs. Keep the request gate's public imports
// here so routing and authorization ordering stay visible in one place.
import { canAccess } from '../shared/portal-auth.mjs';
import { json } from './auth/common.mjs';
import { handleLogin, handleLogout } from './auth/session.mjs';
import { handleCreateInvite, handleAcceptInvite } from './auth/invites.mjs';
import { handleChangePassword, handleChangeUsername } from './auth/profile.mjs';
import { handleListUsers, handleUpdateUser } from './auth/users.mjs';

export { AUTH_COOKIE } from './auth/common.mjs';
export { resolveUser, breakGlassUser } from './auth/session.mjs';

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
    return json({
      ok: true, authenticated: true, username: user.username, role: user.role,
      // Break-glass has no dashboard_users row, so the profile UI hides the
      // self-service forms rather than offering edits that cannot work.
      has_profile: !!user.id,
    });
  }

  // Self-service, before the role gate below: a viewer must be able to manage
  // their own credentials.
  if (user && p === '/auth/change-password' && method === 'POST') {
    return handleChangePassword(request, env, user);
  }
  if (user && p === '/auth/change-username' && method === 'POST') {
    return handleChangeUsername(request, env, user);
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
