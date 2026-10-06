import { hashPassword, foldUsername, randomHex, sha256Hex, isValidRole } from '../../shared/portal-auth.mjs';
import { INVITE_TTL_HOURS, MIN_PASSWORD_LENGTH, sb, sbRows, json, readBody, isUnexpired } from './common.mjs';

// --- invites --------------------------------------------------------------

export async function handleCreateInvite(request, env, user) {
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

export async function handleAcceptInvite(request, env) {
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
  if (!isUnexpired(inv.expires_at)) {
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
