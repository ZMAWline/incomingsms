import { computeBillingBreakdown, computeResellerUtilization } from '../shared/billing.js';
import { resolveMsisdn, resolveZip, validateNewIccid, buildSwapSimRequest, buildSwapImeiRequest, isSwapSuccess, swapErrorMessage } from '../shared/sim-swap.mjs';
import { PRESETS as API_TESTER_PRESETS_REGISTRY, listPresetsForClient, isStateChanging } from './api-tester-presets.js';
import { formatGatewayState, parseIccidList } from '../shared/skyline-state.mjs';
import { isTeltikInvalidIccidResponse, iccidSwapPatch } from '../shared/teltik-iccid.mjs';
import { resolveTeltikKnownMdn as resolveSharedTeltikKnownMdn } from '../shared/teltik-known-mdn.mjs';
import { recordHostingPortCheck, buildHostingPortCheckRow, normalizeHostPortState, runHostingPortSweep, enqueueHostingPortJob, getHostingPortJob, listHostingPortJobs, processHostingPortJobs } from '../shared/hosting-port-status.mjs';

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

    // WING gateway-status: external partner endpoint with its own API-key auth.
    // Must run BEFORE the operator Basic-auth gate so WING never needs operator creds.
    if (url.pathname === '/api/gateway-status') {
      return handleGatewayStatus(request, env);
    }

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

    // Daily escalation export — deterministic by NY date range, split by
    // service provider and gateway host. See handleBadRentalEscalationExport.
    if (url.pathname === '/api/bad-rentals/escalation-export' && request.method === 'GET') {
      return handleBadRentalEscalationExport(env, corsHeaders, url);
    }

    // Compatibility alias for the original narrow export.
    if (url.pathname === '/api/bad-rentals/teltik-port-offline-export' && request.method === 'GET') {
      return handleTeltikPortOfflineExport(env, corsHeaders, url);
    }

    // HE1 rollup — reports auto-resolved on proven-healthy evidence.
    if (url.pathname === '/api/bad-rentals/healthy-evidence-summary' && request.method === 'GET') {
      return handleHealthyEvidenceSummary(env, corsHeaders, url);
    }

    // R2 — read-only operator_escalations backlog counts. The dashboard never
    // read this table before (the 323 legacy rows were invisible to every
    // dashboard UI surface); this is the minimal visibility fix.
    if (url.pathname === '/api/bad-rentals/escalation-backlog' && request.method === 'GET') {
      return handleBadRentalEscalationBacklog(env, corsHeaders);
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

    if (url.pathname.startsWith('/api/bad-rentals/') && url.pathname.endsWith('/rerun-auto') && request.method === 'POST') {
      const id = url.pathname.slice('/api/bad-rentals/'.length, -('/rerun-auto'.length));
      return handleBadRentalRerunAuto(id, request, env, corsHeaders);
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
      // One chunk per request — the frontend loops until has_more=false so the
      // browser sees per-chunk progress and Cloudflare's response timeout never
      // fires on long activation batches. Defaults match the previous behavior
      // (offset=0, limit=200) so a no-arg call still imports the first chunk.
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10) || 200));
      const res = await env.TELTIK_WORKER.fetch(
        new Request(`https://teltik-worker/import?secret=${env.ADMIN_RUN_SECRET}&offset=${offset}&limit=${limit}`, { method: 'POST' })
      );
      const text = await res.text();
      let chunk;
      try { chunk = JSON.parse(text); } catch {
        return new Response(JSON.stringify({ ok: false, error: 'worker returned non-JSON', body: text }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(chunk), { status: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    if (url.pathname.startsWith('/api/qbo-invoices/') && request.method === 'DELETE') {
      return handleQboInvoiceDelete(env, corsHeaders, url);
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

    if (url.pathname === '/api/billing/rental-export') {
      return handleRentalExport(url, env, corsHeaders);
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
    if (url.pathname === '/api/atomic-swap-sim' && request.method === 'POST') {
      return handleAtomicSwapSim(request, env, corsHeaders);
    }
    if (url.pathname === '/api/atomic-swap-imei' && request.method === 'POST') {
      return handleAtomicSwapImei(request, env, corsHeaders);
    }
    if (url.pathname === '/api/atomic-sub-action' && request.method === 'POST') {
      return handleAtomicSubAction(request, env, corsHeaders);
    }

    if (url.pathname === '/api/teltik-query' && request.method === 'POST') {
      return handleTeltikQuery(request, env, corsHeaders);
    }
    if (url.pathname === '/api/teltik-host-check' && request.method === 'POST') {
      return handleTeltikHostCheck(request, env, corsHeaders);
    }
    if (url.pathname === '/api/hosting-port-status/run' && request.method === 'POST') {
      return handleHostingPortStatusRun(request, env, corsHeaders);
    }
    // Exact /jobs list route must be matched before the /jobs/:id prefix route.
    if (url.pathname === '/api/hosting-port-status/jobs' && request.method === 'GET') {
      return handleHostingPortStatusJobsList(url, env, corsHeaders);
    }
    if (url.pathname.startsWith('/api/hosting-port-status/jobs/') && request.method === 'GET') {
      const jobId = url.pathname.slice('/api/hosting-port-status/jobs/'.length);
      return handleHostingPortStatusJobGet(jobId, env, corsHeaders);
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
    if (url.pathname === '/api/rotation-health' && request.method === 'GET') {
      return handleRotationHealth(request, env, corsHeaders);
    }
    if (url.pathname === '/api/catchup-sweep/run' && request.method === 'POST') {
      return handleCatchupSweepRun(request, env, corsHeaders);
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

  // Two schedules (wrangler.toml [triggers]): the 12h cron runs the capped
  // automatic sweep; the 1-minute tick drains queued Workers-page Hosting
  // Port Check jobs one bounded batch per tick, so a manual full sweep
  // continues even after the operator's browser closes. Both record through
  // the same canonical recorder, so cron + manual runs feed one history.
  // Awaited (not ctx.waitUntil): fire-and-forget drains were observed to be
  // dropped before persisting progress/logs; awaiting keeps the scheduled
  // event alive until the batch commits.
  async scheduled(event, env, ctx) {
    if (event.cron === '0 */12 * * *') {
      await runHostingPortSweep(env, { source: 'cron' })
        .then(s => console.log('[HostPort] cron sweep done: ' + JSON.stringify({
          total: s.total, online: s.online, offline: s.offline,
          unknown: s.unknown, error: s.error, truncated: s.truncated,
        })))
        .catch(e => console.log('[HostPort] cron sweep failed: ' + (e && e.message || e)));
    }
    await processHostingPortJobs(env, { maxJobs: 1 })
      .then(r => { if (r.claimed) console.log('[HostPort] job drain: ' + JSON.stringify(r)); })
      .catch(e => console.log('[HostPort] job drain failed: ' + (e && e.message || e)));
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
// /v1/get-info: 10 digit US, no country code, no '+'. Anything else (E.164,
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
    let query = `sims?select=id,iccid,port,status,vendor,gateway_host,carrier,rotation_interval_hours,rotation_eligible,mobility_subscription_id,gateway_id,last_mdn_rotated_at,last_rotation_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc`;

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

    // Latest persisted Teltik hosting port status + uptime stats, derived from
    // the canonical hosting_port_status_checks history across ALL check
    // sources. Missing RPC/table (pre-migration) degrades to nulls.
    const hostPortMap = {}; // sim_id -> get_hosting_port_status_summary row
    const teltikHostedIds = filteredSims
      .filter(s => s.gateway_host === 'teltik' || (!s.gateway_host && s.vendor === 'teltik'))
      .map(s => s.id);
    if (teltikHostedIds.length > 0) {
      const CHUNK = 500;
      const hpChunks = [];
      for (let i = 0; i < teltikHostedIds.length; i += CHUNK) hpChunks.push(teltikHostedIds.slice(i, i + CHUNK));
      const hpUrl = env.SUPABASE_URL + '/rest/v1/rpc/get_hosting_port_status_summary';
      const hpHeaders = {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      try {
        const hpResponses = await Promise.all(hpChunks.map(chunk =>
          fetch(hpUrl, { method: 'POST', headers: hpHeaders, body: JSON.stringify({ sim_ids: chunk }) })
            .then(r => r.ok ? r.json() : null)
        ));
        for (const rows of hpResponses) {
          if (!Array.isArray(rows)) continue;
          for (const row of rows) hostPortMap[row.sim_id] = row;
        }
      } catch (_) { /* pre-migration or transient RPC failure: no host-port data */ }
    }

    const formatted = filteredSims.map(sim => {
      const smsStat = smsMap[sim.id] || { count: 0, last_received: null };
      const hp = hostPortMap[sim.id] || null;

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
        gateway_host: sim.gateway_host || null,
        carrier: sim.carrier || null,
        rotation_interval_hours: sim.rotation_interval_hours || 24,
        rotation_eligible: sim.rotation_eligible !== false,
        hosting_port_state: hp ? hp.last_state : null,
        hosting_port_checked_at: hp ? hp.last_checked_at : null,
        hosting_port_source: hp ? hp.last_source : null,
        hosting_port_mdn: hp ? hp.last_mdn : null,
        hosting_port_mdn_source: hp ? hp.last_mdn_source : null,
        hosting_port_error: hp ? hp.last_error : null,
        hosting_port_checks_24h: hp ? hp.checks_24h : 0,
        hosting_port_online_24h: hp ? hp.online_24h : 0,
        hosting_port_checks_7d: hp ? hp.checks_7d : 0,
        hosting_port_online_7d: hp ? hp.online_7d : 0,
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

async function resolveTeltikKnownMdnForSim(env, sim, dbCurrentMdn) {
  return resolveSharedTeltikKnownMdn(env, {
    ...(sim || {}),
    db_current_mdn: dbCurrentMdn || (sim && (sim.db_current_mdn || sim.current_mdn_e164)) || null,
  });
}

// Heal a swapped-card Teltik SIM. After Teltik replaces the physical SIM the
// ICCID changes but the MDN does not, so every call keyed by the OLD ICCID 404s
// "Invalid ICCID" — but get-info BY MDN still resolves the line and returns the
// CURRENT ICCID. Adopt it via the shared iccidSwapPatch (no number churn, no
// reseller webhook). Teltik get-info is keyed by the Teltik-known MDN: the
// latest raw Teltik inbound SMS payload destination, falling back to DB msisdn
// only when no Teltik SMS payload MDN exists. Never throws. `sim` needs { id, iccid, msisdn }.
async function healTeltikIccidBySim(env, sim) {
  if (!sim || !sim.id) return { ok: false, reason: 'missing_sim' };
  if (!env.TELTIK_API_KEY) return { ok: false, reason: 'teltik_key_missing' };
  const dbCurrentMdn = sim.msisdn ? '+1' + String(sim.msisdn).replace(/\D/g, '').replace(/^1/, '') : null;
  const picked = await resolveTeltikKnownMdnForSim(env, sim, dbCurrentMdn);
  const mdn = picked ? toTeltik10Digit(picked.mdn) : '';
  if (mdn.length !== 10) return { ok: false, reason: 'missing_or_invalid_mdn' };
  const infoUrl = 'https://api.smsgateway.xyz/v1/get-info?apikey=' + encodeURIComponent(env.TELTIK_API_KEY) + '&mdn=' + encodeURIComponent(mdn);
  let res, text;
  try { res = await relayFetch(env, infoUrl, { method: 'GET' }); text = await res.text(); }
  catch (e) { return { ok: false, reason: 'get_info_exception' }; }
  let info = null; try { info = JSON.parse(text); } catch {}
  await logCarrierApiCall(env, {
    run_id: 'teltik_heal_iccid_' + sim.id + '_' + Date.now(),
    step: 'sync_iccid', iccid: sim.iccid, imei: null, vendor: 'teltik',
    request_url: 'https://api.smsgateway.xyz/v1/get-info?mdn=' + encodeURIComponent(mdn),
    request_method: 'GET', request_body: null,
    response_status: res.status, response_ok: res.ok,
    response_body_text: text, response_body_json: info,
    error: res.ok ? null : ('Teltik get-info HTTP ' + res.status),
  });
  if (res.status === 404) return { ok: false, reason: 'line_not_found_deprovisioned' };
  if (!res.ok || !info) return { ok: false, reason: 'get_info_http_' + res.status };
  const newIccid = info.iccid || null;
  if (!newIccid) return { ok: false, reason: 'no_iccid_in_response' };
  if (newIccid === sim.iccid) return { ok: true, changed: false, iccid: newIccid, mdn_source: picked ? picked.source : null };
  const patchRes = await fetch(env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + encodeURIComponent(String(sim.id)), {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(iccidSwapPatch(sim.iccid, newIccid)),
  });
  if (!patchRes.ok) {
    const detail = await patchRes.text().catch(() => '');
    return { ok: false, reason: 'db_patch_' + patchRes.status, detail: detail.slice(0, 200) };
  }
  return { ok: true, changed: true, old_iccid: sim.iccid, new_iccid: newIccid, mdn_source: picked ? picked.source : null };
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
    let resolvedMdnSource = null;
    let iccid_heal = null;
    if (res.ok && json) {
      const rawMdn = json.msisdn || json.mdn || json.phone_number || '';
      if (rawMdn) {
        resolvedMdn = rawMdn;
        resolvedMdnSource = 'teltik_get_phone_number_inventory';
        db_update = await syncActiveSim(env, iccid, { mdn: rawMdn, activatedAt: null });
      } else {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: 'Teltik query: no MDN in response at ' + new Date().toISOString(),
        }).catch(() => {});
      }
    } else if (isTeltikInvalidIccidResponse(res.status, json || text)) {
      // Physical SIM-card swap: the old ICCID is dead but the MDN still resolves.
      // Auto-heal by adopting the line's current ICCID instead of just flagging error.
      const simRows = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,iccid,msisdn&limit=1').catch(() => null);
      const simRow = Array.isArray(simRows) && simRows[0] ? simRows[0] : null;
      if (simRow) iccid_heal = await healTeltikIccidBySim(env, simRow);
      if (!(iccid_heal && iccid_heal.ok)) {
        await sbPatch(env, 'sims?iccid=eq.' + encodeURIComponent(iccid), {
          status: 'error',
          last_rotation_error: 'Teltik query HTTP ' + res.status + ' (Invalid ICCID; heal ' + ((iccid_heal && iccid_heal.reason) || 'unavailable') + ') at ' + new Date().toISOString(),
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

    // Operator UI expects Query to also surface /v1/port-status so an offline
    // gateway is visible. Live Teltik now requires mdn here too (BRR #6938);
    // use the MDN resolved from get-phone-number and never ICCID. Failure here
    // is non-fatal, but no valid MDN means we must skip instead of making a
    // malformed apikey-only request.
    let port_status = null;
    const portStatusMdn = toTeltik10Digit(resolvedMdn);
    if (!portStatusMdn || portStatusMdn.length !== 10) {
      port_status = { ok: false, skipped: true, error: 'no valid Teltik-known MDN — port-status skipped' };
    } else {
      try {
        const psUrl = 'https://api.smsgateway.xyz/v1/port-status?apikey=' + encodeURIComponent(apiKey)
          + '&mdn=' + encodeURIComponent(portStatusMdn);
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
          request_url: 'https://api.smsgateway.xyz/v1/port-status?mdn=' + encodeURIComponent(portStatusMdn),
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
          response: psJson || psText,
        };
      } catch (e) {
        port_status = { ok: false, error: 'port-status exception: ' + (e && e.message ? e.message : String(e)) };
      }
    }

    // Canonical hosting port-status history (task t_a71decd6): every Query for
    // a Teltik-vendor SIM records its /v1/port-status read. Failed/skipped
    // reads record as error, never offline.
    try {
      const hpsSimRows = await sbGet(env, 'sims?iccid=eq.' + encodeURIComponent(iccid) + '&select=id,vendor,gateway_host&limit=1').catch(() => null);
      const hpsSim = Array.isArray(hpsSimRows) && hpsSimRows[0] ? hpsSimRows[0] : null;
      const psHttp = (port_status && port_status.http_status) || null;
      const psBody = port_status && typeof port_status.response === 'object' ? port_status.response
        : (port_status && port_status.response != null ? { raw: port_status.response } : null);
      await recordHostingPortCheck(env, buildHostingPortCheckRow({
        sim_id: hpsSim ? hpsSim.id : null,
        iccid,
        vendor: (hpsSim && hpsSim.vendor) || 'teltik',
        gateway_host: (hpsSim && hpsSim.gateway_host) || 'teltik',
        mdn: portStatusMdn && portStatusMdn.length === 10 ? portStatusMdn : null,
        mdn_source: portStatusMdn && portStatusMdn.length === 10 ? resolvedMdnSource : null,
        source: 'single_query',
        http_status: psHttp,
        state: normalizeHostPortState(psHttp, psBody),
        raw: psBody,
        error: (port_status && (port_status.error || (!port_status.ok && psHttp ? 'Teltik port-status HTTP ' + psHttp : null))) || null,
      }));
    } catch (_) { /* recording must not break Query */ }

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update,
      iccid_heal,
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

// POST /api/teltik-host-check — Teltik gateway checks for a SIM seated in a
// Teltik gateway but provisioned on another carrier (e.g. Atomic vendor,
// gateway_host='teltik'). The provider query stays with the vendor API; this
// adds what the Teltik side knows about the line.
//
// MDN rule: Teltik/TotalTick may still know the line by the first MDN it ever
// saw — our rotations don't sync back to Teltik (inbound SMS matches by
// ICCID-in-alias for the same reason). Both /v1/get-info and /v1/port-status
// use the Teltik-known MDN: the raw payload destination of the latest
// Teltik-delivered inbound SMS for this SIM, falling back to our DB current MDN
// only when no such SMS payload MDN exists. Never key Teltik host-port status by ICCID.
async function handleTeltikHostCheck(request, env, corsHeaders) {
  try {
    const body = await request.json().catch(() => ({}));
    const apiKey = env.TELTIK_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'TELTIK_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    let simId = body.sim_id || null;
    const iccid = body.iccid || null;
    let dbCurrentMdn = body.mdn || null;
    let simVendor = body.vendor || null;
    let simGatewayHost = body.gateway_host || null;
    if ((!simId && iccid) || (simId && !simVendor)) {
      const filter = simId ? 'id=eq.' + encodeURIComponent(String(simId)) : 'iccid=eq.' + encodeURIComponent(String(iccid));
      const rows = await sbGet(env, 'sims?select=id,iccid,vendor,gateway_host,sim_numbers(e164)&sim_numbers.valid_to=is.null&' + filter + '&limit=1').catch(() => null);
      const sim = Array.isArray(rows) && rows[0] ? rows[0] : null;
      if (sim) {
        simId = sim.id;
        simVendor = simVendor || sim.vendor || null;
        simGatewayHost = simGatewayHost || sim.gateway_host || null;
        if (!dbCurrentMdn) dbCurrentMdn = (sim.sim_numbers && sim.sim_numbers[0] && sim.sim_numbers[0].e164) || null;
      }
    }

    const picked = await resolveTeltikKnownMdnForSim(env, { id: simId, iccid }, dbCurrentMdn);
    const mdnDigits = picked ? toTeltik10Digit(picked.mdn) : null;

    const teltikGet = async (step, loggedUrl, fullUrl) => {
      const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + fullUrl : fullUrl;
      const headers = {};
      if (env.RELAY_KEY) headers['x-relay-key'] = env.RELAY_KEY;
      const res = await fetch(fetchUrl, { method: 'GET', headers });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      await logCarrierApiCall(env, {
        run_id: 'teltik_host_' + step + '_' + (iccid || simId || 'unknown') + '_' + Date.now(),
        step,
        iccid,
        imei: null,
        vendor: 'teltik',
        request_url: loggedUrl,
        request_method: 'GET',
        request_body: null,
        response_status: res.status,
        response_ok: res.ok,
        response_body_text: text,
        response_body_json: json,
        error: res.ok ? null : 'Teltik ' + step + ' HTTP ' + res.status,
      });
      return { ok: res.ok, http_status: res.status, response: json || text };
    };

    // Line-specific context by Teltik-known MDN.
    let get_info = null;
    if (mdnDigits && mdnDigits.length === 10) {
      get_info = await teltikGet('get_info',
        'https://api.smsgateway.xyz/v1/get-info?mdn=' + encodeURIComponent(mdnDigits),
        'https://api.smsgateway.xyz/v1/get-info?apikey=' + encodeURIComponent(apiKey) + '&mdn=' + encodeURIComponent(mdnDigits));
    }

    let port_status = null;
    if (mdnDigits && mdnDigits.length === 10) {
      port_status = await teltikGet('port_status',
        'https://api.smsgateway.xyz/v1/port-status?mdn=' + encodeURIComponent(mdnDigits),
        'https://api.smsgateway.xyz/v1/port-status?apikey=' + encodeURIComponent(apiKey) + '&mdn=' + encodeURIComponent(mdnDigits));
    } else {
      port_status = { ok: false, skipped: true, error: 'no valid Teltik-known MDN — port-status skipped' };
    }

    // Canonical hosting port-status history (task t_a71decd6). Failed/skipped
    // reads record as error, never offline.
    await recordHostingPortCheck(env, buildHostingPortCheckRow({
      sim_id: simId,
      iccid,
      vendor: simVendor,
      gateway_host: simGatewayHost || 'teltik',
      mdn: mdnDigits && mdnDigits.length === 10 ? mdnDigits : null,
      mdn_source: picked ? picked.source : null,
      source: body.source === 'manual_bulk' ? 'manual_bulk' : 'single_query',
      http_status: port_status.http_status || null,
      state: normalizeHostPortState(port_status.http_status, typeof port_status.response === 'object' ? port_status.response : null),
      raw: typeof port_status.response === 'object' ? port_status.response : (port_status.response != null ? { raw: port_status.response } : null),
      error: port_status.ok ? null : (port_status.error || 'Teltik port-status HTTP ' + port_status.http_status),
    }));

    return new Response(JSON.stringify({
      ok: (get_info ? get_info.ok : true) && port_status.ok,
      sim_id: simId,
      iccid,
      mdn: mdnDigits || null,
      mdn_source: picked ? picked.source : null,
      db_current_mdn: dbCurrentMdn,
      latest_teltik_sms: picked && picked.source === 'teltik_inbound_sms_payload_mdn'
        ? { received_at: picked.received_at || null } : null,
      mdn_resolution: picked ? { source: picked.source, trail: picked.trail || null, inventory: picked.inventory || null } : null,
      get_info: get_info || { ok: false, skipped: true, error: 'no valid Teltik-known MDN — get-info skipped' },
      port_status,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// POST /api/hosting-port-status/run — operator/bulk/manual sweep of Teltik
// hosting port status. Body: { sim_ids?: number[], source?: 'manual_bulk'|'manual_sweep',
// offset?: number, max_sims?: number }. With sim_ids: checks exactly those SIMs
// (Sims bulk action). Without: sweeps active Teltik-hosted SIMs in a stable
// id-ordered batch at { offset, max_sims } — the Workers-page full run loops
// batches until has_more=false. All checks persist through the shared recorder,
// so manual runs count in uptime stats.
async function handleHostingPortStatusRun(request, env, corsHeaders) {
  try {
    const body = await request.json().catch(() => ({}));
    const simIds = Array.isArray(body.sim_ids) && body.sim_ids.length > 0 ? body.sim_ids : null;
    const source = body.source === 'manual_bulk' ? 'manual_bulk' : 'manual_sweep';
    const offset = Number.isInteger(body.offset) && body.offset >= 0 ? body.offset : 0;
    const maxSims = Number.isInteger(body.max_sims) && body.max_sims >= 1 && body.max_sims <= 500
      ? body.max_sims : 200;
    // Durable full sweep: { source: 'manual_sweep', async: true } enqueues a
    // hosting_port_status_jobs row and returns immediately; the 1-minute
    // scheduled tick drains it batch by batch server-side, independent of the
    // browser. enqueueHostingPortJob clamps max_sims to ASYNC_JOB_MAX_SIMS so
    // one tick's batch fits Cloudflare's subrequest budget. Synchronous
    // single-batch mode below stays for sim_ids bulk checks and tests.
    if (body.async === true && !simIds) {
      const job = await enqueueHostingPortJob(env, { source: 'manual_sweep', maxSims, createdBy: 'dashboard' });
      return new Response(JSON.stringify(job), {
        status: job.ok ? 202 : 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const summary = await runHostingPortSweep(env, { simIds, source, offset, maxSims });
    return new Response(JSON.stringify(summary, null, 2), {
      status: summary.ok ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/hosting-port-status/jobs?limit=5 — recent durable sweep jobs,
// newest first, so the Workers page can rediscover an in-flight sweep after
// the browser was closed and reopened.
async function handleHostingPortStatusJobsList(url, env, corsHeaders) {
  try {
    const limit = Number(url.searchParams.get('limit'));
    const jobs = await listHostingPortJobs(env, { limit: Number.isInteger(limit) ? limit : 5 });
    return new Response(JSON.stringify({ ok: true, jobs }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/hosting-port-status/jobs/:id — poll a durable sweep job. Polling
// is display-only: the job advances on the scheduled tick whether or not
// anyone is watching.
async function handleHostingPortStatusJobGet(jobId, env, corsHeaders) {
  try {
    const job = await getHostingPortJob(env, jobId);
    if (!job) {
      return new Response(JSON.stringify({ ok: false, error: 'job not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, job }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
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

// GET /api/rotation-health — the Rotation Health tab's single data call.
// Mirrors details-finalizer's computeDueBaseline()/countDeliveryGaps() logic
// (src/shared/rotation-baseline.mjs) but runs the queries directly here so the
// tab loads with one fast round-trip and no service-binding hop.
async function handleRotationHealth(request, env, corsHeaders) {
  const jsonResp = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
  try {
    // Start of today's NY calendar date as UTC ISO (DST-safe: try both offsets)
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).reduce((a, p) => (p.type !== 'literal' && (a[p.type] = p.value), a), {});
    let tonightStart = `${parts.year}-${parts.month}-${parts.day}T05:00:00Z`;
    for (const off of ['04', '05']) {
      const cand = `${parts.year}-${parts.month}-${parts.day}T${off}:00:00Z`;
      const back = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(cand)).reduce((a, p) => (p.type !== 'literal' && (a[p.type] = p.value), a), {});
      if (back.day === parts.day) { tonightStart = cand; break; }
    }
    const enc = encodeURIComponent;

    const [nightly, teltik, recent, failedTonight, lastRuns] = await Promise.all([
      supabaseGetAllArray(env, `sims?select=id,vendor,last_mdn_rotated_at,activated_at,reseller_sims!inner(reseller_id,active)&reseller_sims.active=eq.true&status=eq.active&vendor=neq.teltik&rotation_eligible=eq.true`),
      supabaseGetAllArray(env, `sims?select=id,last_mdn_rotated_at,rotation_interval_hours,reseller_sims!inner(reseller_id,active)&reseller_sims.active=eq.true&status=eq.active&vendor=eq.teltik`),
      supabaseGetAllArray(env, `sims?select=id,vendor,last_mdn_rotated_at,last_notified_at&status=eq.active&rotation_status=eq.success&last_mdn_rotated_at=gte.${enc(new Date(Date.now() - 24 * 3600 * 1000).toISOString())}`),
      supabaseGetAllArray(env, `sims?select=id,vendor,msisdn,last_rotation_error&rotation_status=eq.failed&last_mdn_rotated_at=gt.${enc(tonightStart)}`),
      supabaseGet(env, `cron_runs?select=run_id,kind,status,started_at,ended_at,summary&kind=in.(rotation_review,catchup_sweep)&order=started_at.desc&limit=10`)
        .then(r => r.ok ? r.json() : []),
    ]);

    // Open-pending count (needs Prefer: count=exact, so a dedicated call)
    let pendingOpen = 0;
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/pending_review_items?status=eq.open&select=id&limit=1`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
        },
      });
      const m = (res.headers.get('content-range') || '').match(/\/(\d+|\*)$/);
      pendingOpen = m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
    } catch {}

    const perVendor = {};
    let missedTotal = 0;
    for (const s of nightly) {
      const v = s.vendor || 'unknown';
      if (!perVendor[v]) perVendor[v] = { eligible: 0, rotated: 0, missed: 0 };
      perVendor[v].eligible++;
      const rotatedToday = s.last_mdn_rotated_at && s.last_mdn_rotated_at >= tonightStart;
      const activatedToday = s.activated_at && s.activated_at >= tonightStart;
      if (rotatedToday) perVendor[v].rotated++;
      else if (!activatedToday) { perVendor[v].missed++; missedTotal++; }
    }
    const nowMs = Date.now();
    const teltikDue = teltik.filter(s => !s.last_mdn_rotated_at
      || nowMs - new Date(s.last_mdn_rotated_at).getTime() >= (s.rotation_interval_hours || 48) * 3600 * 1000).length;
    const teltikRotatedToday = teltik.filter(s => s.last_mdn_rotated_at && s.last_mdn_rotated_at >= tonightStart).length;
    const deliveryGaps = recent.filter(s => s.last_mdn_rotated_at
      && (!s.last_notified_at || new Date(s.last_notified_at) < new Date(s.last_mdn_rotated_at)));

    return jsonResp({
      generated_at: new Date().toISOString(),
      tonight_start: tonightStart,
      per_vendor: perVendor,
      missed_total: missedTotal,
      teltik: { eligible: teltik.length, due_now: teltikDue, rotated_today: teltikRotatedToday },
      delivery_gaps: deliveryGaps.length,
      delivery_gap_sims: deliveryGaps.slice(0, 50).map(s => ({ id: s.id, vendor: s.vendor, rotated_at: s.last_mdn_rotated_at })),
      failed_tonight: failedTonight.length,
      failed_sims: failedTonight.slice(0, 50),
      pending_open: pendingOpen,
      recent_runs: lastRuns,
    });
  } catch (e) {
    return jsonResp({ error: String(e) }, 500);
  }
}

// POST /api/catchup-sweep/run — manual "fix it now" trigger; proxies the
// details-finalizer /catchup-sweep endpoint (same engine as the 2h cron).
async function handleCatchupSweepRun(request, env, corsHeaders) {
  try {
    if (!env.FINALIZER_RUN_SECRET || !env.DETAILS_FINALIZER) {
      return new Response(JSON.stringify({ error: 'FINALIZER_RUN_SECRET or DETAILS_FINALIZER not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const reqUrl = new URL(request.url);
    const dry = reqUrl.searchParams.get('dry') === '1' ? '&dry=1' : '';
    const url = 'https://details-finalizer/catchup-sweep?secret=' + encodeURIComponent(env.FINALIZER_RUN_SECRET) + dry;
    const r = await env.DETAILS_FINALIZER.fetch(url, { method: 'GET' });
    const body = await r.text();
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 500) }; }
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, result: parsed }), {
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

    // Teltik SIMs can't be fixed via mdn-rotator (it has no Teltik API — Teltik
    // is delegated to teltik-worker). The dominant Teltik "broken" case is a
    // physical SIM-card swap → stale ICCID, which we heal in-dashboard via
    // get-info-by-MDN. Partition: heal teltik here, forward the rest to mdn-rotator.
    const idList = simIds.map(s => encodeURIComponent(String(s))).join(',');
    const simRows = await sbGet(env, 'sims?id=in.(' + idList + ')&select=id,iccid,msisdn,vendor').catch(() => null);
    const rows = Array.isArray(simRows) ? simRows : [];
    const teltikRows = rows.filter(r => r.vendor === 'teltik');
    const teltikIds = new Set(teltikRows.map(r => String(r.id)));
    const otherIds = simIds.filter(s => !teltikIds.has(String(s)));

    const results = [];
    for (const r of teltikRows) {
      const heal = await healTeltikIccidBySim(env, r);
      results.push({ sim_id: r.id, vendor: 'teltik', ok: !!heal.ok, changed: !!heal.changed, new_iccid: heal.new_iccid || null, reason: heal.reason || null });
    }

    let rotatorRaw = null;
    if (otherIds.length > 0) {
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
      const workerUrl = 'https://mdn-rotator/fix-sim?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET);
      const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sim_ids: otherIds })
      });
      const responseText = await workerResponse.text();
      try { rotatorRaw = JSON.parse(responseText); } catch {
        rotatorRaw = { ok: false, error: 'Non-JSON response: ' + responseText.slice(0, 200) };
      }
      if (rotatorRaw && Array.isArray(rotatorRaw.results)) results.push(...rotatorRaw.results);
    }

    return new Response(JSON.stringify({
      ok: true,
      results,
      ...(rotatorRaw && !Array.isArray(rotatorRaw.results) ? { rotator: rotatorRaw } : {}),
    }, null, 2), {
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
    // ?auto_resolution implies a closed-report view (auto-resolved reports are
    // status='remediated'), so without an explicit ?status we must not apply the
    // default open-only filter — it would hide every matching row.
    const autoResolution = (url.searchParams.get('auto_resolution') || '').trim();
    const includeAll = statusParam === 'all' || (!statusParam && !!autoResolution);
    const statusFilter = (statusParam && statusParam !== 'all') ? statusParam : 'received,in_triage';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1000);
    // Bad-rental reviewer auto-resolutions (HE1). The remediator records the
    // explicit action/reason on the ATTEMPT row rather than on
    // rental_reports.remediation_action, whose CHECK constraint only allows
    // (rotated|port_reset|sim_replaced|mdn_swapped|other). So filtering by
    // ?auto_resolution=healthy_evidence_auto_resolved resolves report ids from
    // rental_report_remediation_attempts first, then constrains the list query.
    let autoResolutionIds = null;
    if (autoResolution) {
      autoResolutionIds = await fetchAutoResolvedReportIds(env, autoResolution);
      if (autoResolutionIds.length === 0) {
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
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
      'sims(iccid,vendor,gateway_host,sim_numbers(e164,valid_to))',
      'report_sim_number:sim_numbers!rental_reports_sim_number_id_fkey(e164,valid_from,valid_to)',
    ].join(',');
    let query = 'rental_reports?select=' + encodeURIComponent(select);
    if (!includeAll) {
      query += '&status=in.(' + encodeURIComponent(statusFilter) + ')';
    }
    if (autoResolutionIds) {
      query += '&id=in.(' + encodeURIComponent(autoResolutionIds.join(',')) + ')';
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
                  auto_resolution: null,
                  auto_resolved_at: null,
                };
              }
              attemptSummary[k].count += 1;
              // Rows arrive newest-first, so the first match is the resolving attempt.
              if (a.outcome === HEALTHY_EVIDENCE_OUTCOME && !attemptSummary[k].auto_resolution) {
                attemptSummary[k].auto_resolution = HEALTHY_EVIDENCE_OUTCOME;
                attemptSummary[k].auto_resolved_at = a.attempted_at || null;
              }
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
        issue_type: issueTypeForBadRentalRow(r),
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
        auto_resolution: s ? s.auto_resolution : null,
        auto_resolution_reason: (s && s.auto_resolution === HEALTHY_EVIDENCE_OUTCOME)
          ? HEALTHY_EVIDENCE_REASON : null,
        auto_resolved_at: s ? s.auto_resolved_at : null,
        resellers: r.resellers || null,
        iccid: r && r.sims ? r.sims.iccid : null,
        vendor: r && r.sims ? r.sims.vendor : null,
        gateway_host: r && r.sims ? r.sims.gateway_host : null,
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


// Bad Rental Review auto-resolution vocabulary. Mirrors
// src/bad-rental-remediator/healthy-evidence.mjs — the remediator writes these
// on the attempt row (action/outcome) and in the rental_report_events evidence.
const HEALTHY_EVIDENCE_OUTCOME = 'healthy_evidence_auto_resolved';
const HEALTHY_EVIDENCE_REASON  = 'confirmed_working';
const HEALTHY_EVIDENCE_ACTION  = 'healthy_evidence_auto_resolve';

// An `id=in.(...)` filter is spliced into a GET URL, so the id list has to
// stay inside the request-line limits of the Workers runtime and of PostgREST's
// proxy. HE1's whole premise is that a LARGE share of the queue is noise, so
// the auto-resolved set grows without bound — 5000 ids would build a ~40KB URL
// and fail with a 414 rather than returning fewer rows. Chunk (summary) or cap
// (list) at this size instead.
const MAX_REPORT_ID_FILTER = 500;

function chunkIds(ids, size = MAX_REPORT_ID_FILTER) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// Report ids whose remediation attempts carry the given auto-resolution
// outcome. Unknown/unsupported values return [] rather than an unfiltered
// list, so a typo can never silently widen the result set.
//
// Attempts come back newest-first, so when there are more auto-resolutions
// than one URL can carry we keep the MOST RECENT MAX_REPORT_ID_FILTER of them
// — which is what a received_at.desc list view wants anyway — and log the drop
// rather than truncating silently.
async function fetchAutoResolvedReportIds(env, outcome) {
  if (outcome !== HEALTHY_EVIDENCE_OUTCOME) return [];
  try {
    const resp = await supabaseGet(env,
      'rental_report_remediation_attempts?outcome=eq.' + encodeURIComponent(outcome)
      + '&select=report_id&order=attempted_at.desc&limit=5000');
    if (!resp.ok) return [];
    const rows = await resp.json();
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    for (const r of rows) {
      if (r && r.report_id != null) seen.add(r.report_id);
    }
    // Set iteration is insertion order, i.e. newest attempt first.
    const ids = [...seen];
    if (ids.length > MAX_REPORT_ID_FILTER) {
      console.log('[fetchAutoResolvedReportIds] ' + ids.length + ' auto-resolved reports;'
        + ' returning the ' + MAX_REPORT_ID_FILTER + ' most recent to keep the id filter in one URL');
      return ids.slice(0, MAX_REPORT_ID_FILTER);
    }
    return ids;
  } catch (e) {
    console.log('[fetchAutoResolvedReportIds] failed: ' + e);
    return [];
  }
}

// GET /api/bad-rentals/escalation-backlog
//
// R2 — read-only operator_escalations counts (queued, delivery_failed,
// delivered, total, oldest created_at). The remediator worker's own
// backlog fetcher stays the source of truth for the drain logic; this is
// just visibility so an operator does not need to hit the worker's admin
// JSON endpoint directly to see the same numbers. Counts only — no
// line_item content (MDNs/ICCIDs) crosses this route.
async function handleBadRentalEscalationBacklog(env, corsHeaders) {
  try {
    const countFor = async (filter) => {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/operator_escalations?select=id${filter}`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      });
      const m = (res.headers.get('content-range') || '').match(/\/(\d+|\*)$/);
      return m && m[1] !== '*' ? parseInt(m[1], 10) : 0;
    };
    const [queued, deliveryFailed, delivered, total] = await Promise.all([
      countFor('&status=eq.queued'),
      countFor('&status=in.(delivery_failed,post_failed)'),
      countFor('&status=in.(delivered,posted)'),
      countFor(''),
    ]);
    const oldestRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/operator_escalations?select=created_at&status=not.in.(delivered,posted)&order=created_at.asc&limit=1`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } },
    );
    const oldestRows = oldestRes.ok ? await oldestRes.json().catch(() => []) : [];
    const oldest_created_at = Array.isArray(oldestRows) && oldestRows[0] ? oldestRows[0].created_at : null;
    return new Response(JSON.stringify({
      queued, delivery_failed: deliveryFailed, delivered, total, oldest_created_at,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

// GET /api/bad-rentals/healthy-evidence-summary?days=7
//
// Operator rollup for reports the reviewer closed on proven-healthy evidence
// (provider Active + host port ONLINE + inbound-SMS usage proof). Answers
// "how much of the bad-rental queue is noise, and on which vendors/hosts".
// Customer numbers are never included — report/SIM ids and timestamps only.
async function handleHealthyEvidenceSummary(env, corsHeaders, url) {
  try {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '7', 10) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const aResp = await supabaseGet(env,
      'rental_report_remediation_attempts?outcome=eq.' + encodeURIComponent(HEALTHY_EVIDENCE_OUTCOME)
      + '&attempted_at=gte.' + encodeURIComponent(since)
      + '&select=report_id,action,outcome,mode,attempted_at&order=attempted_at.desc&limit=5000');
    if (!aResp.ok) {
      const txt = await aResp.text();
      return new Response(JSON.stringify({ error: 'supabase_' + aResp.status, detail: txt }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const attempts = await aResp.json();
    const rows = Array.isArray(attempts) ? attempts : [];
    // One entry per report (newest attempt wins).
    const byReport = new Map();
    for (const a of rows) {
      if (!a || a.report_id == null) continue;
      if (!byReport.has(a.report_id)) {
        byReport.set(a.report_id, {
          report_id: a.report_id,
          resolved_at: a.attempted_at || null,
          action: a.action || HEALTHY_EVIDENCE_ACTION,
          mode: a.mode || null,
        });
      }
    }
    const ids = [...byReport.keys()];
    const summary = {
      resolution: HEALTHY_EVIDENCE_OUTCOME,
      reason: HEALTHY_EVIDENCE_REASON,
      window_days: days,
      since,
      total: ids.length,
      by_vendor: {},
      by_gateway_host: {},
      by_status: {},
      reports: [],
    };
    if (ids.length === 0) {
      return new Response(JSON.stringify(summary), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const select = ['id', 'status', 'sim_id', 'rental_id', 'received_at', 'closed_at',
      'auto_remediation_state', 'remediation_action',
      'rentals(reseller_rental_id)', 'sims(vendor,gateway_host)'].join(',');
    // Chunked, not capped: this is a rollup, so every auto-resolved report in
    // the window has to be counted. One `id=in.(...)` per MAX_REPORT_ID_FILTER
    // ids keeps each request line short enough to survive.
    const reportRows = [];
    for (const chunk of chunkIds(ids)) {
      const rResp = await supabaseGet(env,
        'rental_reports?select=' + encodeURIComponent(select)
        + '&id=in.(' + encodeURIComponent(chunk.join(',')) + ')'
        + '&order=closed_at.desc.nullslast&limit=' + MAX_REPORT_ID_FILTER);
      if (!rResp.ok) continue;
      const part = await rResp.json().catch(() => []);
      if (Array.isArray(part)) reportRows.push(...part);
    }
    for (const r of reportRows) {
      const meta = byReport.get(r.id) || {};
      const vendor = (r.sims && r.sims.vendor) || 'unknown';
      const host = (r.sims && r.sims.gateway_host) || 'unknown';
      const status = r.status || 'unknown';
      summary.by_vendor[vendor] = (summary.by_vendor[vendor] || 0) + 1;
      summary.by_gateway_host[host] = (summary.by_gateway_host[host] || 0) + 1;
      summary.by_status[status] = (summary.by_status[status] || 0) + 1;
      summary.reports.push({
        report_id: r.id,
        status: r.status,
        auto_remediation_state: r.auto_remediation_state || null,
        remediation_action: r.remediation_action || null,
        auto_resolution: HEALTHY_EVIDENCE_OUTCOME,
        auto_resolution_reason: HEALTHY_EVIDENCE_REASON,
        resolved_at: meta.resolved_at || r.closed_at || null,
        received_at: r.received_at || null,
        sim_id: r.sim_id || null,
        rental_id: r.rental_id || null,
        reseller_rental_id: (r.rentals && r.rentals.reseller_rental_id) || null,
        vendor,
        gateway_host: host,
      });
    }
    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

function issueTypeForBadRentalRow(r) {
  if (!r) return null;
  if (r.issue_type) return r.issue_type; // forward-compatible if DB column is added later
  if (r.escalation_reason === 'teltik_gateway_port_offline') return 'Teltik gateway port offline';
  return null;
}

// Compatibility alias for the original "Export Teltik offline CSV" endpoint.
//
// The old handler had no date range (it swept every report ever written), a
// UTC "today" in the filename and only the host-offline escalation reason, so
// it could not answer "what needs escalation today". It now delegates to the
// deterministic escalation export below, pre-filtered to the host-offline
// escalation reason and defaulting to the last 30 New York days when the
// caller passes no range. Existing links keep working; they just get the
// richer, provider-vs-host separated CSV.
async function handleTeltikPortOfflineExport(env, corsHeaders, url) {
  const target = new URL(url ? url.toString() : 'https://dashboard/api/bad-rentals/teltik-port-offline-export');
  if (!target.searchParams.get('escalation_reason')) {
    target.searchParams.set('escalation_reason', 'teltik_gateway_port_offline');
  }
  if (!target.searchParams.get('start') && !target.searchParams.get('end') && !target.searchParams.get('days')) {
    target.searchParams.set('days', '30');
  }
  return handleBadRentalEscalationExport(env, corsHeaders, target);
}

// =========================================================
// Bad Rental Review — daily escalation export (t_732f6de4)
//
// Answers, for any New York date range, "which numbers/SIMs need escalating,
// and to whom": every SIM with bad-rental reports in the range, grouped per
// SIM, split by SERVICE PROVIDER (sims.vendor — Atomic/AT&T, Teltik, Wing,
// Helix) and GATEWAY HOST (sims.gateway_host — the physical gateway). The two
// axes are never collapsed: an Atomic-provider line seated in a Teltik gateway
// escalates to Atomic for the provider claim and to Teltik for the host claim,
// and is never reported as a "Teltik line".
//
// Cohorts follow the 2026-08-06 Atomic bad-rental audit:
//   C1a  zero inbound SMS in the window (and none ever) while the provider
//        reads Active + host port OFFLINE          → provider primary + host
//   C1b  zero inbound SMS while the host cannot report state (port-status
//        HTTP 400 though get-info resolves)        → joint provider + host
//   C3   line demonstrably delivered SMS in the window but the host port reads
//        OFFLINE now (reset already returned no_change) → host
//   C4   provider healthy + host online + traffic flowing → NOT escalated
//
// Everything is filtered on UTC instants derived from the NY date range, so
// the result never depends on which rows the Bad Rentals table happens to be
// showing or on which page filters are active.
// =========================================================

const ESCALATION_EXPORT_TZ = 'America/New_York';
const ESCALATION_EXPORT_MAX_DAYS = 92;
const ESCALATION_EXPORT_REPORT_LIMIT = 5000;
const ESCALATION_EXPORT_ATTEMPT_LIMIT = 5000;
const ESCALATION_EXPORT_INBOUND_PAGE = 1000;
const ESCALATION_EXPORT_INBOUND_MAX_PAGES = 20;
const ESCALATION_EXPORT_EVER_PROBE_LIMIT = 250;
// Port-status checks are sparse (12h cron + on-demand reads), so look a little
// before the window for the newest state rather than reporting "never checked".
const ESCALATION_EXPORT_HOST_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

// --- New York (or any IANA zone) date maths, no dependencies ---------------

// Milliseconds to ADD to a UTC instant to get the wall clock in `tz`
// (negative for New York). Derived from Intl so DST is handled by the runtime.
function tzOffsetMsAt(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - utcMs;
}

// The UTC instant at which the given local calendar day starts in `tz`.
// Two passes so a day that starts on a DST transition still resolves.
function zonedDayStartUtcMs(dateStr, tz) {
  const base = Date.parse(String(dateStr) + 'T00:00:00Z');
  if (!Number.isFinite(base)) return NaN;
  let ts = base - tzOffsetMsAt(base, tz);
  ts = base - tzOffsetMsAt(ts, tz);
  return ts;
}

// 'YYYY-MM-DD' for a UTC instant, in `tz`.
function zonedDateString(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// 'YYYY-MM-DD HH:mm' in `tz` — the operator-facing timestamp format. Returns
// '' for anything unparseable so a CSV cell is never the string "Invalid Date".
function formatZonedTimestamp(value, tz) {
  if (!value) return '';
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return parts.year + '-' + parts.month + '-' + parts.day
    + ' ' + (Number(parts.hour) % 24 + '').padStart(2, '0') + ':' + parts.minute;
}

function addDaysToDateString(dateStr, days) {
  const ms = Date.parse(String(dateStr) + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

const ESCALATION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Resolve ?start/?end/?days/?tz into UTC instants. No parameters at all means
// "needs escalation today" — the current NY day. Returns { error, message }
// with a plain-English message the UI can show verbatim.
function parseEscalationExportRange(url, nowMs) {
  const tz = (url.searchParams.get('tz') || '').trim() || ESCALATION_EXPORT_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (e) {
    return { error: 'invalid_tz', message: 'Unknown time zone "' + tz + '". Try America/New_York.' };
  }

  const today = zonedDateString(nowMs, tz);
  let start = (url.searchParams.get('start') || '').trim();
  let end = (url.searchParams.get('end') || '').trim();
  const daysParam = (url.searchParams.get('days') || '').trim();

  if (!start && !end && daysParam) {
    const n = parseInt(daysParam, 10);
    if (!Number.isFinite(n) || n < 1) {
      return { error: 'invalid_days', message: '?days must be a whole number of days, 1 or more (got "' + daysParam + '").' };
    }
    end = today;
    start = addDaysToDateString(today, -(Math.min(n, ESCALATION_EXPORT_MAX_DAYS) - 1));
  }
  if (!start && !end) { start = today; end = today; }
  if (start && !end) end = start;
  if (end && !start) start = end;

  if (!ESCALATION_DATE_RE.test(start)) {
    return { error: 'invalid_start', message: 'Start date must look like YYYY-MM-DD (got "' + start + '").' };
  }
  if (!ESCALATION_DATE_RE.test(end)) {
    return { error: 'invalid_end', message: 'End date must look like YYYY-MM-DD (got "' + end + '").' };
  }
  if (end < start) {
    return { error: 'end_before_start', message: 'End date ' + end + ' is before start date ' + start + '.' };
  }

  const startMs = zonedDayStartUtcMs(start, tz);
  const endMs = zonedDayStartUtcMs(addDaysToDateString(end, 1), tz);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { error: 'invalid_range', message: 'Could not resolve ' + start + ' → ' + end + ' in ' + tz + '.' };
  }
  const days = Math.round((endMs - startMs) / 86400000);
  if (days > ESCALATION_EXPORT_MAX_DAYS) {
    return {
      error: 'range_too_large',
      message: 'That range covers ' + days + ' days; the maximum is ' + ESCALATION_EXPORT_MAX_DAYS + '.',
    };
  }
  return {
    tz, start, end, days,
    start_utc: new Date(startMs).toISOString(),
    end_utc: new Date(endMs).toISOString(),
    start_ms: startMs, end_ms: endMs,
    is_today: start === today && end === today,
  };
}

// --- Labels ---------------------------------------------------------------

// SERVICE PROVIDER label — sims.vendor, the carrier account the line is
// provisioned on. Never derived from the gateway host.
function escalationProviderLabel(vendor) {
  const v = String(vendor || '').toLowerCase();
  if (v === 'atomic') return 'Atomic / AT&T (service provider)';
  if (v === 'wing_iot') return 'Wing IoT / AT&T (service provider)';
  if (v === 'helix') return 'Helix / T-Mobile (service provider)';
  if (v === 'teltik') return 'Teltik (service provider)';
  return (v || 'unknown') + ' (service provider)';
}

// GATEWAY HOST label — the physical gateway, independent of the provider.
function escalationHostLabel(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'teltik') return 'Teltik (gateway host)';
  if (h === 'skyline') return 'Skyline (gateway host)';
  return (h || 'unknown') + ' (gateway host)';
}

function mask4(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  return digits.length >= 4 ? '****' + digits.slice(-4) : '';
}

// --- Cohort classification (pure) -----------------------------------------

// Decide whether one SIM's group of reports needs escalation, which cohort it
// falls in, and who owns it. Provider and host verdicts are computed
// independently and can both fire (C1a/C1b are joint escalations).
function classifyEscalationGroup(group) {
  const g = group || {};
  const vendor = String(g.vendor || '').toLowerCase() || 'unknown';
  const host = String(g.gateway_host || '').toLowerCase() || 'unknown';
  const reasons = new Set((g.escalation_reasons || []).map(r => String(r || '').toLowerCase()).filter(Boolean));
  const hostCheck = g.host_check || null;
  const hostState = hostCheck ? String(hostCheck.state || '').toLowerCase() : '';
  const httpStatus = hostCheck && hostCheck.http_status != null ? Number(hostCheck.http_status) : null;
  const inbound = g.inbound || {};
  const inboundCount = Number(inbound.count_in_window || 0);
  const inboundEver = inbound.ever === true ? true : (inbound.ever === false ? false : null);
  const resetNoChange = !!g.reset_no_change || reasons.has('teltik_reset_failed');

  // ---- host verdict ----
  let hostIssue = null;
  if (hostState === 'offline' || reasons.has('teltik_gateway_port_offline')) {
    hostIssue = 'teltik_gateway_port_offline';
  } else if (hostState === 'error' && httpStatus === 400) {
    hostIssue = 'host_port_status_http_400';
  } else if (hostState === 'error' || hostState === 'unknown') {
    hostIssue = 'host_unobservable';
  } else if (reasons.has('teltik_forward_url_misconfigured')) {
    hostIssue = 'teltik_forward_url_misconfigured';
  } else if (resetNoChange) {
    hostIssue = 'teltik_reset_failed';
  }

  // ---- provider verdict ----
  // Zero inbound SMS in the window is only a PROVIDER claim when the line has
  // also never carried traffic (or we could not establish that it has): a line
  // that demonstrably delivered SMS is a host-side story, not a provider one.
  const PROVIDER_REASONS = [
    'vendor_active_no_sms', 'vendor_iccid_not_found', 'vendor_cancelled_active_rental',
    'imei_wrong_type', 'imei_drift_vendor', 'atomic_restore_failed', 'helix_unsuspend_failed',
    'wing_w7_dialable_retry_failed', 'wing_not_activated', 'vendor_mdn_drift', 'vendor_read_failed',
  ];
  let providerIssue = null;
  if (inboundCount === 0 && inboundEver !== true) {
    providerIssue = 'vendor_active_no_sms';
  } else {
    const hit = PROVIDER_REASONS.find(r => reasons.has(r));
    if (hit) providerIssue = hit === 'wing_not_activated' ? 'wing_w7_dialable_retry_failed' : hit;
  }

  // ---- cohort ----
  let cohort;
  let classification;
  if (providerIssue === 'vendor_active_no_sms' && hostIssue === 'teltik_gateway_port_offline') {
    cohort = 'C1a_zero_inbound_host_port_offline';
    classification = 'Zero inbound SMS in window' + (inboundEver === false ? ' and none ever received' : '')
      + '; host reports the port OFFLINE';
  } else if (providerIssue === 'vendor_active_no_sms' && hostIssue === 'host_port_status_http_400') {
    cohort = 'C1b_zero_inbound_host_port_status_400';
    classification = 'Zero inbound SMS in window' + (inboundEver === false ? ' and none ever received' : '')
      + '; host port-status returns HTTP 400 while get-info resolves the line';
  } else if (providerIssue === 'vendor_active_no_sms' && hostIssue) {
    cohort = 'C1b_zero_inbound_host_unobservable';
    classification = 'Zero inbound SMS in window; host state could not be established (' + hostIssue + ')';
  } else if (providerIssue === 'vendor_active_no_sms') {
    cohort = 'P1_zero_inbound_host_reads_healthy';
    classification = 'Zero inbound SMS in window while the host port reads healthy — provider side owns this';
  } else if (providerIssue) {
    cohort = 'P2_provider_' + providerIssue;
    classification = 'Provider-side failure recorded by the reviewer: ' + providerIssue;
  } else if (hostIssue === 'teltik_gateway_port_offline') {
    cohort = 'C3_host_port_offline_line_proven_good';
    classification = 'Line delivered ' + inboundCount + ' inbound SMS in window but the host port reads OFFLINE now';
  } else if (hostIssue === 'teltik_reset_failed') {
    cohort = 'H2_host_reset_failed_no_change';
    classification = 'Host port reset ran and returned no_change / failed';
  } else if (hostIssue) {
    cohort = 'H3_host_unobservable_line_proven_good';
    classification = 'Line delivered ' + inboundCount + ' inbound SMS in window but the host cannot report port state ('
      + hostIssue + ')';
  } else {
    cohort = 'C4_no_fault_found';
    classification = 'Provider healthy, host port online, ' + inboundCount + ' inbound SMS in window — no line fault found';
  }

  const escalate = !!(providerIssue || hostIssue);
  const providerTarget = providerIssue ? escalationProviderLabel(vendor) : '';
  const hostTarget = hostIssue ? escalationHostLabel(host) : '';
  const recommendedTarget = providerTarget && hostTarget
    ? providerTarget + ' + ' + hostTarget
    : (providerTarget || hostTarget || '');

  // Failure type in the §H.3 vocabulary (escalations.mjs). When both sides
  // fire, the provider claim is primary — that matches the audit's ownership.
  const failureType = providerIssue || (hostIssue === 'host_port_status_http_400' ? 'teltik_gateway_port_offline' : hostIssue) || '';

  // Confidence: how strongly the evidence supports the PRIMARY claim
  // (failure_type). An unproven "never delivered" claim is capped at low even
  // when the host read is definitive — the 2026-06-30 Atomic escalation was
  // argued on evidence that did not hold, and this export must not repeat it.
  let confidence = 'medium';
  if (!escalate) confidence = 'n/a';
  else if (providerIssue === 'vendor_active_no_sms' && inboundEver === null) confidence = 'low';
  else if (providerIssue === 'vendor_active_no_sms' && inboundEver === false && hostState) confidence = 'high';
  else if (!providerIssue && hostIssue === 'teltik_gateway_port_offline' && hostState === 'offline') confidence = 'high';

  const providerName = escalationProviderLabel(vendor).replace(' (service provider)', '');
  const hostName = escalationHostLabel(host).replace(' (gateway host)', '');
  let action;
  if (cohort.startsWith('C1a')) {
    action = 'Escalate to ' + providerName + ': line reads Active but has carried no inbound SMS'
      + (inboundEver === false ? ' since activation' : ' in this window')
      + ' — ask for an HSS/provisioning attach trace on this ICCID. In parallel ask ' + hostName
      + ' why the port is OFFLINE / whether the SIM is seated.';
  } else if (cohort.startsWith('C1b')) {
    action = 'Joint escalation. ' + hostName + ': /v1/port-status fails for this line while /v1/get-info resolves it'
      + (httpStatus ? ' (HTTP ' + httpStatus + ')' : '') + ' — ask why, and whether the line is seated in a gateway port. '
      + providerName + ': no inbound SMS' + (inboundEver === false ? ' since activation' : ' in this window')
      + ' though the line reads Active — ask for an attach trace.';
  } else if (cohort.startsWith('P1')) {
    action = 'Escalate to ' + providerName + ': host port reads healthy yet no inbound SMS landed'
      + (inboundEver === false ? ' since activation' : ' in this window') + '. Ask for an attach/delivery trace on this ICCID.';
  } else if (cohort.startsWith('P2')) {
    action = 'Escalate to ' + providerName + ': reviewer recorded ' + providerIssue + '. Attach the reviewer evidence below.';
  } else if (cohort.startsWith('C3')) {
    action = 'Escalate to ' + hostName + ': the line demonstrably delivered SMS in this window but the port reads OFFLINE now'
      + (resetNoChange ? ' and a port reset already returned no_change' : '')
      + ' — ask why a reset does not restore a port for a line that worked hours earlier.';
  } else if (cohort.startsWith('H2')) {
    action = 'Escalate to ' + hostName + ': port reset returned no_change / failed. Do not loop more resets — ask for a manual port check.';
  } else if (cohort.startsWith('H3')) {
    action = 'Escalate to ' + hostName + ': port state cannot be read for this line'
      + (httpStatus ? ' (port-status HTTP ' + httpStatus + ')' : '') + ' — ask why the read fails.';
  } else {
    action = 'No escalation — provider and host both read healthy and traffic flowed. Treat the report as noise.';
  }

  return {
    escalate,
    cohort,
    classification,
    failure_type: failureType,
    confidence,
    provider_issue: providerIssue || '',
    host_issue: hostIssue || '',
    provider_escalation_target: providerTarget,
    host_escalation_target: hostTarget,
    recommended_escalation_target: recommendedTarget,
    recommended_action: action,
  };
}

// --- CSV shape ------------------------------------------------------------

const ESCALATION_EXPORT_COLUMNS = [
  'sim_id',
  'service_provider',
  'gateway_host',
  'provider_host',
  'reseller',
  'reseller_rental_ids',
  'current_mdn',
  'teltik_known_host_mdn',
  'iccid',
  'report_ids',
  'report_count',
  'first_report_at_ny',
  'last_report_at_ny',
  'cohort',
  'classification',
  'failure_type',
  'confidence',
  'escalation_reasons',
  'report_statuses',
  'reason_codes',
  'provider_evidence',
  'host_evidence',
  'inbound_sms_count_window',
  'inbound_sms_last_at_ny',
  'inbound_sms_ever',
  'inbound_sms_window_ny',
  'auto_attempts_count',
  'auto_attempts_last',
  'provider_escalation_target',
  'host_escalation_target',
  'recommended_escalation_target',
  'recommended_action',
];

function escalationExportCsv(rows) {
  const lines = [ESCALATION_EXPORT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(ESCALATION_EXPORT_COLUMNS.map(c => csvEscape(row[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// bad_rental_escalations_2026-08-06_ny.csv (single day) or
// bad_rental_escalations_2026-08-01_to_2026-08-06_ny.csv (range).
function buildEscalationExportFilename(range, filters) {
  const span = range.start === range.end ? range.start : range.start + '_to_' + range.end;
  const scope = filters && filters.scope === 'all' ? 'all_' : '';
  const reason = filters && filters.escalation_reason
    ? String(filters.escalation_reason).replace(/[^a-z0-9_]+/gi, '_') + '_'
    : '';
  return 'bad_rental_escalations_' + scope + reason + span + '_ny.csv';
}

// --- Evidence assembly (pure) ---------------------------------------------

// Group reports by SIM and fold in attempts / host checks / inbound evidence,
// then classify. Pure so the whole shape is unit-testable without any IO.
function buildEscalationExportRows({ reports, attempts, hostChecks, inbound, everKnown, range, filters }) {
  const f = filters || {};
  const attemptsByReport = new Map();
  for (const a of (attempts || [])) {
    if (!a || a.report_id == null) continue;
    const key = String(a.report_id);
    if (!attemptsByReport.has(key)) attemptsByReport.set(key, []);
    attemptsByReport.get(key).push(a);
  }
  const hostBySim = new Map();
  for (const c of (hostChecks || [])) {
    if (!c || c.sim_id == null) continue;
    const key = String(c.sim_id);
    const prev = hostBySim.get(key);
    const at = Date.parse(c.checked_at || '') || 0;
    if (!prev || at > prev._at) {
      hostBySim.set(key, { ...c, _at: at, teltik_mdn: prev && prev.teltik_mdn ? prev.teltik_mdn : null });
    }
    // Teltik-known host MDN: the newest check that did NOT fall back to our own
    // current MDN (which is the provider's number, not the host's).
    const cur = hostBySim.get(key);
    const src = String(c.mdn_source || '').toLowerCase();
    if (c.mdn && src && src !== 'db_current_mdn' && !cur.teltik_mdn) cur.teltik_mdn = c.mdn;
  }
  const inboundBySim = new Map();
  for (const [simId, v] of (inbound instanceof Map ? inbound : new Map(Object.entries(inbound || {})))) {
    inboundBySim.set(String(simId), v);
  }

  const groups = new Map();
  for (const r of (reports || [])) {
    if (!r) continue;
    const sim = r.sims || {};
    const vendor = String(sim.vendor || '').toLowerCase();
    const gatewayHost = String(sim.gateway_host || '').toLowerCase()
      || (vendor === 'teltik' ? 'teltik' : (vendor ? 'skyline' : ''));
    if (f.vendor && vendor !== f.vendor) continue;
    if (f.gateway_host && gatewayHost !== f.gateway_host) continue;

    const simId = r.sim_id != null ? r.sim_id : (sim.id != null ? sim.id : null);
    const key = simId != null ? 'sim:' + simId : (sim.iccid ? 'iccid:' + sim.iccid : 'report:' + r.id);
    let g = groups.get(key);
    if (!g) {
      const currentE164 = Array.isArray(sim.sim_numbers) && sim.sim_numbers[0]
        ? sim.sim_numbers[0].e164 : null;
      g = {
        key, sim_id: simId, vendor: vendor || 'unknown', gateway_host: gatewayHost || 'unknown',
        iccid: sim.iccid || '', current_mdn: currentE164 || sim.msisdn || '',
        resellers: new Set(), reseller_rental_ids: new Set(),
        report_ids: [], statuses: new Set(), reason_codes: new Set(),
        escalation_reasons: new Set(),
        first_report_at: null, last_report_at: null,
        attempt_count: 0, last_attempt: null, reset_no_change: false,
      };
      groups.set(key, g);
    }
    g.report_ids.push(r.id);
    if (r.resellers && r.resellers.name) g.resellers.add(r.resellers.name);
    if (r.rentals && r.rentals.reseller_rental_id) g.reseller_rental_ids.add(String(r.rentals.reseller_rental_id));
    if (r.status) g.statuses.add(r.status);
    if (r.reason_code) g.reason_codes.add(r.reason_code);
    if (r.escalation_reason) g.escalation_reasons.add(r.escalation_reason);
    if (r.received_at) {
      if (!g.first_report_at || r.received_at < g.first_report_at) g.first_report_at = r.received_at;
      if (!g.last_report_at || r.received_at > g.last_report_at) g.last_report_at = r.received_at;
    }
    for (const a of (attemptsByReport.get(String(r.id)) || [])) {
      g.attempt_count += 1;
      const at = a.attempted_at || '';
      if (!g.last_attempt || at > (g.last_attempt.attempted_at || '')) g.last_attempt = a;
      const action = String(a.action || '').toLowerCase();
      const outcome = String(a.outcome || '').toLowerCase();
      if (action.includes('reset') && (outcome === 'no_change' || outcome === 'failed' || outcome === 'error')) {
        g.reset_no_change = true;
      }
    }
  }

  const tz = range.tz;
  const windowLabel = range.start === range.end ? range.start + ' (NY)' : range.start + ' → ' + range.end + ' (NY)';
  const rows = [];
  for (const g of groups.values()) {
    const hostCheck = g.sim_id != null ? (hostBySim.get(String(g.sim_id)) || null) : null;
    const inb = (g.sim_id != null ? inboundBySim.get(String(g.sim_id)) : null) || { count: 0, last_at: null };
    const everEntry = g.sim_id != null && everKnown
      ? (everKnown instanceof Map ? everKnown.get(String(g.sim_id)) : everKnown[String(g.sim_id)])
      : undefined;
    const ever = inb.count > 0 ? true : (everEntry === undefined ? null : !!everEntry);

    const verdict = classifyEscalationGroup({
      vendor: g.vendor,
      gateway_host: g.gateway_host,
      escalation_reasons: [...g.escalation_reasons],
      host_check: hostCheck,
      inbound: { count_in_window: inb.count, ever },
      reset_no_change: g.reset_no_change,
    });

    const providerEvidence = [
      'service provider=' + g.vendor,
      'reports=' + g.report_ids.length + (g.reason_codes.size ? ' (' + [...g.reason_codes].join('|') + ')' : ''),
      'inbound SMS in window=' + inb.count,
      'inbound SMS ever=' + (ever === null ? 'unknown' : (ever ? 'yes' : 'no')),
      g.escalation_reasons.size ? 'reviewer escalation_reason=' + [...g.escalation_reasons].join('|') : '',
    ].filter(Boolean).join('; ');

    const hostEvidence = [
      'gateway host=' + g.gateway_host,
      hostCheck
        ? 'port-status ' + (hostCheck.state || 'unknown')
          + (hostCheck.http_status != null ? ' HTTP ' + hostCheck.http_status : '')
          + ' at ' + formatZonedTimestamp(hostCheck.checked_at, tz) + ' NY'
          + (hostCheck.mdn ? ' (mdn ' + mask4(hostCheck.mdn) + ', source ' + (hostCheck.mdn_source || 'unknown') + ')' : '')
          + (hostCheck.error ? ' err=' + String(hostCheck.error).slice(0, 120) : '')
        : 'no port-status check recorded in the lookback window',
      g.reset_no_change ? 'port reset returned no_change/failed' : '',
    ].filter(Boolean).join('; ');

    const lastAttempt = g.last_attempt
      ? (g.last_attempt.action || '?') + ' → ' + (g.last_attempt.outcome || '?')
        + (g.last_attempt.mode ? ' [' + g.last_attempt.mode + ']' : '')
        + ' at ' + formatZonedTimestamp(g.last_attempt.attempted_at, tz) + ' NY'
      : '';

    rows.push({
      sim_id: g.sim_id == null ? '' : g.sim_id,
      service_provider: g.vendor,
      gateway_host: g.gateway_host,
      provider_host: g.vendor + ' on ' + g.gateway_host,
      reseller: [...g.resellers].join(' | '),
      reseller_rental_ids: [...g.reseller_rental_ids].join(' '),
      current_mdn: g.current_mdn || '',
      teltik_known_host_mdn: (hostCheck && hostCheck.teltik_mdn) || '',
      iccid: g.iccid || '',
      report_ids: g.report_ids.join(' '),
      report_count: g.report_ids.length,
      first_report_at_ny: formatZonedTimestamp(g.first_report_at, tz),
      last_report_at_ny: formatZonedTimestamp(g.last_report_at, tz),
      cohort: verdict.cohort,
      classification: verdict.classification,
      failure_type: verdict.failure_type,
      confidence: verdict.confidence,
      escalation_reasons: [...g.escalation_reasons].join(' '),
      report_statuses: [...g.statuses].join(' '),
      reason_codes: [...g.reason_codes].join(' '),
      provider_evidence: providerEvidence,
      host_evidence: hostEvidence,
      inbound_sms_count_window: inb.count,
      inbound_sms_last_at_ny: formatZonedTimestamp(inb.last_at, tz),
      inbound_sms_ever: ever === null ? 'unknown' : (ever ? 'yes' : 'no'),
      inbound_sms_window_ny: windowLabel,
      auto_attempts_count: g.attempt_count,
      auto_attempts_last: lastAttempt,
      provider_escalation_target: verdict.provider_escalation_target,
      host_escalation_target: verdict.host_escalation_target,
      recommended_escalation_target: verdict.recommended_escalation_target,
      recommended_action: verdict.recommended_action,
      _escalate: verdict.escalate,
    });
  }

  const kept = f.scope === 'all' ? rows : rows.filter(r => r._escalate);
  // Escalation-needed first, then the noisiest SIMs, then a stable id order.
  kept.sort((a, b) => {
    if (a.cohort !== b.cohort) return a.cohort < b.cohort ? -1 : 1;
    if (b.report_count !== a.report_count) return b.report_count - a.report_count;
    return String(a.sim_id).localeCompare(String(b.sim_id));
  });

  const totals = {
    sims_in_range: rows.length,
    rows: kept.length,
    needs_escalation: rows.filter(r => r._escalate).length,
    no_fault_found: rows.filter(r => !r._escalate).length,
    by_cohort: {}, by_service_provider: {}, by_gateway_host: {}, by_provider_host: {},
    by_escalation_target: {},
  };
  for (const r of kept) {
    totals.by_cohort[r.cohort] = (totals.by_cohort[r.cohort] || 0) + 1;
    totals.by_service_provider[r.service_provider] = (totals.by_service_provider[r.service_provider] || 0) + 1;
    totals.by_gateway_host[r.gateway_host] = (totals.by_gateway_host[r.gateway_host] || 0) + 1;
    totals.by_provider_host[r.provider_host] = (totals.by_provider_host[r.provider_host] || 0) + 1;
    if (r.recommended_escalation_target) {
      totals.by_escalation_target[r.recommended_escalation_target] =
        (totals.by_escalation_target[r.recommended_escalation_target] || 0) + 1;
    }
  }
  return { rows: kept, totals };
}

// --- Evidence fetching ----------------------------------------------------

async function fetchEscalationExportAttempts(env, reportIds) {
  const out = [];
  if (!reportIds.length) return { ok: true, rows: out, truncated: false, error: null };
  let truncated = false;
  for (let i = 0; i < reportIds.length; i += 200) {
    const chunk = reportIds.slice(i, i + 200);
    const resp = await supabaseGet(env, 'rental_report_remediation_attempts?report_id=in.'
      + encodeURIComponent('(' + chunk.join(',') + ')')
      + '&select=report_id,action,outcome,mode,attempted_at'
      + '&order=attempted_at.desc&limit=' + ESCALATION_EXPORT_ATTEMPT_LIMIT);
    if (!resp.ok) return { ok: false, rows: out, truncated, error: 'attempts_http_' + resp.status };
    const rows = await resp.json().catch(() => null);
    if (!Array.isArray(rows)) return { ok: false, rows: out, truncated, error: 'attempts_bad_payload' };
    if (rows.length >= ESCALATION_EXPORT_ATTEMPT_LIMIT) truncated = true;
    out.push(...rows);
  }
  return { ok: true, rows: out, truncated, error: null };
}

async function fetchEscalationExportHostChecks(env, simIds, sinceIso) {
  const out = [];
  if (!simIds.length) return { ok: true, rows: out, truncated: false, error: null };
  let truncated = false;
  for (let i = 0; i < simIds.length; i += 50) {
    const chunk = simIds.slice(i, i + 50);
    const resp = await supabaseGet(env, 'hosting_port_status_checks?sim_id=in.'
      + encodeURIComponent('(' + chunk.join(',') + ')')
      + '&checked_at=gte.' + encodeURIComponent(sinceIso)
      + '&select=sim_id,state,http_status,error,mdn,mdn_source,checked_at,gateway_host,vendor'
      + '&order=checked_at.desc&limit=1000');
    if (!resp.ok) return { ok: false, rows: out, truncated, error: 'host_checks_http_' + resp.status };
    const rows = await resp.json().catch(() => null);
    if (!Array.isArray(rows)) return { ok: false, rows: out, truncated, error: 'host_checks_bad_payload' };
    if (rows.length >= 1000) truncated = true;
    out.push(...rows);
  }
  return { ok: true, rows: out, truncated, error: null };
}

// Inbound SMS actually delivered to each SIM inside the window — the one
// signal that comes from our own ingest rather than a vendor's self-report.
async function fetchEscalationExportInbound(env, simIds, startIso, endIso) {
  const counts = new Map();
  if (!simIds.length) return { ok: true, counts, truncated: false, error: null };
  let truncated = false;
  for (let i = 0; i < simIds.length; i += 100) {
    const chunk = simIds.slice(i, i + 100);
    for (let page = 0; page < ESCALATION_EXPORT_INBOUND_MAX_PAGES; page++) {
      const resp = await supabaseGet(env, 'inbound_sms?sim_id=in.'
        + encodeURIComponent('(' + chunk.join(',') + ')')
        + '&received_at=gte.' + encodeURIComponent(startIso)
        + '&received_at=lt.' + encodeURIComponent(endIso)
        + '&select=sim_id,received_at&order=received_at.desc'
        + '&limit=' + ESCALATION_EXPORT_INBOUND_PAGE + '&offset=' + (page * ESCALATION_EXPORT_INBOUND_PAGE));
      if (!resp.ok) return { ok: false, counts, truncated, error: 'inbound_http_' + resp.status };
      const rows = await resp.json().catch(() => null);
      if (!Array.isArray(rows)) return { ok: false, counts, truncated, error: 'inbound_bad_payload' };
      for (const row of rows) {
        if (!row || row.sim_id == null) continue;
        const key = String(row.sim_id);
        const cur = counts.get(key) || { count: 0, last_at: null };
        cur.count += 1;
        if (!cur.last_at || (row.received_at && row.received_at > cur.last_at)) cur.last_at = row.received_at || cur.last_at;
        counts.set(key, cur);
      }
      if (rows.length < ESCALATION_EXPORT_INBOUND_PAGE) break;
      if (page === ESCALATION_EXPORT_INBOUND_MAX_PAGES - 1) truncated = true;
    }
  }
  return { ok: true, counts, truncated, error: null };
}

// "Has this SIM EVER carried an inbound SMS?" — one bounded existence probe per
// candidate SIM. Only asked for SIMs with zero traffic in the window, because
// that is the only place the answer changes the cohort. Unprobed SIMs stay
// 'unknown' rather than being reported as never-delivered.
async function probeEscalationInboundEver(env, simIds, limit) {
  const known = new Map();
  const ids = simIds.slice(0, limit);
  let idx = 0;
  const workers = Array.from({ length: Math.min(6, ids.length || 1) }, async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      try {
        const resp = await supabaseGet(env, 'inbound_sms?sim_id=eq.' + encodeURIComponent(id) + '&select=id&limit=1');
        if (!resp.ok) continue;
        const rows = await resp.json().catch(() => null);
        if (Array.isArray(rows)) known.set(String(id), rows.length > 0);
      } catch (e) {
        // A failed probe must never read as "never delivered" — leave unknown.
      }
    }
  });
  await Promise.all(workers);
  return { known, probed: ids.length, skipped: Math.max(0, simIds.length - ids.length) };
}

// --- Handler --------------------------------------------------------------

async function handleBadRentalEscalationExport(env, corsHeaders, url) {
  try {
    const range = parseEscalationExportRange(url, Date.now());
    if (range.error) {
      return new Response(JSON.stringify({ error: range.error, message: range.message }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const format = (url.searchParams.get('format') || 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    const filters = {
      scope: (url.searchParams.get('scope') || '').toLowerCase() === 'all' ? 'all' : 'needs_escalation',
      escalation_reason: (url.searchParams.get('escalation_reason') || '').trim(),
      vendor: (url.searchParams.get('vendor') || '').trim().toLowerCase(),
      gateway_host: (url.searchParams.get('gateway_host') || '').trim().toLowerCase(),
    };

    const select = [
      'id', 'status', 'reason_code', 'received_at', 'sim_id', 'rental_id',
      'escalation_reason', 'auto_remediation_state', 'last_auto_attempt_at',
      'resellers(name)',
      'rentals(reseller_rental_id)',
      'sims(id,iccid,msisdn,vendor,gateway_host,sim_numbers(e164,valid_to))',
    ].join(',');
    let query = 'rental_reports?select=' + encodeURIComponent(select)
      + '&received_at=gte.' + encodeURIComponent(range.start_utc)
      + '&received_at=lt.' + encodeURIComponent(range.end_utc)
      + '&sims.sim_numbers.valid_to=is.null';
    if (filters.escalation_reason) {
      query += '&escalation_reason=eq.' + encodeURIComponent(filters.escalation_reason);
    }
    query += '&order=received_at.asc&limit=' + ESCALATION_EXPORT_REPORT_LIMIT;

    const resp = await supabaseGet(env, query);
    if (!resp.ok) {
      const txt = await resp.text();
      return new Response(JSON.stringify({
        error: 'supabase_' + resp.status,
        message: 'Could not read bad-rental reports for ' + range.start + ' → ' + range.end + '.',
        detail: txt.slice(0, 500),
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const reports = await resp.json().catch(() => []);
    const reportRows = Array.isArray(reports) ? reports : [];
    const reportsTruncated = reportRows.length >= ESCALATION_EXPORT_REPORT_LIMIT;

    const reportIds = reportRows.map(r => r && r.id).filter(x => x != null);
    const simIds = [...new Set(reportRows
      .map(r => (r && r.sim_id != null) ? r.sim_id : (r && r.sims && r.sims.id != null ? r.sims.id : null))
      .filter(x => x != null))];

    const notes = [];
    const [attempts, hostChecks, inbound] = await Promise.all([
      fetchEscalationExportAttempts(env, reportIds),
      fetchEscalationExportHostChecks(env, simIds, new Date(range.start_ms - ESCALATION_EXPORT_HOST_LOOKBACK_MS).toISOString()),
      fetchEscalationExportInbound(env, simIds, range.start_utc, range.end_utc),
    ]);
    if (!attempts.ok) notes.push('remediation attempts unavailable (' + attempts.error + ')');
    if (!hostChecks.ok) notes.push('host port-status history unavailable (' + hostChecks.error + ')');
    if (!inbound.ok) notes.push('inbound SMS evidence unavailable (' + inbound.error + ')');
    if (attempts.truncated) notes.push('remediation attempts truncated at the query limit');
    if (hostChecks.truncated) notes.push('host port-status history truncated at the query limit');
    if (inbound.truncated) notes.push('inbound SMS evidence truncated at the query limit');
    if (reportsTruncated) notes.push('report list truncated at ' + ESCALATION_EXPORT_REPORT_LIMIT + ' rows — narrow the date range');

    // Only SIMs with no traffic in the window need the "ever delivered" probe.
    let everKnown = new Map();
    if (inbound.ok) {
      const zeroSims = simIds.filter(id => !inbound.counts.get(String(id)));
      const probe = await probeEscalationInboundEver(env, zeroSims, ESCALATION_EXPORT_EVER_PROBE_LIMIT);
      everKnown = probe.known;
      if (probe.skipped > 0) {
        notes.push(probe.skipped + ' SIM(s) not probed for lifetime inbound SMS (cap '
          + ESCALATION_EXPORT_EVER_PROBE_LIMIT + ') — reported as unknown');
      }
    }

    const { rows, totals } = buildEscalationExportRows({
      reports: reportRows,
      attempts: attempts.rows,
      hostChecks: hostChecks.rows,
      inbound: inbound.counts,
      everKnown,
      range,
      filters,
    });

    const meta = {
      range: {
        tz: range.tz, start: range.start, end: range.end, days: range.days,
        start_utc: range.start_utc, end_utc: range.end_utc, is_today: range.is_today,
      },
      filters,
      totals,
      notes,
      reports_in_range: reportRows.length,
    };
    const filename = buildEscalationExportFilename(range, filters);

    if (format === 'json') {
      return new Response(JSON.stringify({
        ...meta,
        filename,
        columns: ESCALATION_EXPORT_COLUMNS,
        rows: rows.map(r => {
          const out = {};
          for (const c of ESCALATION_EXPORT_COLUMNS) out[c] = r[c];
          return out;
        }),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(escalationExportCsv(rows), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="' + filename + '"',
        'X-Escalation-Row-Count': String(rows.length),
        'X-Escalation-Range': range.start + '..' + range.end,
        'X-Escalation-Tz': range.tz,
        'X-Escalation-Notes': notes.join('; ').slice(0, 400),
        'Access-Control-Expose-Headers':
          'Content-Disposition, X-Escalation-Row-Count, X-Escalation-Range, X-Escalation-Tz, X-Escalation-Notes',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: 'escalation_export_failed',
      message: String(error && error.message || error),
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes(String.fromCharCode(13)))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
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
      headers: sbHeaders,
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


// Requeue the auto-remediator for a still-open bad-rental report — useful after
// a false escalation (for example BRR #6938's malformed Teltik port-status read).
// Leaves rental_reports.status untouched, clears the auto escalation marker, and
// makes the row eligible for the next reviewer tick by clearing last_auto_attempt_at.
async function handleBadRentalRerunAuto(id, request, env, corsHeaders) {
  try {
    const reportId = parseInt(id, 10);
    if (!Number.isFinite(reportId) || reportId <= 0) {
      return new Response(JSON.stringify({ error: 'invalid report id' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }
    const actor = body.actor ? String(body.actor).slice(0, 120) : 'operator';
    const note = body.note ? String(body.note).slice(0, 500) : 'queued for auto-remediator rerun from dashboard';

    const curResp = await supabaseGet(env,
      'rental_reports?id=eq.' + reportId + '&select=id,status,auto_remediation_state,escalation_reason');
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
    const cur = curRows[0];
    if (cur.status !== 'received' && cur.status !== 'in_triage') {
      return new Response(JSON.stringify({ error: 'report is not open (status=' + cur.status + ')' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const prevState = cur.auto_remediation_state || null;
    const prevEscalation = cur.escalation_reason || null;
    const nowIso = new Date().toISOString();
    const sbHeaders = {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };

    // Fresh attempt-budget marker. The remediator stops counting per-action
    // attempts at the newest operator_requeue marker, so a report escalated by
    // a fixed automation bug can actually run again instead of immediately
    // tripping max_attempts_reached.
    const markerResp = await fetch(`${env.SUPABASE_URL}/rest/v1/rental_report_remediation_attempts`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'return=minimal' },
      body: JSON.stringify({
        report_id: reportId,
        attempt_no: 0,
        mode: 'operator',
        action: 'operator_requeue',
        outcome: 'requeued',
        evidence: { source: 'dashboard_rerun_auto', actor, prev_state: prevState, prev_escalation_reason: prevEscalation },
      }),
    });
    if (!markerResp.ok) {
      const txt = await markerResp.text().catch(() => '');
      return new Response(JSON.stringify({ error: 'marker_insert_failed', detail: txt }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const patch = {
      auto_remediation_state: 'queued',
      last_auto_attempt_at: null,
      escalation_reason: null,
      next_review_at: null,
      updated_at: nowIso,
    };

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
          from_status: cur.status,
          to_status: cur.status,
          actor,
          note,
          evidence: {
            source: 'dashboard_rerun_auto',
            auto_remediation_state_from: prevState,
            auto_remediation_state_to: 'queued',
            escalation_reason_from: prevEscalation,
          },
        }),
      });
    } catch (e) {
      console.log('[BadRentalRerunAuto] event log insert failed: ' + e);
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

        // Resolve MDN for Teltik API calls: use the MDN Teltik still knows the
        // line by — latest raw Teltik inbound SMS payload destination first,
        // DB current MDN only as fallback. Do NOT use get-phone-number/current DB MDN as the
        // reset key after rotations; Teltik can reject it as Invalid MDN.
        const dbCurrentMdn = row.sim_numbers && row.sim_numbers[0] && row.sim_numbers[0].e164;
        const picked = await resolveTeltikKnownMdnForSim(env, { id: sim_id, iccid: row.iccid }, dbCurrentMdn);
        const rawMdn = picked && picked.mdn;
        const mdnSource = picked ? picked.source : null;
        if (!rawMdn) {
          const err = `No Teltik-known MDN for Teltik SIM ${row.iccid}, cannot reset port`;
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

async function handleQboInvoiceDelete(env, corsHeaders, url) {
  try {
    const id = url.pathname.split('/').pop();
    if (!id || !/^\d+$/.test(id)) return new Response(JSON.stringify({ error: 'invalid id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/qbo_invoices?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        Prefer: 'return=representation',
      },
    });
    if (!resp.ok) return new Response(JSON.stringify({ error: 'delete failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const deleted = await resp.json();
    if (!Array.isArray(deleted) || deleted.length === 0) {
      return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true, deleted: deleted.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    // INC-2: optional billing_mode override for the preview (rental testing).
    // Absent => undefined => legacy_simday. Only the exact string 'rental' diverts.
    const billing_mode = url.searchParams.get('billing_mode') || undefined;
    // Optional forward-only cutover override (rental mode only). Absent => default
    // RENTAL_CUTOVER_DATE. Used by dashboard-test to diff against an earlier audit window.
    const cutover = url.searchParams.get('cutover') || undefined;
    const result = await computeBillingBreakdown(env, { resellerId, start, end, billing_mode, cutover });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
async function handleRentalExport(url, env, corsHeaders) {
  try {
    const resellerId = url.searchParams.get('reseller_id');
    const start = url.searchParams.get('start');
    const end = url.searchParams.get('end');
    if (!resellerId || !start || !end) {
      return new Response(JSON.stringify({ error: 'reseller_id, start, end required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const q = env.SUPABASE_URL + '/rest/v1/rentals?select=id,rental_date,carrier,sim_id,e164,reseller_rental_id'
      + '&reseller_id=eq.' + encodeURIComponent(resellerId)
      + '&rental_date=gte.' + encodeURIComponent(start)
      + '&rental_date=lte.' + encodeURIComponent(end)
      + '&order=rental_date.asc,carrier.asc,sim_id.asc';
    const hdrs = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY, Accept: 'application/json' };
    const lines = ['internal_rental_id,rental_date,carrier,sim_id,mdn,trustotp_rental_id'];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(q + '&limit=' + PAGE + '&offset=' + offset, { headers: hdrs });
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        lines.push([r.id, r.rental_date, r.carrier, r.sim_id, r.e164, (r.reseller_rental_id == null ? '' : r.reseller_rental_id)].join(','));
      }
      if (rows.length < PAGE) break;
    }
    return new Response(lines.join('\n') + '\n', { headers: { ...corsHeaders, 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="rental_rows.csv"' } });
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
      // Re-download an existing invoice from history
      const invResp = await supabaseGet(env,
        'qbo_invoices?select=id,week_start,week_end,sim_count,total,daily_breakdown,qbo_customer_map(qbo_display_name,daily_rate)&id=eq.' + encodeURIComponent(invoiceId) + '&limit=1'
      );
      const invData = await invResp.json();
      const inv = Array.isArray(invData) && invData[0] ? invData[0] : null;
      if (!inv) {
        return new Response(JSON.stringify({ error: 'Invoice not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const customerName = inv.qbo_customer_map?.qbo_display_name || 'Customer';
      const dailyRate = parseFloat(inv.qbo_customer_map?.daily_rate || 0);
      const totalAmount = parseFloat(inv.total);
      // Prefer the per-day breakdown snapshotted at generation time. Invoices
      // generated before the daily_breakdown column existed fall back to a
      // single summary line.
      const days = (Array.isArray(inv.daily_breakdown) && inv.daily_breakdown.length > 0)
        ? inv.daily_breakdown
        : [{ sim_count: inv.sim_count, amount: totalAmount }];
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

    const billing_mode = url.searchParams.get('billing_mode') || undefined;
    const breakdown = await computeBillingBreakdown(env, { resellerId, start, end, billing_mode });
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
        daily_breakdown: days,
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

// POST /api/atomic-swap-sim — swap the ICCID on an active ATOMIC line in place.
// Carrier swapSIM keeps the MSISDN/BAN; only sims.iccid changes here. Approach A
// (see docs/superpowers/specs/2026-06-24-atomic-sim-swap-design.md): same sims
// row, so number/rental/reseller/slot/history stay attached.
async function handleAtomicSwapSim(request, env, corsHeaders) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json();
    const simId = body.sim_id;
    const newIccid = (body.new_iccid == null ? '' : String(body.new_iccid)).trim();
    if (!simId) return json({ ok: false, error: 'sim_id required' }, 400);

    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
      return json({ ok: false, error: 'ATOMIC credentials not configured on dashboard worker (push ATOMIC_USERNAME, ATOMIC_TOKEN, ATOMIC_PIN secrets)' }, 500);
    }

    const sims = await sbGet(env, 'sims?select=id,iccid,msisdn,vendor,status,activation_zip,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.' + encodeURIComponent(String(simId)) + '&limit=1');
    const sim = Array.isArray(sims) && sims[0] ? sims[0] : null;
    if (!sim) return json({ ok: false, error: 'SIM #' + simId + ' not found' }, 404);
    if (sim.vendor !== 'atomic') return json({ ok: false, error: 'SIM swap is only supported for ATOMIC (AT&T) SIMs; this SIM is ' + sim.vendor }, 400);
    if (sim.status === 'canceled') return json({ ok: false, error: 'SIM is canceled; cannot swap' }, 400);
    if (sim.status === 'provisioning') return json({ ok: false, error: 'SIM is still provisioning; wait for activation before swapping' }, 400);

    const fmt = validateNewIccid(newIccid, sim.iccid);
    if (!fmt.ok) return json({ ok: false, error: fmt.error }, 400);

    const clash = await sbGet(env, 'sims?select=id&iccid=eq.' + encodeURIComponent(newIccid) + '&limit=1');
    if (Array.isArray(clash) && clash[0] && String(clash[0].id) !== String(sim.id)) {
      return json({ ok: false, error: 'ICCID ' + newIccid + ' is already assigned to SIM #' + clash[0].id }, 409);
    }

    const msisdn = resolveMsisdn(sim);
    if (!msisdn) return json({ ok: false, error: 'No MSISDN on file for this SIM; cannot swap' }, 400);
    const zipCode = resolveZip(body.zip_code, sim);
    if (!zipCode) return json({ ok: false, error: 'ZIP required for swapSIM (none on file; enter one)' }, 400);

    const apiUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const requestBody = buildSwapSimRequest({
      session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
      msisdn,
      zipCode,
      newSim: newIccid,
    });

    const res = await relayFetch(env, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const success = res.ok && isSwapSuccess(data);
    const errMsg = success ? null : swapErrorMessage(data, res.status);

    await logCarrierApiCall(env, {
      run_id: 'atomic_swap_' + sim.iccid + '_' + Date.now(),
      step: 'swap_sim',
      iccid: sim.iccid,
      imei: null,
      vendor: 'atomic',
      request_url: apiUrl,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: data,
      error: errMsg,
    });

    if (!success) {
      await logSystemError(env, { source: 'dashboard', action: 'swap_sim', sim_id: sim.id, iccid: sim.iccid, error_message: 'ATOMIC swapSIM failed: ' + errMsg, error_details: { msisdn, new_iccid: newIccid, response: data, status: res.status } });
      return json({ ok: false, error: errMsg, response: data }, res.status >= 400 ? res.status : 502);
    }

    const note = 'ICCID swapped from ' + sim.iccid + ' to ' + newIccid + ' on ' + new Date().toISOString();
    // Carrier already accepted the swap, so the DB write is consequential — check it
    // explicitly rather than via best-effort sbPatch (which swallows non-2xx).
    const patchRes = await fetch(env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + encodeURIComponent(String(sim.id)), {
      method: 'PATCH',
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ iccid: newIccid, status_reason: note }),
    });
    if (!patchRes.ok) {
      const detail = await patchRes.text().catch(() => '');
      await logSystemError(env, { source: 'dashboard', action: 'swap_sim_db_patch', sim_id: sim.id, iccid: sim.iccid, error_message: 'Carrier swapSIM succeeded but DB patch failed: HTTP ' + patchRes.status, error_details: { new_iccid: newIccid, detail } });
      return json({ ok: false, error: 'Carrier swap succeeded but the database update failed (HTTP ' + patchRes.status + '). The line is now on ' + newIccid + ' at AT&T — check system errors and fix the SIM record.', new_iccid: newIccid, response: data }, 502);
    }

    return json({ ok: true, sim_id: sim.id, old_iccid: sim.iccid, new_iccid: newIccid, msisdn, response: data });
  } catch (error) {
    return json({ ok: false, error: String(error) }, 500);
  }
}

// POST /api/atomic-swap-imei — set the device IMEI (NWIMEI) AT&T whitelists for an
// ATOMIC line so it matches what the gateway broadcasts. A line registers iff the
// gateway-broadcast IMEI == AT&T NWIMEI. MSISDN/BAN/ICCID stay; only sims.imei changes.
async function handleAtomicSwapImei(request, env, corsHeaders) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json();
    const simId = body.sim_id;
    const newImei = (body.imei == null ? '' : String(body.imei)).trim();
    if (!simId) return json({ ok: false, error: 'sim_id required' }, 400);
    if (!/^\d{15}$/.test(newImei)) return json({ ok: false, error: 'imei must be 15 digits' }, 400);

    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
      return json({ ok: false, error: 'ATOMIC credentials not configured on dashboard worker' }, 500);
    }

    const sims = await sbGet(env, 'sims?select=id,iccid,msisdn,vendor,status,activation_zip,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.' + encodeURIComponent(String(simId)) + '&limit=1');
    const sim = Array.isArray(sims) && sims[0] ? sims[0] : null;
    if (!sim) return json({ ok: false, error: 'SIM #' + simId + ' not found' }, 404);
    if (sim.vendor !== 'atomic') return json({ ok: false, error: 'swapImei is only supported for ATOMIC (AT&T) SIMs; this SIM is ' + sim.vendor }, 400);
    if (sim.status === 'canceled') return json({ ok: false, error: 'SIM is canceled; cannot swap IMEI' }, 400);

    const msisdn = resolveMsisdn(sim);
    if (!msisdn) return json({ ok: false, error: 'No MSISDN on file for this SIM' }, 400);
    const zipCode = resolveZip(body.zip_code, sim);
    if (!zipCode) return json({ ok: false, error: 'ZIP required for swapImei (PPU zip; none on file)' }, 400);

    const apiUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const requestBody = buildSwapImeiRequest({
      session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
      msisdn,
      zipCode,
      imei: newImei,
    });

    const res = await relayFetch(env, apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const success = res.ok && isSwapSuccess(data);
    const errMsg = success ? null : swapErrorMessage(data, res.status);

    await logCarrierApiCall(env, {
      run_id: 'atomic_swapimei_' + sim.iccid + '_' + Date.now(),
      step: 'swap_imei',
      iccid: sim.iccid,
      imei: newImei,
      vendor: 'atomic',
      request_url: apiUrl,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: data,
      error: errMsg,
    });

    if (!success) {
      await logSystemError(env, { source: 'dashboard', action: 'swap_imei', sim_id: sim.id, iccid: sim.iccid, error_message: 'ATOMIC swapImei failed: ' + errMsg, error_details: { msisdn, imei: newImei, zipCode, response: data, status: res.status } });
      return json({ ok: false, error: errMsg, response: data }, res.status >= 400 ? res.status : 502);
    }

    await sbPatch(env, 'sims?id=eq.' + encodeURIComponent(String(sim.id)), { imei: newImei });

    return json({ ok: true, sim_id: sim.id, iccid: sim.iccid, msisdn, zipCode, imei: newImei, response: data });
  } catch (error) {
    return json({ ok: false, error: String(error) }, 500);
  }
}

// POST /api/atomic-sub-action — drive an ATOMIC subscriber lifecycle op for a line.
// op: suspend|restore|deactivate|reconnect. Used to re-provision lines stuck in
// network "registration denied" (CEREG 0,3) despite attStatus=Active.
async function handleAtomicSubAction(request, env, corsHeaders) {
  const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const OPS = {
    suspend:    { requestType: 'suspendSubscriber',    reasonCode: 'NPG', status: 'suspended' },
    restore:    { requestType: 'restoreSubscriber',    reasonCode: 'CR',  status: 'active' },
    deactivate: { requestType: 'deactivateSubscriber', reasonCode: 'DD',  status: 'canceled' },
    reconnect:  { requestType: 'reconnectSubscriber',  reasonCode: '',    status: 'active' },
  };
  try {
    const body = await request.json();
    const simId = body.sim_id;
    const op = String(body.op || '').trim();
    if (!simId) return json({ ok: false, error: 'sim_id required' }, 400);
    if (!OPS[op]) return json({ ok: false, error: 'op must be one of: ' + Object.keys(OPS).join(', ') }, 400);
    if (!env.ATOMIC_USERNAME || !env.ATOMIC_TOKEN || !env.ATOMIC_PIN) {
      return json({ ok: false, error: 'ATOMIC credentials not configured on dashboard worker' }, 500);
    }

    const sims = await sbGet(env, 'sims?select=id,iccid,msisdn,vendor,status,sim_numbers(e164)&sim_numbers.valid_to=is.null&id=eq.' + encodeURIComponent(String(simId)) + '&limit=1');
    const sim = Array.isArray(sims) && sims[0] ? sims[0] : null;
    if (!sim) return json({ ok: false, error: 'SIM #' + simId + ' not found' }, 404);
    if (sim.vendor !== 'atomic') return json({ ok: false, error: 'ATOMIC only; this SIM is ' + sim.vendor }, 400);
    const msisdn = resolveMsisdn(sim);
    if (!msisdn) return json({ ok: false, error: 'No MSISDN on file for this SIM' }, 400);

    const spec = OPS[op];
    const apiUrl = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
    const requestBody = {
      wholeSaleApi: {
        session: { userName: env.ATOMIC_USERNAME, token: env.ATOMIC_TOKEN, pin: env.ATOMIC_PIN },
        wholeSaleRequest: { requestType: spec.requestType, MSISDN: msisdn, reasonCode: spec.reasonCode },
      },
    };

    const res = await relayFetch(env, apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const success = res.ok && isSwapSuccess(data);
    const errMsg = success ? null : swapErrorMessage(data, res.status);

    await logCarrierApiCall(env, {
      run_id: 'atomic_' + op + '_' + sim.iccid + '_' + Date.now(),
      step: 'sub_' + op,
      iccid: sim.iccid,
      imei: null,
      vendor: 'atomic',
      request_url: apiUrl,
      request_method: 'POST',
      request_body: requestBody,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: data,
      error: errMsg,
    });

    if (!success) {
      await logSystemError(env, { source: 'dashboard', action: 'sub_' + op, sim_id: sim.id, iccid: sim.iccid, error_message: 'ATOMIC ' + spec.requestType + ' failed: ' + errMsg, error_details: { msisdn, response: data, status: res.status } });
      return json({ ok: false, error: errMsg, response: data }, res.status >= 400 ? res.status : 502);
    }

    await sbPatch(env, 'sims?id=eq.' + encodeURIComponent(String(sim.id)), { status: spec.status });
    return json({ ok: true, sim_id: sim.id, iccid: sim.iccid, msisdn, op, requestType: spec.requestType, new_status: spec.status, response: data });
  } catch (error) {
    return json({ ok: false, error: String(error) }, 500);
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

// ===== WING gateway-status endpoint (external partner, read-only) =====
// GET /api/gateway-status?iccid=... or ?iccids=a,b,c
// Auth: dedicated GATEWAY_STATUS_API_KEY via X-Api-Key header (or ?key=).
// Returns live Skyline gateway state per ICCID, with the numeric `st` mapped
// to a human string like "State 3 = Registered (ready)". See
// src/shared/skyline-state.mjs and docs/superpowers/specs/2026-06-26-wing-gateway-status-api-design.md
const GATEWAY_STATUS_MAX_ICCIDS = 100;

function gatewayStatusKeyEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Live read of one gateway's ports via the skyline-gateway worker. Returns
// { ok: true, iccidMap } where iccidMap[iccid] = port entry, or { ok: false }
// when the gateway/bridge is unreachable or returns an error.
async function fetchGatewayPortInfo(env, gatewayId) {
  try {
    if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET) return { ok: false };
    const params = new URLSearchParams({
      gateway_id: String(gatewayId),
      secret: env.SKYLINE_SECRET,
      all_slots: '1',
    });
    const resp = await env.SKYLINE_GATEWAY.fetch(
      'https://skyline-gateway/port-info?' + params.toString(),
      { method: 'GET' }
    );
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false }; }
    if (!resp.ok || !data || !data.ok) return { ok: false };
    const iccidMap = {};
    for (const p of (data.ports || [])) {
      if (p && p.iccid) iccidMap[p.iccid] = p;
    }
    return { ok: true, iccidMap };
  } catch {
    return { ok: false };
  }
}

// Assemble the per-ICCID result. `sim` is the matching sims row (or undefined),
// `portInfoByGateway` maps gateway_id -> result of fetchGatewayPortInfo.
function buildGatewayStatusResult(iccid, sim, portInfoByGateway) {
  const base = {
    iccid,
    found: false,
    state_code: null,
    state_label: null,
    gateway_state: null,
    number: null,
    operator: null,
    signal: null,
    imei: null,
    message: null,
  };

  if (!sim) {
    base.message = 'not found in system';
    return base;
  }
  base.found = true;
  base.number = (sim.sim_numbers && sim.sim_numbers[0]) ? sim.sim_numbers[0].e164 : null;

  if (sim.gateway_id === null || sim.gateway_id === undefined) {
    base.message = 'not assigned to a gateway';
    return base;
  }

  const info = portInfoByGateway[sim.gateway_id];
  if (!info || !info.ok) {
    base.message = 'gateway unreachable';
    return base;
  }

  const entry = info.iccidMap[iccid];
  if (!entry) {
    base.message = 'not present in gateway';
    return base;
  }

  const fmt = formatGatewayState(entry.st);
  base.state_code = fmt.state_code;
  base.state_label = fmt.state_label;
  base.gateway_state = fmt.gateway_state;
  base.operator = entry.operator != null ? entry.operator : null;
  base.signal = entry.signal != null ? entry.signal : null;
  base.imei = entry.imei != null ? entry.imei : null;
  // Prefer our DB number; fall back to the gateway-reported number if absent.
  if (base.number == null && entry.number) base.number = entry.number;
  return base;
}

async function handleGatewayStatus(request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  };
  const jsonRes = (obj, status) => new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'GET') return jsonRes({ error: 'method not allowed' }, 405);

  // Auth: dedicated API key, fail closed if not configured.
  const configuredKey = env.GATEWAY_STATUS_API_KEY;
  if (!configuredKey) return jsonRes({ error: 'gateway-status endpoint not configured' }, 503);

  const url = new URL(request.url);
  const presentedKey = request.headers.get('X-Api-Key') || url.searchParams.get('key') || '';
  if (!gatewayStatusKeyEquals(presentedKey, configuredKey)) {
    return jsonRes({ error: 'unauthorized' }, 401);
  }

  const iccids = parseIccidList(url.searchParams.get('iccid'), url.searchParams.get('iccids'));
  if (iccids.length === 0) return jsonRes({ error: 'iccid or iccids required' }, 400);
  if (iccids.length > GATEWAY_STATUS_MAX_ICCIDS) {
    return jsonRes({ error: 'too many iccids (max ' + GATEWAY_STATUS_MAX_ICCIDS + ')' }, 400);
  }

  try {
    // 1. Look up the SIMs by ICCID (id, gateway, active number).
    const inList = iccids.map(c => encodeURIComponent(c)).join(',');
    const simsResp = await supabaseGet(
      env,
      'sims?iccid=in.(' + inList + ')&select=id,iccid,gateway_id,sim_numbers(e164)&sim_numbers.valid_to=is.null'
    );
    const sims = simsResp.ok ? await simsResp.json() : [];
    const simByIccid = {};
    for (const s of sims) simByIccid[s.iccid] = s;

    // 2. One live /port-info call per distinct gateway.
    const gatewayIds = [...new Set(
      sims.filter(s => s.gateway_id !== null && s.gateway_id !== undefined).map(s => s.gateway_id)
    )];
    const portInfoByGateway = {};
    for (const gid of gatewayIds) {
      portInfoByGateway[gid] = await fetchGatewayPortInfo(env, gid);
    }

    // 3. Assemble results in request order.
    const results = iccids.map(iccid =>
      buildGatewayStatusResult(iccid, simByIccid[iccid], portInfoByGateway)
    );
    return jsonRes({ ok: true, count: results.length, results });
  } catch (e) {
    return jsonRes({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

