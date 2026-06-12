import { computeBillingBreakdown, computeResellerUtilization } from '../shared/billing.js';
import { PRESETS as API_TESTER_PRESETS_REGISTRY, listPresetsForClient, isStateChanging } from './api-tester-presets.js';

function normalizeImeiPoolPort(port) {
  if (!port) return port;
  const dotMatch = port.match(/^(\d+)\.(\d+)$/);
  if (dotMatch) return dotMatch[1] + '.' + String(parseInt(dotMatch[2])).padStart(2, '0');
  const letterToSlot = { A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8 };
  const letterMatch = port.match(/^(\d+)([A-Ha-h])$/);
  if (letterMatch) return letterMatch[1] + '.' + String(letterToSlot[letterMatch[2].toUpperCase()] || 1).padStart(2, '0');
  return port;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Basic auth check
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !checkAuth(authHeader, env)) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="Dashboard"' }
      });
    }

    // CORS headers for API requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API Routes
    if (url.pathname === '/api/stats') {
      return handleStats(env, corsHeaders);
    }

    if (url.pathname === '/api/sms-usage') {
      return handleSmsUsage(env, corsHeaders, url);
    }

    if (url.pathname === '/api/sims') {
      return handleSims(env, corsHeaders, url);
    }

    if (url.pathname === '/api/messages') {
      return handleMessages(env, corsHeaders, url);
    }

    if (url.pathname === '/api/resellers') {
      return handleResellers(env, corsHeaders);
    }

    if (url.pathname === '/api/gateways') {
      return handleGateways(request, env, corsHeaders);
    }

    if (url.pathname === '/api/gateway-defective-slots') {
      return handleGatewayDefectiveSlots(request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/run/')) {
      const workerName = url.pathname.replace('/api/run/', '');
      return handleRunWorker(request, env, workerName, corsHeaders);
    }

    if (url.pathname === '/api/rotate-sim') {
      return handleRotateSim(request, env, corsHeaders);
    }

    if (url.pathname === '/api/cancel') {
      return handleCancelSims(request, env, corsHeaders);
    }

    if (url.pathname === '/api/suspend') {
      return handleSuspendSims(request, env, corsHeaders);
    }

    if (url.pathname === '/api/restore') {
      return handleRestoreSims(request, env, corsHeaders);
    }

    if (url.pathname === '/api/activate') {
      return handleActivateSims(request, env, corsHeaders);
    }

    if (url.pathname === '/api/sim-online') {
      return handleSimOnline(request, env, corsHeaders);
    }

    if (url.pathname === '/api/wing-check') {
      return handleWingCheck(request, env, corsHeaders);
    }

    if (url.pathname === '/api/helix-query') {
      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});
      return handleHelixQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {
      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});
      return handleHelixQueryBulk(request, env, corsHeaders);
    }

    if (url.pathname === '/api/send-test-sms') {
      return handleSendTestSms(request, env, corsHeaders);
    }

    if (url.pathname === '/api/bulk-send-test-sms' && request.method === 'POST') {
      return handleBulkSendTestSms(request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/skyline/')) {
      return handleSkylineProxy(request, env, url, corsHeaders);
    }

    if (url.pathname.startsWith('/api/kasa/')) {
      return handleKasaProxy(request, env, url, corsHeaders);
    }

    if (url.pathname === '/api/fix-sim') {
      return handleFixSim(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-pool') {
      if (request.method === 'GET') return handleImeiPoolGet(env, corsHeaders);
      if (request.method === 'POST') return handleImeiPoolPost(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-pool/pick' && request.method === 'GET') {
      return handleImeiPoolPick(env, corsHeaders);
    }

    if (url.pathname === '/api/import-gateway-imeis' && request.method === 'POST') {
      return handleImportGatewayImeis(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-pool/fix-slot' && request.method === 'POST') {
      return handleImeiPoolFixSlot(request, env, corsHeaders);
    }

    if (url.pathname === '/api/check-imei' && request.method === 'GET') {
      return handleCheckImei(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/check-imeis' && request.method === 'POST') {
      return handleCheckImeis(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-pool/fix-incompatible' && request.method === 'POST') {
      return handleFixIncompatibleImei(request, env, corsHeaders);
    }

    if (url.pathname === '/api/errors') {
      return handleErrors(env, corsHeaders, url);
    }

    if (url.pathname === '/api/bad-rentals') {
      return handleBadRentals(env, corsHeaders, url);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/update') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/update'.length));
      return handleUpdateBadRental(id, request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/resolve') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/resolve'.length));
      return handleResolveBadRental(id, request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/report') && request.method === 'GET') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/report'.length));
      return handleBadRentalReport(id, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/pause-auto') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/pause-auto'.length));
      return handleBadRentalAutoLock(id, 'operator_locked', request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/resume-auto') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/resume-auto'.length));
      return handleBadRentalAutoLock(id, null, request, env, corsHeaders);
    }

    if (url.pathname === '/api/remediator/status' && request.method === 'GET') {
      return handleRemediatorStatus(env, corsHeaders);
    }

    if (url.pathname === '/api/remediator/run-now' && request.method === 'POST') {
      return handleRemediatorRunNow(request, env, corsHeaders);
    }

    if (url.pathname === '/api/remediator/kill-switch' && request.method === 'POST') {
      return handleRemediatorKillSwitch(request, env, corsHeaders);
    }

    if (url.pathname === '/api/error-logs') {
      return handleErrorLogs(env, corsHeaders, url);
    }

    if (url.pathname === '/api/log-error' && request.method === 'POST') {
      return handleLogError(request, env, corsHeaders);
    }

    if (url.pathname === '/api/resolve-error' && request.method === 'POST') {
      return handleResolveError(request, env, corsHeaders);
    }

    if (url.pathname === '/api/unassign-reseller' && request.method === 'POST') {
      return handleUnassignReseller(request, env, corsHeaders);
    }

    if (url.pathname === '/api/set-rotation-eligible' && request.method === 'POST') {
      return handleSetRotationEligible(request, env, corsHeaders);
    }

    if (url.pathname === '/api/assign-reseller' && request.method === 'POST') {
      return handleAssignReseller(request, env, corsHeaders);
    }

    if (url.pathname === '/api/set-sim-status' && request.method === 'POST') {
      return handleSetSimStatus(request, env, corsHeaders);
    }

    if (url.pathname === '/api/reset-to-provisioning' && request.method === 'POST') {
      return handleResetToProvisioning(request, env, corsHeaders);
    }

    if (url.pathname === '/api/sim-action' && request.method === 'POST') {
      return handleSimAction(request, env, corsHeaders);
    }

    if (url.pathname === '/api/sim-webhooks') {
      return handleSimWebhooks(env, corsHeaders, url);
    }

    if (url.pathname === '/api/imei-sweep' && request.method === 'POST') {
      return handleImeiSweep(env, corsHeaders);
    }

    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {
      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});
      return handleTriggerBlimeiSweep(env, corsHeaders);
    }

    if (url.pathname === '/api/import-teltik' && request.method === 'POST') {
      // INC-10: walk the Teltik line list in chunks. The worker enforces the
      // page size; we loop until has_more=false so a single button click drains
      // a 1500+ line activation batch without tripping Cloudflare's
      // 1000-subrequest cap inside any one Worker invocation.
      const CHUNK = 200;
      const MAX_CHUNKS = 50; // safety stop = 10k SIMs
      let offset = 0;
      let totals = { imported: 0, updated: 0, unchanged: 0, skipped: 0, processed: 0 };
      let chunks = 0;
      let total = null;
      let lastChunk = null;
      while (chunks < MAX_CHUNKS) {
        const res = await env.TELTIK_WORKER.fetch(
          new Request(`https://teltik-worker/import?secret=${env.ADMIN_RUN_SECRET}&offset=${offset}&limit=${CHUNK}`, { method: 'POST' })
        );
        const text = await res.text();
        let chunk;
        try { chunk = JSON.parse(text); } catch {
          return new Response(JSON.stringify({ ok: false, error: 'worker returned non-JSON', body: text, chunks }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!res.ok || chunk.ok === false) {
          return new Response(JSON.stringify({ ok: false, error: chunk.error || `worker ${res.status}`, chunks, totals, last: chunk }),
            { status: res.status || 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        lastChunk = chunk;
        total = chunk.total ?? total;
        totals.imported += chunk.imported || 0;
        totals.updated += chunk.updated || 0;
        totals.unchanged += chunk.unchanged || 0;
        totals.skipped += chunk.skipped || 0;
        totals.processed += chunk.processed || 0;
        chunks++;
        if (!chunk.has_more || chunk.next_offset == null) break;
        offset = chunk.next_offset;
      }
      const truncated = chunks >= MAX_CHUNKS && lastChunk && lastChunk.has_more;
      return new Response(JSON.stringify({ ok: true, total, chunks, truncated, ...totals }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/teltik-reconcile' && request.method === 'POST') {
      const res = await env.TELTIK_WORKER.fetch(
        new Request('https://teltik-worker/reconcile?secret=' + env.ADMIN_RUN_SECRET, { method: 'POST' })
      );
      return new Response(await res.text(), { status: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/sync-gateway-slots' && request.method === 'POST') {
      return handleSyncGatewaySlots(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-gateway-sync' && request.method === 'POST') {
      return handleImeiGatewaySync(request, env, corsHeaders);
    }

    if (url.pathname === '/api/qbo-mappings' && request.method === 'GET') {
      return handleQboMappingsGet(env, corsHeaders);
    }

    if (url.pathname === '/api/qbo-mappings' && request.method === 'POST') {
      return handleQboMappingsPost(request, env, corsHeaders);
    }

    if (url.pathname === '/api/qbo-mappings' && request.method === 'DELETE') {
      return handleQboMappingsDelete(url, env, corsHeaders);
    }

    if (url.pathname === '/api/qbo-invoices') {
      return handleQboInvoicesGet(env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/qbo-invoices/') && request.method === 'PATCH') {
      return handleQboInvoicePatch(request, env, corsHeaders, url);
    }

    if (url.pathname === '/api/reseller-keys' && request.method === 'GET') {
      return handleResellerKeysList(url, env, corsHeaders);
    }
    if (url.pathname === '/api/reseller-keys' && request.method === 'POST') {
      return handleResellerKeysCreate(request, env, corsHeaders);
    }
    if (url.pathname === '/api/reseller-keys/revoke' && request.method === 'POST') {
      return handleResellerKeysRevoke(request, env, corsHeaders);
    }

    if (url.pathname === '/api/reseller-credentials' && request.method === 'GET') {
      return handleResellerCredentialsList(env, corsHeaders);
    }

    if (url.pathname === '/api/reseller-credentials' && request.method === 'POST') {
      return handleResellerCredentials(request, env, corsHeaders);
    }

    if (url.pathname === '/api/billing/preview') {
      return handleBillingPreview(url, env, corsHeaders);
    }

    if (url.pathname === '/api/utilization') {
      return handleUtilization(url, env, corsHeaders);
    }

    if (url.pathname === '/api/billing/download-invoice') {
      return handleBillingDownloadInvoice(url, env, corsHeaders);
    }

    if (url.pathname === '/api/billing/create-invoice' && request.method === 'POST') {
      return handleBillingCreateInvoice(request, env, corsHeaders);
    }

    if (url.pathname === '/api/bill-audit/upload' && request.method === 'POST') {
      return handleBillAuditUpload(request, env, corsHeaders);
    }
    if (url.pathname === '/api/bill-audit/results') {
      return handleBillAuditResults(env, corsHeaders, url);
    }
    if (url.pathname === '/api/bill-audit/uploads' && request.method === 'DELETE') {
      return handleBillAuditDelete(env, corsHeaders, url);
    }
    if (url.pathname === '/api/bill-audit/uploads') {
      return handleBillAuditUploads(env, corsHeaders);
    }
    if (url.pathname === '/api/bill-audit/export') {
      return handleBillAuditExport(env, corsHeaders, url);
    }
    if (url.pathname === '/api/bill-audit/recompute' && request.method === 'POST') {
      return handleBillAuditRecompute(env, corsHeaders, url);
    }
    if (url.pathname === '/api/bill-audit/backfill-cancel-dates' && request.method === 'POST') {
      return handleBackfillCancelDates(env, corsHeaders);
    }

    if (url.pathname === '/api/plan-rates' && request.method === 'GET') {
      return handlePlanRatesList(env, corsHeaders);
    }
    if (url.pathname === '/api/plan-rates' && request.method === 'POST') {
      return handlePlanRatesCreate(request, env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/plan-rates/') && request.method === 'PATCH') {
      return handlePlanRatesUpdate(request, env, corsHeaders, url);
    }
    if (url.pathname.startsWith('/api/plan-rates/') && request.method === 'DELETE') {
      return handlePlanRatesDelete(env, corsHeaders, url);
    }

    if (url.pathname === '/api/reseller-rates' && request.method === 'GET') {
      return handleResellerRatesList(env, corsHeaders, url);
    }
    if (url.pathname === '/api/reseller-rates' && request.method === 'POST') {
      return handleResellerRatesCreate(request, env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/reseller-rates/') && request.method === 'PATCH') {
      return handleResellerRatesUpdate(request, env, corsHeaders, url);
    }
    if (url.pathname.startsWith('/api/reseller-rates/') && request.method === 'DELETE') {
      return handleResellerRatesDelete(env, corsHeaders, url);
    }

    if (url.pathname === '/api/billing-ledger' && request.method === 'GET') {
      return handleBillingLedgerList(env, corsHeaders, url);
    }
    if (url.pathname === '/api/billing-ledger/months' && request.method === 'GET') {
      return handleBillingLedgerMonths(env, corsHeaders);
    }
    if (url.pathname === '/api/billing-ledger/summary' && request.method === 'GET') {
      return handleBillingLedgerSummary(env, corsHeaders, url);
    }
    if (url.pathname === '/api/billing-ledger/regenerate' && request.method === 'POST') {
      return handleBillingLedgerRegenerate(request, env, corsHeaders, url);
    }
    if (url.pathname === '/api/billing-ledger/reconcile' && request.method === 'POST') {
      return handleBillingLedgerReconcile(request, env, corsHeaders, url);
    }

    // Debug endpoint to test worker-to-worker connectivity via service binding
    if (url.pathname === '/api/debug-cancel') {
      try {
        const hasBinding = !!env.SIM_CANCELLER;
        if (!hasBinding) {
          return new Response(JSON.stringify({
            error: 'SIM_CANCELLER service binding not configured',
            hasSecret: !!env.CANCEL_SECRET
          }, null, 2), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        const testUrl = 'https://sim-canceller/';
        console.log(`[Debug] Testing service binding fetch`);
        const testResponse = await env.SIM_CANCELLER.fetch(testUrl);
        const testText = await testResponse.text();
        return new Response(JSON.stringify({
          method: 'service binding',
          status: testResponse.status,
          body: testText.slice(0, 500),
          hasSecret: !!env.CANCEL_SECRET,
          secretLength: env.CANCEL_SECRET?.length || 0
        }, null, 2), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    if (url.pathname === '/api/delete-sim' && request.method === 'POST') {
      return handleDeleteSim(request, env, corsHeaders);
    }

    if (url.pathname === '/api/api-tester/presets' && request.method === 'GET') {
      return handleApiTesterPresetsList(corsHeaders);
    }

    if (url.pathname === '/api/api-tester/run' && request.method === 'POST') {
      return handleApiTesterRun(request, env, corsHeaders);
    }

    if (url.pathname === '/api/relay-test' && request.method === 'POST') {
      return handleRelayTest(request, env, corsHeaders);
    }

    if (url.pathname === '/api/atomic-query' && request.method === 'POST') {
      return handleAtomicQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/teltik-query' && request.method === 'POST') {
      return handleTeltikQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/rotation-audit' && request.method === 'GET') {
      return handleRotationAudit(request, env, corsHeaders);
    }

    if (url.pathname === '/api/rotation-audit/run' && request.method === 'POST') {
      return handleRotationAuditRun(request, env, corsHeaders);
    }

    if (url.pathname === '/api/rotation-reviews' && request.method === 'GET') {
      return handleRotationReviewsList(request, env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/rotation-reviews/') && request.method === 'GET') {
      const runId = url.pathname.slice('/api/rotation-reviews/'.length);
      return handleRotationReviewGet(runId, env, corsHeaders);
    }
    if (url.pathname === '/api/rotation-review/run' && request.method === 'POST') {
      return handleRotationReviewRun(request, env, corsHeaders);
    }
    if (url.pathname === '/api/pending-items' && request.method === 'GET') {
      return handlePendingItemsList(request, env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/pending-items/') && url.pathname.endsWith('/respond') && request.method === 'POST') {
      const id = url.pathname.slice('/api/pending-items/'.length, -('/respond'.length));
      return handlePendingItemRespond(id, request, env, corsHeaders);
    }
    if (url.pathname === '/api/operator-question' && request.method === 'POST') {
      return handleOperatorQuestion(request, env, corsHeaders);
    }

    // Static assets (css/js/img split out of index.html live under /static/)
    if (url.pathname.startsWith('/static/')) {
      return env.ASSETS.fetch(request);
    }
    // Serve HTML dashboard for all non-API paths (SPA routing)
    return serveApp(env);
  },
};

function checkAuth(authHeader, env) {
  if (!env.DASHBOARD_AUTH) return true; // No auth configured

  const [scheme, credentials] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;

  const decoded = atob(credentials);
  return decoded === env.DASHBOARD_AUTH; // Format: "username:password"
}

// Normalize an MDN to the exact format Teltik expects for /v1/reset-port and
// /v1/port-status: 10 digit US, no country code, no '+'. Anything else (E.164,
// "+1XXXXXXXXXX", "13044123064", "(304) 412-3064") collapses to the 10-digit
// subscriber number. Non-US 11+ digit inputs that do not start with '1' are
// returned digits-only and left to Teltik to reject explicitly.
function toTeltik10Digit(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(env.RELAY_URL + '/' + url, {
      ...init,
      headers: { ...(init && init.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

// ── API Tester: shared Helix token (in-memory, single-flight) ───────────────
let __hxTokenCache = { token: null, expiresAt: 0, inflight: null };
async function getHelixToken(env, opts) {
  const force = opts && opts.force;
  const now = Date.now();
  if (!force && __hxTokenCache.token && __hxTokenCache.expiresAt > now + 30_000) return __hxTokenCache.token;
  if (__hxTokenCache.inflight && !force) return __hxTokenCache.inflight;
  __hxTokenCache.inflight = (async () => {
    const res = await relayFetch(env, env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    if (!res.ok || !parsed || !parsed.access_token) {
      __hxTokenCache.inflight = null;
      throw new Error('Helix token fetch failed: ' + res.status + ' ' + text.slice(0, 200));
    }
    const ttl = (parsed.expires_in ? Number(parsed.expires_in) : 3600) * 1000;
    __hxTokenCache = { token: parsed.access_token, expiresAt: Date.now() + ttl, inflight: null };
    return parsed.access_token;
  })();
  try { return await __hxTokenCache.inflight; }
  finally { if (__hxTokenCache.inflight) __hxTokenCache.inflight = null; }
}

// ── API Tester: redaction allow-list ──────────────────────────────────────
const REDACTED_HEADER_KEYS = ['authorization', 'x-relay-key'];
const REDACTED_BODY_FIELDS = new Set(['userName', 'token', 'pin', 'password']);
function redactHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => {
    out[k] = REDACTED_HEADER_KEYS.includes(k.toLowerCase()) ? '[REDACTED]' : h[k];
  });
  return out;
}
function redactBody(b) {
  if (b == null) return b;
  if (typeof b === 'string') {
    return b.replace(/(password=)[^&]+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(b)) return b.map(redactBody);
  if (typeof b === 'object') {
    const out = {};
    Object.keys(b).forEach((k) => {
      out[k] = REDACTED_BODY_FIELDS.has(k) ? '[REDACTED]' : redactBody(b[k]);
    });
    return out;
  }
  return b;
}
function redactUrl(u) {
  try { return String(u).replace(/(password=)[^&#]+/gi, '$1[REDACTED]'); }
  catch { return u; }
}

function handleApiTesterPresetsList(corsHeaders) {
  return new Response(JSON.stringify(listPresetsForClient()), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleApiTesterRun(request, env, corsHeaders) {
  const respond = (status, payload) => new Response(JSON.stringify(payload), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
  let body;
  try { body = await request.json(); } catch { return respond(400, { ok: false, error: 'invalid JSON' }); }
  const presetKey = body && body.presetKey;
  const inputs = (body && body.inputs) || {};
  const preset = presetKey && API_TESTER_PRESETS_REGISTRY[presetKey];
  if (!preset) return respond(400, { ok: false, error: 'unknown preset: ' + presetKey });

  const missing = (preset.inputs || []).filter((i) => i.required && (inputs[i.name] === undefined || inputs[i.name] === null || inputs[i.name] === ''));
  if (missing.length) return respond(400, { ok: false, error: 'missing required inputs: ' + missing.map((m) => m.name).join(', ') });

  let gateway = null;
  if ((preset.inputs || []).some((i) => i.source === 'gateways')) {
    const gid = inputs.gateway_id;
    if (!gid) return respond(400, { ok: false, error: 'gateway_id is required' });
    try {
      const gres = await supabaseGet(env, 'gateways?select=id,code,name,host,api_port,username,password,active&id=eq.' + encodeURIComponent(gid) + '&active=eq.true&limit=1');
      const rows = await gres.json();
      gateway = rows && rows[0];
    } catch (e) { return respond(500, { ok: false, error: 'gateway lookup failed: ' + String(e) }); }
    if (!gateway) return respond(400, { ok: false, error: 'gateway not found or inactive' });
  }

  const runOnce = async (helixToken) => {
    const built = preset.build({ env, inputs, gateway, helixToken });
    const init = { method: built.method, headers: built.headers || {} };
    if (built.body !== null && built.body !== undefined && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(built.method.toUpperCase())) {
      init.body = typeof built.body === 'string' ? built.body : JSON.stringify(built.body);
    }
    const resp = await relayFetch(env, built.url, init);
    const respText = await resp.text();
    const respHeaders = {}; resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { built, init, status: resp.status, headers: respHeaders, bodyText: respText };
  };

  try {
    let helixToken = null;
    if (preset.needsHelixToken) helixToken = await getHelixToken(env);
    let result = await runOnce(helixToken);
    if (preset.needsHelixToken && result.status === 401) {
      helixToken = await getHelixToken(env, { force: true });
      result = await runOnce(helixToken);
    }
    return respond(200, {
      ok: true,
      status: result.status,
      headers: result.headers,
      body: result.bodyText,
      request: {
        method: result.built.method,
        url: redactUrl(result.built.url),
        redactedHeaders: redactHeaders(result.built.headers || {}),
        body: redactBody(result.built.body == null ? null : (typeof result.built.body === 'string' ? result.built.body : JSON.parse(JSON.stringify(result.built.body)))),
      },
    });
  } catch (err) {
    return respond(200, { ok: false, error: String((err && err.message) || err) });
  }
}


async function handleStats(env, corsHeaders) {
  try {
    const base = env.SUPABASE_URL + '/rest/v1/';
    const authHeaders = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json',
      Prefer: 'count=exact',
    };

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Notification freshness — broadcastable SIMs (active + rs.active=true,
    // excluding wing_iot ABIR-stuck) split by per-vendor notification window.
    const cutoff24hISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoff48hISO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const broadcastBase = (vendor) => 'sims?select=id,reseller_sims!inner(active)&status=eq.active&vendor=eq.' + vendor + '&reseller_sims.active=eq.true&limit=1';
    const wingBroadcastSuffix = '&or=(rotation_status.is.null,rotation_status.neq.failed)';

    const [totalRes, activeRes, provRes, msgRes, suspRes, errRes, atmRes, telRes, wingRes, helRes] = await Promise.all([
      fetch(base + 'sims?select=id&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.active&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.provisioning&limit=1', { headers: authHeaders }),
      fetch(base + 'inbound_sms?select=id&received_at=gte.' + yesterday + '&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.suspended&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&status=eq.error&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.atomic&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.teltik&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.wing_iot&status=neq.canceled&limit=1', { headers: authHeaders }),
      fetch(base + 'sims?select=id&vendor=eq.helix&status=neq.canceled&limit=1', { headers: authHeaders }),
    ]);

    // Rotation freshness via RPC — see public.rotation_freshness().
    // Counts client-assigned SIMs (any active reseller link, any sim status) whose
    // CURRENT number has a client-confirmed rotation (number.online delivered with a
    // rentalId) within the carrier window (att 24h / tmobile 48h).
    let freshByVendor = {};
    try {
      const freshRes = await fetch(base + 'rpc/rotation_freshness', {
        method: 'POST',
        headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json' }),
        body: '{}',
      });
      if (freshRes.ok) {
        const freshRows = await freshRes.json();
        for (const r of (Array.isArray(freshRows) ? freshRows : [])) {
          freshByVendor[r.vendor] = { total: Number(r.total) || 0, fresh: Number(r.fresh) || 0, window_hours: Number(r.window_hours) || 24 };
        }
      }
    } catch (e) { /* leave freshByVendor empty on RPC error */ }

    const getCount = res => {
      const cr = res.headers.get('content-range') || '';
      return parseInt(cr.split('/')[1] || '0', 10);
    };

    const stats = {
      total_sims: getCount(totalRes),
      active_sims: getCount(activeRes),
      provisioning_sims: getCount(provRes),
      messages_24h: getCount(msgRes),
      suspended_sims: getCount(suspRes),
      error_sims: getCount(errRes),
      vendor_atomic: getCount(atmRes),
      vendor_teltik: getCount(telRes),
      vendor_wing_iot: getCount(wingRes),
      vendor_helix: getCount(helRes),
      freshness: freshByVendor,
    };

    return new Response(JSON.stringify(stats), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Billing cycle + EST date helpers for SMS usage analytics.
// Soft-coded anchor day — change here when real Wing billing cycle date is confirmed.
const BILLING_CYCLE_ANCHOR_DAY = 5;

function currentCycleStartEst(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  let y = parseInt(parts.year, 10);
  let m = parseInt(parts.month, 10);
  const d = parseInt(parts.day, 10);
  if (d < BILLING_CYCLE_ANCHOR_DAY) {
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return y + '-' + String(m).padStart(2, '0') + '-' + String(BILLING_CYCLE_ANCHOR_DAY).padStart(2, '0');
}

function todayEst(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

function estDateFromDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
}

function nextEstDate(yyyyMmDd) {
  const t = new Date(yyyyMmDd + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return estDateFromDate(t);
}

async function handleSmsUsage(env, corsHeaders, url) {
  try {
    const noCache = url && url.searchParams && url.searchParams.has('nocache');
    const cacheKey = new Request('https://cache.local/sms-usage');
    if (!noCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    const body = {
      p_cycle_start: currentCycleStartEst(),
      p_today: todayEst(),
      p_trend_days: 30,
    };

    const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/get_sms_usage_summary', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: 'rpc_failed', status: r.status, detail: txt }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await r.json();
    const resp = new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60',
      },
    });
    if (!noCache) await caches.default.put(cacheKey, resp.clone());
    return resp;
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleSims(env, corsHeaders, url) {
  try {
    // Parse filter params
    const statusFilter = url.searchParams.get('status');
    const resellerFilter = url.searchParams.get('reseller_id');
    const hideCancelled = url.searchParams.get('hide_cancelled') !== 'false';

    // Build query with reseller and gateway info
    let query = `sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,rotation_eligible,mobility_subscription_id,gateway_id,last_mdn_rotated_at,last_rotation_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc`;

    // Apply status filter
    if (statusFilter) {
      query += `&status=eq.${statusFilter}`;
    } else if (hideCancelled) {
      query += `&status=neq.canceled`;
    }

    const sims = await supabaseGetAllArray(env, query);

    // Filter by reseller if specified (done client-side since nested filter is complex)
    let filteredSims = sims;
    if (resellerFilter) {
      const resellerId = parseInt(resellerFilter);
      filteredSims = sims.filter(sim =>
        sim.reseller_sims?.some(rs => rs.reseller_id === resellerId)
      );
    }

    // Get SMS stats via DB-side aggregation, chunked into batches of 500
    // sim_ids per RPC call. PostgREST caps response rows at 1000, so a single
    // call with all sim_ids silently truncates once >1000 SIMs have messages.
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const CHUNK = 500;
      const chunks = [];
      for (let i = 0; i < simIds.length; i += CHUNK) chunks.push(simIds.slice(i, i + CHUNK));
      const smsUrl = env.SUPABASE_URL + '/rest/v1/rpc/get_sms_counts_24h';
      const rpcHeaders = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      const responses = await Promise.all(chunks.map(chunk =>
        fetch(smsUrl, {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({ sim_ids: chunk }),
        }).then(r => r.json())
      ));
      for (const rows of responses) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
        }
      }
    }

    const formatted = filteredSims.map(sim => {
      const smsStat = smsMap[sim.id] || { count: 0, last_received: null };

      // Extract reseller info
      const resellerSim = sim.reseller_sims?.[0];
      const resellerId = resellerSim?.reseller_id || null;
      const resellerName = resellerSim?.resellers?.name || null;

      return {
        id: sim.id,
        iccid: sim.iccid,
        port: sim.port,
        status: sim.status,
        mobility_subscription_id: sim.mobility_subscription_id,
        phone_number: sim.sim_numbers?.[0]?.e164 || null,
        verification_status: sim.sim_numbers?.[0]?.verification_status || null,
        sms_count: smsStat.count,
        last_sms_received: smsStat.last_received,
        reseller_id: resellerId,
        reseller_name: resellerName,
        gateway_id: sim.gateway_id,
        gateway_code: sim.gateways?.code || null,
        gateway_name: sim.gateways?.name || null,
        last_mdn_rotated_at: sim.last_mdn_rotated_at || null,
        last_rotation_at: sim.last_rotation_at || null,
        activated_at: sim.activated_at || null,
        last_activation_error: sim.last_activation_error || null,
        last_notified_at: sim.last_notified_at || null,
        vendor: sim.vendor || 'unknown',
        carrier: sim.carrier || null,
        rotation_interval_hours: sim.rotation_interval_hours || 24,
        rotation_eligible: sim.rotation_eligible !== false,
      };
    });

    return new Response(JSON.stringify(formatted), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleMessages(env, corsHeaders, url) {
  try {
    const baseSelect = 'select=id,to_number,from_number,body,received_at,sim_id,sims(iccid)';
    const search = ((url && url.searchParams && url.searchParams.get('search')) || '').trim();

    let queryPath;
    if (!search) {
      queryPath = `inbound_sms?${baseSelect}&order=received_at.desc&limit=500`;
    } else {
      const terms = search.split(/[,;\r\n]+/)
        .map(t => t.replace(/[^a-zA-Z0-9\s+\-]/g, '').trim())
        .filter(Boolean)
        .slice(0, 10);
      if (!terms.length) {
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const predicates = [];
      const simIds = new Set();
      for (const t of terms) {
        const enc = encodeURIComponent(`*${t}*`);
        predicates.push(`body.ilike.${enc}`);
        predicates.push(`from_number.ilike.${enc}`);
        predicates.push(`to_number.ilike.${enc}`);
        const digits = t.replace(/\D/g, '');
        if (digits && digits !== t) {
          const encD = encodeURIComponent(`*${digits}*`);
          predicates.push(`from_number.ilike.${encD}`);
          predicates.push(`to_number.ilike.${encD}`);
        }
        if (digits && digits.length >= 4) {
          try {
            const simResp = await supabaseGet(env, `sims?select=id&iccid=ilike.${encodeURIComponent('*' + digits + '*')}&limit=200`);
            if (simResp.ok) {
              const sims = await simResp.json();
              if (Array.isArray(sims)) for (const s of sims) simIds.add(s.id);
            }
          } catch (_) { /* ignore — fall back to text search */ }
        }
      }
      if (simIds.size) {
        predicates.push(`sim_id.in.(${[...simIds].join(',')})`);
      }
      queryPath = `inbound_sms?${baseSelect}&or=(${predicates.join(',')})&order=received_at.desc&limit=2000`;
    }

    const response = await supabaseGet(env, queryPath);
    const messages = await response.json();
    if (!response.ok || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'messages_query_failed', detail: messages }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const formatted = messages.map(msg => ({
      id: msg.id,
      to_number: msg.to_number,
      from_number: msg.from_number,
      body: msg.body,
      received_at: msg.received_at,
      sim_id: msg.sim_id,
      iccid: msg.sims?.iccid || null
    }));

    return new Response(JSON.stringify(formatted), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRotateSim(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const iccids = body.iccids || [];

    if (!Array.isArray(iccids) || iccids.length === 0) {
      return new Response(JSON.stringify({ error: 'iccids array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.MDN_ROTATOR) {
      return new Response(JSON.stringify({ error: 'MDN_ROTATOR service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.ADMIN_RUN_SECRET) {
      return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const results = [];
    for (const iccid of iccids) {
      const trimmed = iccid.trim();
      if (!trimmed) continue;

      try {
        const workerUrl = `https://worker/rotate-sim?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(trimmed)}`;
        const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl);
        const responseText = await workerResponse.text();
        let result;
        try {
          result = JSON.parse(responseText);
        } catch {
          result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
        }
        results.push({ iccid: trimmed, ...result });
      } catch (err) {
        results.push({ iccid: trimmed, ok: false, error: String(err) });
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRunWorker(request, env, workerName, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const limit = body.limit || null;
    const force = body.force || false;

    // Worker configs with service bindings
    const workerConfigs = {
      'bulk-activator': {
        binding: env.BULK_ACTIVATOR,
        secret: env.BULK_RUN_SECRET
      },
      'details-finalizer': {
        binding: env.DETAILS_FINALIZER,
        secret: env.FINALIZER_RUN_SECRET
      },
      'mdn-rotator': {
        binding: env.MDN_ROTATOR,
        secret: env.ADMIN_RUN_SECRET
      },
      'phone-number-sync': {
        binding: env.PHONE_NUMBER_SYNC,
        secret: env.SYNC_SECRET
      },
      'reseller-sync': {
        binding: env.RESELLER_SYNC,
        secret: env.FINALIZER_RUN_SECRET
      }
    };

    const config = workerConfigs[workerName];
    if (!config) {
      return new Response(JSON.stringify({ error: 'Unknown worker' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!config.secret) {
      return new Response(JSON.stringify({ error: `Secret not configured for ${workerName}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!config.binding) {
      return new Response(JSON.stringify({ error: `Service binding not configured for ${workerName}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let workerUrl = limit
      ? 'https://worker/run?secret=' + encodeURIComponent(config.secret) + '&limit=' + limit
      : 'https://worker/run?secret=' + encodeURIComponent(config.secret);
    if (force) workerUrl += '&force=true';

    // Use service binding for worker-to-worker communication
    const workerResponse = await config.binding.fetch(workerUrl);

    // Handle non-JSON responses (e.g., Cloudflare errors)
    const responseText = await workerResponse.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      // Log error to system_errors
      await logSystemError(env, {
        source: 'dashboard',
        action: `run_${workerName}`,
        error_message: `Worker returned non-JSON response (${workerResponse.status}): ${responseText.slice(0, 200)}`,
        error_details: { status: workerResponse.status, body: responseText.slice(0, 1000) }
      });
      return new Response(JSON.stringify({
        error: `Worker returned non-JSON response (${workerResponse.status}): ${responseText.slice(0, 200)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Log worker errors to system_errors
    if (!workerResponse.ok || (result && result.error)) {
      await logSystemError(env, {
        source: workerName,
        action: 'run',
        error_message: result.error || `Worker returned status ${workerResponse.status}`,
        error_details: { request: { url: workerUrl }, response: result, status: workerResponse.status }
      });
    }

    return new Response(JSON.stringify(result), {
      status: workerResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await logSystemError(env, {
      source: 'dashboard',
      action: `run_${workerName}`,
      error_message: String(error),
    });
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleCancelSims(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const iccids = body.iccids || [];

    if (!Array.isArray(iccids) || iccids.length === 0) {
      return new Response(JSON.stringify({ error: 'iccids array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.CANCEL_SECRET) {
      return new Response(JSON.stringify({ error: 'CANCEL_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Dashboard] Calling sim-canceller via service binding`);
    console.log(`[Dashboard] ICCIDs: ${JSON.stringify(iccids)}`);

    let cancelResponse;
    try {
      // Use service binding for worker-to-worker communication
      cancelResponse = await env.SIM_CANCELLER.fetch(
        `https://sim-canceller/cancel?secret=${encodeURIComponent(env.CANCEL_SECRET)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ iccids })
        }
      );
    } catch (fetchError) {
      console.log(`[Dashboard] Fetch error: ${fetchError}`);
      return new Response(JSON.stringify({
        error: `Failed to reach sim-canceller: ${String(fetchError)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Dashboard] Response status: ${cancelResponse.status}`);

    // Handle non-JSON responses (e.g., Cloudflare errors)
    const responseText = await cancelResponse.text();
    console.log(`[Dashboard] Response body: ${responseText.slice(0, 500)}`);

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      // Response is not JSON - likely a Cloudflare error or plain text
      return new Response(JSON.stringify({
        error: `Worker returned non-JSON response (${cancelResponse.status}): ${responseText.slice(0, 200)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(result), {
      status: cancelResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleSuspendSims(request, env, corsHeaders) {
  return handleStatusChange(request, env, corsHeaders, 'suspend');
}

async function handleRestoreSims(request, env, corsHeaders) {
  return handleStatusChange(request, env, corsHeaders, 'restore');
}

async function handleStatusChange(request, env, corsHeaders, action) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const simIds = body.sim_ids || [];

    if (!Array.isArray(simIds) || simIds.length === 0) {
      return new Response(JSON.stringify({ error: 'sim_ids array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.STATUS_SECRET) {
      return new Response(JSON.stringify({ error: 'STATUS_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SIM_STATUS_CHANGER) {
      return new Response(JSON.stringify({ error: 'SIM_STATUS_CHANGER service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Dashboard] Calling sim-status-changer via service binding for ${action}`);
    console.log(`[Dashboard] SIM IDs: ${JSON.stringify(simIds)}`);

    let statusResponse;
    try {
      // Use service binding for worker-to-worker communication
      statusResponse = await env.SIM_STATUS_CHANGER.fetch(
        `https://sim-status-changer/${action}?secret=${encodeURIComponent(env.STATUS_SECRET)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sim_ids: simIds })
        }
      );
    } catch (fetchError) {
      console.log(`[Dashboard] Fetch error: ${fetchError}`);
      return new Response(JSON.stringify({
        error: `Failed to reach sim-status-changer: ${String(fetchError)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[Dashboard] Response status: ${statusResponse.status}`);

    // Handle non-JSON responses
    const responseText = await statusResponse.text();
    console.log(`[Dashboard] Response body: ${responseText.slice(0, 500)}`);

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      return new Response(JSON.stringify({
        error: `Worker returned non-JSON response (${statusResponse.status}): ${responseText.slice(0, 200)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(result), {
      status: statusResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleActivateSims(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const sims = body.sims || [];
    const vendor = body.vendor || 'atomic';

    if (!Array.isArray(sims) || sims.length === 0) {
      return new Response(JSON.stringify({ error: 'sims array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.BULK_RUN_SECRET) {
      return new Response(JSON.stringify({ error: 'BULK_RUN_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Use service binding for worker-to-worker communication
    const activateUrl = `https://bulk-activator/activate?secret=${encodeURIComponent(env.BULK_RUN_SECRET)}`;

    const activateResponse = await env.BULK_ACTIVATOR.fetch(activateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sims, vendor })
    });

    // Handle non-JSON responses (e.g., Cloudflare errors)
    const responseText = await activateResponse.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      return new Response(JSON.stringify({
        error: `Worker returned non-JSON response (${activateResponse.status}): ${responseText.slice(0, 200)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(result), {
      status: activateResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleResellers(env, corsHeaders) {
  try {
    const response = await supabaseGet(env, 'resellers?select=id,name&order=name.asc');
    const resellers = await response.json();
    return new Response(JSON.stringify(resellers), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleKasaProxy(request, env, url, corsHeaders) {
  if (!env.KASA_CONTROL) {
    return new Response(JSON.stringify({error: 'KASA_CONTROL not configured'}), {
      status: 503,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
  const kasaPath = url.pathname.replace('/api/kasa', '');
  const kasaReq = new Request('https://kasa-control.workers.dev' + kasaPath, {
    method: request.method,
    headers: { 'Content-Type': 'application/json' },
    body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
  });
  try {
    const res = await env.KASA_CONTROL.fetch(kasaReq);
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch(err) {
    return new Response(JSON.stringify({error: String(err)}), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleGateways(request, env, corsHeaders) {
  const url = new URL(request.url);
  const idParam = url.searchParams.get('id');

  if (request.method === 'GET') {
    try {
      const response = await supabaseGet(env, 'gateways?select=id,mac_address,code,name,location,host,api_port,username,password,total_ports,slots_per_port,active&order=code.asc');
      const gateways = await response.json();
      return new Response(JSON.stringify(gateways), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { mac_address, code, name, location, host, api_port, username, password, total_ports, slots_per_port, active } = body;

      if (!mac_address || !code) {
        return new Response(JSON.stringify({ error: 'mac_address and code are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/gateways`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          mac_address,
          code,
          name: name || null,
          location: location || null,
          host: host || null,
          api_port: api_port || 80,
          username: username || null,
          password: password || null,
          total_ports: total_ports || 64,
          slots_per_port: slots_per_port || 1,
          active: active !== false,
        }),
      });

      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return new Response(JSON.stringify({ error: `Failed to create gateway: ${errText}` }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const created = await insertRes.json();
      return new Response(JSON.stringify({ ok: true, gateway: created[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  if (request.method === 'PATCH') {
    if (!idParam) {
      return new Response(JSON.stringify({ error: 'id query param is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    try {
      const body = await request.json();
      const allowed = ['mac_address','code','name','location','host','api_port','username','password','total_ports','slots_per_port','active'];
      const patch = {};
      for (const k of allowed) {
        if (k in body) patch[k] = body[k];
      }
      if (!Object.keys(patch).length) {
        return new Response(JSON.stringify({ error: 'no editable fields provided' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      patch.updated_at = new Date().toISOString();
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/gateways?id=eq.${encodeURIComponent(idParam)}`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Failed to update gateway: ${errText}` }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const updated = await res.json();
      return new Response(JSON.stringify({ ok: true, gateway: updated[0] || null }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  if (request.method === 'DELETE') {
    if (!idParam) {
      return new Response(JSON.stringify({ error: 'id query param is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/gateways?id=eq.${encodeURIComponent(idParam)}`, {
        method: 'DELETE',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Failed to delete gateway: ${errText}` }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Method not allowed', { status: 405 });
}

async function handleGatewayDefectiveSlots(request, env, corsHeaders) {
  const url = new URL(request.url);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (request.method === 'GET') {
    const gatewayId = url.searchParams.get('gateway_id');
    if (!gatewayId) {
      return new Response(JSON.stringify({ error: 'gateway_id query param is required' }), { status: 400, headers: jsonHeaders });
    }
    try {
      const res = await supabaseGet(env, `gateway_defective_slots?select=id,port_slot,reason,created_at&gateway_id=eq.${encodeURIComponent(gatewayId)}&order=port_slot.asc`);
      const slots = await res.json();
      return new Response(JSON.stringify({ ok: true, slots }), { headers: jsonHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const gatewayId = body.gateway_id;
      const portSlot = normalizeImeiPoolPort(body.port_slot);
      const reason = body.reason || null;
      if (!gatewayId || !portSlot) {
        return new Response(JSON.stringify({ error: 'gateway_id and port_slot are required' }), { status: 400, headers: jsonHeaders });
      }
      const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/gateway_defective_slots?on_conflict=gateway_id,port_slot`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify({ gateway_id: gatewayId, port_slot: portSlot, reason }),
      });
      if (!insertRes.ok) {
        const errText = await insertRes.text();
        return new Response(JSON.stringify({ error: `Failed to mark defective: ${errText}` }), { status: 500, headers: jsonHeaders });
      }
      const rows = await insertRes.json();
      return new Response(JSON.stringify({ ok: true, slot: rows[0] || null }), { headers: jsonHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
    }
  }

  if (request.method === 'DELETE') {
    const gatewayId = url.searchParams.get('gateway_id');
    const portSlot = normalizeImeiPoolPort(url.searchParams.get('port_slot'));
    if (!gatewayId || !portSlot) {
      return new Response(JSON.stringify({ error: 'gateway_id and port_slot are required' }), { status: 400, headers: jsonHeaders });
    }
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/gateway_defective_slots?gateway_id=eq.${encodeURIComponent(gatewayId)}&port_slot=eq.${encodeURIComponent(portSlot)}`, {
        method: 'DELETE',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!res.ok) {
        const errText = await res.text();
        return new Response(JSON.stringify({ error: `Failed to unmark defective: ${errText}` }), { status: 500, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: jsonHeaders });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
    }
  }

  return new Response('Method not allowed', { status: 405 });
}

async function handleSimOnline(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const simId = body.sim_id;

    if (!simId) {
      return new Response(JSON.stringify({ error: 'sim_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Step 1: Get the SIM basic info
    const simResponse = await supabaseGet(env, `sims?select=id,iccid,status,vendor,rotation_status,rotation_interval_hours,last_mdn_rotated_at,last_rotation_at&id=eq.${simId}`);
    const sims = await simResponse.json();

    if (!sims || sims.length === 0) {
      return new Response(JSON.stringify({ error: 'SIM not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sim = sims[0];

    // ABIR guard: never broadcast number.online for a wing_iot SIM that the
    // rotation system has flagged as stuck on the ABIR (non-dialable) plan.
    // Its msisdn is a 5xxx interim MDN that can't receive normal SMS.
    if (sim.vendor === 'wing_iot' && sim.rotation_status === 'failed') {
      return new Response(JSON.stringify({
        ok: false,
        error: 'SIM is stuck on ABIR (non-dialable plan). Force-rotate it first before notifying online.',
        sim_id: simId,
        abir_skipped: true,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Step 2: Get current phone number
    const numberResponse = await supabaseGet(env, `sim_numbers?select=e164,verification_status&sim_id=eq.${simId}&valid_to=is.null&limit=1`);
    const numbers = await numberResponse.json();
    const currentNumber = numbers?.[0]?.e164;
    const verificationStatus = numbers?.[0]?.verification_status;

    // Step 3: Get reseller info
    const resellerSimResponse = await supabaseGet(env, `reseller_sims?select=reseller_id,resellers(name)&sim_id=eq.${simId}&active=eq.true&limit=1`);
    const resellerSims = await resellerSimResponse.json();
    const resellerId = resellerSims?.[0]?.reseller_id;
    const resellerName = resellerSims?.[0]?.resellers?.name;

    // Step 4: Get webhook URL
    let webhookUrl = null;
    if (resellerId) {
      const webhookResponse = await supabaseGet(env, `reseller_webhooks?select=url&reseller_id=eq.${resellerId}&enabled=eq.true&limit=1`);
      const webhooks = await webhookResponse.json();
      webhookUrl = webhooks?.[0]?.url;
    }

    if (!currentNumber) {
      return new Response(JSON.stringify({ error: 'SIM has no current phone number' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!resellerId) {
      return new Response(JSON.stringify({ error: 'SIM has no reseller assigned' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!webhookUrl) {
      return new Response(JSON.stringify({ error: `Reseller "${resellerName || resellerId}" has no webhook configured` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Calculate online_until — midnight NY of the rotation-due date
    const _baseTs = sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at) : new Date();
    const _intervalHours = sim.rotation_interval_hours || (sim.vendor === 'teltik' ? 48 : 24);
    const _intervalDays = Math.ceil(_intervalHours / 24);
    const _nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(_baseTs);
    const [_y, _m, _d] = _nyDate.split('-').map(Number);
    const _probe = new Date(Date.UTC(_y, _m - 1, _d + _intervalDays, 5, 0, 0));
    const _probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(_probe);
    const _tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', timeZoneName: 'shortOffset'
    }).formatToParts(_probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
    const _offsetHours = -parseInt(_tzPart.replace('GMT', '') || '-4');
    const onlineUntil = new Date(`${_probeNyDate}T${String(_offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();

    // Build the webhook payload
    const payload = {
      event_type: "number.online",
      created_at: new Date().toISOString(),
      message_id: `manual_${simId}_${Date.now().toString(36)}`,
      data: {
        sim_id: simId,
        iccid: sim.iccid,
        number: currentNumber,
        status: sim.status,
        online: true,
        online_until: onlineUntil,
        carrier: sim.vendor === 'teltik' ? 'T-Mobile' : 'att',
        verified: verificationStatus === 'verified',
      },
    };

    // Send the webhook
    console.log(`[SimOnline] Sending webhook to ${webhookUrl} for SIM ${simId}`);
    const webhookResponse = await relayFetch(env, webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const webhookStatus = webhookResponse.status;
    const webhookOk = webhookResponse.ok;
    let webhookBody = null;
    try {
      webhookBody = await webhookResponse.text();
    } catch { }

    // Record the webhook delivery
    await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_deliveries`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        message_id: payload.message_id,
        event_type: 'number.online',
        reseller_id: resellerId,
        webhook_url: webhookUrl,
        payload,
        status: webhookOk ? 'delivered' : 'failed',
        attempts: 1,
        last_attempt_at: new Date().toISOString(),
        delivered_at: webhookOk ? new Date().toISOString() : null,
      }),
    });

    // Update last_notified_at on the SIM
    if (webhookOk) {
      await fetch(env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + simId, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ last_notified_at: new Date().toISOString() }),
      });
    }

    if (webhookOk) {
      return new Response(JSON.stringify({
        ok: true,
        message: `Successfully sent number.online webhook for ${currentNumber}`,
        sim_id: simId,
        number: currentNumber,
        reseller: resellerName,
        webhook_status: webhookStatus,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({
        ok: false,
        error: `Webhook failed with status ${webhookStatus}`,
        sim_id: simId,
        number: currentNumber,
        reseller: resellerName,
        webhook_response: webhookBody?.slice(0, 200),
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleWingCheck(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const { iccid } = await request.json();
    if (!iccid) {
      return new Response(JSON.stringify({ error: 'iccid required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const baseUrl = env.WING_IOT_BASE_URL || 'https://restapi19.att.com/rws/api';
    const url = baseUrl + '/v1/devices/' + encodeURIComponent(iccid);
    const auth = 'Basic ' + btoa(env.WING_IOT_USERNAME + ':' + env.WING_IOT_API_KEY);
    const runId = 'wing_check_' + iccid + '_' + Date.now();

    const headers = { Authorization: auth };
    if (env.RELAY_KEY) headers['x-relay-key'] = env.RELAY_KEY;
    const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + url : url;
    const res = await fetch(fetchUrl, {
      method: 'GET',
      headers
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    // Log to carrier_api_logs
    await logCarrierApiCall(env, {
      run_id: runId,
      step: 'query',
      iccid,
      imei: null,
      vendor: 'wing_iot',
      request_url: url,
      request_method: 'GET',
      request_body: null,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: json,
      error: res.ok ? null : 'Wing IoT query failed: ' + res.status,
    });

    let db_update_wing = null;
    let db_skip_reason = null;
    const wingStatus = json && json.status ? json.status.toLowerCase() : '';
    const wingPlan = json && json.communicationPlan ? json.communicationPlan : '';
    const DIALABLE_PLAN = 'Wing Tel Inc - NON ABIR SMS MO/MT US';
    if (res.ok && json && (wingStatus === 'active' || wingStatus === 'activated')) {
      if (wingPlan === DIALABLE_PLAN) {
        db_update_wing = await syncActiveSim(env, iccid, {
          mdn: json.mdn || json.msisdn || null,
          activatedAt: json.dateActivated || null,
        });
      } else {
        // SIM is on ABIR (non-dialable). Flag rotation_status='failed' so the
        // mdn-rotator's remediation pass on the next /run will pick it up and
        // run the dialable PUT (jumps straight to PUT-2 via the "already on
        // ABIR" path in rotateWingIotSim).
        try {
          await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
            rotation_status: 'failed',
            status: 'rotation_failed',
            last_rotation_error: 'Stuck on ABIR plan — flagged by Query at ' + new Date().toISOString(),
          });
          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Marked rotation_status=failed — run mdn-rotator to retry the dialable PUT.';
        } catch (e) {
          db_skip_reason = 'SIM is on plan "' + wingPlan + '" (not dialable). Failed to flag for retry: ' + String(e);
        }
      }
    } else {
      const errMsg = !res.ok
        ? 'Wing query HTTP ' + res.status
        : (!json
            ? 'Wing query: invalid JSON response'
            : 'Wing query: unexpected carrier status "' + wingStatus + '"');
      try {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: errMsg + ' at ' + new Date().toISOString(),
        });
        db_skip_reason = errMsg;
      } catch (_) {}
    }
    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update: db_update_wing,
      db_skip_reason: db_skip_reason,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleHelixQuery(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const subId = body.mobility_subscription_id;

    if (!subId) {
      return new Response(JSON.stringify({ error: 'mobility_subscription_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tokenRes = await relayFetch(env, env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = tokenData.access_token;
    const detailsUrl = env.HX_API_BASE + '/api/mobility-subscriber/details';
    const detailsRes = await relayFetch(env, detailsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ mobilitySubscriptionId: parseInt(subId) }),
    });

    const detailsText = await detailsRes.text();
    let detailsData;
    try {
      detailsData = JSON.parse(detailsText);
    } catch {
      await sbPatch(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId), {
        status: 'error',
        last_rotation_error: 'Helix query: invalid JSON response at ' + new Date().toISOString(),
      }).catch(() => {});
      return new Response(JSON.stringify({ error: 'Invalid JSON from Helix', raw: detailsText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!detailsRes.ok) {
      await sbPatch(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId), {
        status: 'error',
        last_rotation_error: 'Helix query HTTP ' + detailsRes.status + ' at ' + new Date().toISOString(),
      }).catch(() => {});
      return new Response(JSON.stringify({ error: 'Helix API error', status: detailsRes.status, details: detailsData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const data = Array.isArray(detailsData) ? detailsData[0] : detailsData;
    let db_update = null;
    if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
      db_update = await syncCancelledSim(env, String(subId), data);
    }

    // Log to carrier_api_logs
    await logCarrierApiCall(env, {
      run_id: 'helix_query_' + subId + '_' + Date.now(),
      step: 'query',
      iccid: data?.iccid || null,
      imei: data?.imei || null,
      vendor: 'helix',
      request_url: detailsUrl,
      request_method: 'POST',
      request_body: { mobilitySubscriptionId: parseInt(subId) },
      response_status: detailsRes.status,
      response_ok: detailsRes.ok,
      response_body_text: detailsText,
      response_body_json: detailsData,
      error: null,
    });

    return new Response(JSON.stringify({ ok: true, mobility_subscription_id: subId, helix_response: detailsData, db_update }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleTeltikQuery(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const { iccid } = await request.json();
    if (!iccid) {
      return new Response(JSON.stringify({ error: 'iccid required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const apiKey = env.TELTIK_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'TELTIK_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const teltikUrl = 'https://api.smsgateway.xyz/v1/get-phone-number/?apikey=' + encodeURIComponent(apiKey) + '&iccid=' + encodeURIComponent(iccid);
    const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + teltikUrl : teltikUrl;
    const fetchHeaders = {};
    if (env.RELAY_KEY) fetchHeaders['x-relay-key'] = env.RELAY_KEY;
    const res = await fetch(fetchUrl, { method: 'GET', headers: fetchHeaders });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    await logCarrierApiCall(env, {
      run_id: 'teltik_query_' + iccid + '_' + Date.now(),
      step: 'query',
      iccid,
      imei: null,
      vendor: 'teltik',
      request_url: 'https://api.smsgateway.xyz/v1/get-phone-number/?iccid=' + encodeURIComponent(iccid),
      request_method: 'GET',
      request_body: null,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: json,
      error: res.ok ? null : 'Teltik query failed: ' + res.status,
    });

    let db_update = null;
    let resolvedMdn = null;
    if (res.ok && json) {
      const rawMdn = json.msisdn || json.mdn || json.phone_number || '';
      if (rawMdn) {
        resolvedMdn = rawMdn;
        db_update = await syncActiveSim(env, iccid, { mdn: rawMdn, activatedAt: null });
      } else {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: 'Teltik query: no MDN in response at ' + new Date().toISOString(),
        }).catch(() => {});
      }
    } else {
      const errMsg = !res.ok
        ? 'Teltik query HTTP ' + res.status
        : 'Teltik query: invalid JSON response';
      await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
        status: 'error',
        last_rotation_error: errMsg + ' at ' + new Date().toISOString(),
      }).catch(() => {});
    }

    // Operator UI expects Query to also surface /v1/port-status so an offline port is
    // visible. Only attempt when we resolved an MDN; failure here is non-fatal — the
    // MDN result still gets returned.
    let port_status = null;
    if (resolvedMdn) {
      // Teltik /v1/port-status uses the same MDN format as /reset-port: 10 digits, US.
      const mdnDigits = toTeltik10Digit(resolvedMdn);
      try {
        const psUrl = 'https://api.smsgateway.xyz/v1/port-status?apikey=' + encodeURIComponent(apiKey) + '&mdn=' + encodeURIComponent(mdnDigits);
        const psFetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + psUrl : psUrl;
        const psHeaders = {};
        if (env.RELAY_KEY) psHeaders['x-relay-key'] = env.RELAY_KEY;
        const psRes = await fetch(psFetchUrl, { method: 'GET', headers: psHeaders });
        const psText = await psRes.text();
        let psJson = null; try { psJson = JSON.parse(psText); } catch {}
        await logCarrierApiCall(env, {
          run_id: 'teltik_port_status_' + iccid + '_' + Date.now(),
          step: 'port_status',
          iccid,
          imei: null,
          vendor: 'teltik',
          request_url: 'https://api.smsgateway.xyz/v1/port-status?mdn=' + encodeURIComponent(mdnDigits),
          request_method: 'GET',
          request_body: null,
          response_status: psRes.status,
          response_ok: psRes.ok,
          response_body_text: psText,
          response_body_json: psJson,
          error: psRes.ok ? null : 'Teltik port-status HTTP ' + psRes.status,
        });
        port_status = {
          ok: psRes.ok,
          http_status: psRes.status,
          mdn: mdnDigits,
          response: psJson || psText,
        };
      } catch (e) {
        port_status = { ok: false, error: 'port-status exception: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update,
      port_status,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function syncCancelledSim(env, subId, helixData) {
  try {
    const sims = await sbGet(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId) + '&select=id,iccid,status&limit=1');
    const sim = Array.isArray(sims) ? sims[0] : null;
    if (!sim) return { found: false };

    const result = { found: true, iccid: sim.iccid, sim_id: sim.id };

    if (sim.status !== 'canceled') {
      await sbPatch(env, 'sims?id=eq.' + sim.id, { status: 'canceled' });
      result.status_updated = true;
      result.previous_status = sim.status;
    } else {
      result.status_already_canceled = true;
    }

    // Idempotent cancel-side cleanup: expire active sim_numbers and remove from reseller_sims.active.
    // Filters ensure no work happens if these are already in the desired state — safe to call repeatedly.
    const nowIsoCancel = new Date().toISOString();
    await sbPatch(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null', { valid_to: nowIsoCancel });
    await sbPatch(env, 'reseller_sims?sim_id=eq.' + sim.id + '&active=eq.true', { active: false });

    const hist = await sbGet(env, 'sim_status_history?sim_id=eq.' + sim.id + '&new_status=eq.canceled&limit=1');
    if (!Array.isArray(hist) || hist.length === 0) {
      const canceledAt = helixData.canceledAt || helixData.cancelledAt;
      if (canceledAt) {
        await sbPost(env, 'sim_status_history', {
          sim_id: sim.id,
          old_status: sim.status,
          new_status: 'canceled',
          changed_at: new Date(canceledAt).toISOString(),
        });
        result.history_inserted = true;
        result.canceled_at = new Date(canceledAt).toISOString();
      } else {
        result.no_cancel_date = true;
      }
    } else {
      result.history_exists = true;
      result.canceled_at = hist[0].changed_at;
    }

    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

function toE164(mdn) {
  if (!mdn) return null;
  const digits = String(mdn).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

async function syncActiveSim(env, iccid, { mdn, activatedAt, zipCode }) {
  try {
    const sims = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,status,activated_at,activation_zip,msisdn&limit=1');
    const sim = Array.isArray(sims) ? sims[0] : null;
    if (!sim) return { found: false };

    const result = { found: true, iccid: sim.iccid, sim_id: sim.id };
    const patch = {};

    if (sim.status !== 'active') {
      patch.status = 'active';
      result.status_updated = true;
      result.previous_status = sim.status;
    }

    if (activatedAt && !sim.activated_at) {
      const parsed = new Date(activatedAt);
      if (!isNaN(parsed.getTime())) {
        patch.activated_at = parsed.toISOString();
        result.activated_at_set = patch.activated_at;
      }
    } else if (sim.activated_at) {
      result.activated_at = sim.activated_at;
    }

    if (zipCode) {
      patch.activation_zip = zipCode;
      result.activation_zip_set = zipCode;
    }

    if (Object.keys(patch).length > 0) {
      await sbPatch(env, 'sims?id=eq.' + sim.id, patch);
    }

    if (mdn) {
      const e164 = toE164(mdn);
      if (e164) {
        const msisdnBare = String(mdn).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
        if (msisdnBare && msisdnBare.length === 10 && msisdnBare !== sim.msisdn) {
          await sbPatch(env, 'sims?id=eq.' + sim.id, { msisdn: msisdnBare });
          result.msisdn_updated = true;
          result.msisdn_new = msisdnBare;
        }
        const existing = await sbGet(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null&select=e164&limit=1');
        const currentMdn = Array.isArray(existing) && existing[0] ? existing[0].e164 : null;
        if (currentMdn !== e164) {
          const now = new Date().toISOString();
          if (currentMdn) {
            await sbPatch(env, 'sim_numbers?sim_id=eq.' + sim.id + '&valid_to=is.null', { valid_to: now });
          }
          await sbPost(env, 'sim_numbers', { sim_id: sim.id, e164, valid_from: now, valid_to: null });
          result.mdn_updated = true;
          result.mdn_old = currentMdn;
          result.mdn_new = e164;
        } else {
          result.mdn_already_set = true;
          result.mdn = currentMdn;
        }
      }
    }

    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleHelixQueryBulk(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit) || 100, 200);
    const offset = parseInt(body.offset) || 0;

    const simsData = await sbGet(env, 'sims?mobility_subscription_id=not.is.null&status=not.eq.canceled&select=id,iccid,status,mobility_subscription_id&limit=5000');
    const allSims = Array.isArray(simsData) ? simsData : [];
    const batch = allSims.slice(offset, offset + limit);

    if (batch.length === 0) {
      return new Response(JSON.stringify({ ok: true, total_eligible: allSims.length, processed: 0, message: 'No SIMs in this batch' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tokenRes = await relayFetch(env, env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const token = tokenData.access_token;

    const results = {
      ok: true,
      total_eligible: allSims.length,
      processed: batch.length,
      offset,
      has_more: offset + batch.length < allSims.length,
      next_offset: offset + batch.length,
      cancelled_found: 0,
      db_updated: 0,
      already_synced: 0,
      errors: 0,
      changed: [],
    };

    for (const sim of batch) {
      try {
        const detailsRes = await relayFetch(env, env.HX_API_BASE + '/api/mobility-subscriber/details', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),
        });

        if (!detailsRes.ok) {
          results.errors++;
          results.changed.push({ iccid: sim.iccid, error: 'Helix ' + detailsRes.status });
          continue;
        }

        const d = await detailsRes.json();
        const data = Array.isArray(d) ? d[0] : d;

        if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
          results.cancelled_found++;
          const upd = await syncCancelledSim(env, String(sim.mobility_subscription_id), data);
          if (upd.status_updated) results.db_updated++;
          else if (upd.status_already_canceled) results.already_synced++;
          results.changed.push({ iccid: sim.iccid, sub_id: sim.mobility_subscription_id, helix_status: data.status, ...upd });
        }
      } catch (e) {
        results.errors++;
        results.changed.push({ iccid: sim.iccid, error: String(e) });
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleSendTestSms(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { gateway_id, port, to_number, message } = body;

    if (!gateway_id || !port || !to_number || !message) {
      return new Response(JSON.stringify({ error: 'gateway_id, port, to_number, and message are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Proxy through SKYLINE_GATEWAY service binding
    if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET) {
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY or SKYLINE_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    console.log(`[SendTestSms] Proxying to skyline-gateway: gateway=${gateway_id} port=${port} to=${to_number}`);

    const skylineRes = await env.SKYLINE_GATEWAY.fetch(
      `https://skyline-gateway/send-sms?secret=${encodeURIComponent(env.SKYLINE_SECRET)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway_id, port, to: to_number, message }),
      }
    );

    const responseText = await skylineRes.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }


    return new Response(JSON.stringify(result, null, 2), {
      status: skylineRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleBulkSendTestSms(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { target_sim_ids, message } = body;

    if (!Array.isArray(target_sim_ids) || target_sim_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'target_sim_ids must be a non-empty array' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'message is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (message.length > 160) {
      return new Response(JSON.stringify({ error: 'message must be 160 chars or fewer' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sbUrl = env.SUPABASE_URL;
    const sbKey = env.SUPABASE_SERVICE_ROLE_KEY;
    const idList = target_sim_ids.join(',');

    // Fetch target SIMs with their current MDNs
    const targetsRes = await fetch(
      sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&id=in.(' + idList + ')&sim_numbers.valid_to=is.null',
      { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } }
    );
    if (!targetsRes.ok) {
      const errText = await targetsRes.text();
      return new Response(JSON.stringify({ error: 'DB error fetching targets: ' + errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const targets = await targetsRes.json();

    // Fetch sender pool: active SIMs with gateway+port+MDN, not in target list
    const sendersRes = await fetch(
      sbUrl + '/rest/v1/sims?select=id,gateway_id,port,sim_numbers(e164)&status=eq.active&gateway_id=eq.1&port=not.is.null&sim_numbers.valid_to=is.null&limit=200',
      { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } }
    );
    if (!sendersRes.ok) {
      const errText = await sendersRes.text();
      return new Response(JSON.stringify({ error: 'DB error fetching senders: ' + errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const allSenders = await sendersRes.json();

    // Filter out targets from sender pool and senders with no MDN
    const targetSet = new Set(target_sim_ids.map(Number));
    const senders = allSenders.filter(s =>
      !targetSet.has(s.id) &&
      Array.isArray(s.sim_numbers) && s.sim_numbers.length > 0 && s.sim_numbers[0].e164
    );

    if (senders.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'No eligible sender SIMs available' }), {
        status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fisher-Yates shuffle
    for (let i = senders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [senders[i], senders[j]] = [senders[j], senders[i]];
    }

    const results = [];
    const skipped = [];
    let sentCount = 0;
    let errorCount = 0;
    let senderIdx = 0;

    for (const target of targets) {
      const targetMdn = Array.isArray(target.sim_numbers) && target.sim_numbers.length > 0
        ? target.sim_numbers[0].e164
        : null;

      if (!targetMdn) {
        skipped.push({ target_sim_id: target.id, reason: 'no_mdn' });
        continue;
      }

      const sender = senders[senderIdx % senders.length];
      senderIdx++;

      try {
        const skylineRes = await env.SKYLINE_GATEWAY.fetch(
          'https://skyline-gateway/send-sms?secret=' + encodeURIComponent(env.SKYLINE_SECRET),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gateway_id: sender.gateway_id,
              port: sender.port,
              to: targetMdn,
              message
            })
          }
        );
        const resText = await skylineRes.text();
        let resJson;
        try { resJson = JSON.parse(resText); } catch { resJson = { raw: resText }; }

        if (skylineRes.ok) {
          sentCount++;
          results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: true });
        } else {
          errorCount++;
          const errMsg = resJson.error || resJson.raw || ('HTTP ' + skylineRes.status);
          results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: false, error: errMsg });
        }
      } catch (e) {
        errorCount++;
        results.push({ target_sim_id: target.id, target_mdn: targetMdn, sender_sim_id: sender.id, sender_port: sender.port, ok: false, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ ok: true, sent: sentCount, skipped: skipped.length, errors: errorCount, results, skipped_list: skipped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleSkylineProxy(request, env, url, corsHeaders) {
  if (!env.SKYLINE_GATEWAY) {
    return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY service binding not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (!env.SKYLINE_SECRET) {
    return new Response(JSON.stringify({ error: 'SKYLINE_SECRET not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Map /api/skyline/send-sms -> /send-sms, etc.
  const skylinePath = url.pathname.replace('/api/skyline', '');
  const targetUrl = `https://skyline-gateway${skylinePath}?secret=${encodeURIComponent(env.SKYLINE_SECRET)}`;

  try {
    let skylineResponse;
    let requestBodyParsed = null;
    if (request.method === 'GET') {
      // Forward query params for GET requests (like port-status)
      const params = new URLSearchParams(url.searchParams);
      params.set('secret', env.SKYLINE_SECRET);
      skylineResponse = await env.SKYLINE_GATEWAY.fetch(
        `https://skyline-gateway${skylinePath}?${params}`,
        { method: 'GET' }
      );
    } else {
      const body = await request.text();
      try { requestBodyParsed = JSON.parse(body); } catch { }
      skylineResponse = await env.SKYLINE_GATEWAY.fetch(targetUrl, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }

    const responseText = await skylineResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

    // Intercept set-imei to update IMEI pool automatically
    if (skylinePath === '/set-imei' && request.method === 'POST' && result.ok && requestBodyParsed) {
      try {
        const { gateway_id, port, imei: newImei } = requestBodyParsed;
        const normPort = normalizeImeiPoolPort(port);
        if (gateway_id && port && newImei) {
          // 1. Retire old IMEI on this gateway/port (if any)
          await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.${gateway_id}&port=eq.${encodeURIComponent(normPort)}&status=eq.in_use&imei=neq.${newImei}`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 'retired', sim_id: null, assigned_at: null }),
          });
          // 2. Upsert new IMEI as in_use
          const upsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {
            method: 'POST',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify({
              imei: newImei,
              status: 'in_use',
              gateway_id: parseInt(gateway_id),
              port: normPort,
              notes: `Manually set via dashboard on ${new Date().toISOString().split('T')[0]}`,
            }),
          });
          if (!upsertRes.ok) {
            const upsertTxt = await upsertRes.text();
            const conflict = parseImeiPoolConflict(upsertRes.status, upsertTxt);
            if (conflict) {
              await logSystemError(env, {
                source: 'imei-pool',
                action: 'set_imei_intercept',
                error_message: conflict,
                error_details: { gateway_id, port: normPort, imei: newImei },
                severity: 'error',
              });
              throw new Error(conflict);
            }
            throw new Error(`IMEI pool upsert failed: ${upsertRes.status} ${upsertTxt}`);
          }
        }
      } catch (poolErr) {
        console.error('Failed to update IMEI pool after set-imei:', poolErr);
      }
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: skylineResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (fetchError) {
    return new Response(JSON.stringify({
      error: `Failed to reach skyline-gateway: ${String(fetchError)}`
    }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function supabaseGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
}

async function supabaseGetAllArray(env, pathWithoutLimit) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = pathWithoutLimit.includes('?') ? '&' : '?';
    const url = pathWithoutLimit + sep + 'limit=' + pageSize + '&offset=' + offset;
    const resp = await supabaseGet(env, url);
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error('PostgREST fetch failed: ' + resp.status + ' ' + txt);
    }
    const batch = await resp.json();
    if (!Array.isArray(batch)) return batch;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

async function handleRotationAudit(request, env, corsHeaders) {
  try {
    const base = env.SUPABASE_URL + '/rest/v1/';
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    };
    const latestRes = await fetch(base + 'rotation_audit?order=run_at.desc&limit=1', { headers });
    const latestArr = latestRes.ok ? await latestRes.json() : [];
    const histRes = await fetch(base + 'rotation_audit?select=id,run_at,ny_date,trigger,bucket_a_count,bucket_b_count,bucket_c_count,duration_ms&order=run_at.desc&limit=7', { headers });
    const history = histRes.ok ? await histRes.json() : [];
    return new Response(JSON.stringify({ latest: latestArr[0] || null, history }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRotationAuditRun(request, env, corsHeaders) {
  try {
    if (!env.FINALIZER_RUN_SECRET) {
      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET not configured on dashboard worker' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!env.DETAILS_FINALIZER) {
      return new Response(JSON.stringify({ error: 'DETAILS_FINALIZER service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const url = 'https://details-finalizer/reconcile-rotations?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET) + '&force=1';
    const r = await env.DETAILS_FINALIZER.fetch(url, { method: 'GET' });
    const body = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (_e) {}
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, result: parsed || body }), {
      status: r.ok ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRotationReviewsList(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 50);
    const base = env.SUPABASE_URL + '/rest/v1/';
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    };
    const res = await fetch(base + 'cron_runs?kind=eq.rotation_review&select=id,run_id,started_at,ended_at,status,summary&order=started_at.desc&limit=' + limit, { headers });
    const rows = res.ok ? await res.json() : [];
    return new Response(JSON.stringify({ rows }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRotationReviewGet(runIdOrDbId, env, corsHeaders) {
  try {
    const base = env.SUPABASE_URL + '/rest/v1/';
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    };
    // Try as run_id (uuid) first, then fall back to id (bigint)
    let res = await fetch(base + 'cron_runs?run_id=eq.' + encodeURIComponent(runIdOrDbId) + '&select=*&limit=1', { headers });
    let rows = res.ok ? await res.json() : [];
    if (rows.length === 0 && /^\d+$/.test(runIdOrDbId)) {
      res = await fetch(base + 'cron_runs?id=eq.' + runIdOrDbId + '&select=*&limit=1', { headers });
      rows = res.ok ? await res.json() : [];
    }
    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ run: rows[0] }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleRotationReviewRun(request, env, corsHeaders) {
  try {
    if (!env.FINALIZER_RUN_SECRET || !env.DETAILS_FINALIZER) {
      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET or DETAILS_FINALIZER not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const url = 'https://details-finalizer/rotation-review?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET);
    const r = await env.DETAILS_FINALIZER.fetch(url, { method: 'GET' });
    const body = await r.text();
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, report_md: body }), {
      status: r.ok ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handlePendingItemsList(request, env, corsHeaders) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'open';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    const base = env.SUPABASE_URL + '/rest/v1/';
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
    };
    const filter = status === 'all' ? '' : '&status=eq.' + encodeURIComponent(status);
    const res = await fetch(base + 'pending_review_items?select=*' + filter + '&order=created_at.desc&limit=' + limit, { headers });
    const rows = res.ok ? await res.json() : [];
    // Also return count of open items for the sidebar badge
    const countRes = await fetch(base + 'pending_review_items?status=eq.open&select=id&limit=1', {
      headers: { ...headers, Prefer: 'count=exact' }
    });
    const cr = countRes.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+|\*)$/);
    const openCount = m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
    return new Response(JSON.stringify({ rows, open_count: openCount }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handlePendingItemRespond(id, request, env, corsHeaders) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');
    const responseText = body.response_text ? String(body.response_text).slice(0, 4000) : null;
    if (!['reply', 'acknowledge', 'snooze', 'dismiss'].includes(action)) {
      return new Response(JSON.stringify({ error: 'invalid action' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const update = { resolved_at: new Date().toISOString() };
    if (action === 'reply')       { update.status = 'answered';     update.operator_response = responseText; }
    if (action === 'acknowledge') { update.status = 'acknowledged'; if (responseText) update.operator_response = responseText; }
    if (action === 'snooze')      { update.status = 'snoozed';      update.resolved_at = null; if (responseText) update.operator_response = responseText; }
    if (action === 'dismiss')     { update.status = 'dismissed';    if (responseText) update.operator_response = responseText; }

    const base = env.SUPABASE_URL + '/rest/v1/';
    const headers = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    const res = await fetch(base + 'pending_review_items?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH', headers, body: JSON.stringify(update),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'patch failed: ' + res.status + ' ' + t.slice(0, 200) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const rows = await res.json().catch(() => []);
    return new Response(JSON.stringify({ ok: true, item: rows[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleOperatorQuestion(request, env, corsHeaders) {
  try {
    const body = await request.json().catch(() => ({}));
    const summary = String(body.summary || '').slice(0, 200);
    const details = String(body.details_md || body.summary || '').slice(0, 4000);
    if (!summary) {
      return new Response(JSON.stringify({ error: 'summary required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/pending_review_items', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify([{ kind: 'operator_question', summary, details_md: details, status: 'open' }]),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'insert failed: ' + res.status + ' ' + t.slice(0, 200) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const rows = await res.json().catch(() => []);
    return new Response(JSON.stringify({ ok: true, item: rows[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleFixSim(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const simIds = body.sim_ids || [];

    if (!Array.isArray(simIds) || simIds.length === 0) {
      return new Response(JSON.stringify({ error: 'sim_ids array is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.MDN_ROTATOR) {
      return new Response(JSON.stringify({ error: 'MDN_ROTATOR service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.ADMIN_RUN_SECRET) {
      return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const workerUrl = `https://mdn-rotator/fix-sim?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_ids: simIds })
    });

    const responseText = await workerResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch {
      result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: workerResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleImeiPoolGet(env, corsHeaders) {
  try {
    // Supabase enforces PGRST_MAX_ROWS=1000 server-side, so we must paginate
    const baseUrl = `${env.SUPABASE_URL}/rest/v1/imei_pool?select=id,imei,status,device_type,sim_id,assigned_at,previous_sim_id,notes,created_at,gateway_id,port,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc`;
    const batchSize = 1000;
    let allRows = [];
    let offset = 0;

    while (true) {
      const response = await fetch(baseUrl, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
          Range: `${offset}-${offset + batchSize - 1}`,
        },
      });
      const batch = await response.json();
      if (!Array.isArray(batch) || batch.length === 0) break;
      allRows = allRows.concat(batch);
      if (batch.length < batchSize) break; // Last page
      offset += batchSize;
    }

    // Get total gateway slots for context
    const gwRes = await supabaseGet(env, 'gateways?select=total_ports,slots_per_port&active=eq.true');
    const gateways = await gwRes.json();
    const totalSlots = Array.isArray(gateways) ? gateways.reduce((sum, gw) => sum + (gw.total_ports || 0) * (gw.slots_per_port || 1), 0) : 0;

    const stats = {
      total: allRows.length,
      available: allRows.filter(e => e.status === 'available').length,
      in_use: allRows.filter(e => e.status === 'in_use').length,
      retired: allRows.filter(e => e.status === 'retired').length,
      slots: totalSlots,
      by_type: {
        phone: allRows.filter(e => (e.device_type || 'phone') === 'phone').length,
        router: allRows.filter(e => e.device_type === 'router').length,
      },
      available_by_type: {
        phone: allRows.filter(e => e.status === 'available' && (e.device_type || 'phone') === 'phone').length,
        router: allRows.filter(e => e.status === 'available' && e.device_type === 'router').length,
      },
    };

    return new Response(JSON.stringify({ pool: allRows, stats }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleImeiPoolPick(env, corsHeaders) {
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/imei_pool?select=imei&status=eq.available&limit=1`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
        },
      }
    );
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: 'No available IMEIs in pool' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, imei: rows[0].imei }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleImeiPoolPost(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const action = body.action;

    if (action === 'add') {
      const imeis = body.imeis || [];
      // INC-13: device_type tagging (phone|router). Default phone for back-compat.
      const deviceType = (body.device_type === 'router') ? 'router' : 'phone';
      if (!Array.isArray(imeis) || imeis.length === 0) {
        return new Response(JSON.stringify({ error: 'imeis array is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Validate IMEI format
      const valid = [];
      const invalid = [];
      for (const imei of imeis) {
        const trimmed = imei.trim();
        if (/^\d{15}$/.test(trimmed)) {
          valid.push({ imei: trimmed, status: 'available', device_type: deviceType });
        } else if (trimmed) {
          invalid.push(trimmed);
        }
      }

      if (valid.length === 0) {
        return new Response(JSON.stringify({ error: 'No valid IMEIs found', invalid }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Check for retired IMEIs — retired IMEIs cannot be reused
      const imeiValues = valid.map(v => v.imei);
      const existingRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=in.(${imeiValues.join(',')})&select=imei,status`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
        }
      );
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      const retiredSet = new Set(existingRows.filter(r => r.status === 'retired').map(r => r.imei));
      const inPoolSet = new Set(existingRows.filter(r => r.status !== 'retired').map(r => r.imei));

      const rejectedRetired = valid.filter(v => retiredSet.has(v.imei)).map(v => v.imei);
      const toAdd = valid.filter(v => !retiredSet.has(v.imei) && !inPoolSet.has(v.imei));
      const dupCount = valid.filter(v => inPoolSet.has(v.imei)).length;

      if (rejectedRetired.length > 0 && toAdd.length === 0) {
        return new Response(JSON.stringify({
          error: 'All submitted IMEIs have been retired and cannot be reused: ' + rejectedRetired.join(', '),
          rejected_retired: rejectedRetired,
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      let added = 0;
      if (toAdd.length > 0) {
        const addInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(toAdd),
        });
        const addInsertText = await addInsertRes.text();
        let addInserted = [];
        try { addInserted = JSON.parse(addInsertText); } catch { }
        added = Array.isArray(addInserted) ? addInserted.length : 0;
      }

      return new Response(JSON.stringify({
        ok: true,
        added,
        duplicates: dupCount,
        invalid: invalid.length,
        rejected_retired: rejectedRetired,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'retire') {
      const id = body.id;
      if (!id) {
        return new Response(JSON.stringify({ error: 'id is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Retire available or in_use IMEIs (carrier rejected)
      const patchRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${id}&status=in.(available,in_use)`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ status: 'retired', sim_id: null, assigned_at: null }),
        }
      );

      const patchText = await patchRes.text();
      let patched = [];
      try { patched = JSON.parse(patchText); } catch { }

      if (patched.length === 0) {
        return new Response(JSON.stringify({ error: 'IMEI not found or already retired' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({ ok: true, retired: patched[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'unretire') {
      const id = body.id;
      if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const patchRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${id}&status=eq.retired`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ status: 'available' }),
        }
      );
      const patched = await patchRes.json().catch(() => []);
      if (!patched.length) return new Response(JSON.stringify({ error: 'IMEI not found or not retired' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, unretired: patched[0] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action. Use "add", "retire", or "unretire"' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleImportGatewayImeis(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const gatewayId = body.gateway_id;

    if (!gatewayId) {
      return new Response(JSON.stringify({ error: 'gateway_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SKYLINE_GATEWAY) {
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SKYLINE_SECRET) {
      return new Response(JSON.stringify({ error: 'SKYLINE_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch all port data with all_slots=1 to get every IMEI (including inactive slots)
    const infoParams = new URLSearchParams({
      gateway_id: gatewayId,
      secret: env.SKYLINE_SECRET,
      all_slots: '1',
    });
    const infoRes = await env.SKYLINE_GATEWAY.fetch(
      `https://skyline-gateway/port-info?${infoParams}`,
      { method: 'GET' }
    );
    const infoText = await infoRes.text();
    let infoData;
    try { infoData = JSON.parse(infoText); } catch {
      return new Response(JSON.stringify({ error: `Non-JSON from skyline-gateway: ${infoText.slice(0, 200)}` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!infoData.ok) {
      return new Response(JSON.stringify({ error: infoData.error || 'Gateway returned error', detail: infoData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ports = infoData.ports || [];
    const totalPorts = ports.length;

    // Query DB for all in_use IMEIs for this gateway (DB is the source of truth)
    const dbRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.${encodeURIComponent(gatewayId)}&status=eq.in_use&select=imei,port`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const dbRows = dbRes.ok ? await dbRes.json() : [];

    // Build map: normalizedPort -> dbImei
    const dbSlotMap = {};
    for (const row of dbRows) {
      if (row.port) dbSlotMap[normalizeImeiPoolPort(row.port)] = row.imei;
    }

    // Process gateway ports: compare against DB slot map
    const seen = new Set();
    const toInsert = [];
    const discrepancies = [];
    let skippedNoImei = 0;
    let inSync = 0;
    const simImeiMap = [];

    for (const p of ports) {
      const imei = (p.imei || '').trim();
      if (!imei || !/^\d{15}$/.test(imei)) {
        skippedNoImei++;
        continue;
      }
      const normPort = p.port ? normalizeImeiPoolPort(p.port) : null;

      if (normPort && Object.prototype.hasOwnProperty.call(dbSlotMap, normPort)) {
        const dbImei = dbSlotMap[normPort];
        if (dbImei === imei) {
          // Already in sync — no action needed
          inSync++;
        } else {
          // Discrepancy: DB says dbImei, gateway has imei — DB wins
          discrepancies.push({ port: normPort, db_imei: dbImei, gateway_imei: imei });
        }
        // Either way, skip insertion — DB is authoritative for this slot
      } else {
        // No DB entry for this slot — add as new
        if (!seen.has(imei)) {
          seen.add(imei);
          toInsert.push({
            imei,
            status: 'in_use',
            gateway_id: parseInt(gatewayId),
            port: normPort || p.port || null,
            notes: `Imported from gateway ${gatewayId} port ${p.port}${p.iccid ? ' iccid=' + p.iccid : ''}`,
          });
        }
      }

      // Track sim_id -> IMEI for backfilling
      if (p.iccid && p.sim_id) {
        simImeiMap.push({ sim_id: p.sim_id, imei });
      }
    }

    // Insert new IMEIs (slots not yet in DB)
    let inserted = 0;
    if (toInsert.length > 0) {
      const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify(toInsert),
      });
      const insertText = await insertRes.text();
      let insertedArr = [];
      try { insertedArr = JSON.parse(insertText); } catch { }
      if (!insertRes.ok) {
        const conflict = parseImeiPoolConflict(insertRes.status, insertText);
        const errMsg = conflict || `IMEI pool bulk insert failed: ${insertRes.status} ${insertText.slice(0, 300)}`;
        await logSystemError(env, {
          source: 'imei-pool',
          action: 'gateway_sync_insert',
          error_message: errMsg,
          error_details: { gateway_id: gatewayId, attempted: toInsert.length },
          severity: 'error',
        });
        // Surface in response but don't throw — partial success is still useful
        discrepancies.push({ type: 'insert_conflict', message: errMsg });
      } else {
        inserted = Array.isArray(insertedArr) ? insertedArr.length : 0;
      }
    }

    // Backfill sims.imei for active slots that have a matched sim_id
    let backfilled = 0;
    for (const entry of simImeiMap) {
      try {
        const patchRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/sims?id=eq.${encodeURIComponent(String(entry.sim_id))}&imei=is.null`,
          {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ imei: entry.imei }),
          }
        );
        if (patchRes.ok) backfilled++;
      } catch { }
    }

    // Link sim_id on imei_pool entries for active SIM slots,
    // and backfill sims.current_imei_pool_id where not set.
    let linked = 0;
    let backfilledCurrentPool = 0;
    for (const entry of simImeiMap) {
      try {
        const linkRes = await fetch(
          `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.${encodeURIComponent(entry.imei)}`,
          {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=representation',
            },
            body: JSON.stringify({ sim_id: entry.sim_id }),
          }
        );
        if (linkRes.ok) {
          linked++;
          // Backfill sims.current_imei_pool_id if not set
          try {
            const poolRows = await linkRes.json();
            const poolId = Array.isArray(poolRows) && poolRows[0]?.id;
            if (poolId) {
              const simPatch = await fetch(
                `${env.SUPABASE_URL}/rest/v1/sims?id=eq.${encodeURIComponent(String(entry.sim_id))}&current_imei_pool_id=is.null`,
                {
                  method: 'PATCH',
                  headers: {
                    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'Content-Type': 'application/json',
                    Prefer: 'return=minimal',
                  },
                  body: JSON.stringify({ current_imei_pool_id: poolId }),
                }
              );
              if (simPatch.ok) backfilledCurrentPool++;
            }
          } catch { }
        }
      } catch { }
    }

    return new Response(JSON.stringify({
      ok: true,
      total_ports: totalPorts,
      skipped_no_imei: skippedNoImei,
      in_sync: inSync,
      added: inserted,
      discrepancies,
      backfilled_sims: backfilled,
      linked_to_sims: linked,
      backfilled_current_pool: backfilledCurrentPool,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleImeiPoolFixSlot(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { gateway_id, port, db_imei, gateway_imei } = body;

    if (!gateway_id || !port || !db_imei || !gateway_imei) {
      return new Response(JSON.stringify({ error: 'gateway_id, port, db_imei, gateway_imei are all required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify db_imei exists in pool and is in_use
    const verifyRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.${encodeURIComponent(db_imei)}&select=imei,status,gateway_id,port`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const verifyRows = verifyRes.ok ? await verifyRes.json() : [];
    const dbRow = verifyRows[0];

    if (!dbRow) {
      return new Response(JSON.stringify({ error: `IMEI ${db_imei} not found in pool` }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (dbRow.status !== 'in_use') {
      return new Response(JSON.stringify({ error: `IMEI ${db_imei} is not in_use (status: ${dbRow.status})` }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Check for conflict: db_imei assigned to a different gateway/port
    const normPort = normalizeImeiPoolPort(port);
    const normDbPort = normalizeImeiPoolPort(dbRow.port);
    if (String(dbRow.gateway_id) !== String(gateway_id) || normDbPort !== normPort) {
      return new Response(JSON.stringify({
        error: `Conflict: IMEI ${db_imei} is in_use on gateway ${dbRow.gateway_id} port ${dbRow.port}, not ${gateway_id}/${port}. Resolve this manually.`,
        conflict: { gateway_id: dbRow.gateway_id, port: dbRow.port },
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET) {
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY or SKYLINE_SECRET not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Push db_imei to the gateway slot via skyline-gateway
    const setParams = new URLSearchParams({ secret: env.SKYLINE_SECRET });
    const setRes = await env.SKYLINE_GATEWAY.fetch(
      `https://skyline-gateway/set-imei?${setParams}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway_id, port, imei: db_imei }),
      }
    );
    const setData = await setRes.json();
    if (!setData.ok) {
      return new Response(JSON.stringify({
        error: 'Gateway rejected IMEI push: ' + (setData.error || JSON.stringify(setData)),
        skyline_response: setData,
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Retire the gateway's current IMEI in pool (if it exists and isn't already retired)
    let retired = false;
    if (gateway_imei && gateway_imei !== db_imei) {
      const retireRes = await fetch(
        `${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.${encodeURIComponent(gateway_imei)}&status=neq.retired`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ status: 'retired' }),
        }
      );
      retired = retireRes.ok;
    }

    return new Response(JSON.stringify({
      ok: true,
      message: `IMEI ${db_imei} pushed to gateway ${gateway_id} port ${port}`,
      gateway_imei_retired: retired,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
async function handleErrors(env, corsHeaders, url) {
  try {
    const statusFilter = url.searchParams.get('status') || 'open';

    // Query system_errors table
    let errQuery = `system_errors?select=id,source,action,sim_id,iccid,error_message,error_details,severity,status,resolved_at,resolved_by,resolution_notes,created_at&order=created_at.desc&limit=500`;
    if (statusFilter !== 'all') {
      errQuery += `&status=eq.${statusFilter}`;
    }
    const errResponse = await supabaseGet(env, errQuery);
    const systemErrors = await errResponse.json();

    // Also get SIMs with last_activation_error (legacy errors)
    const simQuery = `sims?select=id,iccid,port,status,last_activation_error,gateways(code),sim_numbers(e164)&last_activation_error=not.is.null&sim_numbers.valid_to=is.null&order=id.desc&limit=200`;
    const simResponse = await supabaseGet(env, simQuery);
    const simErrors = await simResponse.json();

    // Also get SIMs with last_rotation_error
    const rotQuery = `sims?select=id,iccid,port,status,last_rotation_error,last_rotation_at,gateways(code),sim_numbers(e164)&last_rotation_error=not.is.null&sim_numbers.valid_to=is.null&order=last_rotation_at.desc.nullslast&limit=200`;
    const rotResponse = await supabaseGet(env, rotQuery);
    const rotErrors = await rotResponse.json();

    // Convert SIM errors to unified format
    const legacyErrors = (Array.isArray(simErrors) ? simErrors : []).map(sim => ({
      id: `sim_${sim.id}`,
      source: 'activation',
      action: 'activate',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: sim.last_activation_error,
      error_details: null,
      severity: 'error',
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      resolution_notes: null,
      created_at: null,
      phone_number: sim.sim_numbers?.[0]?.e164 || null,
      gateway_code: sim.gateways?.code || null,
      sim_status: sim.status,
      _legacy: true,
    }));

    // Convert rotation errors to unified format
    const rotationErrors = (Array.isArray(rotErrors) ? rotErrors : []).map(sim => ({
      id: `rot_${sim.id}`,
      source: 'rotation',
      action: 'rotate_mdn',
      sim_id: sim.id,
      iccid: sim.iccid,
      error_message: sim.last_rotation_error,
      error_details: null,
      severity: 'error',
      status: 'open',
      resolved_at: null,
      resolved_by: null,
      resolution_notes: null,
      created_at: sim.last_rotation_at || null,
      phone_number: sim.sim_numbers?.[0]?.e164 || null,
      gateway_code: sim.gateways?.code || null,
      sim_status: sim.status,
      _legacy: true,
    }));

    // Format system_errors
    const sysFormatted = (Array.isArray(systemErrors) ? systemErrors : []).map(e => ({ ...e, _legacy: false }));

    // Deduplicate system_errors by (sim_id, source): keep most recent, auto-resolve older ones
    const seenKey = new Map();
    for (const e of sysFormatted) {
      if (!e.sim_id) continue;
      const k = e.sim_id + ':' + e.source;
      const existing = seenKey.get(k);
      if (!existing || new Date(e.created_at) > new Date(existing.created_at)) {
        seenKey.set(k, e);
      }
    }
    const keepIds = new Set([...seenKey.values()].map(e => e.id));
    const toAutoResolve = sysFormatted.filter(e => e.sim_id && !keepIds.has(e.id)).map(e => e.id);
    if (toAutoResolve.length > 0) {
      const inClause = toAutoResolve.join(',');
      fetch(`${env.SUPABASE_URL}/rest/v1/system_errors?id=in.(${inClause})`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: 'auto-dedup' }),
      }).catch(() => {});
    }
    const dedupedSys = sysFormatted.filter(e => !e.sim_id || keepIds.has(e.id));

    // Merge: deduplicated system_errors first, then legacy activation errors, then rotation errors
    const merged = [...dedupedSys, ...legacyErrors, ...rotationErrors];

    return new Response(JSON.stringify(merged), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleErrorLogs(env, corsHeaders, url) {
  try {
    const simId = url.searchParams.get('sim_id');
    const iccid = url.searchParams.get('iccid');

    if (!simId && !iccid) return new Response(JSON.stringify({ error: 'sim_id or iccid required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    let lookupIccid = iccid;

    // If we have sim_id but no iccid, look up the iccid from the sims table
    if (simId && !lookupIccid) {
      const simRes = await supabaseGet(env, `sims?select=iccid&id=eq.${simId}&limit=1`);
      const sims = await simRes.json();
      lookupIccid = sims?.[0]?.iccid;
      if (!lookupIccid) {
        return new Response(JSON.stringify([]), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Query helix_api_logs by iccid with correct column names
    const query = `carrier_api_logs?select=id,step,iccid,imei,vendor,request_url,request_method,request_body,response_status,response_ok,response_body_json,response_body_text,error,created_at&iccid=eq.${encodeURIComponent(lookupIccid)}&order=created_at.desc&limit=20`;
    const response = await supabaseGet(env, query);
    const logs = await response.json();
    return new Response(JSON.stringify(logs), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleBadRentals(env, corsHeaders, url) {
  try {
    const statusParam = url.searchParams.get('status');
    const includeAll = statusParam === 'all';
    const statusFilter = (statusParam && !includeAll) ? statusParam : 'received,in_triage';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    // Embeds:
    //   resellers(name)                       — operator label
    //   rentals(reseller_rental_id)           — reseller's own id when echoed
    //   sims(sim_numbers(...))                — the SIM's CURRENT MDN (valid_to IS NULL)
    //   report_sim_number — via the explicit FK rental_reports_sim_number_id_fkey —
    //     the sim_numbers row CAPTURED at intake. Its valid_to tells the UI
    //     when the reported MDN was retired (= "old number expiration").
    const select = [
      'id', 'reseller_id', 'e164', 'reason_code', 'reason_note', 'status',
      'sim_id', 'sim_number_id', 'rental_id',
      'remediation_action', 'duplicate_of',
      'received_at', 'triaged_at', 'closed_at', 'updated_at',
      'auto_remediation_state', 'last_auto_attempt_at', 'escalation_reason',
      'resellers(name)',
      'rentals(reseller_rental_id)',
      'sims(iccid,sim_numbers(e164,valid_to))',
      'report_sim_number:sim_numbers!rental_reports_sim_number_id_fkey(e164,valid_from,valid_to)',
    ].join(',');
    let query = 'rental_reports?select=' + encodeURIComponent(select);
    if (!includeAll) {
      query += '&status=in.(' + encodeURIComponent(statusFilter) + ')';
    }
    query += '&sims.sim_numbers.valid_to=is.null'
      + '&order=received_at.desc&limit=' + limit;
    const resp = await supabaseGet(env, query);
    if (!resp.ok) {
      const txt = await resp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + resp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rows = await resp.json();
    // INC-23 — pull a compact attempts summary per report so the Bad Rentals
    // list can show "Auto attempts: N (last: <action> <outcome>)".
    const reportIds = (Array.isArray(rows) ? rows : []).map(r => r && r.id).filter(x => x != null);
    const attemptSummary = {};
    if (reportIds.length > 0) {
      try {
        const idIn = encodeURIComponent('(' + reportIds.join(',') + ')');
        const aResp = await supabaseGet(env,
          'rental_report_remediation_attempts?report_id=in.' + idIn
          + '&select=report_id,action,outcome,attempted_at,attempt_no,mode'
          + '&order=attempted_at.desc&limit=2000');
        if (aResp.ok) {
          const attempts = await aResp.json();
          if (Array.isArray(attempts)) {
            for (const a of attempts) {
              const k = a.report_id;
              if (!attemptSummary[k]) {
                attemptSummary[k] = {
                  count: 0,
                  last_action: a.action || null,
                  last_outcome: a.outcome || null,
                  last_attempted_at: a.attempted_at || null,
                  last_mode: a.mode || null,
                };
              }
              attemptSummary[k].count += 1;
            }
          }
        }
      } catch (e) {
        console.log('[handleBadRentals] attempts summary fetch failed: ' + e);
      }
    }
    const flat = (Array.isArray(rows) ? rows : []).map(r => {
      const s = attemptSummary[r.id] || null;
      const currentE164 = r && r.sims && Array.isArray(r.sims.sim_numbers) && r.sims.sim_numbers[0]
        ? r.sims.sim_numbers[0].e164
        : null;
      const resellerRentalId = r && r.rentals ? r.rentals.reseller_rental_id : null;
      const rsn = r && r.report_sim_number ? r.report_sim_number : null;
      return {
        id: r.id,
        reseller_id: r.reseller_id,
        e164: r.e164,
        reason_code: r.reason_code,
        reason_note: r.reason_note,
        status: r.status,
        sim_id: r.sim_id,
        sim_number_id: r.sim_number_id,
        rental_id: r.rental_id,
        remediation_action: r.remediation_action,
        duplicate_of: r.duplicate_of,
        received_at: r.received_at,
        triaged_at: r.triaged_at,
        closed_at: r.closed_at,
        updated_at: r.updated_at,
        auto_remediation_state: r.auto_remediation_state || null,
        last_auto_attempt_at: r.last_auto_attempt_at || null,
        escalation_reason: r.escalation_reason || null,
        auto_attempts_count: s ? s.count : 0,
        auto_attempts_last_action: s ? s.last_action : null,
        auto_attempts_last_outcome: s ? s.last_outcome : null,
        auto_attempts_last_attempted_at: s ? s.last_attempted_at : null,
        auto_attempts_last_mode: s ? s.last_mode : null,
        resellers: r.resellers || null,
        iccid: r && r.sims ? r.sims.iccid : null,
        reseller_rental_id: resellerRentalId,
        current_e164: currentE164,
        report_sim_number_e164: rsn ? rsn.e164 : null,
        report_sim_number_valid_from: rsn ? rsn.valid_from : null,
        report_sim_number_valid_to: rsn ? rsn.valid_to : null,
      };
    });
    return new Response(JSON.stringify(flat), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// INC-17 / INC-16a — operator pause/resume of the bad-rental auto-remediator.
// targetState = 'operator_locked' to take over, or null to resume auto.
// Writes a rental_report_events audit row so the timeline shows the lock change.
async function handleBadRentalAutoLock(id, targetState, request, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }
    const actor = body.actor ? String(body.actor).slice(0, 120) : 'operator';
    const note = body.note ? String(body.note).slice(0, 500) : null;

    const curResp = await supabaseGet(env, 'rental_reports?id=eq.' + reportId + '&select=id,status,auto_remediation_state');
    if (!curResp.ok) {
      const txt = await curResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + curResp.status, detail: txt }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const curRows = await curResp.json();
    if (!Array.isArray(curRows) || curRows.length === 0) {
      return new Response(JSON.stringify({ error: 'report not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const prev = curRows[0].auto_remediation_state || null;
    const nowIso = new Date().toISOString();
    const patch = { auto_remediation_state: targetState, updated_at: nowIso };

    const patchResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rental_reports?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!patchResp.ok) {
      const txt = await patchResp.text();
      return new Response(JSON.stringify({ error: 'patch_failed', detail: txt }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const updated = await patchResp.json();

    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/rental_report_events`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          report_id: reportId,
          from_status: curRows[0].status,
          to_status: curRows[0].status,
          actor: actor,
          note: note,
          evidence: { auto_remediation_state_from: prev, auto_remediation_state_to: targetState },
        }),
      });
    } catch (e) {
      console.log('[BadRentalAutoLock] event log insert failed: ' + e);
    }
    return new Response(JSON.stringify({ ok: true, report: updated[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function callRemediator(env, path, init) {
  if (!env.BAD_RENTAL_REMEDIATOR) {
    return { ok: false, status: 500, body: { error: 'no_service_binding' } };
  }
  const url = 'https://bad-rental-remediator' + path;
  try {
    const resp = await env.BAD_RENTAL_REMEDIATOR.fetch(url, init);
    let body = null;
    try { body = await resp.json(); } catch (_) { body = null; }
    return { ok: resp.ok, status: resp.status, body };
  } catch (err) {
    return { ok: false, status: 502, body: { error: String(err) } };
  }
}

function remediatorSecret(env) {
  return env.BAD_RENTAL_REMEDIATOR_ADMIN_SECRET || env.ADMIN_RUN_SECRET || '';
}

async function logRemediatorControl(env, control, fromState, toState, actor) {
  // Audit to console only; rental_report_events.report_id is NOT NULL so it
  // cannot host worker-level control events. A dedicated audit table is
  // tracked as follow-up (INC §I.2 implementation note).
  console.log('[RemediatorControl] ' + JSON.stringify({ control, from: fromState, to: toState, actor: (actor || 'operator').slice(0, 120), at: new Date().toISOString() }));
}

async function handleRemediatorStatus(env, corsHeaders) {
  const secret = remediatorSecret(env);
  const r = await callRemediator(env, '/status?secret=' + encodeURIComponent(secret), { method: 'GET' });
  return new Response(JSON.stringify(r.body || { error: 'unknown' }), {
    status: r.ok ? 200 : r.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleRemediatorRunNow(request, env, corsHeaders) {
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const actor = body && body.actor ? String(body.actor).slice(0, 120) : 'operator';
  const secret = remediatorSecret(env);
  const r = await callRemediator(env, '/run?secret=' + encodeURIComponent(secret), { method: 'GET' });
  await logRemediatorControl(env, 'run_now', null, null, actor);
  return new Response(JSON.stringify(r.body || { error: 'unknown' }), {
    status: r.ok ? 200 : r.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleRemediatorKillSwitch(request, env, corsHeaders) {
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const enabled = body && body.enabled === true;
  const actor = body && body.actor ? String(body.actor).slice(0, 120) : 'operator';
  const secret = remediatorSecret(env);
  const before = await callRemediator(env, '/status?secret=' + encodeURIComponent(secret), { method: 'GET' });
  const fromState = before && before.body && before.body.status && before.body.status.kill_switch;
  const r = await callRemediator(env, '/kill-switch?secret=' + encodeURIComponent(secret), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (r.ok) {
    await logRemediatorControl(env, 'kill_switch', fromState || null, enabled ? 'enabled' : 'disabled', actor);
  }
  return new Response(JSON.stringify(r.body || { error: 'unknown' }), {
    status: r.ok ? 200 : r.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function handleResolveBadRental(id, request, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }

    const ALLOWED_ACTIONS = ['rotated', 'port_reset', 'sim_replaced', 'mdn_swapped', 'other'];
    const remediationAction = String(body.remediation_action || 'other').toLowerCase();
    if (!ALLOWED_ACTIONS.includes(remediationAction)) {
      return new Response(JSON.stringify({ error: 'remediation_action must be one of ' + ALLOWED_ACTIONS.join(',') }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const note = body.note ? String(body.note).slice(0, 500) : null;
    const actor = body.actor ? String(body.actor).slice(0, 120) : 'operator';

    // Fetch current report so we have from_status for the audit row and can refuse
    // to reopen-then-close already-closed reports.
    const curResp = await supabaseGet(env, 'rental_reports?id=eq.' + reportId + '&select=id,status');
    if (!curResp.ok) {
      const txt = await curResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + curResp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const curRows = await curResp.json();
    if (!Array.isArray(curRows) || curRows.length === 0) {
      return new Response(JSON.stringify({ error: 'report not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const fromStatus = curRows[0].status;
    if (fromStatus !== 'received' && fromStatus !== 'in_triage') {
      return new Response(JSON.stringify({ error: 'report is not open (status=' + fromStatus + ')' }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const nowIso = new Date().toISOString();
    const patch = {
      status: 'remediated',
      remediation_action: remediationAction,
      closed_at: nowIso,
      updated_at: nowIso,
    };
    if (fromStatus === 'received') patch.triaged_at = nowIso;

    const patchResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rental_reports?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!patchResp.ok) {
      const txt = await patchResp.text();
      return new Response(JSON.stringify({ error: 'patch_failed', detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const updated = await patchResp.json();

    // Append-only audit event. Best-effort; log but don't fail the request.
    try {
      await fetch(`${env.SUPABASE_URL}/rest/v1/rental_report_events`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          report_id: reportId,
          from_status: fromStatus,
          to_status: 'remediated',
          actor: actor,
          note: note,
          evidence: { remediation_action: remediationAction },
        }),
      });
    } catch (e) {
      console.log('[ResolveBadRental] event log insert failed: ' + e);
    }

    return new Response(JSON.stringify({ ok: true, report: updated[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// Log an error from any source into system_errors
// POST /api/bad-rentals/:id/update — operator edit for any rental_reports status
// transition. Validates against the same CHECK enums as the migration and
// writes a rental_report_events audit row for every change. Reopening a closed
// report (terminal → open) clears closed_at and remediation_action/duplicate_of
// so the row stays in a coherent state; the event log preserves the history.
async function handleUpdateBadRental(id, request, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }

    const ALLOWED_STATUSES = ['received','in_triage','remediated','unable_to_reproduce','duplicate'];
    const TERMINAL_STATUSES = ['remediated','unable_to_reproduce','duplicate'];
    const ALLOWED_ACTIONS = ['rotated','port_reset','sim_replaced','mdn_swapped','other'];

    const toStatus = body.status ? String(body.status).toLowerCase() : null;
    if (!toStatus || !ALLOWED_STATUSES.includes(toStatus)) {
      return new Response(JSON.stringify({ error: 'status must be one of ' + ALLOWED_STATUSES.join(',') }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const remediationActionRaw = body.remediation_action != null && body.remediation_action !== ''
      ? String(body.remediation_action).toLowerCase()
      : null;
    if (toStatus === 'remediated') {
      if (!remediationActionRaw || !ALLOWED_ACTIONS.includes(remediationActionRaw)) {
        return new Response(JSON.stringify({ error: 'remediation_action required for status=remediated; one of ' + ALLOWED_ACTIONS.join(',') }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    } else if (remediationActionRaw && !ALLOWED_ACTIONS.includes(remediationActionRaw)) {
      return new Response(JSON.stringify({ error: 'remediation_action must be one of ' + ALLOWED_ACTIONS.join(',') }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let duplicateOf = null;
    if (body.duplicate_of != null && body.duplicate_of !== '') {
      const n = parseInt(body.duplicate_of, 10);
      if (!Number.isFinite(n) || n <= 0) {
        return new Response(JSON.stringify({ error: 'duplicate_of must be a positive integer' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (n === reportId) {
        return new Response(JSON.stringify({ error: 'duplicate_of cannot reference the report itself' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      duplicateOf = n;
    }

    const note = body.note ? String(body.note).slice(0, 500) : null;
    const actor = body.actor ? String(body.actor).slice(0, 120) : 'operator';

    const curResp = await supabaseGet(env, 'rental_reports?id=eq.' + reportId + '&select=id,status,triaged_at,closed_at,remediation_action,duplicate_of');
    if (!curResp.ok) {
      const txt = await curResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + curResp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const curRows = await curResp.json();
    if (!Array.isArray(curRows) || curRows.length === 0) {
      return new Response(JSON.stringify({ error: 'report not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const cur = curRows[0];
    const fromStatus = cur.status;

    const nowIso = new Date().toISOString();
    const patch = { status: toStatus, updated_at: nowIso };

    if (fromStatus === 'received' && toStatus !== 'received' && !cur.triaged_at) {
      patch.triaged_at = nowIso;
    }
    if (TERMINAL_STATUSES.includes(toStatus)) {
      patch.closed_at = cur.closed_at || nowIso;
    } else {
      patch.closed_at = null;
    }

    if (toStatus === 'remediated') {
      patch.remediation_action = remediationActionRaw;
      patch.duplicate_of = null;
    } else if (toStatus === 'duplicate') {
      patch.remediation_action = null;
      patch.duplicate_of = duplicateOf;
    } else {
      patch.remediation_action = null;
      patch.duplicate_of = null;
    }

    const patchResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rental_reports?id=eq.${reportId}`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    });
    if (!patchResp.ok) {
      const txt = await patchResp.text();
      return new Response(JSON.stringify({ error: 'patch_failed', detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const updated = await patchResp.json();

    try {
      const evidence = {};
      if (patch.remediation_action) evidence.remediation_action = patch.remediation_action;
      if (patch.duplicate_of) evidence.duplicate_of = patch.duplicate_of;
      await fetch(`${env.SUPABASE_URL}/rest/v1/rental_report_events`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          report_id: reportId,
          from_status: fromStatus,
          to_status: toStatus,
          actor: actor,
          note: note,
          evidence: Object.keys(evidence).length ? evidence : null,
        }),
      });
    } catch (e) {
      console.log('[UpdateBadRental] event log insert failed: ' + e);
    }

    return new Response(JSON.stringify({ ok: true, report: updated[0] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/bad-rentals/:id/report — returns the parsed report row, the
// raw JSON body the reseller sent (rental_reports.raw_payload, captured
// since the 2026-06-04 diagnostics migration) and the audit timeline.
// For rows that predate the migration raw_payload is NULL and storage_note
// carries a legacy-row explanation for the operator UI.
async function handleBadRentalReport(id, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const reportSelect = [
      'id','reseller_id','rental_id','sim_id','sim_number_id','e164',
      'reason_code','reason_note','attempts','first_attempt_at','client_request_id',
      'status','remediation_action','duplicate_of',
      'received_at','triaged_at','closed_at','updated_at',
      'raw_payload','source',
      'auto_remediation_state','last_auto_attempt_at','escalation_reason',
      'resellers(name)',
      'rentals(reseller_rental_id)',
    ].join(',');
    const repResp = await supabaseGet(env, 'rental_reports?id=eq.' + reportId + '&select=' + encodeURIComponent(reportSelect));
    if (!repResp.ok) {
      const txt = await repResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + repResp.status, detail: txt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const reps = await repResp.json();
    if (!Array.isArray(reps) || reps.length === 0) {
      return new Response(JSON.stringify({ error: 'report not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const report = reps[0];

    const evResp = await supabaseGet(env,
      'rental_report_events?report_id=eq.' + reportId +
      '&select=id,from_status,to_status,actor,note,evidence,created_at' +
      '&order=created_at.asc&limit=200');
    let events = [];
    if (evResp.ok) {
      const j = await evResp.json();
      if (Array.isArray(j)) events = j;
    }

    // raw_payload was added by the 2026-06-04 diagnostics migration. Older
    // reports inserted before that column existed will have NULL — surface a
    // precise legacy note for those rows only.
    const hasRawPayload = report && report.raw_payload != null;
    const storageNote = hasRawPayload ? null
      : 'Raw HTTP webhook body was not captured for this report (received before the 2026-06-04 diagnostics migration). The parsed report columns and audit timeline below are the most complete record available.';

    // INC-23 — auto-remediation attempts table (one row per attempted action).
    let attempts = [];
    try {
      const aResp = await supabaseGet(env,
        'rental_report_remediation_attempts?report_id=eq.' + reportId
        + '&select=id,attempt_no,mode,action,attempted_at,outcome,evidence,error_message,next_review_at'
        + '&order=attempted_at.desc&limit=200');
      if (aResp.ok) {
        const j = await aResp.json();
        if (Array.isArray(j)) attempts = j;
      }
    } catch (e) {
      console.log('[handleBadRentalReport] attempts fetch failed: ' + e);
    }

    // INC-23 — surface a Paperclip escalation link if any event evidence carries it.
    // Wired forward-compatibly: INC-16f will populate one of these keys.
    let escalation = null;
    try {
      for (const ev of events) {
        const ev_e = ev && ev.evidence;
        if (!ev_e || typeof ev_e !== 'object') continue;
        const url = ev_e.escalation_issue_url || ev_e.paperclip_issue_url || null;
        const issueId = ev_e.escalation_issue_id || ev_e.paperclip_issue_id || null;
        if (url || issueId) {
          escalation = {
            url: url || null,
            issue_id: issueId || null,
            reason: ev_e.escalation_reason || report.escalation_reason || null,
            event_at: ev.created_at || null,
          };
          break;
        }
      }
      if (!escalation && report.escalation_reason) {
        escalation = { url: null, issue_id: null, reason: report.escalation_reason, event_at: null };
      }
    } catch (_) { /* tolerate any shape */ }

    return new Response(JSON.stringify({ report, events, attempts, escalation, storage_note: storageNote }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleLogError(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { source, action, sim_id, iccid, error_message, error_details, severity } = body;
    if (!source || !error_message) {
      return new Response(JSON.stringify({ error: 'source and error_message required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    await logSystemError(env, { source, action, sim_id, iccid, error_message, error_details, severity });
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Mark system_errors as resolved
async function handleResolveError(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { error_ids, resolution_notes } = body;
    if (!error_ids || !Array.isArray(error_ids) || error_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'error_ids array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Filter out legacy sim_ IDs and rotation rot_ IDs and handle them separately
    const systemIds = error_ids.filter(id => typeof id === 'number');
    const legacySimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('sim_')).map(id => parseInt(id.replace('sim_', '')));
    const rotationSimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('rot_')).map(id => parseInt(id.replace('rot_', '')));

    // Resolve system errors
    if (systemIds.length > 0) {
      const idsParam = systemIds.map(id => `id.eq.${id}`).join(',');
      await fetch(`${env.SUPABASE_URL}/rest/v1/system_errors?or=(${idsParam})`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolved_by: 'admin',
          resolution_notes: resolution_notes || null,
        }),
      });
    }

    // Clear last_activation_error for legacy SIM errors
    if (legacySimIds.length > 0) {
      for (const simId of legacySimIds) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/sims?id=eq.${simId}`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_activation_error: null }),
        });
      }
    }

    // Clear last_rotation_error for rotation SIM errors
    if (rotationSimIds.length > 0) {
      for (const simId of rotationSimIds) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/sims?id=eq.${simId}`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_rotation_error: null }),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, resolved: systemIds.length + legacySimIds.length + rotationSimIds.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Reset SIMs back to provisioning so details-finalizer re-processes them
async function handleSetSimStatus(request, env, corsHeaders) {
  const body = await request.json();
  const { sim_id, status } = body;
  const validStatuses = ['provisioning', 'active', 'suspended', 'canceled', 'error', 'pending', 'helix_timeout', 'data_mismatch'];
  if (!sim_id || !status) {
    return new Response(JSON.stringify({ error: 'sim_id and status required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  if (!validStatuses.includes(status)) {
    return new Response(JSON.stringify({ error: 'Invalid status. Valid: ' + validStatuses.join(', ') }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const res = await fetch(
    env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + encodeURIComponent(String(sim_id)),
    {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    return new Response(JSON.stringify({ error: 'DB error: ' + text }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ ok: true, sim_id, status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleResetToProvisioning(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { sim_ids } = body;
    if (!Array.isArray(sim_ids) || sim_ids.length === 0) {
      return new Response(JSON.stringify({ error: 'sim_ids array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const idList = sim_ids.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (idList.length === 0) {
      return new Response(JSON.stringify({ error: 'No valid sim_ids' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const patchUrl = `${env.SUPABASE_URL}/rest/v1/sims?id=in.(${idList.join(',')})`;
    const res = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ status: 'provisioning', activated_at: null }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: `Supabase error: ${errText}` }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const updated = await res.json();
    const count = Array.isArray(updated) ? updated.length : idList.length;
    return new Response(JSON.stringify({ ok: true, reset: count }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Assign SIM to reseller
async function handleAssignReseller(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { sim_id, reseller_id } = body;
    if (!sim_id || !reseller_id) {
      return new Response(JSON.stringify({ error: 'sim_id and reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    // Deactivate any existing active assignment
    await fetch(`${env.SUPABASE_URL}/rest/v1/reseller_sims?sim_id=eq.${sim_id}&active=eq.true`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ active: false }),
    });
    // Upsert new assignment (handles existing inactive row from prior assignment)
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/reseller_sims?on_conflict=reseller_id,sim_id`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ sim_id, reseller_id, active: true }),
    });
    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: err }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Unassign SIMs from reseller
async function handleSetRotationEligible(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const simIds = Array.isArray(body.sim_ids) ? body.sim_ids.map(Number).filter(Boolean) : [];
    const eligible = body.eligible === true;
    if (simIds.length === 0) {
      return new Response(JSON.stringify({ error: 'sim_ids array required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Single PATCH against sims?id=in.(...) — atomic, one round-trip.
    const url = `${env.SUPABASE_URL}/rest/v1/sims?id=in.(${simIds.join(',')})`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ rotation_eligible: eligible }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      return new Response(JSON.stringify({ error: 'Supabase PATCH ' + res.status + ': ' + text.slice(0, 200) }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const updated = Array.isArray(data) ? data.length : 0;
    return new Response(JSON.stringify({ ok: true, updated, eligible }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleUnassignReseller(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const simIds = body.sim_ids || [];
    if (!Array.isArray(simIds) || simIds.length === 0) {
      return new Response(JSON.stringify({ error: 'sim_ids array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let unassigned = 0;
    for (const simId of simIds) {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/reseller_sims?sim_id=eq.${simId}&active=eq.true`, {
        method: 'PATCH',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ active: false }),
      });
      if (res.ok) {
        const updated = await res.json();
        if (updated.length > 0) unassigned++;
      }
    }

    return new Response(JSON.stringify({ ok: true, unassigned }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleDeleteSim(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const simId = parseInt(body.sim_id);
    if (!simId) {
      return new Response(JSON.stringify({ error: 'sim_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const base = env.SUPABASE_URL + '/rest/v1';
    const h = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    };
    // Nullify sim_id in system_errors (nullable FK — preserve the error log)
    await fetch(base + '/system_errors?sim_id=eq.' + simId, {
      method: 'PATCH',
      headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ sim_id: null }),
    });
    // Delete all child records in dependency order
    for (const table of ['sim_numbers', 'inbound_sms', 'reseller_sims', 'sim_status_history']) {
      await fetch(base + '/' + table + '?sim_id=eq.' + simId, { method: 'DELETE', headers: h });
    }
    // Delete the SIM itself
    const del = await fetch(base + '/sims?id=eq.' + simId, { method: 'DELETE', headers: h });
    if (!del.ok) {
      const errText = await del.text();
      return new Response(JSON.stringify({ error: 'Failed to delete SIM: ' + errText }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, deleted: simId }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// Helper: insert a row into system_errors
function parseImeiPoolConflict(status, bodyText) {
  if (status !== 409 && status !== 422) return null;
  let parsed;
  try { parsed = JSON.parse(bodyText); } catch { return null; }
  if (parsed.code !== '23505') return null;
  const msg = parsed.message || '';
  const det = parsed.details || '';
  if (msg.includes('imei_pool_unique_in_use_sim')) {
    const m = det.match(/sim_id\)=\((\d+)\)/);
    const simPart = m ? ' (SIM #' + m[1] + ')' : '';
    return 'IMEI pool conflict: SIM' + simPart + ' already has an active (in_use) IMEI entry. ' +
           'The old entry must be retired before assigning a new one. Check the IMEI Pool tab.';
  }
  if (msg.includes('imei_pool_unique_in_use_slot')) {
    const m = det.match(/gateway_id, port\)=\(([^)]+)\)/);
    const slotPart = m ? ' (gateway/port ' + m[1] + ')' : '';
    return 'IMEI pool conflict: gateway slot' + slotPart + ' already has an active (in_use) IMEI entry. ' +
           'The existing slot entry must be retired first. Check the IMEI Pool tab.';
  }
  return 'IMEI pool unique conflict: ' + (parsed.message || bodyText.slice(0, 200));
}

async function logSystemError(env, { source, action, sim_id, iccid, error_message, error_details, severity }) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/system_errors`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        source: source || 'unknown',
        action: action || null,
        sim_id: sim_id || null,
        iccid: iccid || null,
        error_message: error_message || 'Unknown error',
        error_details: error_details || null,
        severity: severity || 'error',
        status: 'open',
      }),
    });
  } catch (e) {
    console.error('[logSystemError] Failed to log error:', e);
  }
}

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const vendor = logData.vendor || 'unknown';
  const payload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    vendor,
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_body_text: (logData.response_body_text || '').slice(0, 5000),
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };
  console.log('[' + vendor.toUpperCase() + ' API] ' + logData.request_method + ' ' + logData.request_url + ' -> ' + logData.response_status + ' ' + (logData.response_ok ? 'OK' : 'FAIL'));
  try {
    const res = await fetch(env.SUPABASE_URL + '/rest/v1/carrier_api_logs', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('[Carrier Log] Supabase failed: ' + res.status);
  } catch (e) {
    console.error('[Carrier Log] Failed to log:', e);
  }
}

async function handleImeiGatewaySync(request, env, corsHeaders) {
  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const workerUrl = `https://mdn-rotator/imei-gateway-sync?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const responseText = await workerResponse.text();
  let result;
  try { result = JSON.parse(responseText); } catch {
    result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: workerResponse.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleImeiSweep(env, corsHeaders) {
  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const workerUrl = `https://mdn-rotator/imei-sweep?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, { method: 'POST' });
  const responseText = await workerResponse.text();
  let result;
  try { result = JSON.parse(responseText); } catch {
    result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: workerResponse.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleTriggerBlimeiSweep(env, corsHeaders) {
  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const workerUrl = `https://mdn-rotator/trigger-blimei-sweep?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, { method: 'POST' });
  const responseText = await workerResponse.text();
  let result;
  try { result = JSON.parse(responseText); } catch {
    result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: workerResponse.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleSyncGatewaySlots(request, env, corsHeaders) {
  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const gateway_id = body.gateway_id ? parseInt(body.gateway_id) : null;
  if (!gateway_id) return new Response(JSON.stringify({ error: 'gateway_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const workerUrl = `https://mdn-rotator/sync-gateway-slots?gateway_id=${gateway_id}&secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, { method: 'POST' });
  const responseText = await workerResponse.text();
  let result;
  try { result = JSON.parse(responseText); } catch {
    result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: workerResponse.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleSimAction(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { sim_id, action } = body;
    if (!sim_id || !action) return new Response(JSON.stringify({ error: 'sim_id and action required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Teltik rotate is handled by teltik-worker, not mdn-rotator. Look up vendor first.
    if (action === 'rotate') {
      const vendorRes = await supabaseGet(env, `sims?select=iccid,vendor&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`);
      const vendorRows = await vendorRes.json().catch(() => []);
      const row = Array.isArray(vendorRows) && vendorRows[0] ? vendorRows[0] : null;
      if (row && row.vendor === 'teltik') {
        if (!env.TELTIK_WORKER) return new Response(JSON.stringify({ ok: false, error: 'TELTIK_WORKER not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const tUrl = `https://teltik-worker/rotate-sim?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}&iccid=${encodeURIComponent(row.iccid)}&force=${body.force === true ? 'true' : 'false'}`;
        const tRes = await env.TELTIK_WORKER.fetch(tUrl, { method: 'POST' });
        const tText = await tRes.text();
        let tResult; try { tResult = JSON.parse(tText); } catch { tResult = { ok: false, error: `Non-JSON response: ${tText.slice(0, 200)}` }; }
        if (!tResult.ok && tResult.error) {
          await logSystemError(env, { source: 'dashboard', action: 'rotate', sim_id, error_message: tResult.error, error_details: { vendor: 'teltik', response: tResult, status: tRes.status } });
        }
        return new Response(JSON.stringify({ ok: tResult.ok, action, sim_id, iccid: row.iccid, forced: body.force === true, vendor: 'teltik', detail: tResult }, null, 2), { status: tRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Teltik "OTA refresh" maps to Teltik /v1/reset-port (operator label only; on the
    // wire it is a gateway port reset, not a carrier OTA). Non-Teltik SIMs fall through
    // to the existing mdn-rotator ota_refresh path.
    if (action === 'ota_refresh') {
      const vendorRes = await supabaseGet(env, `sims?select=iccid,vendor,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`);
      const vendorRows = await vendorRes.json().catch(() => []);
      const row = Array.isArray(vendorRows) && vendorRows[0] ? vendorRows[0] : null;
      if (row && row.vendor === 'teltik') {
        const apiKey = env.TELTIK_API_KEY;
        if (!apiKey) return new Response(JSON.stringify({ ok: false, error: 'TELTIK_API_KEY not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // Resolve MDN: prefer DB, fall back to live Teltik /v1/get-phone-number lookup
        // by ICCID so a stale or missing sim_numbers row doesn't break the operator action.
        let rawMdn = row.sim_numbers && row.sim_numbers[0] && row.sim_numbers[0].e164;
        let mdnSource = 'db';
        let mdnLookupError = null;
        if (!rawMdn && row.iccid) {
          try {
            const gpUrl = `https://api.smsgateway.xyz/v1/get-phone-number/?apikey=${encodeURIComponent(apiKey)}&iccid=${encodeURIComponent(row.iccid)}`;
            const gpFetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + gpUrl : gpUrl;
            const gpHeaders = {};
            if (env.RELAY_KEY) gpHeaders['x-relay-key'] = env.RELAY_KEY;
            const gpRes = await fetch(gpFetchUrl, { method: 'GET', headers: gpHeaders });
            const gpText = await gpRes.text();
            let gpJson = null; try { gpJson = JSON.parse(gpText); } catch {}
            if (gpRes.ok && gpJson) {
              rawMdn = gpJson.msisdn || gpJson.mdn || gpJson.phone_number || null;
              if (rawMdn) mdnSource = 'teltik_live';
            } else {
              mdnLookupError = `get-phone-number HTTP ${gpRes.status}: ${(gpJson && (gpJson.message || gpJson.error)) || gpText.slice(0, 120)}`;
            }
          } catch (e) {
            mdnLookupError = `get-phone-number exception: ${e && e.message ? e.message : String(e)}`;
          }
        }
        if (!rawMdn) {
          const err = `No MDN for Teltik SIM ${row.iccid}, cannot reset port` + (mdnLookupError ? ` (${mdnLookupError})` : '');
          return new Response(JSON.stringify({ ok: false, error: err, action, sim_id, iccid: row.iccid, vendor: 'teltik' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        // Teltik /reset-port requires the bare 10-digit US number — not +1XXXXXXXXXX
        // and not 11 digits with the country code. Strip non-digits, then drop a
        // leading '1' when it produces an 11-digit US MDN.
        const mdnDigits = toTeltik10Digit(rawMdn);

        const teltikUrl = `https://api.smsgateway.xyz/v1/reset-port?apikey=${encodeURIComponent(apiKey)}&mdn=${encodeURIComponent(mdnDigits)}`;
        const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + teltikUrl : teltikUrl;
        const fetchHeaders = {};
        if (env.RELAY_KEY) fetchHeaders['x-relay-key'] = env.RELAY_KEY;
        const tRes = await fetch(fetchUrl, { method: 'GET', headers: fetchHeaders });
        const tText = await tRes.text();
        let tJson = null; try { tJson = JSON.parse(tText); } catch {}
        // Teltik can return 200 with { success: false, message: ... } so check both HTTP and body.
        const bodySuccess = !tJson || tJson.success !== false;
        const ok = tRes.ok && bodySuccess;
        const teltikMsg = (tJson && (tJson.message || tJson.error)) || (!tRes.ok ? `HTTP ${tRes.status}` : null) || (tText ? tText.slice(0, 200) : null);
        await logCarrierApiCall(env, {
          run_id: `teltik_reset_port_${row.iccid}_${Date.now()}`,
          step: 'reset_port',
          iccid: row.iccid,
          imei: null,
          vendor: 'teltik',
          request_url: `https://api.smsgateway.xyz/v1/reset-port?mdn=${encodeURIComponent(mdnDigits)}`,
          request_method: 'GET',
          request_body: null,
          response_status: tRes.status,
          response_ok: tRes.ok,
          response_body_text: tText,
          response_body_json: tJson,
          error: ok ? null : `Teltik reset-port failed: ${teltikMsg || 'unknown'}`,
        });
        if (!ok) {
          await logSystemError(env, { source: 'dashboard', action: 'ota_refresh', sim_id, error_message: `Teltik reset-port: ${teltikMsg || 'unknown'}`, error_details: { vendor: 'teltik', response: tJson || tText, status: tRes.status, mdn_source: mdnSource } });
        }
        const respBody = { ok, action, sim_id, iccid: row.iccid, mdn: mdnDigits, mdn_source: mdnSource, vendor: 'teltik', http_status: tRes.status, detail: tJson || tText };
        if (!ok) respBody.error = `Teltik reset-port: ${teltikMsg || 'unknown'}`;
        if (ok && tJson && tJson.message) respBody.message = tJson.message;
        return new Response(JSON.stringify(respBody, null, 2), { status: ok ? 200 : (tRes.status >= 400 ? tRes.status : 502), headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const workerUrl = `https://mdn-rotator/sim-action?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false, imei_strategy: body.imei_strategy ?? null, force: body.force === true })
    });

    const responseText = await workerResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch {
      result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };
    }

    // Log action errors to system_errors
    if (!result.ok && result.error) {
      await logSystemError(env, {
        source: 'dashboard',
        action: action,
        sim_id: sim_id,
        error_message: result.error,
        error_details: { request: { sim_id, action }, response: result, status: workerResponse.status },
      });
    }

    return new Response(JSON.stringify(result, null, 2), {
      status: workerResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    await logSystemError(env, {
      source: 'dashboard',
      action: 'sim_action',
      error_message: String(error),
    });
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleCheckImei(request, env, corsHeaders, url) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const imei = url.searchParams.get('imei') || '';
    if (!/^\d{15}$/.test(imei)) {
      return new Response(JSON.stringify({ error: 'imei must be 15 digits' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const checkUrl = 'https://mdn-rotator/check-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET) + '&imei=' + encodeURIComponent(imei);
    const workerRes = await env.MDN_ROTATOR.fetch(checkUrl, { method: 'GET' });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleCheckImeis(request, env, corsHeaders) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await request.json().catch(() => ({}));
    const checkUrl = 'https://mdn-rotator/check-imeis?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET);
    const workerRes = await env.MDN_ROTATOR.fetch(checkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleFixIncompatibleImei(request, env, corsHeaders) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await request.json().catch(() => ({}));
    const fixUrl = 'https://mdn-rotator/fix-incompatible-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET);
    const workerRes = await env.MDN_ROTATOR.fetch(fixUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleQboRoute(request, env, corsHeaders, url) {
  try {
    if (!env.QUICKBOOKS) return new Response(JSON.stringify({ error: 'QUICKBOOKS binding not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const qboPath = url.pathname.replace('/api/qbo', '');
    const qboUrl = new URL(`https://quickbooks${qboPath}${url.search}`);

    const workerResponse = await env.QUICKBOOKS.fetch(qboUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' ? await request.text() : undefined,
    });

    const responseText = await workerResponse.text();
    return new Response(responseText, {
      status: workerResponse.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleSimWebhooks(env, corsHeaders, url) {
  try {
    const simId = parseInt(url.searchParams.get('sim_id') || '0', 10);
    if (!simId) {
      return new Response(JSON.stringify({ error: 'sim_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // webhook_deliveries.payload is jsonb shaped like { data: { sim_id, iccid, number, ... } }
    // Use PostgREST nested JSON path filter. The `cs.{json}` containment form
    // (previously tried) silently returned 0 rows here, even though the
    // equivalent SQL `payload @> jsonb` matches — see /api/sim-webhooks 2026-05-21.
    const q = `webhook_deliveries?select=id,event_type,reseller_id,webhook_url,payload,status,attempts,last_attempt_at,delivered_at,created_at,response_body&event_type=eq.number.online&payload->data->>sim_id=eq.${simId}&order=created_at.desc&limit=50`;
    const res = await supabaseGet(env, q);
    const rows = await res.json().catch(() => []);
    const deliveries = Array.isArray(rows) ? rows : [];
    return new Response(JSON.stringify({ ok: true, sim_id: simId, count: deliveries.length, deliveries }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleResellerKeysList(url, env, corsHeaders) {
  try {
    const resellerId = url.searchParams.get('reseller_id');
    let q = 'reseller_api_keys?select=id,reseller_id,api_key,enabled,created_at,resellers(name)&order=created_at.desc';
    if (resellerId) q += '&reseller_id=eq.' + encodeURIComponent(resellerId);
    const resp = await supabaseGet(env, q);
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: 'lookup failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const rows = await resp.json();
    const out = (Array.isArray(rows) ? rows : []).map(r => ({
      id: r.id,
      reseller_id: r.reseller_id,
      reseller_name: r.resellers?.name || null,
      api_key_masked: maskApiKey(r.api_key),
      enabled: r.enabled,
      created_at: r.created_at,
    }));
    return new Response(JSON.stringify(out), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function maskApiKey(k) {
  if (!k || k.length < 8) return '****';
  return k.slice(0, 9) + '…' + k.slice(-4);
}

function generateApiKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'rsk_live_' + hex;
}

async function handleResellerKeysCreate(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const resellerId = body.reseller_id;
    if (!resellerId) {
      return new Response(JSON.stringify({ error: 'reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const checkResp = await supabaseGet(env, 'resellers?select=id&id=eq.' + encodeURIComponent(resellerId) + '&limit=1');
    const checkRows = await checkResp.json();
    if (!Array.isArray(checkRows) || checkRows.length === 0) {
      return new Response(JSON.stringify({ error: 'reseller not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const apiKey = generateApiKey();
    const insertResp = await fetch(env.SUPABASE_URL + '/rest/v1/reseller_api_keys', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ reseller_id: resellerId, api_key: apiKey, enabled: true }),
    });
    if (!insertResp.ok) {
      const txt = await insertResp.text();
      return new Response(JSON.stringify({ error: 'insert failed: ' + txt }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const inserted = await insertResp.json();
    const row = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
    return new Response(JSON.stringify({
      id: row?.id,
      reseller_id: resellerId,
      api_key: apiKey,
      enabled: true,
      created_at: row?.created_at,
      note: 'This key is shown once. Copy it now and deliver to the reseller securely.',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleResellerKeysRevoke(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const id = body.id;
    if (!id) {
      return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/reseller_api_keys?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ enabled: false }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return new Response(JSON.stringify({ error: 'revoke failed: ' + txt }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// PBKDF2-SHA256 password hashing for the reseller-portal login flow.
// Format must stay in sync with src/reseller-portal/index.js verifyPassword.
const RP_PBKDF2_ITERS = 100000;
function _u8ToB64(u8) { return btoa(String.fromCharCode.apply(null, u8)); }
async function hashResellerPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: RP_PBKDF2_ITERS, hash: 'SHA-256' },
    km, 256
  );
  return 'pbkdf2_sha256$' + RP_PBKDF2_ITERS + '$' + _u8ToB64(salt) + '$' + _u8ToB64(new Uint8Array(bits));
}

async function handleResellerCredentials(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const resellerId = body.reseller_id;
    const username = (body.username || '').trim().toLowerCase();
    const password = body.password || '';
    if (!resellerId) return new Response(JSON.stringify({ error: 'reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!username || !/^[a-z0-9._-]{3,40}$/.test(username)) return new Response(JSON.stringify({ error: 'username must be 3-40 chars: a-z, 0-9, . _ -' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const hasPassword = !!password;
    if (hasPassword && password.length < 8) return new Response(JSON.stringify({ error: 'password must be at least 8 characters' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Reject duplicate username for a different reseller.
    const dupResp = await supabaseGet(env, 'resellers?select=id&username=eq.' + encodeURIComponent(username) + '&id=neq.' + encodeURIComponent(resellerId) + '&limit=1');
    const dupRows = dupResp.ok ? await dupResp.json() : [];
    if (Array.isArray(dupRows) && dupRows.length > 0) {
      return new Response(JSON.stringify({ error: 'username already in use by another reseller' }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const update = { username };
    if (hasPassword) {
      update.password_hash = await hashResellerPassword(password);
      update.password_updated_at = new Date().toISOString();
    }
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/resellers?id=eq.' + encodeURIComponent(resellerId), {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(update),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return new Response(JSON.stringify({ error: 'update failed: ' + txt }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, reseller_id: Number(resellerId), username, password_changed: hasPassword }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleResellerCredentialsList(env, corsHeaders) {
  try {
    const resp = await supabaseGet(env, 'resellers?select=id,name,username,password_hash,password_updated_at&order=name.asc');
    if (!resp.ok) return new Response(JSON.stringify({ error: 'lookup failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const rows = await resp.json();
    const out = (Array.isArray(rows) ? rows : []).map(function(r){
      return {
        reseller_id: r.id,
        reseller_name: r.name || ('#' + r.id),
        username: r.username || null,
        has_password: !!r.password_hash,
        password_updated_at: r.password_updated_at || null,
      };
    });
    return new Response(JSON.stringify(out), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleQboMappingsGet(env, corsHeaders) {
  try {
    const query = `qbo_customer_map?select=id,reseller_id,customer_name,qbo_customer_id,qbo_display_name,daily_rate,resellers(name)&order=id.desc`;
    const response = await supabaseGet(env, query);
    const data = await response.json();
    const mapped = (Array.isArray(data) ? data : []).map(m => ({
      ...m,
      reseller_name: m.resellers?.name || null,
    }));
    return new Response(JSON.stringify(mapped), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleQboMappingsPost(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { reseller_id, qbo_customer_id, qbo_display_name, daily_rate } = body;
    if (!qbo_customer_id) return new Response(JSON.stringify({ error: 'qbo_customer_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const insertResp = await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_customer_map`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ reseller_id: reseller_id || null, qbo_customer_id, qbo_display_name, daily_rate: daily_rate || 0.50 }),
    });
    const inserted = await insertResp.json();
    return new Response(JSON.stringify(inserted), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleQboMappingsDelete(url, env, corsHeaders) {
  try {
    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_customer_map?id=eq.${id}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function handleQboInvoicesGet(env, corsHeaders) {
  try {
    const query = `qbo_invoices?select=id,week_start,week_end,sim_count,total,status,paid_at,error_message,qbo_customer_map(qbo_display_name)&order=created_at.desc&limit=50`;
    const response = await supabaseGet(env, query);
    const data = await response.json();
    const mapped = (Array.isArray(data) ? data : []).map(inv => ({
      ...inv,
      customer_name: inv.qbo_customer_map?.qbo_display_name || null,
    }));
    return new Response(JSON.stringify(mapped), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}


async function handleQboInvoicePatch(request, env, corsHeaders, url) {
  try {
    const id = url.pathname.split('/').pop();
    if (!id || !/^\d+$/.test(id)) return new Response(JSON.stringify({ error: 'invalid id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const body = await request.json();
    const patch = {};
    if (typeof body.paid === 'boolean') {
      if (body.paid) {
        patch.status = 'paid';
        patch.paid_at = new Date().toISOString();
      } else {
        patch.status = 'draft';
        patch.paid_at = null;
      }
    }
    if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'nothing to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/qbo_invoices?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: 'update failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true, ...patch }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleQboInvoicePreview(url, env, corsHeaders) {
  // Legacy stub – replaced by /api/billing/preview
  return new Response(JSON.stringify({ error: 'Use /api/billing/preview' }), { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleBillingPreview(url, env, corsHeaders) {
  try {
    const resellerId = url.searchParams.get('reseller_id');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !start || !end) {
      return new Response(JSON.stringify({ error: 'reseller_id, start, end required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const result = await computeBillingBreakdown(env, { resellerId, start, end });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
async function handleUtilization(url, env, corsHeaders) {
  try {
    const resellerId = url.searchParams.get('reseller_id');
    const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const vendorParam = url.searchParams.get('vendor');
    if (!resellerId) {
      return new Response(JSON.stringify({ error: 'reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    // Window: last `days` calendar days in EST, inclusive of today.
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const now = new Date();
    const end = fmt.format(now);
    const startD = new Date(now.getTime());
    startD.setUTCDate(startD.getUTCDate() - (days - 1));
    const start = fmt.format(startD);
    const vendors = vendorParam ? vendorParam.split(',').map(s => s.trim()).filter(Boolean) : null;
    const result = await computeResellerUtilization(env, { resellerId, start, end, vendors });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleBillingCreateInvoice(request, env, corsHeaders) {
  // Kept for backward compatibility but no longer called by the UI.
  return new Response(JSON.stringify({ error: 'Use /api/billing/download-invoice' }), { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function buildCSV(customerName, start, end, days, dailyRate) {
  // QuickBooks Online invoice import CSV format
  const csvField = v => '"' + String(v).replace(/"/g, '""') + '"';
  const rows = [];
  rows.push([
    'InvoiceNo', 'Customer', 'InvoiceDate', 'DueDate', 'Terms',
    'ServiceDate', 'ProductService', 'Description', 'Item Quantity', 'Rate', 'Amount'
  ].map(csvField).join(','));

  // Format date as MM/DD/YYYY for QBO
  const fmtDate = iso => {
    const [y, m, d] = iso.split('-');
    return m + '/' + d + '/' + y;
  };

  const invoiceNo = 'INV-' + start.replace(/-/g, '') + '-' + end.replace(/-/g, '');
  for (const d of days) {
    rows.push([
      invoiceNo,
      customerName,
      fmtDate(end),
      fmtDate(end),
      'Due on receipt',
      d.date ? fmtDate(d.date) : fmtDate(end),
      'US Business phone Rental',
      '',
      d.sim_count,
      (d.rate !== undefined ? d.rate : dailyRate).toFixed(2),
      d.amount.toFixed(2),
    ].map(csvField).join(','));
  }

  return rows.join('\r\n') + '\r\n';
}

async function handleBillingDownloadInvoice(url, env, corsHeaders) {
  try {
    const invoiceId = url.searchParams.get('invoice_id');

    if (invoiceId) {
      // Re-download an existing invoice from history (single summary line item)
      const invResp = await supabaseGet(env,
        'qbo_invoices?select=id,week_start,week_end,sim_count,total,qbo_customer_map(qbo_display_name,daily_rate)&id=eq.' + encodeURIComponent(invoiceId) + '&limit=1'
      );
      const invData = await invResp.json();
      const inv = Array.isArray(invData) && invData[0] ? invData[0] : null;
      if (!inv) {
        return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const customerName = inv.qbo_customer_map?.qbo_display_name || 'Customer';
      const dailyRate = parseFloat(inv.qbo_customer_map?.daily_rate || 0);
      const totalAmount = parseFloat(inv.total);
      // For re-download we don't have day-by-day breakdown, use a single summary line
      const days = [{ sim_count: inv.sim_count, amount: totalAmount }];
      const csv = buildCSV(customerName, inv.week_start, inv.week_end, days, dailyRate);
      const filename = 'invoice_' + customerName.replace(/[^a-z0-9]/gi, '_') + '_' + inv.week_start + '_' + inv.week_end + '.csv';
      return new Response(csv, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="' + filename + '"',
        },
      });
    }

    // New invoice: reseller_id + start + end
    const resellerId = url.searchParams.get('reseller_id');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !start || !end) {
      return new Response(JSON.stringify({ error: 'reseller_id, start, end required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const breakdown = await computeBillingBreakdown(env, { resellerId, start, end });
    if (!breakdown.mapping) {
      return new Response(JSON.stringify({ error: 'No customer rate configured for this reseller' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const mapping = breakdown.mapping;
    const dailyRate = breakdown.daily_rate;
    const days = breakdown.days;
    const totalSimDays = breakdown.total_sim_days;
    const totalAmount = breakdown.total_amount;

    if (totalSimDays === 0) {
      return new Response(JSON.stringify({ error: 'No billable SIM-days in this range' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Record in qbo_invoices
    await fetch(env.SUPABASE_URL + '/rest/v1/qbo_invoices', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        qbo_customer_map_id: mapping.id,
        qbo_invoice_id: null,
        week_start: start,
        week_end: end,
        sim_count: totalSimDays,
        total: totalAmount,
        status: 'draft',
      }),
    });

    const csv = buildCSV(mapping.qbo_display_name, start, end, days, dailyRate);
    const filename = 'invoice_' + mapping.qbo_display_name.replace(/[^a-z0-9]/gi, '_') + '_' + start + '_' + end + '.csv';
    return new Response(csv, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

// ── Billing Audit (vendor-agnostic, non-prorated) ───────────────────────────
// Plan rates live in the plan_rates table (managed via Plan Rates UI).
// Lookup is by vendor — each vendor has exactly one active plan at a time.

async function loadActiveRates(env, atDate) {
    const at = atDate ? new Date(atDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const rows = await sbGet(env, `plan_rates?or=(effective_to.is.null,effective_to.gte.${at})&effective_from=lte.${at}&order=effective_from.desc`);
    const out = {};
    (rows || []).forEach(r => {
        if (!out[r.vendor]) out[r.vendor] = { rate: parseFloat(r.rate), plan_name: r.plan_name };
    });
    return out;
}

// Plan-name → vendor lookup, used for the Wing aggregator upload where
// the bill mixes ATOMIC/Helix/Wing IoT lines distinguished by plan name.
async function loadActivePlanMap(env, atDate) {
    const at = atDate ? new Date(atDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    const rows = await sbGet(env, `plan_rates?or=(effective_to.is.null,effective_to.gte.${at})&effective_from=lte.${at}&order=effective_from.desc`);
    const byPlan = {};
    (rows || []).forEach(r => {
        const key = (r.plan_name || '').trim().toLowerCase();
        if (key && !byPlan[key]) byPlan[key] = { vendor: r.vendor, rate: parseFloat(r.rate), plan_name: r.plan_name };
    });
    return byPlan;
}

const WING_AGGREGATOR_VENDORS = ['wing_iot', 'atomic', 'helix'];

async function handlePlanRatesList(env, corsHeaders) {
    const rows = await sbGet(env, 'plan_rates?order=vendor.asc,plan_name.asc,effective_from.desc');
    return new Response(JSON.stringify(rows || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handlePlanRatesCreate(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const vendor = (body.vendor || '').trim();
        const plan_name = (body.plan_name || '').trim();
        const rate = parseFloat(body.rate);
        const effective_from = body.effective_from || new Date().toISOString().split('T')[0];
        const notes = body.notes || null;
        if (!vendor || !plan_name || !(rate >= 0)) {
            return new Response(JSON.stringify({ error: 'vendor, plan_name, and non-negative rate required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const existing = await sbGet(env, `plan_rates?vendor=eq.${encodeURIComponent(vendor)}&plan_name=eq.${encodeURIComponent(plan_name)}&effective_to=is.null`);
        if (existing && existing.length) {
            const closeDate = new Date(effective_from);
            closeDate.setDate(closeDate.getDate() - 1);
            const closeIso = closeDate.toISOString().split('T')[0];
            await sbPatch(env, `plan_rates?id=eq.${existing[0].id}`, { effective_to: closeIso });
        }
        const [created] = await sbPost(env, 'plan_rates', { vendor, plan_name, rate, effective_from, notes });
        return new Response(JSON.stringify(created), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handlePlanRatesUpdate(request, env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const body = await request.json();
        const patch = {};
        if (body.plan_name != null) patch.plan_name = String(body.plan_name).trim();
        if (body.rate != null) patch.rate = parseFloat(body.rate);
        if (body.effective_from != null) patch.effective_from = body.effective_from;
        if ('effective_to' in body) patch.effective_to = body.effective_to;
        if ('notes' in body) patch.notes = body.notes;
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'no fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sbPatch(env, `plan_rates?id=eq.${encodeURIComponent(id)}`, patch);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handlePlanRatesDelete(env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/plan_rates?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });
        if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

// ── Reseller Rates (selling-side, time-bounded, volume tiers) ───────────────
// Used by computeBillingBreakdown in src/shared/billing.js to override the flat
// qbo_customer_map.daily_rate per (reseller, vendor, date, sim_count).

function sanitizeTiers(input) {
    if (!Array.isArray(input)) throw new Error('tiers must be an array');
    if (input.length === 0) throw new Error('tiers must not be empty');
    const cleaned = input.map((t, idx) => {
        const min = Number(t.min_count);
        const max = (t.max_count == null || t.max_count === '') ? null : Number(t.max_count);
        const rate = Number(t.rate);
        if (!Number.isInteger(min) || min < 0) throw new Error('tier ' + idx + ': min_count must be a non-negative integer');
        if (max != null && (!Number.isInteger(max) || max < min)) throw new Error('tier ' + idx + ': max_count must be an integer >= min_count or null');
        if (!Number.isFinite(rate) || rate < 0) throw new Error('tier ' + idx + ': rate must be a non-negative number');
        return { min_count: min, max_count: max, rate };
    }).sort((a, b) => a.min_count - b.min_count);
    for (let i = 0; i < cleaned.length; i++) {
        if (i > 0 && cleaned[i].min_count <= cleaned[i - 1].min_count) throw new Error('tiers must have strictly increasing min_count');
        if (cleaned[i].max_count != null && cleaned[i].max_count < cleaned[i].min_count) throw new Error('tier ' + i + ': max_count < min_count');
    }
    return cleaned;
}

function validateVendor(v) {
    if (v == null || v === '') return null;
    if (!['atomic', 'helix', 'wing_iot', 'teltik'].includes(v)) throw new Error('invalid vendor');
    return v;
}

async function handleResellerRatesList(env, corsHeaders, url) {
    try {
        const resellerId = url.searchParams.get('reseller_id');
        let q = 'reseller_rates?select=id,reseller_id,vendor,effective_from,effective_to,tiers,notes,created_at,updated_at,resellers(name)&order=reseller_id.asc,vendor.asc.nullsfirst,effective_from.desc';
        if (resellerId) q = q.replace('?', '?reseller_id=eq.' + encodeURIComponent(resellerId) + '&');
        const rows = await sbGet(env, q);
        const mapped = (rows || []).map(r => Object.assign({}, r, { reseller_name: r.resellers?.name || null }));
        return new Response(JSON.stringify(mapped), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleResellerRatesCreate(request, env, corsHeaders) {
    try {
        const body = await request.json();
        const reseller_id = body.reseller_id != null ? parseInt(body.reseller_id) : NaN;
        if (!Number.isInteger(reseller_id)) {
            return new Response(JSON.stringify({ error: 'reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        const vendor = validateVendor(body.vendor);
        const effective_from = body.effective_from || new Date().toISOString().split('T')[0];
        const effective_to = body.effective_to || null;
        const tiers = sanitizeTiers(body.tiers);
        const notes = body.notes ? String(body.notes) : null;

        // Auto-close prior open row for same (reseller, vendor)
        const filter = 'reseller_rates?reseller_id=eq.' + reseller_id + '&effective_to=is.null&' + (vendor == null ? 'vendor=is.null' : 'vendor=eq.' + encodeURIComponent(vendor));
        const existing = await sbGet(env, filter);
        if (Array.isArray(existing) && existing.length) {
            const closeDate = new Date(effective_from + 'T12:00:00Z');
            closeDate.setUTCDate(closeDate.getUTCDate() - 1);
            const closeIso = closeDate.toISOString().split('T')[0];
            for (const row of existing) {
                if (row.effective_from > closeIso) continue;
                await sbPatch(env, 'reseller_rates?id=eq.' + row.id, { effective_to: closeIso });
            }
        }
        const [created] = await sbPost(env, 'reseller_rates', { reseller_id, vendor, effective_from, effective_to, tiers, notes });
        return new Response(JSON.stringify(created), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleResellerRatesUpdate(request, env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const body = await request.json();
        const patch = {};
        if (body.effective_from != null) patch.effective_from = body.effective_from;
        if ('effective_to' in body) patch.effective_to = body.effective_to || null;
        if (body.tiers != null) patch.tiers = sanitizeTiers(body.tiers);
        if ('notes' in body) patch.notes = body.notes ? String(body.notes) : null;
        if (!Object.keys(patch).length) return new Response(JSON.stringify({ error: 'no fields to update' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        await sbPatch(env, 'reseller_rates?id=eq.' + encodeURIComponent(id), patch);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleResellerRatesDelete(env, corsHeaders, url) {
    try {
        const id = url.pathname.split('/').pop();
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const resp = await fetch(env.SUPABASE_URL + '/rest/v1/reseller_rates?id=eq.' + encodeURIComponent(id), {
            method: 'DELETE',
            headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
                Prefer: 'return=minimal',
            },
        });
        if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}


const NON_BILLABLE_TERMINAL_STATUSES = new Set(['canceled', 'cancelled', 'error', 'abandoned']);

function parseBillCSV(text, vendor) {
    if (vendor === 'teltik') return parseTeltikCSV(text);
    return parseWingCSV(text);
}

function parseWingCSV(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV has no data rows');
    const headers = lines[0].split(',').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = splitCSVLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = (values[i] || '').trim(); });
        return row;
    });
}

function parseUSDateMDY(s) {
    const parts = s.split('/').map(n => parseInt(n, 10));
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    return new Date(Date.UTC(parts[2], parts[0] - 1, parts[1]));
}

function unquote(s) {
    if (!s) return '';
    s = s.trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s.trim();
}

function parseTeltikCSV(text) {
    const allLines = text.split('\n').map(l => l.replace(/\r$/, ''));
    let invoiceNo = null, periodStart = null, periodEnd = null;
    for (let i = 0; i < Math.min(40, allLines.length); i++) {
        const ln = allLines[i];
        const mi = ln.match(/Invoice No\.?\s*([A-Za-z0-9-]+)/i);
        if (mi && !invoiceNo) invoiceNo = mi[1];
        const mb = ln.match(/Period Beginning\.?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (mb && !periodStart) periodStart = parseUSDateMDY(mb[1]);
        const me = ln.match(/Period Ending\.?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        if (me && !periodEnd) periodEnd = parseUSDateMDY(me[1]);
    }

    let headerIdx = -1;
    for (let i = 0; i < allLines.length; i++) {
        const ln = allLines[i].toUpperCase();
        if (ln.includes('LINE NUMBER') && ln.includes('SIM NUMBER') && ln.includes('PLAN NAME')) { headerIdx = i; break; }
    }
    if (headerIdx === -1) throw new Error('Teltik CSV: header row (LINE NUMBER, SIM NUMBER, PLAN NAME) not found');

    const headers = splitCSVLine(allLines[headerIdx]).map(h => unquote(h));
    const idxOf = (name) => headers.findIndex(h => h.toUpperCase() === name.toUpperCase());
    const iSim = idxOf('SIM NUMBER');
    const iLine = idxOf('LINE NUMBER');
    const iPlan = idxOf('PLAN NAME');
    const iPlanCharges = idxOf('PLAN CHARGES');
    if (iSim < 0 || iLine < 0 || iPlan < 0 || iPlanCharges < 0) {
        throw new Error('Teltik CSV: required header columns missing');
    }

    const fromIso = periodStart ? periodStart.toISOString() : '';
    const toIso = periodEnd ? periodEnd.toISOString() : '';
    const out = [];
    for (let i = headerIdx + 1; i < allLines.length; i++) {
        const raw = allLines[i];
        if (!raw || !raw.trim()) continue;
        const values = splitCSVLine(raw);
        const sim = unquote(values[iSim] || '').replace(/^'/, '').trim();
        const lineNum = unquote(values[iLine] || '').trim();
        if (!sim || !lineNum) continue;
        const plan = unquote(values[iPlan] || '').trim();
        const planChargesStr = unquote(values[iPlanCharges] || '0').replace(/[$,\s]/g, '');
        const price = parseFloat(planChargesStr) || 0;
        const row = {
            'Id': lineNum,
            'Item Type': 'Plan',
            'Description': plan,
            'From Date': fromIso,
            'To Date': toIso,
            'Subscription Name': plan,
            'Subscription Iccid': sim,
            'Subscription Identifier': lineNum,
            'Bypassed Plan ID': '',
            'Carrier': 'T-Mobile',
            'Price': String(price),
        };
        if (out.length === 0 && invoiceNo) row._invoice_no = invoiceNo;
        out.push(row);
    }
    if (!out.length) throw new Error('Teltik CSV: no data rows after header');
    if (invoiceNo && out[0]) out[0]._invoice_no = invoiceNo;
    return out;
}

function splitCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else { current += ch; }
    }
    result.push(current);
    return result;
}

async function sbGet(env, path) {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        }
    });
    return resp.json();
}

async function sbPost(env, table, data) {
    const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
        },
        body: JSON.stringify(data),
    });
    return resp.json();
}

async function sbPatch(env, path, data) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
        method: 'PATCH',
        headers: {
            'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        },
        body: JSON.stringify(data),
    });
}

// Find the most recent transition into a non-billable terminal status for this SIM.
// Returns ISO timestamp or null.
function findCancelTimestamp(history) {
    if (!history || !history.length) return null;
    const cancels = history.filter(h => NON_BILLABLE_TERMINAL_STATUSES.has((h.new_status || '').toLowerCase()));
    if (!cancels.length) return null;
    cancels.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
    return cancels[0].changed_at;
}

// ── Billing Ledger ──────────────────────────────────────────────────────────
// Tracks expected vendor charges per SIM per billing cycle, then reconciles
// against bill_audit_lines on upload. Surfaces over/under/missing/phantom
// charges across time so we can catch double-billing and missed charges.

function cycleAnchorForVendor(vendor) {
    // Teltik bills 16th→15th. AT&T (wing_iot/atomic/helix) bills 5th→4th.
    return vendor === 'teltik' ? 16 : 5;
}

function cycleBoundsContaining(dateInput, anchorDay) {
    const d = new Date(dateInput);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    let startY, startM;
    if (day >= anchorDay) { startY = y; startM = m; }
    else { startY = m === 0 ? y - 1 : y; startM = m === 0 ? 11 : m - 1; }
    const start = new Date(Date.UTC(startY, startM, anchorDay));
    const endY = startM === 11 ? startY + 1 : startY;
    const endM = startM === 11 ? 0 : startM + 1;
    const end = new Date(Date.UTC(endY, endM, anchorDay - 1));
    return { start, end };
}

function nextCycle(cycle, anchorDay) {
    const newStart = new Date(cycle.end);
    newStart.setUTCDate(newStart.getUTCDate() + 1);
    return cycleBoundsContaining(newStart, anchorDay);
}

function isoDate(d) { return d.toISOString().split('T')[0]; }

function daysBetween(start, end) {
    return Math.round((end - start) / 86400000) + 1;
}

// Normalize legacy 'wing' → 'wing_iot' so old uploads reconcile against the right vendor.
function normalizeVendorName(v) {
    if (!v) return v;
    if (v === 'wing') return 'wing_iot';
    return v;
}

async function regenerateLedgerForVendor(env, vendor, options) {
    options = options || {};
    const today = options.today ? new Date(options.today) : new Date();
    const v = normalizeVendorName(vendor);
    const anchor = cycleAnchorForVendor(v);
    const ratesByVendor = await loadActiveRates(env);
    const rateEntry = ratesByVendor[v] || null;

    const sims = await supabaseGetAllArray(env, `sims?vendor=eq.${v}&select=id,iccid,activated_at,status`);
    if (!sims || !sims.length) return { vendor: v, sims: 0, rows: 0 };

    // Bulk-fetch cancel histories for terminal SIMs only
    const terminalSims = sims.filter(s => NON_BILLABLE_TERMINAL_STATUSES.has((s.status || '').toLowerCase()));
    const historyBySimId = {};
    if (terminalSims.length) {
        const ids = terminalSims.map(s => s.id);
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const hist = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
            hist.forEach(h => {
                if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
                historyBySimId[h.sim_id].push(h);
            });
        }
    }

    const allRows = [];
    for (const sim of sims) {
        if (!sim.activated_at) continue;
        const activatedAt = new Date(sim.activated_at);
        if (activatedAt > today) continue;

        let cancelDate = null;
        if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
            const tsStr = findCancelTimestamp(historyBySimId[sim.id] || []);
            cancelDate = tsStr ? new Date(tsStr) : null;
        }

        const endLimit = cancelDate || today;
        let cycle = cycleBoundsContaining(activatedAt, anchor);
        let safetyN = 0;
        while (cycle.start <= endLimit && safetyN++ < 240) {
            const simStartedThisCycle = activatedAt >= cycle.start && activatedAt <= cycle.end;
            const cycleStartsAfterCancel = cancelDate && cycle.start > cancelDate;
            if (cycleStartsAfterCancel) break;

            let expected = null, basis = 'unknown_rate';
            if (rateEntry) {
                if (v === 'teltik' && simStartedThisCycle) {
                    const daysActive = daysBetween(activatedAt, cycle.end);
                    const daysCycle = daysBetween(cycle.start, cycle.end);
                    expected = Math.round((rateEntry.rate * daysActive / daysCycle) * 10000) / 10000;
                    basis = 'prorated_activation';
                } else {
                    expected = rateEntry.rate;
                    basis = 'full_cycle';
                }
            }

            allRows.push({
                sim_id: sim.id,
                iccid: sim.iccid,
                vendor: v,
                plan_name: rateEntry ? rateEntry.plan_name : null,
                period_start: isoDate(cycle.start),
                period_end: isoDate(cycle.end),
                expected_amount: expected,
                expected_basis: basis,
            });

            if (cycle.start > today) break;
            cycle = nextCycle(cycle, anchor);
        }
    }

    // Bulk upsert. Don't include status/billed_amount/bill_audit_line_id/notes —
    // those are reconciliation-managed; preserved on update by omitting them.
    const CHUNK = 500;
    for (let i = 0; i < allRows.length; i += CHUNK) {
        const batch = allRows.slice(i, i + CHUNK);
        await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=sim_id,vendor,period_start`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
        });
    }

    return { vendor: v, sims: sims.length, rows: allRows.length };
}

async function handleBillingLedgerRegenerate(request, env, corsHeaders, url) {
    try {
        const vendorParam = url.searchParams.get('vendor');
        const vendors = vendorParam ? [vendorParam] : ['wing_iot', 'atomic', 'helix', 'teltik'];
        const results = [];
        for (const v of vendors) {
            results.push(await regenerateLedgerForVendor(env, v));
        }
        return new Response(JSON.stringify({ ok: true, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

// Reconcile a bill upload against the ledger.
// For each bill_audit_lines row of this upload:
//   - Find matching ledger row by (iccid, vendor, period containing from_date)
//   - Set ledger.billed_amount, bill_audit_line_id
//   - Status: billed (within $0.01), over (billed > expected), under (billed < expected)
// After matching, mark unmatched ledger rows in the bill's covered period as 'missing'.
async function reconcileLedgerForUpload(env, uploadId) {
    const uploadResp = await sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`);
    if (!uploadResp || !uploadResp.length) throw new Error('upload not found');
    const upload = uploadResp[0];
    const invoiceNo = upload.invoice_no || (upload.filename || '').replace(/\.[^.]+$/, '') || null;
    const vendor = normalizeVendorName(upload.vendor || 'wing_iot');
    const ledgerVendorFilter = vendor === 'wing_aggregator'
        ? `vendor=in.(${WING_AGGREGATOR_VENDORS.join(',')})`
        : `vendor=eq.${vendor}`;

    const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${uploadId}&order=id.asc`) || [];
    if (!lines.length) return { upload_id: uploadId, matched: 0, missing: 0, phantom: 0 };

    const iccids = [...new Set(lines.map(l => l.subscription_iccid).filter(Boolean))];
    const ledgerRows = [];
    const CHUNK = 200;
    for (let i = 0; i < iccids.length; i += CHUNK) {
        const chunk = iccids.slice(i, i + CHUNK);
        const inClause = chunk.map(s => `"${s}"`).join(',');
        const rows = await supabaseGetAllArray(env, `billing_ledger?${ledgerVendorFilter}&iccid=in.(${inClause})&order=period_start.asc`) || [];
        ledgerRows.push(...rows);
    }
    const ledgerByIccid = {};
    ledgerRows.forEach(r => {
        if (!ledgerByIccid[r.iccid]) ledgerByIccid[r.iccid] = [];
        ledgerByIccid[r.iccid].push(r);
    });

    const updates = [];
    const matchedLedgerIds = new Set();
    let phantomCount = 0;

    for (const line of lines) {
        if (!line.subscription_iccid || !line.from_date) continue;
        const fromDate = new Date(line.from_date);
        const candidates = ledgerByIccid[line.subscription_iccid] || [];
        const match = candidates.find(r => {
            const ps = new Date(r.period_start), pe = new Date(r.period_end);
            return fromDate >= ps && fromDate <= pe;
        });

        if (!match) { phantomCount++; continue; }

        matchedLedgerIds.add(match.id);
        const billed = parseFloat(line.price || '0');
        const expected = match.expected_amount != null ? parseFloat(match.expected_amount) : null;
        let status = 'billed';
        if (expected != null) {
            const diff = billed - expected;
            if (Math.abs(diff) <= 0.01) status = 'billed';
            else if (diff > 0) status = 'over';
            else status = 'under';
        }

        updates.push({
            id: match.id,
            sim_id: match.sim_id,
            iccid: match.iccid,
            vendor: match.vendor,
            plan_name: match.plan_name,
            period_start: match.period_start,
            period_end: match.period_end,
            expected_amount: match.expected_amount,
            expected_basis: match.expected_basis,
            billed_amount: billed,
            bill_audit_line_id: line.id,
            status,
            invoice_no: invoiceNo,
        });
    }

    for (let i = 0; i < updates.length; i += 500) {
        const batch = updates.slice(i, i + 500);
        await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?on_conflict=id`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(batch),
        });
    }

    let missingCount = 0;
    if (upload.billing_period_start && upload.billing_period_end) {
        const periodCovered = ledgerRows.filter(r =>
            !matchedLedgerIds.has(r.id) &&
            r.status !== 'disputed' && r.status !== 'resolved' &&
            new Date(r.period_start) >= new Date(upload.billing_period_start) &&
            new Date(r.period_end) <= new Date(upload.billing_period_end)
        );
        if (periodCovered.length) {
            const ids = periodCovered.map(r => r.id);
            for (let i = 0; i < ids.length; i += 200) {
                const chunk = ids.slice(i, i + 200);
                await sbPatch(env, `billing_ledger?id=in.(${chunk.join(',')})`, { status: 'missing' });
            }
            missingCount = ids.length;
        }
    }

    return { upload_id: uploadId, matched: updates.length, missing: missingCount, phantom: phantomCount };
}

async function handleBillingLedgerReconcile(request, env, corsHeaders, url) {
    try {
        const uploadId = url.searchParams.get('upload_id');
        if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const result = await reconcileLedgerForUpload(env, uploadId);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerList(env, corsHeaders, url) {
    try {
        const filters = [];
        const sim_id = url.searchParams.get('sim_id');
        const iccid = (url.searchParams.get('iccid') || '').trim();
        const vendor = url.searchParams.get('vendor');
        const status = url.searchParams.get('status');
        const periodMonth = url.searchParams.get('period_month'); // YYYY-MM
        if (sim_id) filters.push(`sim_id=eq.${encodeURIComponent(sim_id)}`);
        if (iccid) filters.push(`iccid=ilike.*${encodeURIComponent(iccid)}*`);
        if (vendor) filters.push(`vendor=eq.${encodeURIComponent(vendor)}`);
        if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
        if (periodMonth && /^\d{4}-\d{2}$/.test(periodMonth)) {
            const [y, m] = periodMonth.split('-').map(Number);
            const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
            const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
            filters.push(`period_start=gte.${monthStart}`);
            filters.push(`period_start=lte.${monthEnd}`);
        }
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const order = 'order=period_start.desc,iccid.asc';
        const path = `billing_ledger?${filters.join('&')}${filters.length ? '&' : ''}${order}&limit=${limit}&offset=${offset}`;

        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'count=exact',
            },
        });
        const rows = await resp.json();
        const cr = resp.headers.get('content-range') || '*/0';
        const total = parseInt(cr.split('/')[1] || '0');
        return new Response(JSON.stringify({ rows: rows || [], total, limit, offset }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerMonths(env, corsHeaders) {
    try {
        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_ledger_months`, {
            method: 'POST',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
            },
            body: '{}',
        });
        const rows = await resp.json();
        const months = (rows || []).map(r => r.month).filter(Boolean);
        return new Response(JSON.stringify({ months }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillingLedgerSummary(env, corsHeaders, url) {
    try {
        const vendor = url.searchParams.get('vendor');
        const vendorFilter = vendor ? `&vendor=eq.${encodeURIComponent(vendor)}` : '';
        const statuses = ['pending','billed','over','under','missing','phantom','disputed','resolved'];
        const counts = {};
        await Promise.all(statuses.map(async s => {
            const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/billing_ledger?status=eq.${s}${vendorFilter}&select=id&limit=1`, {
                headers: {
                    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'Prefer': 'count=exact',
                    'Range-Unit': 'items',
                    'Range': '0-0',
                },
            });
            const cr = resp.headers.get('content-range') || '*/0';
            counts[s] = parseInt(cr.split('/')[1] || '0');
        }));
        return new Response(JSON.stringify({ counts }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

// Time-aware audit + Teltik activation proration.
function auditOneLine({ row, sim, history, fromDate, vendor, allPlanRates }) {
    const price = parseFloat(row['Price'] || '0');
    const planId = (row['Bypassed Plan ID'] || '').trim() || null;
    const description = (row['Description'] || '').trim();

    function pickRate(predicate) {
        const candidates = (allPlanRates || []).filter(predicate);
        if (!candidates.length) return null;
        if (!fromDate) return candidates[0];
        const match = candidates.find(r => {
            const ef = new Date(r.effective_from);
            const et = r.effective_to ? new Date(r.effective_to) : null;
            return ef <= fromDate && (!et || et >= fromDate);
        });
        return match || null;
    }

    let rateEntry = null;
    let resolvedVendor = vendor;

    if (vendor === 'wing_aggregator') {
        const key = description.toLowerCase().trim();
        const matched = key ? pickRate(r => (r.plan_name || '').toLowerCase().trim() === key) : null;
        if (matched) {
            rateEntry = { rate: parseFloat(matched.rate), plan_name: matched.plan_name };
            resolvedVendor = matched.vendor;
        } else {
            const dateLabel = fromDate ? fromDate.toISOString().split('T')[0] : 'today';
            return {
                discrepancyType: 'unknown_plan',
                discrepancyDetail: `Plan "${description || planId || '(blank)'}" has no plan_rates row active on ${dateLabel}`,
                expectedPrice: 0,
                resolvedVendor: null,
            };
        }
    } else {
        const matched = pickRate(r => r.vendor === vendor);
        if (matched) rateEntry = { rate: parseFloat(matched.rate), plan_name: matched.plan_name };
    }

    let knownRate = rateEntry ? rateEntry.rate : null;
    let prorated = false;

    if (!sim) {
        return { discrepancyType: 'unknown_iccid', discrepancyDetail: `ICCID ${row['Subscription Iccid'] || '(blank)'} not found in our system`, expectedPrice: 0, resolvedVendor };
    }

    if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) {
        const canceledAt = findCancelTimestamp(history);
        if (canceledAt && fromDate && new Date(canceledAt) < fromDate) {
            const dt = new Date(canceledAt).toISOString().split('T')[0];
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM was ${sim.status} as of ${dt}, before bill period start`, expectedPrice: 0, resolvedVendor };
        }
        if (!canceledAt) {
            return { discrepancyType: 'canceled_before_period', discrepancyDetail: `SIM is ${sim.status} (no cancel-date record); flag for review`, expectedPrice: 0, resolvedVendor };
        }
    }

    // Teltik prorates plan charges on activation only (vendor-billing-cycles memory).
    // If the SIM activated mid-bill-period, expected = rate × daysActive / cycleDays.
    if (knownRate != null && resolvedVendor === 'teltik' && sim.activated_at && fromDate && row['To Date']) {
        const activatedAt = new Date(sim.activated_at);
        const periodEnd = new Date(row['To Date']);
        if (activatedAt > fromDate && activatedAt <= periodEnd) {
            const daysActive = Math.max(1, Math.round((periodEnd - activatedAt) / 86400000) + 1);
            const daysCycle = Math.max(1, Math.round((periodEnd - fromDate) / 86400000) + 1);
            knownRate = Math.round((knownRate * daysActive / daysCycle) * 100) / 100;
            prorated = true;
        }
    }

    if (knownRate != null && Math.abs(price - knownRate) > 0.01) {
        const planLabel = rateEntry.plan_name || planId || resolvedVendor;
        const proLabel = prorated ? ' (prorated)' : '';
        return { discrepancyType: 'rate_mismatch', discrepancyDetail: `${planLabel}${proLabel}: expected $${knownRate.toFixed(2)} but charged $${price.toFixed(2)}`, expectedPrice: knownRate, resolvedVendor };
    }

    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price, resolvedVendor };
}

async function handleBillAuditUpload(request, env, corsHeaders) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const csvText = await file.text();
        const filename = file.name || 'bill.csv';
        const vendor = (new URL(request.url)).searchParams.get('vendor') || 'wing';

        let rows;
        try {
            rows = parseBillCSV(csvText, vendor);
        } catch (parseErr) {
            return new Response(JSON.stringify({ error: String(parseErr.message || parseErr) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!rows.length) return new Response(JSON.stringify({ error: 'CSV has no data rows' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const parsedInvoiceNo = rows[0] && rows[0]._invoice_no ? rows[0]._invoice_no : null;

        const [upload] = await sbPost(env, 'bill_audit_uploads', { filename, vendor, total_rows: rows.length, status: 'processing', invoice_no: parsedInvoiceNo });
        const uploadId = upload.id;

        const allPlanRates = await sbGet(env, 'plan_rates?order=effective_from.desc') || [];
        const allSims = await supabaseGetAllArray(env, 'sims?select=id,iccid,status,vendor,activated_at') || [];
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        // Pre-resolve sim objects + collect IDs whose history we need (only canceled-status SIMs need it)
        const simIds = new Set();
        const parsedRows = rows.map(row => {
            const iccid = row['Subscription Iccid'] || '';
            const sim = simsByIccid[iccid];
            if (sim && NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) simIds.add(sim.id);
            return { row, iccid, sim };
        });

        let allHistory = [];
        if (simIds.size > 0) {
            const idArr = [...simIds];
            for (let i = 0; i < idArr.length; i += 200) {
                const chunk = idArr.slice(i, i + 200);
                const part = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
                allHistory.push(...part);
            }
        }
        const historyBySimId = {};
        allHistory.forEach(h => {
            if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
            historyBySimId[h.sim_id].push(h);
        });

        const billedIccids = new Set();
        const lineRecords = [];

        for (const { row, iccid, sim } of parsedRows) {
            const price = parseFloat(row['Price'] || '0');
            const fromDate = row['From Date'] ? new Date(row['From Date']) : null;
            const toDate = row['To Date'] ? new Date(row['To Date']) : null;
            const planId = (row['Bypassed Plan ID'] || '').trim() || null;
            const history = sim ? (historyBySimId[sim.id] || []) : [];

            const audit = auditOneLine({ row, sim, history, fromDate, vendor, allPlanRates });

            billedIccids.add(iccid);
            lineRecords.push({
                upload_id: uploadId,
                vendor: audit.resolvedVendor || vendor,
                wing_id: row['Id'] || null,
                item_type: row['Item Type'] || null,
                description: row['Description'] || null,
                from_date: fromDate?.toISOString() || null,
                to_date: toDate?.toISOString() || null,
                subscription_name: row['Subscription Name'] || null,
                subscription_iccid: iccid || null,
                subscription_identifier: row['Subscription Identifier'] || null,
                bypassed_plan_id: planId,
                carrier: row['Carrier'] || null,
                price,
                sim_id: sim?.id || null,
                sim_status: sim?.status || null,
                expected_price: audit.expectedPrice,
                discrepancy_type: audit.discrepancyType,
                discrepancy_detail: audit.discrepancyDetail,
            });
        }

        // Duplicate-charge detection: same ICCID with overlapping periods within this upload
        const byIccid = {};
        lineRecords.forEach(r => {
            if (!r.subscription_iccid) return;
            if (!byIccid[r.subscription_iccid]) byIccid[r.subscription_iccid] = [];
            byIccid[r.subscription_iccid].push(r);
        });
        for (const entries of Object.values(byIccid)) {
            if (entries.length < 2) continue;
            for (let i = 0; i < entries.length; i++) {
                for (let j = i + 1; j < entries.length; j++) {
                    const a = entries[i], b = entries[j];
                    if (a.from_date && b.from_date && a.to_date && b.to_date) {
                        const aFrom = new Date(a.from_date), aTo = new Date(a.to_date);
                        const bFrom = new Date(b.from_date), bTo = new Date(b.to_date);
                        if (aFrom < bTo && bFrom < aTo && !b.discrepancy_type) {
                            b.discrepancy_type = 'duplicate_charge';
                            b.discrepancy_detail = `Overlapping period with line ${a.wing_id || a.subscription_iccid}`;
                            b.expected_price = 0;
                        }
                    }
                }
            }
        }

        const targetVendors = vendor === 'wing_aggregator'
            ? new Set(WING_AGGREGATOR_VENDORS)
            : new Set([vendor]);
        const activeSims = (allSims || []).filter(s =>
            !NON_BILLABLE_TERMINAL_STATUSES.has((s.status || '').toLowerCase()) &&
            s.status !== 'provisioning' &&
            targetVendors.has(s.vendor)
        );
        const missingFromBill = activeSims.filter(s => !billedIccids.has(s.iccid));

        for (let i = 0; i < lineRecords.length; i += 500) {
            const batch = lineRecords.slice(i, i + 500);
            await fetch(`${env.SUPABASE_URL}/rest/v1/bill_audit_lines`, {
                method: 'POST',
                headers: {
                    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal',
                },
                body: JSON.stringify(batch),
            });
        }

        const discrepancyCount = lineRecords.filter(r => r.discrepancy_type).length;
        const totalAmount = lineRecords.reduce((sum, r) => sum + (r.price || 0), 0);
        const totalExpected = lineRecords.reduce((sum, r) => sum + (r.expected_price || 0), 0);
        const overchargeAmount = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
        const dates = lineRecords.map(r => r.from_date).filter(Boolean).sort();
        const endDates = lineRecords.map(r => r.to_date).filter(Boolean).sort();

        await sbPatch(env, `bill_audit_uploads?id=eq.${uploadId}`, {
            status: 'complete',
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            billing_period_start: dates[0] ? dates[0].split('T')[0] : null,
            billing_period_end: endDates.length ? endDates[endDates.length - 1].split('T')[0] : null,
        });

        // Auto-update ledger for this vendor (or all 3 AT&T vendors when aggregator) + reconcile this upload
        let ledgerResult = null;
        try {
            if (vendor === 'wing_aggregator') {
                for (const v of WING_AGGREGATOR_VENDORS) await regenerateLedgerForVendor(env, v);
            } else {
                await regenerateLedgerForVendor(env, vendor);
            }
            ledgerResult = await reconcileLedgerForUpload(env, uploadId);
        } catch (recErr) {
            console.error('Ledger reconciliation error:', recErr);
            ledgerResult = { error: String(recErr) };
        }

        return new Response(JSON.stringify({
            upload_id: uploadId,
            ledger: ledgerResult,
            vendor,
            total_rows: lineRecords.length,
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            discrepancies: lineRecords.filter(r => r.discrepancy_type),
            missing_from_bill: missingFromBill.map(s => ({ sim_id: s.id, iccid: s.iccid, status: s.status })),
            missing_count: missingFromBill.length,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (e) {
        console.error('Bill audit upload error:', e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillAuditResults(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const [uploads, lines] = await Promise.all([
        sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
        sbGet(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response(JSON.stringify({ error: 'Upload not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
        upload,
        lines: lines || [],
        discrepancies: (lines || []).filter(l => l.discrepancy_type),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleBillAuditUploads(env, corsHeaders) {
    const data = await sbGet(env, 'bill_audit_uploads?select=id,vendor,filename,invoice_no,billing_period_start,billing_period_end,total_rows,total_amount,total_expected,overcharge_amount,discrepancy_count,status,created_at&order=created_at.desc&limit=50');
    return new Response(JSON.stringify(data || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// Delete an audit upload + its lines + reset any ledger rows that were tied to it.
async function handleBillAuditDelete(env, corsHeaders, url) {
    try {
        const id = url.searchParams.get('id');
        if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(id)}&select=id`) || [];
        if (lines.length) {
            const lineIds = lines.map(l => l.id);
            for (let i = 0; i < lineIds.length; i += 200) {
                const chunk = lineIds.slice(i, i + 200);
                await sbPatch(env, `billing_ledger?bill_audit_line_id=in.(${chunk.join(',')})`, {
                    bill_audit_line_id: null,
                    billed_amount: null,
                    invoice_no: null,
                    status: 'pending',
                });
            }
        }

        await fetch(`${env.SUPABASE_URL}/rest/v1/bill_audit_lines?upload_id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });

        const delResp = await fetch(`${env.SUPABASE_URL}/rest/v1/bill_audit_uploads?id=eq.${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: {
                'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                'Prefer': 'return=minimal',
            },
        });
        if (!delResp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        return new Response(JSON.stringify({ ok: true, lines_deleted: lines.length, ledger_reset: lines.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleBillAuditExport(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response('upload_id required', { status: 400 });

    const [uploads, lines] = await Promise.all([
        sbGet(env, `bill_audit_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
        sbGet(env, `bill_audit_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response('Upload not found', { status: 404 });

    const auditLabels = {
        'unknown_iccid': 'UNKNOWN ICCID',
        'canceled_before_period': 'CANCELED BEFORE PERIOD',
        'rate_mismatch': 'RATE MISMATCH',
        'duplicate_charge': 'DUPLICATE',
    };

    const csvHeaders = 'Bill Line ID,ICCID,Description,Plan ID,Carrier,From Date,To Date,Billed Amount,Expected Amount,Overcharge,SIM Status,Audit Result,Detail';
    const csvRows = (lines || []).map(l => {
        const overcharge = Math.max(0, (l.price || 0) - (l.expected_price || 0));
        const auditResult = l.discrepancy_type ? auditLabels[l.discrepancy_type] || l.discrepancy_type : 'OK';
        return [
            l.wing_id || '',
            l.subscription_iccid || '',
            `"${(l.description || '').replace(/"/g, '""')}"`,
            l.bypassed_plan_id || '',
            l.carrier || '',
            l.from_date ? new Date(l.from_date).toLocaleDateString('en-US') : '',
            l.to_date ? new Date(l.to_date).toLocaleDateString('en-US') : '',
            (l.price || 0).toFixed(2),
            (l.expected_price || 0).toFixed(2),
            overcharge.toFixed(2),
            l.sim_status || 'N/A',
            auditResult,
            `"${(l.discrepancy_detail || '').replace(/"/g, '""')}"`,
        ].join(',');
    });

    const totalBilled = (lines || []).reduce((s, l) => s + (l.price || 0), 0);
    const totalExpected = (lines || []).reduce((s, l) => s + (l.expected_price || 0), 0);
    const totalOvercharge = Math.max(0, totalBilled - totalExpected);
    csvRows.push('');
    csvRows.push(`,,,,,,,${totalBilled.toFixed(2)},${totalExpected.toFixed(2)},${totalOvercharge.toFixed(2)},,"TOTALS",`);

    const csv = csvHeaders + '\n' + csvRows.join('\n');
    const invoiceName = (upload.filename || '').replace(/\.[^.]+$/, '') || `upload-${uploadId}`;
    const exportFilename = `${invoiceName} - Audit.csv`;

    return new Response(csv, {
        headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${exportFilename}"`,
        },
    });
}

// One-time: re-evaluate discrepancies for existing bill_audit_lines using current logic.
// POST /api/bill-audit/recompute             — recomputes ALL uploads
// POST /api/bill-audit/recompute?upload_id=X — recomputes one upload
async function handleBillAuditRecompute(env, corsHeaders, url) {
    try {
        const filterUploadId = url.searchParams.get('upload_id');
        const uploadFilter = filterUploadId ? `?id=eq.${encodeURIComponent(filterUploadId)}` : '?order=id.asc&limit=200';
        const uploads = await sbGet(env, `bill_audit_uploads${uploadFilter}`);
        if (!uploads || !uploads.length) {
            return new Response(JSON.stringify({ ok: true, message: 'No uploads to recompute', uploads_processed: 0 }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const allPlanRates = await sbGet(env, 'plan_rates?order=effective_from.desc') || [];
        const allSims = await supabaseGetAllArray(env, 'sims?select=id,iccid,status,vendor,activated_at') || [];
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        const summary = [];

        for (const upload of uploads) {
            const lines = await supabaseGetAllArray(env, `bill_audit_lines?upload_id=eq.${upload.id}&order=id.asc`) || [];
            if (!lines.length) { summary.push({ upload_id: upload.id, lines: 0, skipped: true }); continue; }

            const simIds = new Set();
            lines.forEach(l => {
                const sim = l.subscription_iccid ? simsByIccid[l.subscription_iccid] : null;
                if (sim && NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || '').toLowerCase())) simIds.add(sim.id);
            });
            let history = [];
            if (simIds.size > 0) {
                const idArr = [...simIds];
                for (let i = 0; i < idArr.length; i += 200) {
                    const chunk = idArr.slice(i, i + 200);
                    const part = await supabaseGetAllArray(env, `sim_status_history?sim_id=in.(${chunk.join(',')})&order=changed_at.desc`) || [];
                    history.push(...part);
                }
            }
            const historyBySimId = {};
            history.forEach(h => {
                if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
                historyBySimId[h.sim_id].push(h);
            });

            // First pass: per-line audit
            const updated = lines.map(l => {
                const iccid = l.subscription_iccid || '';
                const sim = simsByIccid[iccid] || null;
                const fromDate = l.from_date ? new Date(l.from_date) : null;
                const row = {
                    'Subscription Iccid': iccid,
                    'Bypassed Plan ID': l.bypassed_plan_id || '',
                    'Description': l.description || '',
                    'To Date': l.to_date || '',
                    'Price': String(l.price || 0),
                };
                const audit = auditOneLine({ row, sim, history: sim ? (historyBySimId[sim.id] || []) : [], fromDate, vendor: upload.vendor, allPlanRates });
                return {
                    ...l,
                    sim_id: sim?.id || null,
                    sim_status: sim?.status || null,
                    vendor: audit.resolvedVendor || l.vendor,
                    discrepancy_type: audit.discrepancyType,
                    discrepancy_detail: audit.discrepancyDetail,
                    expected_price: audit.expectedPrice,
                };
            });

            // Second pass: duplicate-charge across upload
            const byIccid = {};
            updated.forEach(r => {
                if (!r.subscription_iccid) return;
                if (!byIccid[r.subscription_iccid]) byIccid[r.subscription_iccid] = [];
                byIccid[r.subscription_iccid].push(r);
            });
            for (const entries of Object.values(byIccid)) {
                if (entries.length < 2) continue;
                for (let i = 0; i < entries.length; i++) {
                    for (let j = i + 1; j < entries.length; j++) {
                        const a = entries[i], b = entries[j];
                        if (a.from_date && b.from_date && a.to_date && b.to_date) {
                            const aFrom = new Date(a.from_date), aTo = new Date(a.to_date);
                            const bFrom = new Date(b.from_date), bTo = new Date(b.to_date);
                            if (aFrom < bTo && bFrom < aTo && !b.discrepancy_type) {
                                b.discrepancy_type = 'duplicate_charge';
                                b.discrepancy_detail = `Overlapping period with line ${a.wing_id || a.subscription_iccid}`;
                                b.expected_price = 0;
                            }
                        }
                    }
                }
            }

            // Bulk upsert in chunks (avoids CF subrequest cap and PostgREST 1000-row read cap)
            const upsertRows = updated.map(r => ({
                id: r.id,
                upload_id: r.upload_id,
                vendor: r.vendor,
                subscription_iccid: r.subscription_iccid,
                bypassed_plan_id: r.bypassed_plan_id,
                price: r.price,
                from_date: r.from_date,
                to_date: r.to_date,
                wing_id: r.wing_id,
                item_type: r.item_type,
                description: r.description,
                subscription_name: r.subscription_name,
                subscription_identifier: r.subscription_identifier,
                carrier: r.carrier,
                sim_id: r.sim_id,
                sim_status: r.sim_status,
                discrepancy_type: r.discrepancy_type,
                discrepancy_detail: r.discrepancy_detail,
                expected_price: r.expected_price,
            }));
            for (let i = 0; i < upsertRows.length; i += 500) {
                const batch = upsertRows.slice(i, i + 500);
                await fetch(`${env.SUPABASE_URL}/rest/v1/bill_audit_lines?on_conflict=id`, {
                    method: 'POST',
                    headers: {
                        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
                        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'resolution=merge-duplicates,return=minimal',
                    },
                    body: JSON.stringify(batch),
                });
            }

            const totalAmount = updated.reduce((s, r) => s + (r.price || 0), 0);
            const totalExpected = updated.reduce((s, r) => s + (r.expected_price || 0), 0);
            const overcharge = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
            const discCount = updated.filter(r => r.discrepancy_type).length;
            await sbPatch(env, `bill_audit_uploads?id=eq.${upload.id}`, {
                total_amount: totalAmount,
                total_expected: totalExpected,
                overcharge_amount: overcharge,
                discrepancy_count: discCount,
            });

            summary.push({ upload_id: upload.id, filename: upload.filename, lines: updated.length, discrepancies: discCount, overcharge });
        }

        return new Response(JSON.stringify({ ok: true, uploads_processed: summary.length, summary }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleRelayTest(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const method = (body.method || 'GET').toUpperCase();
    const url = body.url;
    const headers = body.headers || {};
    const reqBody = body.body;
    if (!url) {
      return new Response(JSON.stringify({ error: 'url is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const init = { method, headers };
    if (reqBody !== null && reqBody !== undefined) {
      init.body = typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody);
    }
    const resp = await relayFetch(env, url, init);
    const respBody = await resp.text();
    const respHeaders = {};
    resp.headers.forEach(function(val, key) { respHeaders[key] = val; });
    return new Response(JSON.stringify({ ok: true, status: resp.status, headers: respHeaders, body: respBody }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

async function handleAtomicQuery(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const identifier = (body.identifier || '').trim();
    if (!identifier) {
      return new Response(JSON.stringify({ error: 'ICCID or MSISDN required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
      return new Response(JSON.stringify({ error: 'ATOMIC credentials not configured on dashboard worker (push ATOMIC_USERNAME, ATOMIC_TOKEN, ATOMIC_PIN secrets)' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const apiUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    // ICCID starts with 89 and is 19-20 digits; else treat as MSISDN
    const isIccid = /^89\d{17,19}$/.test(identifier);
    const requestBody = {
      wholeSaleApi: {
        session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
        wholeSaleRequest: {
          requestType: 'subsriberInquiry',
          MSISDN: isIccid ? '' : identifier,
          sim: isIccid ? identifier : '',
        },
      },
    };
    const res = await relayFetch(env, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    await logCarrierApiCall(env, {
      run_id: 'atomic_query_' + identifier + '_' + Date.now(),
      step: 'query',
      iccid: isIccid ? identifier : null,
      imei: null,
      vendor: 'atomic',
      request_url: apiUrl,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: data,
      error: (res.ok && data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse && data.wholeSaleApi.wholeSaleResponse.statusCode === '00')
        ? null
        : 'ATOMIC query: ' + (data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse ? data.wholeSaleApi.wholeSaleResponse.description : res.status),
    });
    let db_update = null;
    const wr2 = data && data.wholeSaleApi && data.wholeSaleApi.wholeSaleResponse;
    if (res.ok && wr2 && wr2.statusCode === '00' && wr2.Result && wr2.Result.attStatus === 'Active') {
      if (isIccid) {
        db_update = await syncActiveSim(env, identifier, {
          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,
          activatedAt: wr2.Result.activationDate || null,
          zipCode: (wr2.Result.address && wr2.Result.address.zipCode) || null,
        });
      }
    } else if (isIccid) {
      const errMsg = !res.ok
        ? 'ATOMIC query HTTP ' + res.status
        : (wr2 && wr2.statusCode !== '00'
            ? 'ATOMIC statusCode ' + wr2.statusCode + ': ' + (wr2.description || '')
            : 'ATOMIC query: status not Active (got "' + (wr2 && wr2.Result && wr2.Result.attStatus) + '")');
      await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(identifier), {
        status: 'error',
        last_rotation_error: errMsg.trim() + ' at ' + new Date().toISOString(),
      }).catch(() => {});
    }
    return new Response(JSON.stringify({ ok: true, response: data, db_update }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// ── Frontend serving ────────────────────────────────────────────────────────
// The SPA frontend lives in public/index.html (extracted 2026-06-12 from the
// old getHTML() template literal by scripts/extract_dashboard_frontend.mjs).
// It is deployed as a Cloudflare Workers static asset (see [assets] in
// wrangler.toml, run_worker_first=true so Basic auth still gates everything).
// The single server-injected value is the HELIX_ENABLED flag placeholder.
async function serveApp(env) {
  const assetRes = await env.ASSETS.fetch('https://dashboard/index.html');
  if (!assetRes.ok) {
    return new Response('Frontend asset missing — was public/index.html deployed?', { status: 500 });
  }
  let html = await assetRes.text();
  html = html.replace('window.HELIX_ENABLED = __HELIX_ENABLED__;',
    'window.HELIX_ENABLED = ' + (env.HELIX_ENABLED === 'true' ? 'true' : 'false') + ';');
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
