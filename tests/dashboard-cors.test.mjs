// The dashboard API echoes Access-Control-Allow-Origin only for its own
// origins (PROD, TEST, per-version PR previews); any other Origin gets no
// header. Runs the real corsHeadersFor from src/dashboard/cors.mjs and the
// real dispatcher lifted out of src/dashboard/index.js (same harness as
// dashboard-api-route-precedence.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { corsHeadersFor, isAllowedOrigin } from '../src/dashboard/cors.mjs';
import { canAccess, requiredRole, apiKeyMayAccess } from '../src/shared/portal-auth.mjs';
import { resolveUser, breakGlassUser, handleAuthRoutes } from '../src/dashboard/auth-routes.mjs';
import { renderLoginPage, renderAcceptInvitePage } from '../src/dashboard/auth-pages.mjs';
import { resolveApiKeyUser, hasApiKeyHeader, handleApiKeyRoutes } from '../src/dashboard/api-keys.mjs';
import { handleAuditLogQuery } from '../src/dashboard/audit-log.mjs';
import { handleSavedFilterRoutes } from '../src/dashboard/saved-filters.mjs';
import { legacyRouteResponse } from '../src/dashboard/legacy-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

const PROD = 'https://dashboard.zalmen-531.workers.dev';
const TEST = 'https://dashboard-test.zalmen-531.workers.dev';
const PREVIEW = 'https://3f9a2c1b-dashboard-test.zalmen-531.workers.dev';

function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0, started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated: ' + signature);
}

function makeDispatcher() {
  const sandbox = {
    console, Response, URL, URLSearchParams, Request, atob,
    canAccess, requiredRole, apiKeyMayAccess, resolveUser, breakGlassUser, handleAuthRoutes,
    renderLoginPage, renderAcceptInvitePage,
    resolveApiKeyUser, hasApiKeyHeader, handleApiKeyRoutes, handleAuditLogQuery,
    handleSavedFilterRoutes, corsHeadersFor, legacyRouteResponse,
    async fetch() {
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } });
    },
    env: {
      DASHBOARD_AUTH: 'admin:test-pass',
      DASHBOARD_BREAK_GLASS: 'on',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
    },
  };
  vm.createContext(sandbox);
  const code = [
    extractFn(SRC, 'async function supabaseGet(env, path, extraHeaders) {'),
    extractFn(SRC, 'async function handleActivationRunsList(env, corsHeaders, url) {'),
    extractFn(SRC, 'async function handleDashboardRequest(request, env, ctx, audit) {')
      .replace(/^async function handleDashboardRequest\(/, 'async function dispatch('),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return (req) => sandbox.dispatch(req, sandbox.env);
}

function authed(pathname, { method = 'GET', origin } = {}) {
  const headers = { Authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') };
  if (origin) headers.Origin = origin;
  return new Request('https://dashboard.test' + pathname, { method, headers });
}

test('the dispatcher builds its CORS headers from cors.mjs, not a wildcard', () => {
  assert.match(SRC, /const corsHeaders = corsHeadersFor\(request\);/);
  assert.doesNotMatch(extractFn(SRC, 'async function handleDashboardRequest(request, env, ctx, audit) {'),
    /'Access-Control-Allow-Origin': '\*'/);
});

test('allowed origins: PROD, TEST, per-version previews', () => {
  for (const o of [PROD, TEST, PREVIEW, 'https://0a1b-2c3d-dashboard-test.zalmen-531.workers.dev']) {
    assert.equal(isAllowedOrigin(o), true, o);
  }
});

test('rejected origins: foreign, look-alikes, http, other workers, missing', () => {
  for (const o of [
    'https://evil.example',
    'http://dashboard.zalmen-531.workers.dev',
    'https://dashboard.zalmen-531.workers.dev.evil.example',
    'https://evil-dashboard-test.zalmen-531.workers.dev',
    'https://xyz-dashboard-test.zalmen-531.workers.dev',
    'https://3f9a2c1b-dashboard.zalmen-531.workers.dev',
    'https://sms-ingest.zalmen-531.workers.dev',
    'null', '', null, undefined,
  ]) {
    assert.equal(isAllowedOrigin(o), false, String(o));
  }
});

test('real handler: allowed origin is echoed on an API response', async () => {
  const dispatch = makeDispatcher();
  const res = await dispatch(authed('/api/activation-runs?limit=5', { origin: TEST }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), TEST);
});

test('real handler: preview origin is echoed', async () => {
  const dispatch = makeDispatcher();
  const res = await dispatch(authed('/api/activation-runs', { origin: PREVIEW }));
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), PREVIEW);
});

test('real handler: foreign origin gets no Allow-Origin header', async () => {
  const dispatch = makeDispatcher();
  const res = await dispatch(authed('/api/activation-runs', { origin: 'https://evil.example' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('real handler: same-origin / non-browser call (no Origin) still works, no header', async () => {
  const dispatch = makeDispatcher();
  const res = await dispatch(authed('/api/activation-runs'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('real handler: OPTIONS preflight answers with methods, headers, and the echoed origin', async () => {
  const dispatch = makeDispatcher();
  const ok = await dispatch(authed('/api/sims', { method: 'OPTIONS', origin: PROD }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), PROD);
  assert.equal(ok.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(ok.headers.get('Access-Control-Allow-Headers'), 'Content-Type, Authorization');

  const foreign = await dispatch(authed('/api/sims', { method: 'OPTIONS', origin: 'https://evil.example' }));
  assert.equal(foreign.status, 200);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
});
