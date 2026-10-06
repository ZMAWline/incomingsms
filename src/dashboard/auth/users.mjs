import { isValidRole } from '../../shared/portal-auth.mjs';
import { sb, sbRows, json, readBody, revokeSessions } from './common.mjs';

// --- user administration --------------------------------------------------

async function activeAdminCount(env, excludeId) {
  const rows = await sbRows(env,
    'dashboard_users?role=eq.admin&status=eq.active&select=id&limit=1000');
  return rows.filter((r) => r.id !== excludeId).length;
}

export async function handleListUsers(env) {
  const users = await sbRows(env,
    'dashboard_users?select=id,username,role,status,created_at,last_login_at,locked_until'
    + '&order=created_at.asc&limit=1000');
  const invites = await sbRows(env,
    'dashboard_invites?consumed_at=is.null&select=id,username,role,created_at,expires_at'
    + '&order=created_at.desc&limit=200');
  return json({ ok: true, users, pending_invites: invites });
}

export async function handleUpdateUser(request, env, actor, userId) {
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
    const revoked = await revokeSessions(env, 'user_id=eq.' + encodeURIComponent(userId) + '&revoked_at=is.null');
    if (!revoked) return json({
      ok: false, user_updated: true, sessions_revoked: false,
      error: 'User updated, but existing sessions could not be signed out. Retry the user update.',
    }, 502);
  }
  return json({ ok: true });
}
