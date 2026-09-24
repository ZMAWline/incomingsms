// Legacy vendor switch (LEGACY_VENDORS, src/shared/legacy-vendors.mjs).
//
// Wing IoT, Helix, SkyLine and Kasa code stays in the repo but is off unless
// LEGACY_VENDORS names it. These tests run the real worker code with a fetch
// stub and prove: nothing calls a switched-off vendor, the live ATOMIC path
// still works, and switching a vendor back on restores the old behaviour.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import {
  legacyVendorEnabled, legacyVendorOfSim, disabledLegacyVendorOfSim, assertLegacyVendorEnabled,
} from '../src/shared/legacy-vendors.mjs';
import { legacyRouteResponse } from '../src/dashboard/legacy-routes.mjs';
import { startVerify } from '../src/bad-rental-remediator/verify-runner.mjs';
import remediator from '../src/bad-rental-remediator/index.js';
import { corsHeadersFor } from '../src/dashboard/cors.mjs';
import { canAccess, requiredRole, apiKeyMayAccess } from '../src/shared/portal-auth.mjs';
import { resolveUser, breakGlassUser, handleAuthRoutes } from '../src/dashboard/auth-routes.mjs';
import { renderLoginPage, renderAcceptInvitePage } from '../src/dashboard/auth-pages.mjs';
import { resolveApiKeyUser, hasApiKeyHeader, handleApiKeyRoutes } from '../src/dashboard/api-keys.mjs';
import { handleAuditLogQuery } from '../src/dashboard/audit-log.mjs';
import { handleSavedFilterRoutes } from '../src/dashboard/saved-filters.mjs';

const realFetch = globalThis.fetch;
const realConsole = { log: console.log, error: console.error, warn: console.warn };
let logLines = [];
function captureLogs() {
  logLines = [];
  console.log = console.warn = console.error = (...a) => { logLines.push(a.join(' ')); };
}
afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(console, realConsole);
});

const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), { status });

// ---------------------------------------------------------------------------
// (e) the shared helper
// ---------------------------------------------------------------------------

test('helper: unset or empty LEGACY_VENDORS = every legacy vendor off', () => {
  for (const env of [{}, { LEGACY_VENDORS: '' }, { LEGACY_VENDORS: ' , ' }, undefined]) {
    for (const v of ['helix', 'wing', 'skyline', 'kasa']) assert.equal(legacyVendorEnabled(env, v), false, `${v} ${JSON.stringify(env)}`);
  }
});

test('helper: "all" enables everything, in any casing', () => {
  for (const all of ['all', 'ALL', ' All ']) {
    for (const v of ['helix', 'wing', 'skyline', 'kasa']) assert.equal(legacyVendorEnabled({ LEGACY_VENDORS: all }, v), true);
  }
});

test('helper: comma list with casing and spaces enables only the named vendors', () => {
  const env = { LEGACY_VENDORS: ' Helix , SKYLINE,' };
  assert.equal(legacyVendorEnabled(env, 'helix'), true);
  assert.equal(legacyVendorEnabled(env, 'skyline'), true);
  assert.equal(legacyVendorEnabled(env, 'wing'), false);
  assert.equal(legacyVendorEnabled(env, 'kasa'), false);
  assert.throws(() => legacyVendorEnabled(env, 'atomic'), /unknown legacy vendor/);
});

test('helper: sims.vendor mapping and the backstop assert', () => {
  assert.equal(legacyVendorOfSim('helix'), 'helix');
  assert.equal(legacyVendorOfSim('wing_iot'), 'wing');
  assert.equal(legacyVendorOfSim('atomic'), null);
  assert.equal(legacyVendorOfSim('teltik'), null);
  assert.equal(disabledLegacyVendorOfSim({}, 'wing_iot'), 'wing');
  assert.equal(disabledLegacyVendorOfSim({ LEGACY_VENDORS: 'wing' }, 'wing_iot'), null);
  assert.equal(disabledLegacyVendorOfSim({}, 'atomic'), null);
  assert.throws(() => assertLegacyVendorEnabled({}, 'helix'), { name: 'LegacyVendorDisabledError', message: 'legacy vendor helix disabled' });
  assert.doesNotThrow(() => assertLegacyVendorEnabled({ LEGACY_VENDORS: 'helix' }, 'helix'));
});

// ---------------------------------------------------------------------------
// (a)/(b) mdn-rotator tick — loader and ATOMIC fixture as in
// tests/mdn-rotator-atomic-rotation.test.mjs
// ---------------------------------------------------------------------------

const SHARED_MODULES = [
  ['../shared/subscriber-sync.js', 'src/shared/subscriber-sync.js', true],
  ['../shared/address-picker.mjs', 'src/shared/address-picker.mjs', false],
  ['../shared/persist-rental.mjs', 'src/shared/persist-rental.mjs', false],
  ['../shared/gateway-host.mjs', 'src/shared/gateway-host.mjs', false],
  ['../shared/activation-bulk.mjs', 'src/shared/activation-bulk.mjs', false],
  ['../shared/sim-swap.mjs', 'src/shared/sim-swap.mjs', false],
  ['../shared/fetch-timeout.mjs', 'src/shared/fetch-timeout.mjs', false],
  ['../shared/supabase-rest.mjs', 'src/shared/supabase-rest.mjs', false],
  ['../shared/legacy-vendors.mjs', 'src/shared/legacy-vendors.mjs', false],
];
async function toDataUrl(relPath) {
  const src = (await readFile(new URL('../' + relPath, import.meta.url), 'utf8'))
    .replace("'./fetch-timeout.mjs'", JSON.stringify(new URL('../src/shared/fetch-timeout.mjs', import.meta.url).href));
  return 'data:text/javascript;base64,' + Buffer.from(src).toString('base64');
}
let rotatorSrc = await readFile(new URL('../src/mdn-rotator/index.js', import.meta.url), 'utf8');
for (const [specifier, relPath, asDataUrl] of SHARED_MODULES) {
  const abs = asDataUrl ? await toDataUrl(relPath) : new URL('../' + relPath, import.meta.url).href;
  rotatorSrc = rotatorSrc.replace(`'${specifier}'`, JSON.stringify(abs));
}
const mdnRotator = (await import('data:text/javascript;base64,' + Buffer.from(rotatorSrc).toString('base64'))).default;

const SUPABASE = 'https://db.test';
const RELAY = 'https://relay.test';
const ATOMIC = 'https://solutionsatt-atomic.telgoo5.com:22712';
const HX_TOKEN_URL = 'https://helix.test/oauth/token';
const HOUR = 3_600_000;

const ROTATOR_ENV = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE_KEY: 'svc',
  ADMIN_RUN_SECRET: 'sekret',
  ATOMIC_USERNAME: 'ezbiz', ATOMIC_TOKEN: 'atok', ATOMIC_PIN: '1234',
  RELAY_URL: RELAY, RELAY_KEY: 'rk',
  HX_TOKEN_URL,
  // No TOKEN_CACHE: any Helix token need goes to the token URL, so it is counted.
};

function atomicSim(id) {
  return {
    id,
    iccid: `8901410300000000${String(id).padStart(3, '0')}`,
    mobility_subscription_id: null,
    msisdn: `21255500${String(id).padStart(2, '0')}`,
    vendor: 'atomic',
    status: 'active',
    last_mdn_rotated_at: new Date(Date.now() - 30 * HOUR).toISOString(),
    activated_at: '2026-01-01T00:00:00.000Z',
    activation_zip: '11238',
    rotation_eligible: true,
    canary_apex_ppu: false,
    reseller_sims: [{ reseller_id: 7 }],
  };
}

// Supabase + ATOMIC + Helix token URL fake. Counts Helix token requests.
function rotatorHarness(sims) {
  const db = new Map(sims.map(s => [s.id, { ...s }]));
  const seen = { helixToken: 0, atomic: [], candidateQueries: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith(RELAY + '/')) {
      const target = url.slice(RELAY.length + 1);
      if (target.startsWith(HX_TOKEN_URL)) {
        seen.helixToken++;
        return jsonResp({ access_token: 'hx-token' });
      }
      if (target.startsWith(ATOMIC)) {
        const req = body.wholeSaleApi.wholeSaleRequest;
        seen.atomic.push(req.requestType);
        const sim = [...db.values()].find(s => s.iccid === req.sim || s.msisdn === req.MSISDN);
        if (req.requestType === 'subsriberInquiry') {
          return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', Result: { msisdn: sim.msisdn, address: { zipCode: '11238', state: 'NY' } } } } });
        }
        if (req.requestType === 'swapMSISDN') {
          return jsonResp({ wholeSaleApi: { wholeSaleResponse: { statusCode: '00', Result: { MSISDN: `310555${String(sim.id).padStart(4, '0')}` } } } });
        }
        throw new Error('unexpected ATOMIC request ' + req.requestType);
      }
      return jsonResp({ rentalId: 77 }); // reseller webhook
    }
    assert.ok(url.startsWith(SUPABASE + '/rest/v1/'), 'unexpected URL ' + url);
    const path = url.slice((SUPABASE + '/rest/v1/').length);
    if (path.startsWith('rpc/claim_rotation_slot')) {
      const row = db.get(body.p_sim_id);
      row.last_mdn_rotated_at = new Date().toISOString();
      return new Response('true', { status: 200 });
    }
    if (method === 'GET') {
      if (path.startsWith('sims?select=id,iccid,mobility_subscription_id')) {
        seen.candidateQueries.push(decodeURIComponent(path));
        return jsonResp([...db.values()].filter(s => s.status === 'active'));
      }
      if (path.startsWith('sim_numbers?sim_id=eq.')) return jsonResp([{ e164: '+1' + db.get(Number(/sim_id=eq\.(\d+)/.exec(path)[1])).msisdn }]);
      if (path.startsWith('reseller_sims?')) return jsonResp([{ reseller_id: 7 }]);
      if (path.startsWith('reseller_webhooks?')) return jsonResp([{ url: 'https://reseller.test/hook' }]);
      return jsonResp([]);
    }
    if (method === 'PATCH' && path.startsWith('sims?id=eq.')) {
      Object.assign(db.get(Number(/id=eq\.(\d+)/.exec(path)[1])), body);
      return jsonResp([{}]);
    }
    return jsonResp([], method === 'POST' ? 201 : 200);
  };
  return { db, seen };
}

async function runTick(env) {
  const res = await mdnRotator.fetch(new Request('https://mdn-rotator/run?secret=sekret&limit=10'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  return res.json();
}

test('(a) mdn-rotator tick with LEGACY_VENDORS unset: zero Helix token requests, ATOMIC SIM still rotates', async () => {
  captureLogs();
  const { db, seen } = rotatorHarness([atomicSim(1)]);
  const result = await runTick(ROTATOR_ENV);

  assert.equal(seen.helixToken, 0, 'no Helix token request');
  assert.equal(result.ok_count, 1);
  assert.ok(seen.atomic.includes('swapMSISDN'), 'ATOMIC swap was sent');
  assert.equal(db.get(1).msisdn, '3105550001', 'new ATOMIC number stored');
  assert.match(seen.candidateQueries[0], /vendor=in\.\(atomic\)/, 'helix and wing_iot left out of the candidate query');
  assert.equal(logLines.filter(l => l.includes('legacy vendor helix disabled')).length, 1, 'exactly one log line per tick');
  assert.equal(logLines.filter(l => /Token failed/.test(l)).length, 0);
});

test('(b) mdn-rotator tick with LEGACY_VENDORS="helix": the Helix token fetch happens again (old behaviour)', async () => {
  captureLogs();
  const { seen } = rotatorHarness([atomicSim(2)]);
  const result = await runTick({ ...ROTATOR_ENV, LEGACY_VENDORS: 'helix' });

  assert.equal(seen.helixToken, 1, 'one Helix token request');
  assert.equal(result.ok_count, 1);
  assert.match(seen.candidateQueries[0], /vendor=in\.\(helix,atomic\)/);
  assert.equal(logLines.filter(l => l.includes('legacy vendor helix disabled')).length, 0);
});

test('mdn-rotator: a manual rotate of a Helix SIM returns legacy_vendor_disabled and never calls out', async () => {
  captureLogs();
  const helixSim = { ...atomicSim(3), vendor: 'helix', mobility_subscription_id: 'sub-3' };
  const { seen } = rotatorHarness([helixSim]);
  const res = await mdnRotator.fetch(new Request(`https://mdn-rotator/rotate-sim?secret=sekret&iccid=${helixSim.iccid}`), ROTATOR_ENV, {});
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'legacy_vendor_disabled');
  assert.equal(body.vendor, 'helix');
  assert.equal(seen.helixToken, 0);
});

test('mdn-rotator: a legacy-only route answers 409 while its vendor is off', async () => {
  captureLogs();
  globalThis.fetch = async (u) => { throw new Error('unexpected fetch ' + u); };
  const res = await mdnRotator.fetch(new Request('https://mdn-rotator/check-imei?secret=sekret&imei=351756051523999'), ROTATOR_ENV, {});
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.vendor, 'helix');
  assert.equal(body.how_to_enable, 'set LEGACY_VENDORS in mdn-rotator wrangler.toml [vars]');
});

// ---------------------------------------------------------------------------
// (c) bad-rental-remediator: SkyLine port probe and the verify send
// ---------------------------------------------------------------------------

mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-06T16:00:00.000Z') });
const NOW = Date.now();
const iso = ms => new Date(ms).toISOString();
mock.timers.reset();

function remediatorScenario() {
  // Same shape as the R1 S5 test in bad-rental-remediator-lifecycle-fixes: a
  // Teltik-era SIM that still carries an old SkyLine gateway_id + port.
  const report = {
    id: 9102, status: 'received', received_at: iso(NOW - 2 * HOUR), sim_id: 'sim-9102',
    sim_number_id: null, rental_id: 'r-9102', reseller_id: 'rs-1', e164: '+15550009102',
    auto_remediation_state: null, last_auto_attempt_at: null, reason_code: 'no_sms_received', attempts: 5,
  };
  const sim = {
    id: 'sim-9102', iccid: '890141000009102', vendor: 'atomic', gateway_host: 'skyline',
    status: 'active', msisdn: '5559009102', gateway_id: 'gw1', port: 3,
  };
  const rental = { id: 'r-9102', sim_id: 'sim-9102', reseller_id: 'rs-1', reseller_rental_id: 'rr-9102', rental_date: '2026-07-01', minted_at: iso(NOW - 10 * 24 * HOUR) };
  const fetchStub = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    if (u.includes('/rental_reports?status=in.') && method === 'GET') return jsonResp([report]);
    if (u.includes('/rental_reports?id=eq.9102')) {
      if (method === 'PATCH') {
        Object.assign(report, JSON.parse(init.body));
        return new Response(null, { status: 204, headers: { 'Content-Range': '0-0/1' } });
      }
      return jsonResp([report]);
    }
    if (u.includes('/rental_report_remediation_attempts')) return method === 'POST' ? jsonResp({}, 201) : jsonResp([]);
    if (u.includes('/sims?id=eq.')) return jsonResp([sim]);
    if (u.includes('/rentals?id=eq.')) return jsonResp([rental]);
    if (u.includes('operator_escalations') && method === 'POST') return jsonResp([{ id: 1 }], 201);
    return jsonResp([]);
  };
  return { fetchStub, report };
}

function remediatorEnv(overrides) {
  const kv = { bad_rental_remediator_enabled: 'true' };
  return {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv', ADMIN_RUN_SECRET: 's',
    TELTIK_API_KEY: 'tk', ATOMIC_USERNAME: 'u', ATOMIC_TOKEN: 't', ATOMIC_PIN: 'p', ATOMIC_API_URL: 'https://atomic.test',
    REMEDIATOR_KV: { async get(k) { return kv[k] ?? null; }, async put(k, v) { kv[k] = v; }, async delete(k) { delete kv[k]; } },
    RESELLER_SYNC: { async fetch() { return jsonResp({ ok: true, status: 'sent' }); } },
    ...overrides,
  };
}

async function runRemediatorTick(env) {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  try {
    const res = await remediator.fetch(new Request('https://w/run?secret=s'), env);
    assert.equal((await res.json()).ok, true);
  } finally { mock.timers.reset(); }
}

test('(c) remediator with the switch off: no SkyLine port probe for a SIM with an old gateway_id', async () => {
  captureLogs();
  const { fetchStub } = remediatorScenario();
  globalThis.fetch = fetchStub;
  let skylineCalls = 0;
  const env = remediatorEnv({ SKYLINE_GATEWAY: { async fetch() { skylineCalls++; return jsonResp({ status: 'offline', online: false }); } } });
  await runRemediatorTick(env);
  assert.equal(skylineCalls, 0);
});

test('(c) remediator with LEGACY_VENDORS="skyline": the port probe runs again', async () => {
  captureLogs();
  const { fetchStub } = remediatorScenario();
  globalThis.fetch = fetchStub;
  let skylineCalls = 0;
  const env = remediatorEnv({ LEGACY_VENDORS: 'skyline', SKYLINE_GATEWAY: { async fetch() { skylineCalls++; return jsonResp({ status: 'online' }); } } });
  await runRemediatorTick(env);
  assert.ok(skylineCalls >= 1);
});

test('(c) verify send with the switch off: no SkyLine send-sms, nothing recorded', async () => {
  let dbCalls = 0;
  globalThis.fetch = async () => { dbCalls++; return jsonResp([]); };
  let skylineCalls = 0;
  const env = {
    SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv', SKYLINE_SECRET: 's', SMS_SENDING_ENABLED: 'true',
    SKYLINE_GATEWAY: { async fetch() { skylineCalls++; return jsonResp({ ok: true }); } },
  };
  const sim = { id: 5, current_mdn_e164: '+15550000005', gateway_id: 1, port: '1.01' };
  const out = await startVerify(env, { report: { id: 1 }, sim, attemptNo: 1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'legacy_vendor_disabled');
  assert.equal(out.vendor, 'skyline');
  assert.equal(skylineCalls, 0);
  assert.equal(dbCalls, 0);
});

// ---------------------------------------------------------------------------
// (d) dashboard legacy routes — through the real dispatcher (same vm harness
// as tests/dashboard-cors.test.mjs)
// ---------------------------------------------------------------------------

const DASH_SRC = fs.readFileSync(new URL('../src/dashboard/index.js', import.meta.url), 'utf8');
function extractFn(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, 'not found: ' + signature);
  let depth = 0, started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; } else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('unterminated: ' + signature);
}
function makeDispatcher(envOverrides = {}) {
  const sandbox = {
    console, Response, URL, URLSearchParams, Request, atob,
    canAccess, requiredRole, apiKeyMayAccess, resolveUser, breakGlassUser, handleAuthRoutes,
    renderLoginPage, renderAcceptInvitePage, resolveApiKeyUser, hasApiKeyHeader, handleApiKeyRoutes,
    handleAuditLogQuery, handleSavedFilterRoutes, corsHeadersFor, legacyRouteResponse,
    async fetch(u) { throw new Error('legacy route must not reach any fetch: ' + u); },
    env: { DASHBOARD_AUTH: 'admin:test-pass', DASHBOARD_BREAK_GLASS: 'on', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'srv', ...envOverrides },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(DASH_SRC, 'async function handleDashboardRequest(request, env, ctx, audit) {')
    .replace(/^async function handleDashboardRequest\(/, 'async function dispatch('), sandbox);
  return (req) => sandbox.dispatch(req, sandbox.env);
}
const authed = (pathname, method = 'POST') => new Request('https://dashboard.test' + pathname, {
  method, headers: { Authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64') },
});

test('(d) dashboard: a legacy route answers 409 with how_to_enable when its vendor is off', async () => {
  captureLogs();
  const dispatch = makeDispatcher();
  for (const [path, vendor] of [['/api/helix-query', 'helix'], ['/api/wing-check', 'wing'], ['/api/sync-gateway-slots', 'skyline'], ['/api/kasa/outlets', 'kasa']]) {
    const res = await dispatch(authed(path, path.startsWith('/api/kasa/') ? 'GET' : 'POST'));
    assert.equal(res.status, 409, path);
    const body = await res.json();
    assert.deepEqual(body, {
      ok: false, reason: 'legacy_vendor_disabled', vendor,
      error: 'legacy vendor disabled',
      how_to_enable: 'set LEGACY_VENDORS in dashboard wrangler.toml [vars]',
    }, path);
  }
});

test('(d) dashboard: routes pass the gate once their vendor is on, and live routes never hit it', () => {
  assert.equal(legacyRouteResponse({ LEGACY_VENDORS: 'helix' }, '/api/helix-query', {}), null);
  assert.equal(legacyRouteResponse({ LEGACY_VENDORS: 'kasa' }, '/api/kasa/outlets', {}), null);
  // needs both helix and skyline
  assert.equal(legacyRouteResponse({ LEGACY_VENDORS: 'helix' }, '/api/imei-sweep', {}).status, 409);
  assert.equal(legacyRouteResponse({ LEGACY_VENDORS: 'helix,skyline' }, '/api/imei-sweep', {}), null);
  for (const live of ['/api/sims', '/api/sim-action', '/api/skyline/port-info', '/api/rotate-sim']) {
    assert.equal(legacyRouteResponse({}, live, {}), null, live);
  }
});

test('dashboard frontend surfaces the 409 message in the error toast', () => {
  const html = fs.readFileSync(new URL('../src/dashboard/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /body\.reason === 'legacy_vendor_disabled'/);
  assert.match(html, /showToast\(`Legacy vendor \$\{body\.vendor\} is switched off\. To turn it back on: \$\{body\.how_to_enable\}`, 'error'\)/);
});

test('no wrangler.toml turns a legacy vendor on; each affected worker carries the commented line', () => {
  const LINE = '# LEGACY_VENDORS = "helix,wing,skyline,kasa"  # off by default; set to re-enable, then deploy';
  for (const w of ['mdn-rotator', 'details-finalizer', 'bad-rental-remediator', 'sim-canceller', 'sim-status-changer', 'ota-status-sync', 'bulk-activator', 'dashboard', 'sms-ingest']) {
    const toml = fs.readFileSync(new URL(`../src/${w}/wrangler.toml`, import.meta.url), 'utf8');
    assert.ok(toml.includes(LINE), w);
    assert.doesNotMatch(toml, /^\s*LEGACY_VENDORS\s*=/m, w);
  }
});
