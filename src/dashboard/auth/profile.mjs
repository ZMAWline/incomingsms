import { hashPassword, verifyPassword, foldUsername } from '../../shared/portal-auth.mjs';
import { MIN_PASSWORD_LENGTH, sb, sbRows, json, readBody } from './common.mjs';

// --- self-service profile -------------------------------------------------
//
// These act on the caller's own account, so they are NOT role-gated: a viewer
// must be able to change their own password. They are routed before the
// canAccess() check in handleAuthRoutes for exactly that reason.
//
// Break-glass has no row in dashboard_users (id is null), so it cannot change
// anything about itself — its credential is the DASHBOARD_AUTH secret.

function requireRealAccount(user) {
  if (!user || !user.id) {
    return json({ ok: false, error: 'The break-glass login has no profile. Sign in with a user account.' }, 400);
  }
  return null;
}

export async function handleChangePassword(request, env, user) {
  const bad = requireRealAccount(user);
  if (bad) return bad;

  const body = await readBody(request);
  const current = String((body && body.current_password) || '');
  const next = String((body && body.new_password) || '');
  if (next.length < MIN_PASSWORD_LENGTH) {
    return json({ ok: false, error: 'New password must be at least ' + MIN_PASSWORD_LENGTH + ' characters' }, 400);
  }

  const rows = await sbRows(env,
    'dashboard_users?id=eq.' + encodeURIComponent(user.id) + '&select=id,password_hash&limit=1');
  const row = rows[0];
  if (!row) return json({ ok: false, error: 'Account not found' }, 404);

  // Requiring the current password means a stolen session cannot be escalated
  // into a permanent account takeover.
  if (!(await verifyPassword(current, row.password_hash))) {
    return json({ ok: false, error: 'Current password is incorrect' }, 403);
  }
  if (await verifyPassword(next, row.password_hash)) {
    return json({ ok: false, error: 'New password must differ from the current one' }, 400);
  }

  const r = await sb(env, 'dashboard_users?id=eq.' + encodeURIComponent(user.id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ password_hash: await hashPassword(next) }),
  });
  if (!r.ok) return json({ ok: false, error: 'Could not change password' }, 500);

  // Sign out everywhere else, keeping this session. A password change is how
  // someone reacts to a suspected compromise, so other sessions must drop.
  await sb(env,
    'dashboard_sessions?user_id=eq.' + encodeURIComponent(user.id)
    + '&revoked_at=is.null&id=neq.' + encodeURIComponent(user.sessionId || ''),
    {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    });

  return json({ ok: true, other_sessions_signed_out: true });
}

export async function handleChangeUsername(request, env, user) {
  const bad = requireRealAccount(user);
  if (bad) return bad;

  const body = await readBody(request);
  const username = String((body && body.username) || '').trim();
  const current = String((body && body.current_password) || '');
  const folded = foldUsername(username);
  if (!folded) return json({ ok: false, error: 'Username is required' }, 400);

  const rows = await sbRows(env,
    'dashboard_users?id=eq.' + encodeURIComponent(user.id) + '&select=id,password_hash,username_folded&limit=1');
  const row = rows[0];
  if (!row) return json({ ok: false, error: 'Account not found' }, 404);
  if (!(await verifyPassword(current, row.password_hash))) {
    return json({ ok: false, error: 'Current password is incorrect' }, 403);
  }

  if (folded !== row.username_folded) {
    const taken = await sbRows(env,
      'dashboard_users?username_folded=eq.' + encodeURIComponent(folded) + '&select=id&limit=1');
    if (taken.length) return json({ ok: false, error: 'That username is taken' }, 409);
  }

  const r = await sb(env, 'dashboard_users?id=eq.' + encodeURIComponent(user.id), {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ username, username_folded: folded }),
  });
  // A racing signup can still win the UNIQUE index between the check above and
  // this write; report it as taken rather than as a server error.
  if (!r.ok) return json({ ok: false, error: 'That username is taken' }, 409);
  return json({ ok: true, username });
}

