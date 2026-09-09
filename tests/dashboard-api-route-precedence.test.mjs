// Regression test for a real live bug: dashboard-test.zalmen-531.workers.dev
// once served the static SPA shell (ZMAW marketing HTML in one observed case)
// for `/api/activation-runs` instead of JSON, because a request path that
// didn't match any `if (url.pathname === '/api/...')` branch fell through to
// the catch-all `return serveApp(env)` / `env.ASSETS.fetch(request)` at the
// bottom of the dispatcher (see src/dashboard/index.js's exported `fetch`).
//
// This test runs the *actual* top-level `fetch(request, env)` dispatcher
// (lifted verbatim out of index.js, same pattern as
// tests/dashboard-activation-runs-route.test.mjs) so a future route added in
// the wrong place, or a mis-ordered `if`, fails a test instead of only
// showing up against a live deploy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
// The dispatcher now imports its auth from modules rather than defining
// checkAuth() inline, so the sandbox is given the real implementations instead
// of a lifted copy. Requests here carry Basic admin:test-pass, which
// breakGlassUser accepts as admin (DASHBOARD_BREAK_GLASS is unset in env).
import { canAccess } from '../src/shared/portal-auth.mjs';
import { resolveUser, breakGlassUser, handleAuthRoutes } from '../src/dashboard/auth-routes.mjs';
import { renderLoginPage, renderAcceptInvitePage } from '../src/dashboard/auth-pages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'index.js'), 'utf8');

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

function makeSandbox(supabaseRoutes, assetRoutes) {
  const supabaseCalls = [];
  const assetCalls = [];
  const sandbox = {
    console, Response, URL, URLSearchParams, Request, atob,
    canAccess, resolveUser, breakGlassUser, handleAuthRoutes,
    renderLoginPage, renderAcceptInvitePage,
    async fetch(url, init) {
      const u = String(url);
      supabaseCalls.push({ url: u, headers: (init && init.headers) || {} });
      for (const [pattern, handler] of supabaseRoutes || []) {
        if (u.includes(pattern)) return handler(u);
      }
      return new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } });
    },
    env: {
      DASHBOARD_AUTH: 'admin:test-pass',
      SUPABASE_URL: 'https://sb.test',
      SUPABASE_SERVICE_ROLE_KEY: 'srv',
      ASSETS: {
        async fetch(reqOrUrl) {
          const u = String(reqOrUrl.url || reqOrUrl);
          assetCalls.push(u);
          for (const [pattern, handler] of assetRoutes || []) {
            if (u.includes(pattern)) return handler(u);
          }
          return new Response('<!DOCTYPE html><title>SMS Gateway Dashboard</title>window.HELIX_ENABLED = __HELIX_ENABLED__;', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        },
      },
    },
  };
  vm.createContext(sandbox);

  const code = [
    extractFn(SRC, 'async function supabaseGet(env, path, extraHeaders) {'),
    extractFn(SRC, 'async function handleActivationRunsList(env, corsHeaders, url) {'),
    extractFn(SRC, 'async function handleActivationRunDetail(env, corsHeaders, runId, url) {'),
    extractFn(SRC, 'async function serveApp(env) {'),
    // Renamed to `dispatch` (not `fetch`) so it doesn't shadow the sandbox's
    // mocked global `fetch` that supabaseGet relies on.
    extractFn(SRC, '  async fetch(request, env) {').replace(/^\s*async fetch\(/, 'async function dispatch('),
  ].join('\n\n');
  vm.runInContext(code, sandbox);
  return { sandbox, supabaseCalls, assetCalls };
}

function authedRequest(path) {
  return new Request('https://dashboard.test' + path, {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') },
  });
}

test('GET /api/activation-runs returns JSON through the real dispatcher, never the asset/SPA shell', async () => {
  const freshRun = { id: 'run-1', source: 'json', status: 'queued', created_at: '2026-08-24T12:00:00Z' };
  const { sandbox, assetCalls } = makeSandbox([
    ['/activation_runs', () => new Response(JSON.stringify([freshRun]), {
      status: 200,
      headers: { 'content-range': '0-0/1' },
    })],
  ]);

  const res = await sandbox.dispatch(authedRequest('/api/activation-runs?limit=5'), sandbox.env);
  assert.equal(res.headers.get('Content-Type'), 'application/json', 'API route must answer JSON, not HTML');

  const body = await res.json();
  assert.deepEqual(body.runs, [freshRun]);
  assert.equal(assetCalls.length, 0, 'the asset/SPA fallback must never be invoked for an /api/* path');
});

test('GET /api/activation-runs/<id> returns JSON, never the asset/SPA shell', async () => {
  const { sandbox, assetCalls } = makeSandbox([
    ['/activation_runs?select=*&id=eq.run-1', () => new Response(JSON.stringify([{ id: 'run-1' }]), { status: 200 })],
    ['/activation_job_items', () => new Response('[]', { status: 200, headers: { 'content-range': '0-0/0' } })],
    ['/carrier_api_logs', () => new Response('[]', { status: 200 })],
  ]);

  const res = await sandbox.dispatch(authedRequest('/api/activation-runs/run-1'), sandbox.env);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(assetCalls.length, 0, 'the asset/SPA fallback must never be invoked for an /api/* path');
});

test('GET /activation-runs (no /api prefix) serves the dashboard app shell, not asset-only content', async () => {
  const { sandbox, assetCalls } = makeSandbox();

  const res = await sandbox.dispatch(authedRequest('/activation-runs'), sandbox.env);
  assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(res.headers.get('Cache-Control'), 'no-store', 'app shell must never be edge-cached, or a stale asset response can outlive a route fix');

  const html = await res.text();
  assert.match(html, /SMS Gateway Dashboard/, 'must be this app\'s SPA shell, not unrelated static content');
  assert.ok(assetCalls.some(u => u.includes('/index.html')), 'the deep link is served by fetching the SPA shell asset, not by a 404/static passthrough');
});

test('an unauthenticated request to /api/activation-runs is rejected before any routing occurs', async () => {
  const { sandbox, assetCalls, supabaseCalls } = makeSandbox();
  const res = await sandbox.dispatch(new Request('https://dashboard.test/api/activation-runs'), sandbox.env);
  assert.equal(res.status, 401);
  assert.equal(assetCalls.length, 0);
  assert.equal(supabaseCalls.length, 0);
});
