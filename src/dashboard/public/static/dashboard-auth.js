// Classic script: shared globals are used by dashboard inline handlers.
// --- Users / roles -------------------------------------------------
// The server is the enforcement point: /api/users is 403 for anyone
// below admin and every write route is role-checked centrally. What
// happens here is presentation only — showing a viewer buttons that
// would just 403 is a worse experience, not a security boundary.
let CURRENT_USER = null;

async function loadCurrentUser() {
    try {
        const res = await fetch('/auth/me');
        if (!res.ok) return null;
        const data = await res.json();
        CURRENT_USER = data && data.ok
            ? { username: data.username, role: data.role, hasProfile: data.has_profile !== false }
            : null;
    } catch (e) { CURRENT_USER = null; }
    applyRoleToUi();
    return CURRENT_USER;
}

function applyRoleToUi() {
    const role = CURRENT_USER && CURRENT_USER.role;
    const navUsers = document.getElementById('nav-users');
    if (navUsers) navUsers.classList.toggle('hidden', role !== 'admin');
    const navAudit = document.getElementById('nav-audit');
    if (navAudit) navAudit.classList.toggle('hidden', role !== 'admin' && role !== 'operator');
    // Viewers get a read-only surface: anything explicitly marked as a
    // write control is hidden rather than left to fail server-side.
    document.querySelectorAll('[data-requires-write]').forEach(function (el) {
        el.classList.toggle('hidden', role === 'viewer');
    });
    const badge = document.getElementById('current-user-badge');
    if (badge && CURRENT_USER) badge.textContent = CURRENT_USER.username + ' · ' + role;
}

async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    const itbody = document.getElementById('invites-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-3 text-dark-400">Loading...</td></tr>';
    try {
        const res = await fetch('/api/users');
        if (res.status === 403) {
            tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-3 text-dark-400">Admins only.</td></tr>';
            return;
        }
        const data = await res.json();
        const users = (data && data.users) || [];
        tbody.innerHTML = users.length ? users.map(function (u) {
            const locked = u.locked_until && new Date(u.locked_until) > new Date();
            const disabled = u.status !== 'active';
            return '<tr style="border-top:1px solid var(--mc-line);">'
                + '<td class="px-4 py-2">' + esc(u.username) + '</td>'
                + '<td class="px-4 py-2">'
                + '<select onchange="updateUser(\'' + esc(u.id) + '\', { role: this.value })" class="px-2 py-1 rounded border text-xs" style="background:var(--mc-bg);border-color:var(--mc-line);">'
                + ['viewer', 'operator', 'admin'].map(function (r) {
                    return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + r + '</option>';
                }).join('')
                + '</select></td>'
                + '<td class="px-4 py-2">' + (disabled ? 'disabled' : 'active')
                + (locked ? ' <span title="too many failed logins">(locked)</span>' : '') + '</td>'
                + '<td class="px-4 py-2">' + esc(fmtWhen(u.last_login_at)) + '</td>'
                + '<td class="px-4 py-2">'
                + '<button onclick="updateUser(\'' + esc(u.id) + '\', { status: \'' + (disabled ? 'active' : 'disabled') + '\' })" class="px-3 py-1 rounded text-xs border" style="border-color:var(--mc-line);">'
                + (disabled ? 'Re-enable' : 'Disable') + '</button>'
                + '</td></tr>';
        }).join('') : '<tr><td colspan="5" class="px-4 py-3 text-dark-400">No users yet — create an invite below.</td></tr>';

        const invites = (data && data.pending_invites) || [];
        if (itbody) {
            itbody.innerHTML = invites.length ? invites.map(function (i) {
                return '<tr style="border-top:1px solid var(--mc-line);">'
                    + '<td class="px-4 py-2">' + esc(i.username || 'anyone with the link') + '</td>'
                    + '<td class="px-4 py-2">' + esc(i.role) + '</td>'
                    + '<td class="px-4 py-2">' + esc(fmtWhen(i.created_at)) + '</td>'
                    + '<td class="px-4 py-2">' + esc(fmtWhen(i.expires_at)) + '</td>'
                    + '</tr>';
            }).join('') : '<tr><td colspan="4" class="px-4 py-3 text-dark-400">None outstanding.</td></tr>';
        }
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-4 py-3">Could not load users: ' + esc(e.message) + '</td></tr>';
    }
    // The keys table shares the Users tab, so it loads with it.
    loadApiKeys();
}

async function updateUser(id, patch) {
    try {
        const res = await fetch('/api/users/' + encodeURIComponent(id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        const data = await res.json().catch(function () { return {}; });
        // The server refuses to strand the last admin; surface that reason.
        if (!res.ok || !data.ok) showToast(data.error || 'Update failed', 'error');
    } catch (e) { showToast('Update failed: ' + e.message, 'error'); }
    loadUsers();
}

async function createInvite() {
    const role = document.getElementById('invite-role').value;
    const username = document.getElementById('invite-username').value.trim();
    try {
        const res = await fetch('/api/invites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: role, username: username || null })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) { showToast(data.error || 'Could not create invite', 'error'); return; }
        document.getElementById('invite-link').value = window.location.origin + data.accept_path;
        document.getElementById('invite-result').classList.remove('hidden');
        loadUsers();
    } catch (e) { showToast('Could not create invite: ' + e.message, 'error'); }
}

function copyInviteLink() {
    const el = document.getElementById('invite-link');
    el.select();
    try { document.execCommand('copy'); } catch (e) { /* clipboard blocked */ }
}

// --- Agent API keys ------------------------------------------------
// Admin-only, and the server refuses the route to API keys of any role,
// so this section can only ever be driven by a signed-in person.

async function loadApiKeys() {
    const tbody = document.getElementById('apikeys-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-3 text-dark-400">Loading...</td></tr>';
    try {
        const res = await fetch('/api/keys');
        if (res.status === 403) {
            tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-3 text-dark-400">Admins only.</td></tr>';
            return;
        }
        const data = await res.json();
        const keys = (data && data.keys) || [];
        tbody.innerHTML = keys.length ? keys.map(function (k) {
            const dead = !k.enabled || !!k.revoked_at;
            return '<tr style="border-top:1px solid var(--mc-line);">'
                + '<td class="px-4 py-2">' + esc(k.name) + '</td>'
                + '<td class="px-4 py-2 font-mono text-xs">' + esc(k.key_prefix) + '&hellip;</td>'
                + '<td class="px-4 py-2">' + esc(k.role) + '</td>'
                + '<td class="px-4 py-2">' + (dead ? 'revoked' : 'active') + '</td>'
                + '<td class="px-4 py-2">' + esc(k.last_used_at ? fmtWhen(k.last_used_at) : 'never') + '</td>'
                + '<td class="px-4 py-2">'
                + (dead ? '' : '<button onclick="revokeApiKey(\'' + esc(k.name) + '\')" class="px-3 py-1 rounded text-xs border" style="border-color:var(--mc-line);">Revoke</button>')
                + '</td></tr>';
        }).join('') : '<tr><td colspan="6" class="px-4 py-3 text-dark-400">No keys yet.</td></tr>';
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" class="px-4 py-3">Could not load keys: ' + esc(e.message) + '</td></tr>';
    }
}

async function createApiKey() {
    const name = document.getElementById('apikey-name').value.trim();
    const role = document.getElementById('apikey-role').value;
    if (!name) { showToast('Give the key a name first', 'error'); return; }
    try {
        const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, role: role })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) { showToast(data.error || 'Could not create the key', 'error'); return; }
        // Shown once. The server stores only a hash, so there is no
        // second chance to read this value.
        document.getElementById('apikey-plaintext').value = data.key;
        document.getElementById('apikey-result').classList.remove('hidden');
        document.getElementById('apikey-name').value = '';
        showToast('Key created. Copy it now — it will not be shown again.', 'success');
        loadApiKeys();
    } catch (e) { showToast('Could not create the key: ' + e.message, 'error'); }
}

async function revokeApiKey(name) {
    if (!(await showConfirm('Revoke API key', 'Revoke "' + name + '"? Anything using it stops working immediately.'))) return;
    try {
        const res = await fetch('/api/keys/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) { showToast(data.error || 'Could not revoke the key', 'error'); return; }
        showToast('Revoked ' + name, 'success');
    } catch (e) { showToast('Could not revoke the key: ' + e.message, 'error'); }
    loadApiKeys();
}

function copyApiKey() {
    const el = document.getElementById('apikey-plaintext');
    el.select();
    try { document.execCommand('copy'); showToast('Copied', 'success'); }
    catch (e) { showToast('Copy blocked by the browser — select and copy manually', 'error'); }
}

async function logout() {
    try { await fetch('/auth/logout', { method: 'POST' }); } catch (e) { /* fall through */ }
    window.location.replace('/');
}

// --- Profile (self-service) ----------------------------------------

function setMsg(id, text, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = text ? (ok ? '#166534' : '#991b1b') : '';
}

async function loadProfile() {
    await loadCurrentUser();
    const u = CURRENT_USER;
    const nameEl = document.getElementById('profile-username');
    const roleEl = document.getElementById('profile-role');
    if (nameEl) nameEl.textContent = u ? u.username : '—';
    if (roleEl) roleEl.textContent = u ? u.role : '—';
    // Break-glass authenticates against a secret, not a row, so there is
    // nothing for it to edit.
    const isBreakGlass = !!u && u.hasProfile === false;
    const forms = document.getElementById('profile-forms');
    const notice = document.getElementById('profile-breakglass');
    if (forms) forms.classList.toggle('hidden', isBreakGlass);
    if (notice) notice.classList.toggle('hidden', !isBreakGlass);
    const pf = document.getElementById('pf-username');
    if (pf && u && !isBreakGlass && !pf.value) pf.value = u.username;
}

async function changeUsername() {
    const username = document.getElementById('pf-username').value.trim();
    const current_password = document.getElementById('pf-username-pw').value;
    setMsg('pf-username-msg', '');
    if (!username) { setMsg('pf-username-msg', 'Enter a username.', false); return; }
    try {
        const res = await fetch('/auth/change-username', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, current_password: current_password })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) { setMsg('pf-username-msg', data.error || 'Could not update username.', false); return; }
        document.getElementById('pf-username-pw').value = '';
        setMsg('pf-username-msg', 'Username updated.', true);
        loadProfile();
    } catch (e) { setMsg('pf-username-msg', 'Network error. Try again.', false); }
}

async function changePassword() {
    const current_password = document.getElementById('pf-cur-pw').value;
    const pw = document.getElementById('pf-new-pw').value;
    const pw2 = document.getElementById('pf-new-pw2').value;
    setMsg('pf-password-msg', '');
    if (pw !== pw2) { setMsg('pf-password-msg', 'The two new passwords do not match.', false); return; }
    if (pw.length < 12) { setMsg('pf-password-msg', 'New password must be at least 12 characters.', false); return; }
    try {
        const res = await fetch('/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_password: current_password, new_password: pw })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok || !data.ok) { setMsg('pf-password-msg', data.error || 'Could not update password.', false); return; }
        document.getElementById('pf-cur-pw').value = '';
        document.getElementById('pf-new-pw').value = '';
        document.getElementById('pf-new-pw2').value = '';
        setMsg('pf-password-msg', 'Password updated. Other browsers have been signed out.', true);
    } catch (e) { setMsg('pf-password-msg', 'Network error. Try again.', false); }
}

