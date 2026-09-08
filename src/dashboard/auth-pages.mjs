// =========================================================
// Standalone HTML for the two pages an unauthenticated visitor may see: the
// login form and the invite-redemption form.
//
// These are served by the Worker instead of the SPA so that public/index.html —
// the whole operator tool, its route names and its data shapes — is never sent
// to anyone who has not logged in.
//
// Self-contained: no external CSS, fonts, or scripts.
// =========================================================

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9; color: #1a1d21; padding: 24px;
  }
  .card {
    width: 100%; max-width: 360px; background: #fff; border: 1px solid #e3e6ea;
    border-radius: 10px; padding: 28px;
  }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
  p.sub { margin: 0 0 20px; font-size: 13px; color: #6b7280; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 5px; }
  input {
    width: 100%; padding: 9px 11px; font-size: 14px; font-family: inherit;
    border: 1px solid #d3d8de; border-radius: 6px; background: #fff; color: inherit;
  }
  input:focus { outline: 2px solid #2563eb; outline-offset: -1px; border-color: #2563eb; }
  button {
    width: 100%; margin-top: 20px; padding: 10px; font-size: 14px; font-weight: 500;
    font-family: inherit; color: #fff; background: #1f2937; border: 0; border-radius: 6px;
    cursor: pointer;
  }
  button:hover { background: #111827; }
  button[disabled] { opacity: .6; cursor: default; }
  .msg { margin-top: 16px; font-size: 13px; padding: 9px 11px; border-radius: 6px; display: none; }
  .msg.err { display: block; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  .msg.ok  { display: block; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
  .hint { margin-top: 14px; font-size: 12px; color: #6b7280; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e6e8eb; }
    .card { background: #171a1f; border-color: #2a2f36; }
    input { background: #0f1115; border-color: #333a42; color: #e6e8eb; }
    button { background: #2563eb; } button:hover { background: #1d4ed8; }
    p.sub, .hint { color: #9aa3ad; }
    .msg.err { background: #2a1416; border-color: #5b2226; color: #fca5a5; }
    .msg.ok  { background: #10231a; border-color: #1f4d34; color: #86efac; }
  }
`;

function page(title, bodyHtml, script) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
${bodyHtml}
</main>
<script>${script}</script>
</body>
</html>`;
}

export function renderLoginPage() {
  return page('Sign in', `
  <h1>Operator dashboard</h1>
  <p class="sub">Sign in to continue.</p>
  <form id="f" autocomplete="on">
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" required>
    <button id="b" type="submit">Sign in</button>
  </form>
  <div id="m" class="msg" role="alert" aria-live="polite"></div>
`, `
  var f = document.getElementById('f'), b = document.getElementById('b'), m = document.getElementById('m');
  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    m.className = 'msg'; m.textContent = '';
    b.disabled = true; b.textContent = 'Signing in...';
    try {
      var res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('u').value,
          password: document.getElementById('p').value
        })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) { window.location.replace('/'); return; }
      m.className = 'msg err';
      m.textContent = data.error || 'Sign in failed.';
    } catch (err) {
      m.className = 'msg err';
      m.textContent = 'Network error. Try again.';
    }
    b.disabled = false; b.textContent = 'Sign in';
  });
`);
}

export function renderAcceptInvitePage() {
  return page('Accept invite', `
  <h1>Set up your account</h1>
  <p class="sub">Choose a username and password to finish your invite.</p>
  <form id="f" autocomplete="on">
    <label for="u">Username</label>
    <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="new-password" minlength="12" required>
    <label for="p2">Confirm password</label>
    <input id="p2" name="password2" type="password" autocomplete="new-password" minlength="12" required>
    <button id="b" type="submit">Create account</button>
  </form>
  <p class="hint">Minimum 12 characters.</p>
  <div id="m" class="msg" role="alert" aria-live="polite"></div>
`, `
  var f = document.getElementById('f'), b = document.getElementById('b'), m = document.getElementById('m');
  var token = new URLSearchParams(window.location.search).get('token') || '';
  if (!token) { m.className = 'msg err'; m.textContent = 'This invite link is missing its token.'; b.disabled = true; }
  f.addEventListener('submit', async function (e) {
    e.preventDefault();
    var pw = document.getElementById('p').value, pw2 = document.getElementById('p2').value;
    m.className = 'msg'; m.textContent = '';
    if (pw !== pw2) { m.className = 'msg err'; m.textContent = 'The two passwords do not match.'; return; }
    b.disabled = true; b.textContent = 'Creating...';
    try {
      var res = await fetch('/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, username: document.getElementById('u').value, password: pw })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        m.className = 'msg ok';
        m.textContent = 'Account created. Redirecting to sign in...';
        setTimeout(function () { window.location.replace('/'); }, 1200);
        return;
      }
      m.className = 'msg err';
      m.textContent = data.error || 'Could not create the account.';
    } catch (err) {
      m.className = 'msg err';
      m.textContent = 'Network error. Try again.';
    }
    b.disabled = false; b.textContent = 'Create account';
  });
`);
}
