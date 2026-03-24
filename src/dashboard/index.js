
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

    if (url.pathname === '/api/sims') {
      return handleSims(env, corsHeaders, url);
    }

    if (url.pathname === '/api/messages') {
      return handleMessages(env, corsHeaders);
    }

    if (url.pathname === '/api/resellers') {
      return handleResellers(env, corsHeaders);
    }

    if (url.pathname === '/api/gateways') {
      return handleGateways(request, env, corsHeaders);
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

    if (url.pathname === '/api/helix-query') {
      return handleHelixQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {
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

    if (url.pathname === '/api/imei-sweep' && request.method === 'POST') {
      return handleImeiSweep(env, corsHeaders);
    }

    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {
      return handleTriggerBlimeiSweep(env, corsHeaders);
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

    if (url.pathname === '/api/billing/preview') {
      return handleBillingPreview(url, env, corsHeaders);
    }

    if (url.pathname === '/api/billing/download-invoice') {
      return handleBillingDownloadInvoice(url, env, corsHeaders);
    }

    if (url.pathname === '/api/billing/create-invoice' && request.method === 'POST') {
      return handleBillingCreateInvoice(request, env, corsHeaders);
    }

    if (url.pathname === '/api/wing-bill/upload' && request.method === 'POST') {
      return handleWingBillUpload(request, env, corsHeaders);
    }
    if (url.pathname === '/api/wing-bill/results') {
      return handleWingBillResults(env, corsHeaders, url);
    }
    if (url.pathname === '/api/wing-bill/uploads') {
      return handleWingBillUploads(env, corsHeaders);
    }
    if (url.pathname === '/api/wing-bill/export') {
      return handleWingBillExport(env, corsHeaders, url);
    }
    if (url.pathname === '/api/wing-bill/backfill-cancel-dates' && request.method === 'POST') {
      return handleBackfillCancelDates(env, corsHeaders);
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

    // Serve HTML dashboard for all non-API paths (SPA routing)
    return new Response(getHTML(), {
      headers: { 'Content-Type': 'text/html' }
    });
  },
};

function checkAuth(authHeader, env) {
  if (!env.DASHBOARD_AUTH) return true; // No auth configured

  const [scheme, credentials] = authHeader.split(' ');
  if (scheme !== 'Basic') return false;

  const decoded = atob(credentials);
  return decoded === env.DASHBOARD_AUTH; // Format: "username:password"
}

async function handleStats(env, corsHeaders) {
  try {
    // Get SIM counts
    const simsResponse = await supabaseGet(env, 'sims?select=status');
    const sims = await simsResponse.json();

    const stats = {
      total_sims: sims.length,
      active_sims: sims.filter(s => s.status === 'active').length,
      provisioning_sims: sims.filter(s => s.status === 'provisioning').length,
    };

    // Get message count (last 24 hours)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const messagesResponse = await supabaseGet(
      env,
      `inbound_sms?select=id&received_at=gte.${yesterday}`
    );
    const messages = await messagesResponse.json();
    stats.messages_24h = messages.length;

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

async function handleSims(env, corsHeaders, url) {
  try {
    // Parse filter params
    const statusFilter = url.searchParams.get('status');
    const resellerFilter = url.searchParams.get('reseller_id');
    const hideCancelled = url.searchParams.get('hide_cancelled') !== 'false';

    // Build query with reseller and gateway info
    let query = `sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000`;

    // Apply status filter
    if (statusFilter) {
      query += `&status=eq.${statusFilter}`;
    } else if (hideCancelled) {
      query += `&status=neq.canceled`;
    }

    const response = await supabaseGet(env, query);
    const sims = await response.json();

    // Filter by reseller if specified (done client-side since nested filter is complex)
    let filteredSims = sims;
    if (resellerFilter) {
      const resellerId = parseInt(resellerFilter);
      filteredSims = sims.filter(sim =>
        sim.reseller_sims?.some(rs => rs.reseller_id === resellerId)
      );
    }

    // Get SMS stats via DB-side aggregation (avoids row-limit truncation)
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const smsUrl = env.SUPABASE_URL + '/rest/v1/rpc/get_sms_counts_24h';
      const smsResp = await fetch(smsUrl, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ sim_ids: simIds }),
      });
      const smsRows = await smsResp.json();
      for (const row of smsRows) {
        smsMap[row.sim_id] = { count: Number(row.sms_count), last_received: row.last_received };
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
        activated_at: sim.activated_at || null,
        last_activation_error: sim.last_activation_error || null,
        last_notified_at: sim.last_notified_at || null,
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

async function handleMessages(env, corsHeaders) {
  try {
    const query = `inbound_sms?select=id,to_number,from_number,body,received_at,sim_id,sims(iccid)&order=received_at.desc&limit=500`;
    const response = await supabaseGet(env, query);
    const messages = await response.json();

    // Flatten the structure
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
      body: JSON.stringify({ sims })
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

async function handleGateways(request, env, corsHeaders) {
  // GET - list all gateways
  if (request.method === 'GET') {
    try {
      const response = await supabaseGet(env, 'gateways?select=id,mac_address,code,name,location,total_ports,active&order=code.asc');
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

  // POST - add new gateway
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { mac_address, code, name, location, total_ports } = body;

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
          total_ports: total_ports || 64,
          active: true
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
    const simResponse = await supabaseGet(env, `sims?select=id,iccid,status&id=eq.${simId}`);
    const sims = await simResponse.json();

    if (!sims || sims.length === 0) {
      return new Response(JSON.stringify({ error: 'SIM not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const sim = sims[0];

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

    // Calculate next rotation time (5 AM UTC next day)
    const now = new Date();
    const next = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      5, 0, 0
    ));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const onlineUntil = next.toISOString();

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
        verified: verificationStatus === 'verified',
      },
    };

    // Send the webhook
    console.log(`[SimOnline] Sending webhook to ${webhookUrl} for SIM ${simId}`);
    const webhookResponse = await fetch(webhookUrl, {
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

    const tokenRes = await fetch(env.HX_TOKEN_URL, {
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
    const detailsRes = await fetch(detailsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ mobilitySubscriptionId: parseInt(subId) }),
    });

    const detailsText = await detailsRes.text();
    let detailsData;
    try {
      detailsData = JSON.parse(detailsText);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON from Helix', raw: detailsText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!detailsRes.ok) {
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

    const tokenRes = await fetch(env.HX_TOKEN_URL, {
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
        const detailsRes = await fetch(env.HX_API_BASE + '/api/mobility-subscriber/details', {
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
    const baseUrl = `${env.SUPABASE_URL}/rest/v1/imei_pool?select=id,imei,status,sim_id,assigned_at,previous_sim_id,notes,created_at,gateway_id,port,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc`;
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
          valid.push({ imei: trimmed, status: 'available' });
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

      // Eligibility gate: check each IMEI before adding
      const rejectedIneligible = [];
      const eligible = [];
      if (env.MDN_ROTATOR && env.ADMIN_RUN_SECRET) {
        for (const candidate of toAdd) {
          try {
            const checkUrl = 'https://mdn-rotator/check-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET) + '&imei=' + encodeURIComponent(candidate.imei);
            const checkRes = await env.MDN_ROTATOR.fetch(checkUrl, { method: 'GET' });
            const checkData = checkRes.ok ? await checkRes.json().catch(() => ({})) : {};
            if (checkData.eligible === true) {
              eligible.push(candidate);
            } else {
              rejectedIneligible.push({ imei: candidate.imei, reason: checkData.result ? JSON.stringify(checkData.result).slice(0, 200) : 'Not eligible for carrier/plan' });
            }
          } catch (eligErr) {
            // On check error, allow the IMEI (do not block on Helix errors)
            console.error('[IMEI Add] Eligibility check error for ' + candidate.imei + ': ' + eligErr);
            eligible.push(candidate);
          }
        }
      } else {
        // No MDN_ROTATOR binding — skip eligibility check
        eligible.push(...toAdd);
      }

      let added = 0;
      if (eligible.length > 0) {
        const addInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(eligible),
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
        rejected_ineligible: rejectedIneligible || [],
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
    const query = `helix_api_logs?select=id,step,iccid,imei,request_url,request_method,request_body,response_status,response_ok,response_body_json,response_body_text,error,created_at&iccid=eq.${encodeURIComponent(lookupIccid)}&order=created_at.desc&limit=20`;
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

// Log an error from any source into system_errors
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

    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const workerUrl = `https://mdn-rotator/sim-action?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;
    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false })
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
    const query = `qbo_invoices?select=id,week_start,week_end,sim_count,total,status,error_message,qbo_customer_map(qbo_display_name)&order=created_at.desc&limit=50`;
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

    // Get reseller name + QBO mapping
    const [resellerResp, mappingResp] = await Promise.all([
      supabaseGet(env, 'resellers?select=id,name&id=eq.' + encodeURIComponent(resellerId) + '&limit=1'),
      supabaseGet(env, 'qbo_customer_map?select=id,qbo_customer_id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId) + '&limit=1'),
    ]);
    const resellerData = await resellerResp.json();
    const mappingData = await mappingResp.json();
    const reseller = Array.isArray(resellerData) && resellerData[0] ? resellerData[0] : null;
    const mapping = Array.isArray(mappingData) && mappingData[0] ? mappingData[0] : null;

    // Get SIM-days with SMS for this reseller in the date range
    // Join: reseller_sims → sims → sim_sms_daily
    const smsResp = await supabaseGet(env,
      'reseller_sims?select=sim_id,sims(sim_sms_daily(est_date,sms_count))' +
      '&reseller_id=eq.' + encodeURIComponent(resellerId) +
      '&active=eq.true'
    );
    const rsSims = await smsResp.json();

    // Aggregate: for each EST calendar day in range, count distinct SIMs with sms_count > 0
    const dailyCounts = {}; // est_date → Set of sim_ids
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!dailyCounts[row.est_date]) dailyCounts[row.est_date] = new Set();
          dailyCounts[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = mapping ? parseFloat(mapping.daily_rate) : 0;
    const days = Object.keys(dailyCounts).sort().map(date => ({
      date,
      sim_count: dailyCounts[date].size,
      amount: dailyCounts[date].size * dailyRate,
    }));
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = totalSimDays * dailyRate;

    return new Response(JSON.stringify({
      reseller_id: resellerId,
      reseller_name: reseller?.name || resellerId,
      mapping,
      daily_rate: dailyRate,
      days,
      total_sim_days: totalSimDays,
      total_amount: totalAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    'ServiceDate', 'ProductService', 'Description', 'Qty', 'Rate', 'Amount'
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
      dailyRate.toFixed(2),
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

    const mappingResp = await supabaseGet(env, 'qbo_customer_map?select=id,qbo_display_name,daily_rate&reseller_id=eq.' + encodeURIComponent(resellerId) + '&limit=1');
    const mappingData = await mappingResp.json();
    const mapping = Array.isArray(mappingData) && mappingData[0] ? mappingData[0] : null;
    if (!mapping) {
      return new Response(JSON.stringify({ error: 'No customer rate configured for this reseller' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const smsResp = await supabaseGet(env,
      'reseller_sims?select=sim_id,sims(sim_sms_daily(est_date,sms_count))' +
      '&reseller_id=eq.' + encodeURIComponent(resellerId) +
      '&active=eq.true'
    );
    const rsSims = await smsResp.json();

    const dailyCounts = {};
    if (Array.isArray(rsSims)) {
      for (const rs of rsSims) {
        const daily = rs.sims?.sim_sms_daily;
        if (!Array.isArray(daily)) continue;
        for (const row of daily) {
          if (!row.est_date || row.sms_count <= 0) continue;
          if (row.est_date < start || row.est_date > end) continue;
          if (!dailyCounts[row.est_date]) dailyCounts[row.est_date] = new Set();
          dailyCounts[row.est_date].add(rs.sim_id);
        }
      }
    }

    const dailyRate = parseFloat(mapping.daily_rate);
    const days = Object.keys(dailyCounts).sort().map(date => ({
      date,
      sim_count: dailyCounts[date].size,
      amount: dailyCounts[date].size * dailyRate,
    }));
    const totalSimDays = days.reduce((s, d) => s + d.sim_count, 0);
    const totalAmount = +(totalSimDays * dailyRate).toFixed(2);

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

// ── Wing Bill Verification ────────────────────────────────────────────────────

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

const BILLABLE_STATUSES = new Set(['active', 'suspended']);

function calculateBillableDays(statusHistory, simCurrentStatus, fromDate, toDate) {
    const totalMs = toDate.getTime() - fromDate.getTime();
    const totalDays = Math.max(1, Math.round(totalMs / (1000 * 60 * 60 * 24)));

    // If no history records, use current status for the whole period
    if (!statusHistory || statusHistory.length === 0) {
        const billable = BILLABLE_STATUSES.has(simCurrentStatus);
        return { billable_days: billable ? totalDays : 0, total_days: totalDays };
    }

    // Sort history by changed_at
    const sorted = [...statusHistory].sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));

    // Determine status at start of period by walking backwards from earliest history
    // The old_status of the first transition tells us what it was before
    let currentStatus = sorted[0].old_status || simCurrentStatus;
    let billableDays = 0;
    let cursor = fromDate.getTime();

    for (const entry of sorted) {
        const changeTime = new Date(entry.changed_at).getTime();
        if (changeTime > toDate.getTime()) break; // past end of period

        const segmentEnd = Math.min(changeTime, toDate.getTime());
        const segmentStart = Math.max(cursor, fromDate.getTime());

        if (segmentEnd > segmentStart && BILLABLE_STATUSES.has(currentStatus)) {
            billableDays += (segmentEnd - segmentStart) / (1000 * 60 * 60 * 24);
        }

        currentStatus = entry.new_status;
        cursor = changeTime;
    }

    // Account for remaining time after last transition
    if (cursor < toDate.getTime()) {
        const segmentStart = Math.max(cursor, fromDate.getTime());
        if (BILLABLE_STATUSES.has(currentStatus)) {
            billableDays += (toDate.getTime() - segmentStart) / (1000 * 60 * 60 * 24);
        }
    }

    return { billable_days: Math.round(billableDays), total_days: totalDays };
}

async function handleWingBillUpload(request, env, corsHeaders) {
    try {
        // 1. Extract CSV
        const formData = await request.formData();
        const file = formData.get('file');
        if (!file) return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const csvText = await file.text();
        const filename = file.name || 'wing_bill.csv';

        // 2. Parse CSV
        const rows = parseWingCSV(csvText);
        if (!rows.length) return new Response(JSON.stringify({ error: 'CSV has no data rows' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

        // 3. Create upload record
        const [upload] = await sbPost(env, 'wing_bill_uploads', { filename, total_rows: rows.length, status: 'processing' });
        const uploadId = upload.id;

        // 4. Fetch all SIMs
        const allSims = await sbGet(env, 'sims?select=id,iccid,status&limit=10000');
        const simsByIccid = {};
        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });

        // 5. Get expected rate
        const expectedRate = parseFloat(env.WING_EXPECTED_RATE || '5.00');

        // 6. Collect unique SIM IDs for batch history fetch
        const simIds = new Set();
        const parsedRows = rows.map(row => {
            const iccid = row['Subscription Iccid'] || '';
            const sim = simsByIccid[iccid];
            if (sim) simIds.add(sim.id);
            return { row, iccid, sim };
        });

        // 7. Batch fetch status history for all relevant SIMs
        let allHistory = [];
        if (simIds.size > 0) {
            const idList = [...simIds].join(',');
            allHistory = await sbGet(env, `sim_status_history?sim_id=in.(${idList})&order=changed_at.asc&limit=50000`) || [];
        }
        // Group history by sim_id
        const historyBySimId = {};
        allHistory.forEach(h => {
            if (!historyBySimId[h.sim_id]) historyBySimId[h.sim_id] = [];
            historyBySimId[h.sim_id].push(h);
        });

        // 8. Process each row
        const billedIccids = new Set();
        const lineRecords = [];

        for (const { row, iccid, sim } of parsedRows) {
            const price = parseFloat(row['Price'] || '0');
            const fromDate = row['From Date'] ? new Date(row['From Date']) : null;
            const toDate = row['To Date'] ? new Date(row['To Date']) : null;

            let discrepancyType = null;
            let discrepancyDetail = null;
            let expectedPrice = price;
            let billableDays = null;
            let totalDays = null;

            if (!sim) {
                discrepancyType = 'unknown_iccid';
                discrepancyDetail = `ICCID ${iccid} not found in our system`;
                expectedPrice = 0;
            } else if (fromDate && toDate) {
                const history = historyBySimId[sim.id] || [];
                // Filter history to relevant period (include some buffer before for context)
                const relevantHistory = history.filter(h => {
                    const t = new Date(h.changed_at).getTime();
                    return t >= fromDate.getTime() && t <= toDate.getTime();
                });

                const calc = calculateBillableDays(relevantHistory, sim.status, fromDate, toDate);
                billableDays = calc.billable_days;
                totalDays = calc.total_days;

                if (billableDays === 0) {
                    discrepancyType = 'not_billable';
                    discrepancyDetail = `SIM status is '${sim.status}' — not billable for this period (0/${totalDays} days)`;
                    expectedPrice = 0;
                } else if (billableDays < totalDays) {
                    expectedPrice = Math.round((price / totalDays) * billableDays * 100) / 100;
                    if (price > expectedPrice + 0.01) {
                        discrepancyType = 'overcharge';
                        discrepancyDetail = `Active ${billableDays}/${totalDays} days — expected $${expectedPrice.toFixed(2)}, charged $${price.toFixed(2)}`;
                    }
                } else {
                    // Fully active — check rate
                    if (Math.abs(price - expectedRate) > 0.01) {
                        discrepancyType = 'rate_mismatch';
                        discrepancyDetail = `Expected $${expectedRate.toFixed(2)} but charged $${price.toFixed(2)}`;
                    }
                    expectedPrice = expectedRate;
                }
            } else {
                // No dates — can only check rate
                if (!BILLABLE_STATUSES.has(sim.status)) {
                    discrepancyType = 'not_billable';
                    discrepancyDetail = `SIM status is '${sim.status}' — should not be billed`;
                    expectedPrice = 0;
                } else if (Math.abs(price - expectedRate) > 0.01) {
                    discrepancyType = 'rate_mismatch';
                    discrepancyDetail = `Expected $${expectedRate.toFixed(2)} but charged $${price.toFixed(2)}`;
                }
            }

            billedIccids.add(iccid);
            lineRecords.push({
                upload_id: uploadId,
                wing_id: row['Id'] || null,
                item_type: row['Item Type'] || null,
                description: row['Description'] || null,
                from_date: fromDate?.toISOString() || null,
                to_date: toDate?.toISOString() || null,
                subscription_name: row['Subscription Name'] || null,
                subscription_iccid: iccid || null,
                subscription_identifier: row['Subscription Identifier'] || null,
                carrier: row['Carrier'] || null,
                price,
                sim_id: sim?.id || null,
                sim_status: sim?.status || null,
                expected_price: expectedPrice,
                billable_days: billableDays,
                total_days: totalDays,
                discrepancy_type: discrepancyType,
                discrepancy_detail: discrepancyDetail,
            });
        }

        // 9. Duplicate charge detection
        const byIccid = {};
        lineRecords.forEach(r => {
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
                            b.discrepancy_detail = `Overlapping period with Wing ID ${a.wing_id}`;
                        }
                    }
                }
            }
        }

        // 10. Missing from bill (active SIMs not in CSV)
        const activeSims = (allSims || []).filter(s => BILLABLE_STATUSES.has(s.status));
        const missingFromBill = activeSims.filter(s => !billedIccids.has(s.iccid));

        // 11. Batch insert line records
        for (let i = 0; i < lineRecords.length; i += 500) {
            const batch = lineRecords.slice(i, i + 500);
            await fetch(`${env.SUPABASE_URL}/rest/v1/wing_bill_lines`, {
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

        // 12. Update upload record
        const discrepancyCount = lineRecords.filter(r => r.discrepancy_type).length;
        const totalAmount = lineRecords.reduce((sum, r) => sum + (r.price || 0), 0);
        const totalExpected = lineRecords.reduce((sum, r) => sum + (r.expected_price || 0), 0);
        const overchargeAmount = Math.max(0, Math.round((totalAmount - totalExpected) * 100) / 100);
        const dates = lineRecords.map(r => r.from_date).filter(Boolean).sort();
        const endDates = lineRecords.map(r => r.to_date).filter(Boolean).sort();

        await sbPatch(env, `wing_bill_uploads?id=eq.${uploadId}`, {
            status: 'complete',
            total_amount: totalAmount,
            total_expected: totalExpected,
            overcharge_amount: overchargeAmount,
            discrepancy_count: discrepancyCount,
            billing_period_start: dates[0] ? dates[0].split('T')[0] : null,
            billing_period_end: endDates.length ? endDates[endDates.length - 1].split('T')[0] : null,
        });

        // 13. Return results
        return new Response(JSON.stringify({
            upload_id: uploadId,
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
        console.error('Wing bill upload error:', e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
}

async function handleWingBillResults(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response(JSON.stringify({ error: 'upload_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const [uploads, lines] = await Promise.all([
        sbGet(env, `wing_bill_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
        sbGet(env, `wing_bill_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response(JSON.stringify({ error: 'Upload not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
        upload,
        lines: lines || [],
        discrepancies: (lines || []).filter(l => l.discrepancy_type),
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleWingBillUploads(env, corsHeaders) {
    const data = await sbGet(env, 'wing_bill_uploads?select=id,filename,billing_period_start,billing_period_end,total_rows,total_amount,total_expected,overcharge_amount,discrepancy_count,status,created_at&order=created_at.desc&limit=50');
    return new Response(JSON.stringify(data || []), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function handleWingBillExport(env, corsHeaders, url) {
    const uploadId = url.searchParams.get('upload_id');
    if (!uploadId) return new Response('upload_id required', { status: 400 });

    const [uploads, lines] = await Promise.all([
        sbGet(env, `wing_bill_uploads?id=eq.${encodeURIComponent(uploadId)}&limit=1`),
        sbGet(env, `wing_bill_lines?upload_id=eq.${encodeURIComponent(uploadId)}&order=id.asc&limit=10000`),
    ]);

    const upload = Array.isArray(uploads) ? uploads[0] : null;
    if (!upload) return new Response('Upload not found', { status: 404 });

    const auditLabels = {
        'not_billable': 'NOT BILLABLE',
        'overcharge': 'OVERCHARGE',
        'unknown_iccid': 'UNKNOWN ICCID',
        'rate_mismatch': 'RATE MISMATCH',
        'duplicate_charge': 'DUPLICATE',
    };

    // Build CSV
    const csvHeaders = 'Wing ID,ICCID,Description,Carrier,From Date,To Date,Billed Amount,Expected Amount,Overcharge,Billable Days,Total Days,SIM Status,Audit Result,Detail';
    const csvRows = (lines || []).map(l => {
        const overcharge = Math.max(0, (l.price || 0) - (l.expected_price || 0));
        const auditResult = l.discrepancy_type ? auditLabels[l.discrepancy_type] || l.discrepancy_type : 'OK';
        return [
            l.wing_id || '',
            l.subscription_iccid || '',
            `"${(l.description || '').replace(/"/g, '""')}"`,
            l.carrier || '',
            l.from_date ? new Date(l.from_date).toLocaleDateString('en-US') : '',
            l.to_date ? new Date(l.to_date).toLocaleDateString('en-US') : '',
            (l.price || 0).toFixed(2),
            (l.expected_price || 0).toFixed(2),
            overcharge.toFixed(2),
            l.billable_days ?? '',
            l.total_days ?? '',
            l.sim_status || 'N/A',
            auditResult,
            `"${(l.discrepancy_detail || '').replace(/"/g, '""')}"`,
        ].join(',');
    });

    // Summary row
    const totalBilled = (lines || []).reduce((s, l) => s + (l.price || 0), 0);
    const totalExpected = (lines || []).reduce((s, l) => s + (l.expected_price || 0), 0);
    const totalOvercharge = Math.max(0, totalBilled - totalExpected);
    csvRows.push('');
    csvRows.push(`,,,,,,${totalBilled.toFixed(2)},${totalExpected.toFixed(2)},${totalOvercharge.toFixed(2)},,,,"TOTALS",`);

    const csv = csvHeaders + '\n' + csvRows.join('\n');

    // Derive invoice number from original filename (e.g. "purchase_8147715.csv" → "purchase_8147715")
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

// ── One-time backfill: populate sim_status_history cancel dates from Helix ──
async function handleBackfillCancelDates(env, corsHeaders) {
    try {
        // 1. Get all canceled SIMs that have a mobility_subscription_id
        const canceledSims = await sbGet(env, 'sims?select=id,iccid,mobility_subscription_id,status&status=eq.canceled&mobility_subscription_id=not.is.null&limit=5000');
        if (!canceledSims || !canceledSims.length) {
            return new Response(JSON.stringify({ ok: true, message: 'No canceled SIMs found', total: 0 }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }

        // 2. Get existing cancel history records so we skip SIMs that already have one
        const simIds = canceledSims.map(s => s.id);
        const existingHistory = await sbGet(env, `sim_status_history?select=sim_id&new_status=eq.canceled&sim_id=in.(${simIds.join(',')})&limit=10000`);
        const alreadyHasHistory = new Set((existingHistory || []).map(h => h.sim_id));

        const needsBackfill = canceledSims.filter(s => !alreadyHasHistory.has(s.id));
        if (!needsBackfill.length) {
            return new Response(JSON.stringify({
                ok: true,
                message: 'All canceled SIMs already have history records',
                total_canceled: canceledSims.length,
                already_have_history: alreadyHasHistory.size,
                needs_backfill: 0
            }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // 3. Get Helix token
        const tokenRes = await fetch(env.HX_TOKEN_URL, {
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

        // 4. Query each SIM's subscriber_details and extract canceledAt
        const results = { backfilled: 0, no_date: 0, api_errors: 0, skipped: 0, details: [] };

        for (const sim of needsBackfill) {
            try {
                const detailsRes = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/details`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),
                });

                if (!detailsRes.ok) {
                    results.api_errors++;
                    results.details.push({ iccid: sim.iccid, error: `Helix ${detailsRes.status}` });
                    continue;
                }

                const detailsData = await detailsRes.json();
                const d = Array.isArray(detailsData) ? detailsData[0] : detailsData;
                const canceledAt = d?.canceledAt || d?.cancelledAt || null;

                if (!canceledAt) {
                    results.no_date++;
                    results.details.push({ iccid: sim.iccid, sub_id: sim.mobility_subscription_id, error: 'No canceledAt in Helix response', helix_status: d?.status });
                    continue;
                }

                // 5. Insert backfill record into sim_status_history
                const ts = new Date(canceledAt).toISOString();
                await sbPost(env, 'sim_status_history', {
                    sim_id: sim.id,
                    old_status: 'active', // best guess — was active before cancel
                    new_status: 'canceled',
                    changed_at: ts,
                });

                results.backfilled++;
                results.details.push({ iccid: sim.iccid, canceled_at: ts });

            } catch (err) {
                results.api_errors++;
                results.details.push({ iccid: sim.iccid, error: String(err) });
            }

            // Rate limit: small delay between Helix calls
            await new Promise(r => setTimeout(r, 200));
        }

        return new Response(JSON.stringify({
            ok: true,
            total_canceled: canceledSims.length,
            already_have_history: alreadyHasHistory.size,
            needs_backfill: needsBackfill.length,
            ...results,
        }, null, 2), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
}

function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMS Gateway Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>

        let sidebarOpen = false;
        function toggleSidebar(open) {
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (!sidebar || !overlay) return;
            if (open) {
                sidebar.classList.add('sidebar-open');
                overlay.classList.remove('hidden');
                setTimeout(() => overlay.classList.add('opacity-100'), 10);
                document.body.classList.add('overflow-hidden');
            } else {
                sidebar.classList.remove('sidebar-open');
                overlay.classList.remove('opacity-100');
                setTimeout(() => {
                    overlay.classList.add('hidden');
                    document.body.classList.remove('overflow-hidden');
                }, 300);
            }
        }

        let confirmPromiseResolver = null;
        function showConfirm(title, message) {
            const modal = document.getElementById('confirm-modal');
            if (!modal) return Promise.resolve(confirm(message));
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').textContent = message;
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            return new Promise((resolve) => {
                confirmPromiseResolver = resolve;
            });
        }
        function handleConfirm(confirmed) {
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            if (confirmPromiseResolver) {
                confirmPromiseResolver(confirmed);
                confirmPromiseResolver = null;
            }
        }

        function toggleLightMode() {
            const isLight = document.documentElement.classList.toggle('light');
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            const sun = document.getElementById('theme-icon-sun');
            const moon = document.getElementById('theme-icon-moon');
            if (sun) sun.classList.toggle('hidden', isLight);
            if (moon) moon.classList.toggle('hidden', !isLight);
        }
        (function() {
            if (localStorage.getItem('theme') === 'light') {
                document.documentElement.classList.add('light');
            }
        })();

        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        dark: {
                            950: 'rgb(var(--dark-950) / <alpha-value>)',
                            900: 'rgb(var(--dark-900) / <alpha-value>)',
                            800: 'rgb(var(--dark-800) / <alpha-value>)',
                            700: 'rgb(var(--dark-700) / <alpha-value>)',
                            600: 'rgb(var(--dark-600) / <alpha-value>)',
                            500: 'rgb(var(--dark-500) / <alpha-value>)',
                            400: 'rgb(var(--dark-400) / <alpha-value>)',
                            300: 'rgb(var(--dark-300) / <alpha-value>)',
                            200: 'rgb(var(--dark-200) / <alpha-value>)',
                            100: 'rgb(var(--dark-100) / <alpha-value>)',
                        },
                        accent: {
                            DEFAULT: '#3b82f6',
                            hover: '#2563eb',
                            glow: 'rgba(59, 130, 246, 0.5)'
                        },
                        surface: {
                            DEFAULT: 'rgb(var(--dark-800) / <alpha-value>)',
                            hover: 'rgb(var(--dark-700) / <alpha-value>)',
                        }
                    },
                    fontFamily: {
                        sans: ['Fira Sans', 'system-ui', 'sans-serif'],
                        mono: ['Fira Code', 'monospace'],
                    }
                }
            }
        }
    </script>
    <style>
        :root {
            --dark-950: 5 5 7;
            --dark-900: 9 9 11;
            --dark-800: 24 24 27;
            --dark-700: 39 39 42;
            --dark-600: 63 63 70;
            --dark-500: 82 82 91;
            --dark-400: 161 161 170;
            --dark-300: 212 212 216;
            --dark-200: 228 228 231;
            --dark-100: 244 244 245;
        }
        html.light {
            --dark-950: 255 255 255;
            --dark-900: 248 250 252;
            --dark-800: 241 245 249;
            --dark-700: 226 232 240;
            --dark-600: 203 213 225;
            --dark-500: 100 116 139;
            --dark-400: 71 85 105;
            --dark-300: 51 65 85;
            --dark-200: 30 41 59;
            --dark-100: 15 23 42;
        }
        html.light .text-white { color: rgb(var(--dark-100)) !important; }
        html.light .sidebar-btn.text-white { color: #3b82f6 !important; background-color: rgba(59,130,246,0.1) !important; border-left-color: #3b82f6 !important; }
        html.light ::-webkit-scrollbar-track { background: rgb(var(--dark-800)); }
        html.light ::-webkit-scrollbar-thumb { background: rgb(var(--dark-600)); border-radius: 3px; }
        /* text-gray-* classes are Tailwind built-ins that don't adapt — override for light mode */
        html.light .text-gray-200 { color: rgb(30 41 59) !important; }
        html.light .text-gray-300 { color: rgb(51 65 85) !important; }
        html.light .text-gray-400 { color: rgb(71 85 105) !important; }
        html.light .text-gray-500 { color: rgb(100 116 139) !important; }
        html.light .text-gray-600 { color: rgb(71 85 105) !important; }
        * { font-family: 'Inter', system-ui, sans-serif; }
        .progress-ring { transform: rotate(-90deg); }
        .progress-ring__circle { transition: stroke-dashoffset 0.5s ease; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #111118; }
        ::-webkit-scrollbar-thumb { background: #2a2a35; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #3a3a48; }
        .sidebar-btn { transition: color 0.15s, background-color 0.15s; }
        .sidebar-btn.text-white { color: #3b82f6 !important; background-color: rgba(59,130,246,0.1) !important; border-left-color: #3b82f6 !important; }
        .sidebar-btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
        @media (max-width: 1024px) {
            .sidebar-open { transform: translateX(0) !important; }
            .sidebar-overlay-active { display: block !important; }
        }
    </style>
</head>
<body class="bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-dark-800 via-dark-900 to-dark-900 text-dark-100 min-h-screen selection:bg-accent/30 tracking-wide overflow-x-hidden">
    <!-- Mobile Sidebar Overlay -->
    <div id="sidebar-overlay" onclick="toggleSidebar(false)" class="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 hidden transition-opacity duration-300"></div>

    <div class="flex min-h-screen relative">
        <!-- Sidebar -->
        <aside id="sidebar" class="fixed inset-y-0 left-0 w-72 bg-dark-950/80 flex flex-col py-6 border-r border-white/5 z-50 backdrop-blur-2xl transition-transform duration-300 -translate-x-full lg:translate-x-0 lg:static lg:w-64">
            <div class="flex items-center gap-3 px-6 mb-10">
                <div class="w-9 h-9 bg-accent rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                </div>
                <div>
                    <p class="text-sm font-semibold text-white leading-tight">SMS</p>
                    <p class="text-xs text-dark-500 leading-tight">Gateway</p>
                </div>
            </div>
            <nav class="flex flex-col gap-1 px-2">
                <a href="/" onclick="event.preventDefault();switchTab('dashboard')" data-tab="dashboard" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Dashboard">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>
                    <span class="text-sm">Dashboard</span>
                </a>
                <a href="/sims" onclick="event.preventDefault();switchTab('sims')" data-tab="sims" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="SIMs">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                    <span class="text-sm">SIMs</span>
                </a>
                <a href="/messages" onclick="event.preventDefault();switchTab('messages')" data-tab="messages" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Messages">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                    <span class="text-sm">Messages</span>
                </a>
                <a href="/workers" onclick="event.preventDefault();switchTab('workers')" data-tab="workers" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Workers">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                    <span class="text-sm">Workers</span>
                </a>
                <a href="/gateway" onclick="event.preventDefault();switchTab('gateway')" data-tab="gateway" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Gateway">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg>
                    <span class="text-sm">Gateway</span>
                </a>
                <a href="/imei-pool" onclick="event.preventDefault();switchTab('imei-pool')" data-tab="imei-pool" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="IMEI Pool">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                    <span class="text-sm">IMEI Pool</span>
                </a>
                <a href="/errors" onclick="event.preventDefault();switchTab('errors')" data-tab="errors" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Errors">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                    <span class="text-sm">Errors</span>
                    <span id="error-badge" class="hidden ml-auto min-w-[16px] h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1">0</span>
                </a>
                <a href="/billing" onclick="event.preventDefault();switchTab('billing')" data-tab="billing" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Billing">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                    <span class="text-sm">Billing</span>
                </a>
                <a href="/guide" onclick="event.preventDefault();switchTab('guide')" data-tab="guide" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Guide">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                    <span class="text-sm">Guide</span>
                </a>
            </nav>
            <div class="mt-auto px-2">
                <button onclick="loadData()" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-dark-400 hover:text-accent hover:bg-dark-600 transition" title="Refresh">
                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                    <span class="text-sm">Refresh</span>
                </button>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="flex-1 w-full min-w-0 overflow-auto">
            <!-- Mobile Top Header -->
            <div class="lg:hidden flex items-center justify-between p-4 bg-dark-950/50 border-b border-white/5 backdrop-blur-md sticky top-0 z-30">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 bg-accent rounded flex items-center justify-center">
                        <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                    </div>
                    <span class="font-bold text-white tracking-tight">SMS Gateway</span>
                </div>
                <button onclick="toggleSidebar(true)" class="p-2 text-dark-400 hover:text-white transition">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                </button>
            </div>

            <div class="p-4 lg:p-8">
            <!-- Header -->
            <header class="flex flex-col md:flex-row md:items-center justify-between mb-8 pb-4 border-b border-white/5 gap-4">
                <div>
                    <h1 class="text-3xl font-bold text-white tracking-tight">SMS Gateway</h1>
                    <p class="text-sm text-dark-400 mt-1 font-medium">Monitor SIMs, messages, and system status</p>
                </div>
                <div class="flex items-center gap-4">
                    <button id="theme-toggle" onclick="toggleLightMode()" class="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700/50 transition" title="Toggle light mode">
                        <svg id="theme-icon-sun" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"/></svg>
                        <svg id="theme-icon-moon" class="w-5 h-5 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
                    </button>
                    <span id="last-updated" class="text-xs text-dark-500"></span>
                    <div class="w-2 h-2 bg-accent rounded-full animate-pulse" title="Connected"></div>
                </div>
            </header>

            <!-- Dashboard Tab -->
            <div id="tab-dashboard" class="tab-content">
                <!-- Stats Cards -->
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                    <!-- Total SIMs -->
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <div class="flex items-center justify-between mb-3">
                            <span class="text-sm text-gray-400">Total SIMs</span>
                            <div class="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                                <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                            </div>
                        </div>
                        <p class="text-3xl font-bold text-white" id="total-sims">-</p>
                    </div>

                    <!-- Active SIMs with Ring -->
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <div class="flex items-center justify-between">
                            <div>
                                <span class="text-sm text-gray-400">Active SIMs</span>
                                <p class="text-3xl font-bold text-white mt-2" id="active-sims">-</p>
                            </div>
                            <div class="relative">
                                <svg class="progress-ring w-16 h-16" viewBox="0 0 60 60">
                                    <circle class="text-dark-600" stroke="currentColor" stroke-width="6" fill="none" cx="30" cy="30" r="26"/>
                                    <circle id="active-ring" class="progress-ring__circle text-accent" stroke="currentColor" stroke-width="6" fill="none" cx="30" cy="30" r="26" stroke-dasharray="163.36" stroke-dashoffset="163.36" stroke-linecap="round"/>
                                </svg>
                                <span id="active-percent" class="absolute inset-0 flex items-center justify-center text-xs font-semibold text-accent">0%</span>
                            </div>
                        </div>
                    </div>

                    <!-- Provisioning -->
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <div class="flex items-center justify-between mb-3">
                            <span class="text-sm text-gray-400">Provisioning</span>
                            <div class="w-8 h-8 rounded-lg bg-yellow-500/20 flex items-center justify-center">
                                <svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                        </div>
                        <p class="text-3xl font-bold text-white" id="provisioning-sims">-</p>
                    </div>

                    <!-- Messages 24h -->
                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                        <div class="flex items-center justify-between mb-3">
                            <span class="text-sm text-gray-400">Messages (24h)</span>
                            <div class="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                                <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                            </div>
                        </div>
                        <p class="text-3xl font-bold text-white" id="messages-24h">-</p>
                    </div>
                </div>

                <!-- Quick Actions -->
                <div class="bg-dark-800 rounded-xl border border-dark-600 mb-6">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <h2 class="text-lg font-semibold text-white">Quick Actions</h2>
                    </div>
                    <div class="p-5 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
                        <button onclick="showActivateModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center group-hover:bg-blue-500/30 transition">
                                <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Activate</span>
                        </button>
                        <button onclick="showSuspendModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-yellow-500/20 flex items-center justify-center group-hover:bg-yellow-500/30 transition">
                                <svg class="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Suspend</span>
                        </button>
                        <button onclick="showRestoreModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition">
                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Restore</span>
                        </button>
                        <button onclick="showCancelModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center group-hover:bg-red-500/30 transition">
                                <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Cancel</span>
                        </button>
                        <button onclick="showHelixQueryModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/30 transition">
                                <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Query</span>
                        </button>
                        <button onclick="showTestSmsModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center group-hover:bg-cyan-500/30 transition">
                                <svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Test SMS</span>
                        </button>
                        <button onclick="showFixSimModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center group-hover:bg-amber-500/30 transition">
                                <svg class="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Fix SIM</span>
                        </button>
                    </div>
                </div>

                <!-- Recent Messages Preview -->
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                        <h2 class="text-lg font-semibold text-white">Recent Messages</h2>
                        <button onclick="switchTab('messages')" class="text-xs text-accent hover:text-green-400 transition">View All</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase">
                                    <th class="px-5 py-3 font-medium">Time</th>
                                    <th class="px-5 py-3 font-medium">To</th>
                                    <th class="px-5 py-3 font-medium">From</th>
                                    <th class="px-5 py-3 font-medium">Message</th>
                                </tr>
                            </thead>
                            <tbody id="messages-preview" class="text-sm">
                                <tr><td colspan="4" class="px-5 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- SIMs Tab -->
            <div id="tab-sims" class="tab-content hidden">
                <div id="sim-action-bar" class="hidden mb-4 p-3 bg-dark-800 rounded-lg border border-dark-600 flex items-center gap-3">
                    <span id="sim-selected-count" class="text-sm text-gray-300">0 selected</span>
                    <button onclick="bulkSimAction('ota_refresh')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition">OTA Refresh</button>
                    <button onclick="bulkSimAction('rotate')" class="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition">Rotate MDN</button>
                    <button onclick="bulkSimAction('fix')" class="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">Fix SIM</button>
                    <button onclick="bulkAssignReseller()" class="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition">Assign Reseller</button>
                    <button onclick="bulkAssignResellerAndNotify()" class="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded transition">Assign + Notify</button>
                    <button onclick="bulkUnassignReseller()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Unassign Reseller</button>
                    <button onclick="bulkSimAction('cancel')" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Cancel</button>
                    <button onclick="bulkSimAction('resume')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>
                    <button onclick="bulkSendOnline()" class="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition">Send Online</button>
                    <button onclick="showBulkSendSmsModal()" class="px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-700 text-white rounded transition">Send SMS</button>
                    <button onclick="bulkResetToProvisioning()" class="px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition">Re-finalize</button>
                    <button onclick="bulkModifyImei()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded transition">Modify IMEI</button>
                </div>
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <div class="flex flex-wrap items-center justify-between gap-4">
                            <div class="flex items-center gap-3">
                                <h2 class="text-lg font-semibold text-white">SIM Status</h2>
                                <span id="sims-cache-label" class="text-xs text-gray-500"></span>
                                <button id="sims-refresh-btn" onclick="loadSims(true); this.querySelector('svg').classList.add('animate-spin'); setTimeout(() => this.querySelector('svg').classList.remove('animate-spin'), 1000)" class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 hover:text-white bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded-lg transition">
                                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                    Refresh
                                </button>
                            </div>
                            <div class="flex flex-wrap items-center gap-3">
                                <select id="filter-status" onchange="loadSims(true)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All (except cancelled)</option>
                                    <option value="all">All (include cancelled)</option>
                                    <option value="active" selected>Active</option>
                                    <option value="provisioning">Provisioning</option>
                                    <option value="pending">Pending</option>
                                    <option value="suspended">Suspended</option>
                                    <option value="canceled">Cancelled</option>
                                    <option value="error">Error</option>
                                    <option value="helix_timeout">Helix Timeout</option>
                                    <option value="data_mismatch">Data Mismatch</option>
                                </select>
                                <select id="filter-reseller" onchange="loadSims(true)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Resellers</option>
                                </select>
                                <select id="filter-gateway" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Gateways</option>
                                </select>
                                <select id="filter-special" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">No Quick Filter</option>
                                    <option value="not_rotated_today">Not rotated today</option>
                                    <option value="no_sms_12h">No SMS in 12h</option>
                                </select>
                                <label class="text-xs text-gray-500 flex items-center gap-1">Activated
                                  <input id="filter-activated-from" type="date" oninput="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-accent" title="Activated from">
                                  <span class="text-gray-600">&#8211;</span>
                                  <input id="filter-activated-to" type="date" oninput="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:border-accent" title="Activated to">
                                </label>
                                <input id="sims-search" type="text" placeholder="Search... (comma-separated for multiple)" oninput="renderSims()" onpaste="normalizePastedSearch(this,event,renderSims)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-48">
                                <span id="sims-count" class="text-sm text-gray-500"></span>
                            </div>
                        </div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium"><input type="checkbox" onchange="toggleAllSims(this)" class="accent-green-500"></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','id')">ID <span class="sort-arrow" data-table="sims" data-col="id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','gateway_code')">Gateway <span class="sort-arrow" data-table="sims" data-col="gateway_code"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','iccid')">ICCID <span class="sort-arrow" data-table="sims" data-col="iccid"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','phone_number')">Phone <span class="sort-arrow" data-table="sims" data-col="phone_number"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','status')">Status <span class="sort-arrow" data-table="sims" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','mobility_subscription_id')">Sub ID <span class="sort-arrow" data-table="sims" data-col="mobility_subscription_id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','reseller_name')">Reseller <span class="sort-arrow" data-table="sims" data-col="reseller_name"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','sms_count')">SMS <span class="sort-arrow" data-table="sims" data-col="sms_count"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','last_sms_received')">Last SMS <span class="sort-arrow" data-table="sims" data-col="last_sms_received"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','last_mdn_rotated_at')">Last Rotated <span class="sort-arrow" data-table="sims" data-col="last_mdn_rotated_at"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','activated_at')">Activated <span class="sort-arrow" data-table="sims" data-col="activated_at"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','last_notified_at')">Last Notified <span class="sort-arrow" data-table="sims" data-col="last_notified_at"></span></th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="sims-table" class="text-sm">
                                <tr><td colspan="13" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    <div id="sims-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>
                    </div>
                </div>
            </div>

            <!-- Messages Tab -->
            <div id="tab-messages" class="tab-content hidden">
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                        <h2 class="text-lg font-semibold text-white">SMS Messages</h2>
                        <div class="flex items-center gap-3">
                            <input id="messages-search" type="text" placeholder="Search..." oninput="renderMessages()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-40">
                            <button onclick="loadMessages()" class="text-xs text-accent hover:text-green-400 transition">Refresh</button>
                        </div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-5 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('messages','received_at')">Time <span class="sort-arrow" data-table="messages" data-col="received_at"></span></th>
                                    <th class="px-5 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('messages','to_number')">To <span class="sort-arrow" data-table="messages" data-col="to_number"></span></th>
                                    <th class="px-5 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('messages','from_number')">From <span class="sort-arrow" data-table="messages" data-col="from_number"></span></th>
                                    <th class="px-5 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('messages','body')">Message <span class="sort-arrow" data-table="messages" data-col="body"></span></th>
                                    <th class="px-5 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('messages','iccid')">ICCID <span class="sort-arrow" data-table="messages" data-col="iccid"></span></th>
                                </tr>
                            </thead>
                            <tbody id="messages-table" class="text-sm">
                                <tr><td colspan="5" class="px-5 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    <div id="messages-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>
                    </div>
                </div>
            </div>

            <!-- Workers Tab -->
            <div id="tab-workers" class="tab-content hidden">
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <h2 class="text-lg font-semibold text-white">Worker Controls</h2>
                    </div>
                    <div class="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <button onclick="runWorker('bulk-activator')" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Bulk Activator</p>
                                <p class="text-xs text-gray-400">Activate pending SIMs</p>
                            </div>
                        </button>
                        <button onclick="runWorker('details-finalizer')" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Details Finalizer</p>
                                <p class="text-xs text-gray-400">Finalize provisioning SIMs</p>
                            </div>
                        </button>
                        <button onclick="runWorker('mdn-rotator')" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">MDN Rotator</p>
                                <p class="text-xs text-gray-400">Rotate phone numbers (batch)</p>
                            </div>
                        </button>
                        <button onclick="showRotateSimModal()" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-orange-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Rotate Specific SIMs</p>
                                <p class="text-xs text-gray-400">Rotate by ICCID</p>
                            </div>
                        </button>
                        <button onclick="runWorker('phone-number-sync')" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Phone Number Sync</p>
                                <p class="text-xs text-gray-400">Sync numbers from Helix</p>
                            </div>
                        </button>
                        <button onclick="showResellerSyncModal()" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-teal-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Reseller Sync</p>
                                <p class="text-xs text-gray-400">Send webhooks to resellers</p>
                            </div>
                        </button>
                    <!-- Reseller Sync Modal -->
                    <div id="reseller-sync-modal" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                        <div class="bg-dark-800 border border-dark-600 rounded-xl p-6 w-full max-w-sm shadow-2xl">
                            <h3 class="text-lg font-semibold text-white mb-4">Reseller Sync</h3>
                            <p class="text-sm text-gray-400 mb-4">Send <code class="bg-dark-900 px-1 rounded text-accent">number.online</code> webhooks to resellers for all active SIMs with verified numbers.</p>
                            <label class="flex items-center gap-3 cursor-pointer mb-6">
                                <input type="checkbox" id="reseller-sync-force" class="w-4 h-4 rounded accent-amber-500">
                                <div>
                                    <span class="text-sm font-medium text-white">Skip dedup (force re-send)</span>
                                    <p class="text-xs text-gray-500">Re-send even if already notified today</p>
                                </div>
                            </label>
                            <div class="flex gap-3">
                                <button onclick="hideResellerSyncModal()" class="flex-1 px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white rounded-lg text-sm transition">Cancel</button>
                                <button onclick="doResellerSync()" class="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm font-medium transition">Run Sync</button>
                            </div>
                        </div>
                    </div>
                    </div>
                </div>
            </div>

            <!-- Gateway Tab -->
            <div id="tab-gateway" class="tab-content hidden">
                <!-- Gateway Selector -->
                <div class="flex flex-wrap items-center gap-4 mb-6">
                    <select id="gw-select" onchange="loadPortStatus()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-4 py-2 text-gray-200 focus:outline-none focus:border-accent min-w-[200px]">
                        <option value="">Select a gateway...</option>
                    </select>
                    <button onclick="loadPortStatus()" class="px-3 py-2 text-sm bg-dark-700 border border-dark-500 rounded-lg text-gray-300 hover:bg-dark-600 transition">Refresh</button>
                    <span id="gw-status-label" class="text-xs text-gray-500"></span>
                </div>

                <!-- Port Status Grid -->
                <div class="bg-dark-800 rounded-xl border border-dark-600 mb-6">
                    <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                        <h2 class="text-lg font-semibold text-white">Port Status</h2>
                        <div class="flex items-center gap-3 text-xs text-gray-500">
                            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-green-500 inline-block"></span> Registered</span>
                            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-yellow-500 inline-block"></span> Registering</span>
                            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-blue-500 inline-block"></span> Idle</span>
                            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-red-500 inline-block"></span> Error/No SIM</span>
                            <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-orange-500 inline-block"></span> No Balance</span>
                        </div>
                    </div>
                    <div id="port-grid" class="p-5 grid grid-cols-4 md:grid-cols-8 lg:grid-cols-16 gap-2">
                        <p class="text-gray-500 text-sm col-span-full text-center py-8">Select a gateway to view port status</p>
                    </div>
                </div>

                <!-- Quick Actions -->
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <h2 class="text-lg font-semibold text-white">Gateway Actions</h2>
                    </div>
                    <div class="p-5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                        <button onclick="showGwSwitchSimModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center group-hover:bg-purple-500/30 transition">
                                <svg class="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Switch SIM</span>
                        </button>
                        <button onclick="showGwImeiModal()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-teal-500/20 flex items-center justify-center group-hover:bg-teal-500/30 transition">
                                <svg class="w-5 h-5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">IMEI</span>
                        </button>
                        <button onclick="showGwCommandModal('reboot')" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center group-hover:bg-orange-500/30 transition">
                                <svg class="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Reboot</span>
                        </button>
                        <button onclick="showGwCommandModal('lock')" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center group-hover:bg-red-500/30 transition">
                                <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Lock</span>
                        </button>
                        <button onclick="showGwCommandModal('unlock')" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition">
                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Unlock</span>
                        </button>
                        <button onclick="importGatewayImeis()" id="gw-import-imei-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center group-hover:bg-cyan-500/30 transition">
                                <svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Import IMEIs</span>
                        </button>
                        <button onclick="syncGatewaySlots()" id="gw-sync-slots-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/30 transition">
                                <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582 4 8 4s8 1.79 8 4"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Sync Slots</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- IMEI Pool Tab -->
            <div id="tab-imei-pool" class="tab-content hidden">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">IMEI Pool</h2>
                    <div class="flex items-center gap-3">
                        <input id="imei-search" type="text" placeholder="Search IMEI..." oninput="renderImeiPool()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-40">
                        <select id="imei-status-filter" onchange="renderImeiPool()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                            <option value="">All Statuses</option>
                            <option value="in_use">In Use</option>
                            <option value="available">Available (Stock)</option>
                            <option value="retired">Retired (Rejected)</option>
                        </select>
                        <button onclick="syncAllGatewayImeis()" id="sync-gateways-btn" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Sync from Gateways</button>
                        <button onclick="showAddImeiModal()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add IMEIs</button>
                        <button onclick="showCheckImeisModal()" class="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Check IMEIs</button>
                    </div>
                </div>

                <!-- Stats Row -->
                <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400" title="Total number of SIM slots across all gateways">Slots</span>
                        <p class="text-2xl font-bold text-purple-400" id="imei-slots">-</p>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400" title="IMEIs currently assigned to a gateway slot">In Use</span>
                        <p class="text-2xl font-bold text-blue-400" id="imei-in-use">-</p>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400" title="Stock IMEIs ready for future assignment">Available</span>
                        <p class="text-2xl font-bold text-accent" id="imei-available">-</p>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400" title="IMEIs rejected by carrier, will not be reused">Retired</span>
                        <p class="text-2xl font-bold text-gray-500" id="imei-retired">-</p>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400" title="Total IMEIs in the database">Total IMEIs</span>
                        <p class="text-2xl font-bold text-white" id="imei-total">-</p>
                    </div>
                </div>

                <!-- Pool Table -->
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','id')">ID <span class="sort-arrow" data-table="imei" data-col="id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','imei')">IMEI <span class="sort-arrow" data-table="imei" data-col="imei"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','status')">Status <span class="sort-arrow" data-table="imei" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','sim_id')">Assigned SIM <span class="sort-arrow" data-table="imei" data-col="sim_id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','gateway_id')">Gateway <span class="sort-arrow" data-table="imei" data-col="gateway_id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','port')">Port <span class="sort-arrow" data-table="imei" data-col="port"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','assigned_at')">Assigned At <span class="sort-arrow" data-table="imei" data-col="assigned_at"></span></th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="imei-pool-table" class="text-sm">
                                <tr><td colspan="6" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    <div id="imei-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>
                    </div>
                </div>
            </div>

            <!-- Errors Tab -->
            <div id="tab-errors" class="tab-content hidden">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">System Errors</h2>
                    <div class="flex items-center gap-3">
                        <select id="errors-status-filter" onchange="loadErrors()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                            <option value="open">Open</option>
                            <option value="acknowledged">Acknowledged</option>
                            <option value="resolved">Resolved</option>
                            <option value="all">All</option>
                        </select>
                        <input id="errors-search" type="text" placeholder="Search..." oninput="renderErrors()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-40">
                        <button onclick="loadErrors()" class="px-3 py-2 text-sm bg-dark-700 border border-dark-500 rounded-lg text-gray-300 hover:bg-dark-600 transition">Refresh</button>
                    </div>
                </div>
                <!-- Error Summary -->
                <div id="error-summary" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"></div>
                <!-- Bulk Action Bar -->
                <div id="error-action-bar" class="hidden mb-4 p-3 bg-dark-800 rounded-lg border border-dark-600 flex items-center gap-3">
                    <span id="error-selected-count" class="text-sm text-gray-300">0 selected</span>
                    <button onclick="bulkResolveErrors()" class="px-3 py-1.5 text-xs bg-accent hover:bg-green-600 text-white rounded transition">Mark Resolved</button>
                    <button onclick="bulkErrorAction('ota_refresh')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition">OTA Refresh</button>
                    <button onclick="bulkErrorAction('cancel')" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Cancel</button>
                    <button onclick="bulkErrorAction('resume')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>
                    <button onclick="bulkErrorAction('fix')" class="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">Fix SIM</button>
                </div>
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium"><input type="checkbox" onchange="toggleAllErrors(this)" class="accent-green-500"></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','source')">Source <span class="sort-arrow" data-table="errors" data-col="source"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','iccid')">ICCID / SIM <span class="sort-arrow" data-table="errors" data-col="iccid"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','error_message')">Error <span class="sort-arrow" data-table="errors" data-col="error_message"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','severity')">Severity <span class="sort-arrow" data-table="errors" data-col="severity"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','status')">Status <span class="sort-arrow" data-table="errors" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('errors','created_at')">Time <span class="sort-arrow" data-table="errors" data-col="created_at"></span></th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="errors-table" class="text-sm">
                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div id="errors-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>
                </div>
                <!-- Error Detail Drawer -->
                <div id="error-detail" class="hidden mt-4 bg-dark-800 rounded-xl border border-dark-600 p-5">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white" id="error-detail-title">Error Details</h3>
                        <button onclick="hideErrorDetail()" class="text-gray-400 hover:text-white text-xl">&times;</button>
                    </div>
                    <div id="error-detail-info" class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4"></div>
                    <div class="mb-3">
                        <h4 class="text-sm font-semibold text-gray-400 mb-2">Error Message</h4>
                        <pre id="error-detail-content" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-60 overflow-y-auto text-red-400 border border-dark-600 whitespace-pre-wrap"></pre>
                    </div>
                    <div id="error-detail-extra" class="hidden mb-3">
                        <h4 class="text-sm font-semibold text-gray-400 mb-2">Error Details (JSON)</h4>
                        <pre id="error-detail-json" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-60 overflow-y-auto text-gray-300 border border-dark-600 whitespace-pre-wrap"></pre>
                    </div>
                    <div id="error-logs-section" class="hidden">
                        <h4 class="text-sm font-semibold text-gray-400 mb-2">API Logs (most recent first)</h4>
                        <div id="error-logs-container" class="space-y-2 max-h-96 overflow-y-auto"></div>
                    </div>
                </div>
            </div>


            <!-- Billing Tab -->
            <div id="tab-billing" class="tab-content hidden">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">Billing & Invoicing</h2>
                </div>

                <!-- Customer Mapping -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white">Customer Rates</h3>
                        <button onclick="showAddMappingModal()" class="px-3 py-1.5 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Reseller</th>
                                    <th class="px-4 py-3 font-medium">Customer Name</th>
                                    <th class="px-4 py-3 font-medium">Daily Rate</th>
                                    <th class="px-4 py-3 font-medium">Active SIMs</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="mapping-table" class="text-sm">
                                <tr><td colspan="5" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Invoice Generator -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Generate Invoice</h3>
                    <div class="flex flex-wrap items-end gap-3 mb-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">Reseller</label>
                            <select id="invoice-reseller" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 min-w-40">
                                <option value="">-- Select Reseller --</option>
                            </select>
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">From</label>
                            <input type="date" id="invoice-start" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        </div>
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">To</label>
                            <input type="date" id="invoice-end" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        </div>
                        <button onclick="previewInvoices()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Preview</button>
                        <button onclick="downloadInvoiceIIF()" id="download-invoice-btn" class="hidden px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Download for QuickBooks</button>
                    </div>
                    <div id="invoice-preview" class="text-gray-400 text-sm"></div>
                </div>

                <!-- Invoice History -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                    <h3 class="text-lg font-semibold text-white mb-3">Invoice History</h3>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Customer</th>
                                    <th class="px-4 py-3 font-medium">Period</th>
                                    <th class="px-4 py-3 font-medium">SIM-days</th>
                                    <th class="px-4 py-3 font-medium">Total</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="invoice-history-table" class="text-sm">
                                <tr><td colspan="5" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Wing Bill Verification -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6 mt-8">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white">Wing Bill Verification</h3>
                    </div>
                    <p class="text-sm text-gray-400 mb-4">Upload the Wing/Helix itemized CSV to cross-reference against SIM records and detect billing discrepancies.</p>

                    <div class="flex flex-wrap items-end gap-3 mb-4">
                        <div class="flex flex-col gap-1">
                            <label class="text-xs text-gray-500 uppercase">CSV File</label>
                            <input type="file" id="wing-csv-file" accept=".csv" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        </div>
                        <button onclick="uploadWingBill()" id="wing-upload-btn" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">
                            Verify Bill
                        </button>
                    </div>

                    <div id="wing-summary" class="hidden mb-4">
                        <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Lines</p>
                                <p class="text-xl font-bold text-white" id="wing-total-rows">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Total Billed</p>
                                <p class="text-xl font-bold text-white" id="wing-total-amount">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Expected</p>
                                <p class="text-xl font-bold text-accent" id="wing-total-expected">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Overcharge</p>
                                <p class="text-xl font-bold text-red-400" id="wing-overcharge">$0.00</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Discrepancies</p>
                                <p class="text-xl font-bold" id="wing-discrepancy-count">0</p>
                            </div>
                            <div class="bg-dark-700 rounded-lg p-3 border border-dark-600">
                                <p class="text-xs text-gray-500 uppercase">Missing from Bill</p>
                                <p class="text-xl font-bold text-yellow-400" id="wing-missing-count">0</p>
                            </div>
                        </div>
                        <button onclick="exportWingAudit(window._wingUploadId)" id="wing-export-btn" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition mb-4">
                            Export Audit Report (CSV)
                        </button>
                    </div>

                    <div id="wing-discrepancies" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-red-400 uppercase mb-2">Discrepancies Found</h4>
                        <div class="overflow-x-auto max-h-96 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">Type</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Description</th>
                                        <th class="px-3 py-2 font-medium">Period</th>
                                        <th class="px-3 py-2 font-medium">Billed</th>
                                        <th class="px-3 py-2 font-medium">Expected</th>
                                        <th class="px-3 py-2 font-medium">Days</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                        <th class="px-3 py-2 font-medium">Detail</th>
                                    </tr>
                                </thead>
                                <tbody id="wing-discrepancy-table"></tbody>
                            </table>
                        </div>
                    </div>

                    <div id="wing-missing" class="hidden mb-4">
                        <h4 class="text-sm font-semibold text-yellow-400 uppercase mb-2">Active SIMs Missing from Bill</h4>
                        <div class="overflow-x-auto max-h-48 overflow-y-auto">
                            <table class="w-full text-sm">
                                <thead class="sticky top-0 bg-dark-800">
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-3 py-2 font-medium">SIM ID</th>
                                        <th class="px-3 py-2 font-medium">ICCID</th>
                                        <th class="px-3 py-2 font-medium">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="wing-missing-table"></tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Wing Verification History -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                    <h3 class="text-lg font-semibold text-white mb-3">Verification History</h3>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Date</th>
                                    <th class="px-4 py-3 font-medium">File</th>
                                    <th class="px-4 py-3 font-medium">Period</th>
                                    <th class="px-4 py-3 font-medium">Lines</th>
                                    <th class="px-4 py-3 font-medium">Billed</th>
                                    <th class="px-4 py-3 font-medium">Overcharge</th>
                                    <th class="px-4 py-3 font-medium">Issues</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="wing-history-table" class="text-sm">
                                <tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">No verifications yet</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Guide Tab -->
            <div id="tab-guide" class="tab-content hidden">
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">System Guide &mdash; Standard Operating Procedures</h2>
                </div>

                <!-- Table of Contents -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Contents</h3>
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-architecture').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">System Architecture</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-sims').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">SIMs Page</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-fix-sim').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Fix SIM</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-mdn-rotation').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">MDN Rotation</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-ota-refresh').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">OTA Refresh</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-cancel-resume').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Cancel / Resume</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-change-imei').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Change IMEI</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-retry-activation').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Retry Activation</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-bulk-activate').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Bulk Activation</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-send-sms').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Send SMS</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-sms-ingest').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Incoming SMS</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-workers').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Workers Page</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-gateway').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Gateway Page</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-imei-pool').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">IMEI Pool</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-errors').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Errors Page</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-billing').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Billing Page</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-reseller-webhooks').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Reseller Webhooks</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-statuses').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">SIM Status Reference</a>
                        <a href="#" onclick="event.preventDefault();document.getElementById('guide-auto-imei-att').scrollIntoView({behavior:'smooth'})" class="text-accent hover:underline">Auto IMEI Change (AT&amp;T)</a>
                    </div>
                </div>

                <!-- Architecture Overview -->
                <div id="guide-architecture" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">System Architecture</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>The system runs on <span class="text-white font-medium">Cloudflare Workers</span> with <span class="text-white font-medium">Supabase</span> (PostgreSQL) as the database. It integrates with two external APIs:</p>
                        <ul class="list-disc list-inside space-y-1 ml-2">
                            <li><span class="text-white font-medium">Helix API</span> &mdash; AT&amp;T carrier operations (activate, cancel, resume, OTA refresh, IMEI change, MDN rotation, subscriber details)</li>
                            <li><span class="text-white font-medium">SkyLine API</span> &mdash; Physical SMS gateway hardware control (send SMS, read/write IMEI, switch SIM, port status, reboot)</li>
                        </ul>
                        <p class="mt-2">Workers communicate via <span class="text-white font-medium">Cloudflare Service Bindings</span> (worker-to-worker calls). The dashboard is the main hub that proxies actions to specialized workers.</p>
                        <div class="bg-dark-900 rounded-lg p-4 mt-3 font-mono text-xs text-gray-400 border border-dark-600">
                            <pre>Dashboard (hub)
  |-- bulk-activator      Bulk SIM activation via Helix
  |-- details-finalizer   Finalize provisioning SIMs (get phone numbers)
  |-- mdn-rotator         MDN rotation, Fix SIM, IMEI operations, sim-action dispatcher
  |     |-- FIX_SIM_QUEUE   (Cloudflare Queue, batch=1, concurrency=1)
  |     |-- MDN_QUEUE        (Cloudflare Queue, batch=10, concurrency=1)
  |     |-- skyline-gateway  (service binding for hardware control)
  |-- sim-canceller       Cancel SIMs via Helix
  |-- sim-status-changer  Suspend / Restore SIMs via Helix
  |-- phone-number-sync   Sync phone numbers from Helix to DB
  |-- reseller-sync       Webhook notifications to resellers (number.online)
  |-- skyline-gateway     Gateway hardware proxy (via Supabase Edge Function bridge)
  |-- quickbooks          QBO OAuth + invoice API
  |-- ota-status-sync     Cron: sync SIM statuses from Helix (every 12h)
  |-- sms-ingest          Receives incoming SMS from physical gateways</pre>
                        </div>
                    </div>
                </div>

                <!-- SIMs Page -->
                <div id="guide-sims" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">SIMs Page</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>The SIMs page displays all SIM cards in the system with filtering, sorting, and bulk actions.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Filters</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">Status</span> &mdash; Filter by SIM status (active, provisioning, error, canceled, suspended)</li>
                                <li><span class="text-white">Reseller</span> &mdash; Filter by assigned reseller</li>
                                <li><span class="text-white">Search</span> &mdash; Free text search across ICCID, phone number, subscription ID</li>
                                <li><span class="text-white">Hide Cancelled</span> &mdash; Toggle to exclude canceled SIMs from the table</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Caching</h4>
                            <p>SIM data is cached client-side for <span class="text-white">30 minutes</span>. The Refresh button or changing filters force-reloads from the server. The cache timestamp is shown in the header.</p>
                        </div>
                        <div class="mt-4">
                            <h4 class="text-white font-medium mb-2">Column Data Sources</h4>
                            <p class="mb-2">Each column in the SIMs table is populated from a specific source. Understanding this helps diagnose stale or missing data.</p>
                            <table class="w-full text-xs border-collapse">
                                <thead>
                                    <tr class="border-b border-dark-500">
                                        <th class="text-left py-1.5 pr-4 text-gray-400 font-medium w-28">Column</th>
                                        <th class="text-left py-1.5 pr-4 text-gray-400 font-medium w-40">Source</th>
                                        <th class="text-left py-1.5 text-gray-400 font-medium">Written by / When</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-dark-700">
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">ID</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.id</td>
                                        <td class="py-1.5 text-gray-300">Auto-incremented primary key. Set when the SIM row is first inserted (bulk-activator or manual).</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Gateway</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.gateway_id &rarr; gateways.code</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">sms-ingest</strong>: updated every time an inbound SMS arrives from a port &mdash; the MAC address in the webhook is resolved to a gateway. Also updated by fix-sim / retry-activation when scanning gateways for the ICCID.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">ICCID</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.iccid</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">bulk-activator</strong>: written at activation time from the CSV upload. Never changed after that (changing ICCID requires a separate Helix API call).</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Phone (MDN)</td>
                                        <td class="py-1.5 pr-4 text-accent">sim_numbers.e164<br/>(valid_to IS NULL)</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">mdn-rotator</strong>: inserts a new row in <code class="bg-dark-900 px-1 rounded">sim_numbers</code> after each rotation; sets <code class="bg-dark-900 px-1 rounded">valid_to</code> on the old row. The current MDN is always the row with <code class="bg-dark-900 px-1 rounded">valid_to = null</code>. Initially set by bulk-activator from Helix subscriber details post-activation.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Status</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.status</td>
                                        <td class="py-1.5 text-gray-300">Written by multiple workers: <strong class="text-white">bulk-activator</strong> &rarr; <code class="bg-dark-900 px-1 rounded">provisioning</code>; <strong class="text-white">details-finalizer</strong> &rarr; <code class="bg-dark-900 px-1 rounded">active</code> when Helix confirms; <strong class="text-white">ota-status-sync</strong> &rarr; syncs every 12 h from Helix; <strong class="text-white">mdn-rotator</strong> / <strong class="text-white">dashboard</strong> actions update on cancel/resume/OTA outcomes.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Sub ID</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.mobility_subscription_id</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">bulk-activator</strong>: after Helix activation, calls <code class="bg-dark-900 px-1 rounded">subscriber/details</code> for each returned sub ID to confirm the matching ICCID, then writes here. Clicking the Sub ID queries Helix live via the dashboard proxy.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Port</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.port</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">sms-ingest</strong>: updated on every inbound SMS from the port field in the Skyline webhook payload (converted from dot-notation to letter format, e.g. <code class="bg-dark-900 px-1 rounded">06.01</code> &rarr; <code class="bg-dark-900 px-1 rounded">6A</code>). Also set during fix-sim / retry-activation / manual slot picker.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Reseller</td>
                                        <td class="py-1.5 pr-4 text-accent">reseller_sims.reseller_id<br/>(active = true)</td>
                                        <td class="py-1.5 text-gray-300">Written by the <strong class="text-white">dashboard</strong> Assign Reseller action (per-row or bulk). A SIM can have multiple historical rows in <code class="bg-dark-900 px-1 rounded">reseller_sims</code>; only the row with <code class="bg-dark-900 px-1 rounded">active=true</code> is shown.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">SMS (24 h)</td>
                                        <td class="py-1.5 pr-4 text-accent">get_sms_counts_24h() RPC</td>
                                        <td class="py-1.5 text-gray-300">Aggregated live from the <code class="bg-dark-900 px-1 rounded">sms_messages</code> table by a Supabase RPC on every page load. Count and last-received timestamp for the last 24 hours. Written by <strong class="text-white">sms-ingest</strong> when messages arrive.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Last Rotated</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.last_mdn_rotated_at</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">mdn-rotator</strong>: written after each successful MDN rotation (both cron and manual). Used by the rotator itself to skip SIMs already rotated today.</td>
                                    </tr>
                                    <tr>
                                        <td class="py-1.5 pr-4 text-white font-mono">Activated</td>
                                        <td class="py-1.5 pr-4 text-accent">sims.activated_at</td>
                                        <td class="py-1.5 text-gray-300"><strong class="text-white">details-finalizer</strong>: set once when the SIM transitions to <code class="bg-dark-900 px-1 rounded">active</code> status. Never overwritten after that.</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Per-Row Actions (dropdown menu on each SIM)</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">OTA Refresh</span> &mdash; Send over-the-air network profile refresh</li>
                                <li><span class="text-white">Rotate MDN</span> &mdash; Change the phone number on the SIM</li>
                                <li><span class="text-white">Fix SIM</span> &mdash; Full repair cycle (IMEI swap + Cancel/Resume + OTA)</li>
                                <li><span class="text-white">Cancel</span> &mdash; Cancel the SIM subscription</li>
                                <li><span class="text-white">Resume</span> &mdash; Resume a canceled SIM</li>
                                <li><span class="text-white">Send SMS</span> &mdash; Send a test SMS from this SIM's gateway port</li>
                                <li><span class="text-white">Change IMEI</span> &mdash; Swap to a new IMEI (from pool or manual)</li>
                                <li><span class="text-white">Retry Activation</span> &mdash; Retry a failed activation on Helix</li>
                                <li><span class="text-white">Assign Reseller</span> &mdash; Link SIM to a reseller</li>
                                <li><span class="text-white">Unassign Reseller</span> &mdash; Remove reseller assignment</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Bulk Actions (select via checkboxes)</h4>
                            <p>Select multiple SIMs using checkboxes, then use the bulk action buttons. Supported: OTA Refresh, Rotate MDN, Fix SIM, Cancel, Resume, Unassign Reseller, Send SMS.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">SIM ID Click</h4>
                            <p>Clicking a SIM's ID opens a modal showing all Helix API log entries for that SIM (looked up by ICCID). Useful for debugging API call history.</p>
                        </div>
                    </div>
                </div>

                <!-- Fix SIM -->
                <div id="guide-fix-sim" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Fix SIM &mdash; Full Repair Cycle</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Fix SIM is the most complex operation. It performs a full repair cycle on a problematic SIM by swapping the IMEI, cycling the carrier status, and refreshing the network profile.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">How it works</h4>
                            <ol class="list-decimal list-inside space-y-2 ml-2">
                                <li>Dashboard sends <code class="bg-dark-900 px-1 rounded text-accent">POST /api/sim-action</code> with <code class="bg-dark-900 px-1 rounded text-accent">action: "fix"</code> to the mdn-rotator worker</li>
                                <li>mdn-rotator resolves the SIM's gateway and port (auto-scans all gateways if not set)</li>
                                <li>Job is queued to <span class="text-white font-medium">FIX_SIM_QUEUE</span> (Cloudflare Queue) to avoid the 30-second service-binding timeout</li>
                                <li>Queue consumer processes the job:
                                    <ol class="list-[lower-alpha] list-inside ml-4 mt-1 space-y-1">
                                        <li>Gets subscriber details from Helix (MDN + BAN)</li>
                                        <li><span class="text-amber-400 font-medium">Step 1: Cancel</span> &mdash; Cancels the subscriber on Helix (reason: CAN, code 1). Retries up to 3 times with <code class="bg-dark-900 px-1 rounded text-accent">retryUntilFulfilled</code></li>
                                        <li>Waits 10 seconds</li>
                                        <li><span class="text-green-400 font-medium">Step 2: Resume On Cancel</span> &mdash; Resumes the subscriber (reason: BBL, code 20). Retries up to 3 times</li>
                                        <li>Waits 5 seconds</li>
                                        <li><span class="text-blue-400 font-medium">Step 3: IMEI Swap</span> &mdash; Retires the old IMEI pool entry, allocates a new IMEI from the pool, checks eligibility with Helix, changes IMEI on Helix, sets IMEI on the physical gateway via SkyLine</li>
                                        <li><span class="text-purple-400 font-medium">Step 4: OTA Refresh</span> &mdash; Sends over-the-air refresh via Helix to re-provision the network profile</li>
                                    </ol>
                                </li>
                            </ol>
                        </div>
                        <div class="mt-3">
                            <h4 class="text-white font-medium mb-1">If it fails</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li>Each Helix call uses <code class="bg-dark-900 px-1 rounded text-accent">retryUntilFulfilled</code> which polls the response until the status shows "fulfilled" (up to 3 attempts with delays)</li>
                                <li>If any step fails, the error is logged to <span class="text-white">system_errors</span> table and the SIM status is set to <span class="text-red-400">error</span></li>
                                <li>The queue has max 2 retries &mdash; if it fails twice, the message is dead-lettered</li>
                                <li>Check the Errors page for details. Click the SIM ID to view the full Helix API request/response log</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <!-- MDN Rotation -->
                <div id="guide-mdn-rotation" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">MDN Rotation (Phone Number Change)</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>MDN rotation changes the phone number (MDN/CTN) on a SIM. This runs automatically every night and can also be triggered manually.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Nightly Cron (automatic)</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Cron fires every 20 min from <span class="text-white font-medium">midnight to noon EST</span> (05:00&ndash;17:00 UTC) on the mdn-rotator worker</li>
                                <li>All SIMs with status <code class="bg-dark-900 px-1 rounded text-accent">active</code> are queued to <span class="text-white font-medium">MDN_QUEUE</span></li>
                                <li>Queue processes batches of 10, concurrency 1 (sequential batches)</li>
                                <li>For each SIM:
                                    <ol class="list-[lower-alpha] list-inside ml-4 mt-1 space-y-1">
                                        <li>Calls Helix MDN change endpoint (<code class="bg-dark-900 px-1 rounded text-accent">PATCH /api/mobility-subscriber/ctn</code>) with the subscription ID</li>
                                        <li>Polls subscriber details until a new phone number appears</li>
                                        <li>Closes old phone number in DB (sets <code class="bg-dark-900 px-1 rounded text-accent">valid_to</code> timestamp)</li>
                                        <li>Inserts new phone number in <code class="bg-dark-900 px-1 rounded text-accent">sim_numbers</code></li>
                                        <li>Updates <code class="bg-dark-900 px-1 rounded text-accent">last_mdn_rotated_at</code> on the SIM record</li>
                                        <li>Sends <code class="bg-dark-900 px-1 rounded text-accent">number.online</code> webhook to the assigned reseller</li>
                                    </ol>
                                </li>
                            </ol>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Manual rotation</h4>
                            <p>Click <span class="text-white">Rotate MDN</span> on a SIM row, or use the bulk action. The same flow runs but only for the selected SIM(s).</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">If it fails</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li>Queue has max 3 retries per message</li>
                                <li>After all retries fail, error is logged to <span class="text-white">system_errors</span></li>
                                <li>At <span class="text-white font-medium">07:00 UTC</span>, a separate cron sends an error summary to Slack listing all failed SIMs</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <!-- OTA Refresh -->
                <div id="guide-ota-refresh" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">OTA Refresh</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>OTA (Over-The-Air) refresh sends a network profile update to the SIM via the carrier. This is useful when a SIM has connectivity issues after an IMEI change or MDN rotation.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Steps</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Dashboard sends <code class="bg-dark-900 px-1 rounded text-accent">action: "ota_refresh"</code> to mdn-rotator</li>
                                <li>Worker gets subscriber details from Helix to obtain the <span class="text-white">attBan</span>, <span class="text-white">subscriberNumber</span> (MDN), and <span class="text-white">iccid</span></li>
                                <li>Calls Helix OTA endpoint (<code class="bg-dark-900 px-1 rounded text-accent">PATCH /api/mobility-subscriber/ota</code>) with those three fields</li>
                                <li>Helix pushes the updated profile to the SIM over the air</li>
                            </ol>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Status update</h4>
                            <p>The OTA response includes the current subscriber status. If the status is <span class="text-yellow-400">Suspended</span> or <span class="text-red-400">Canceled</span>, the SIM status in DB is automatically updated to match. This means running OTA on a suspended SIM will correctly reflect <code class="bg-dark-900 px-1 rounded text-accent">suspended</code> in the dashboard.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">When to use</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li>SIM not connecting to network after IMEI change</li>
                                <li>SIM not receiving SMS after MDN rotation</li>
                                <li>General connectivity troubleshooting</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Failure: data_mismatch</h4>
                            <p>If Helix rejects the OTA request with <span class="text-red-400">"The sim number does not match our records"</span>, the SIM status is automatically set to <code class="bg-dark-900 px-1 rounded text-yellow-400">data_mismatch</code>. This means the subscriber number (MDN) stored in Helix no longer matches what is on record &mdash; typically caused by an out-of-band MDN change. To recover: verify the correct MDN via Helix subscriber details, update the DB record, then retry OTA.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Failure: helix_timeout</h4>
                            <p>If Helix rejects the OTA request with <span class="text-red-400">"The requested subscription does not belong to the user."</span>, the SIM status is automatically set to <code class="bg-dark-900 px-1 rounded text-orange-400">helix_timeout</code>. This means Helix cannot locate the subscription under the current account &mdash; typically caused by a subscription being transferred, cancelled on the carrier side, or a credentials mismatch. Investigate the subscription in Helix directly.</p>
                        </div>
                    </div>
                </div>

                <!-- Cancel / Resume -->
                <div id="guide-cancel-resume" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Cancel / Resume</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <div>
                            <h4 class="text-white font-medium mb-1">Cancel</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Dashboard sends ICCIDs to the <span class="text-white font-medium">sim-canceller</span> worker</li>
                                <li>For each SIM: gets subscriber details (MDN) from Helix</li>
                                <li>Calls Helix status change: <code class="bg-dark-900 px-1 rounded text-accent">subscriberState: "Cancel"</code>, reason code <code class="bg-dark-900 px-1 rounded text-accent">CAN</code> (ID 1)</li>
                                <li>Updates SIM status to <span class="text-red-400">canceled</span> in DB</li>
                                <li>Expires current phone number (sets <code class="bg-dark-900 px-1 rounded text-accent">valid_to</code>)</li>
                                <li>Sends <code class="bg-dark-900 px-1 rounded text-accent">sim.cancelled</code> webhook to the assigned reseller</li>
                            </ol>
                        </div>
                        <div class="mt-3">
                            <h4 class="text-white font-medium mb-1">Resume</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Dashboard sends the action to the <span class="text-white font-medium">mdn-rotator</span> worker (<code class="bg-dark-900 px-1 rounded text-accent">action: "resume"</code>)</li>
                                <li>Gets subscriber details from Helix</li>
                                <li>Calls Helix status change: <code class="bg-dark-900 px-1 rounded text-accent">subscriberState: "Resume On Cancel"</code>, reason code <code class="bg-dark-900 px-1 rounded text-accent">BBL</code> (ID 20)</li>
                                <li>Updates SIM status to <span class="text-green-400">active</span> in DB</li>
                                <li>Re-fetches subscriber details and inserts new phone number into <code class="bg-dark-900 px-1 rounded text-accent">sim_numbers</code></li>
                            </ol>
                        </div>
                    </div>
                </div>

                <!-- Change IMEI -->
                <div id="guide-change-imei" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Change IMEI</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Swaps the IMEI associated with a SIM, both on the carrier side (Helix) and the physical gateway (SkyLine).</p>
                        <ol class="list-decimal list-inside space-y-1 ml-2">
                            <li>Dashboard sends <code class="bg-dark-900 px-1 rounded text-accent">action: "change_imei"</code> to mdn-rotator with optional <code class="bg-dark-900 px-1 rounded text-accent">imei</code> (manual) or <code class="bg-dark-900 px-1 rounded text-accent">auto_imei: true</code> (from pool)</li>
                            <li>Retires all existing <code class="bg-dark-900 px-1 rounded text-accent">in_use</code> IMEI pool entries for this SIM</li>
                            <li>If auto: allocates next available IMEI from pool. If manual: uses the provided IMEI</li>
                            <li>Checks IMEI eligibility with Helix (<code class="bg-dark-900 px-1 rounded text-accent">GET /api/mobility-eligibility/imei</code>)</li>
                            <li>Sets IMEI on the physical gateway port via SkyLine API</li>
                            <li>Updates/upserts the IMEI pool entry (gateway, port, sim_id, status=in_use)</li>
                            <li>Changes IMEI on Helix (<code class="bg-dark-900 px-1 rounded text-accent">PATCH /api/mobility-sub-ops/imei-plan</code>) using <code class="bg-dark-900 px-1 rounded text-accent">retryUntilFulfilled</code></li>
                            <li>Updates the SIM record with the new IMEI and pool entry ID</li>
                        </ol>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">If eligibility fails</h4>
                            <p>The IMEI is marked as <span class="text-red-400">retired</span> in the pool and a new one is tried (when using auto). The error is logged.</p>
                        </div>
                    </div>
                </div>

                <!-- Retry Activation -->
                <div id="guide-retry-activation" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Retry Activation</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Retries a failed activation on Helix. The SIM must have a <code class="bg-dark-900 px-1 rounded text-accent">mobility_subscription_id</code> and the subscription must be in <span class="text-red-400">ACTIVATION_FAILED</span> status on the Helix side.</p>
                        <ol class="list-decimal list-inside space-y-1 ml-2">
                            <li>Dashboard sends <code class="bg-dark-900 px-1 rounded text-accent">action: "retry_activation"</code> to mdn-rotator</li>
                            <li>Worker calls Helix retry endpoint (<code class="bg-dark-900 px-1 rounded text-accent">PATCH /api/mobility-activation/activate/{subscriptionId}</code>) with corrected ICCID/IMEI</li>
                            <li>On success, SIM status is set back to <span class="text-yellow-400">provisioning</span></li>
                            <li>The details-finalizer will later pick it up and finalize (get phone number, set to active)</li>
                        </ol>
                    </div>
                </div>

                <!-- Bulk Activation -->
                <div id="guide-bulk-activate" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Bulk Activation</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Activates multiple new SIM cards at once via the Helix bulk activation API.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Two input modes</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">CSV mode</span> (<code class="bg-dark-900 px-1 rounded text-accent">GET /run</code>) &mdash; Fetches a Google Sheet CSV with columns: iccid, imei, reseller_id, status. Only rows with status "pending" are processed.</li>
                                <li><span class="text-white">JSON mode</span> (<code class="bg-dark-900 px-1 rounded text-accent">POST /activate</code>) &mdash; Receives <code class="bg-dark-900 px-1 rounded text-accent">{sims: [{iccid, imei, reseller_id}]}</code> directly.</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Steps</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Validates all input rows (must have valid iccid, imei, reseller_id)</li>
                                <li>Skips ICCIDs that already have a <code class="bg-dark-900 px-1 rounded text-accent">mobility_subscription_id</code> (already activated)</li>
                                <li>Gets Helix bearer token</li>
                                <li>Sends all SIMs in one call to Helix bulk endpoint (<code class="bg-dark-900 px-1 rounded text-accent">POST /api/mobility-sub-ops/subscription</code>)</li>
                                <li><span class="text-yellow-300 font-medium">ICCID resolution</span>: the bulk response returns only <code class="bg-dark-900 px-1 rounded text-accent">mobilitySubscriptionId</code>s &mdash; no ICCIDs, and Helix does not guarantee response order matches request order. The worker immediately calls <code class="bg-dark-900 px-1 rounded text-accent">POST /api/mobility-subscriber/details</code> for all successful sub IDs to get the authoritative ICCID for each from Helix, then writes to DB using those ICCIDs.</li>
                                <li>For each successful activation: upserts SIM record with status <span class="text-yellow-400">provisioning</span>, assigns to reseller</li>
                                <li>For failed items: logs error and sets SIM status to <span class="text-red-400">error</span> (failed items do include ICCID in the response)</li>
                            </ol>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Why ICCID resolution matters</h4>
                            <p>Positional matching (pairing the Nth sub ID to the Nth ICCID we sent) caused SIMs 417&ndash;424 to have their ICCIDs shifted by one position after a bulk run. The fix: always confirm ICCID ownership via <code class="bg-dark-900 px-1 rounded text-accent">subscriber_details</code> before writing to DB. Logged as step <code class="bg-dark-900 px-1 rounded text-accent">post_activation_details</code> in Helix API Logs.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">After activation</h4>
                            <p>New SIMs start in <span class="text-yellow-400">provisioning</span> status. The <span class="text-white font-medium">details-finalizer</span> worker runs on a cron schedule to poll Helix for the assigned phone number and move the SIM to <span class="text-green-400">active</span>.</p>
                        </div>
                    </div>
                </div>

                <!-- Send SMS -->
                <div id="guide-send-sms" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Send SMS</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Sends an outbound SMS from the physical gateway port associated with a SIM.</p>
                        <ol class="list-decimal list-inside space-y-1 ml-2">
                            <li>Dashboard resolves the SIM's <code class="bg-dark-900 px-1 rounded text-accent">gateway_id</code> and <code class="bg-dark-900 px-1 rounded text-accent">port</code> from the database</li>
                            <li>Sends the request to <span class="text-white font-medium">skyline-gateway</span> worker at <code class="bg-dark-900 px-1 rounded text-accent">/send-sms</code></li>
                            <li>Skyline-gateway loads gateway credentials from DB, authenticates with the device</li>
                            <li>Sends the SMS via the Supabase Edge Function bridge (skyline-bridge) to the physical device</li>
                            <li>The gateway transmits the SMS from the specified port's SIM card</li>
                        </ol>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Bulk Send SMS</h4>
                            <p>Select multiple SIMs and use the bulk Send SMS action. Sends a test SMS from each selected SIM sequentially.</p>
                        </div>
                    </div>
                </div>

                <!-- Incoming SMS -->
                <div id="guide-sms-ingest" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Incoming SMS (sms-ingest)</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>The sms-ingest worker receives incoming SMS messages from the physical gateways and routes them to the correct reseller.</p>
                        <ol class="list-decimal list-inside space-y-1 ml-2">
                            <li>Gateway pushes incoming SMS to sms-ingest via HTTP (two formats supported: JSON <code class="bg-dark-900 px-1 rounded text-accent">recv-sms</code> or raw octet-stream)</li>
                            <li>Worker authenticates the request via header/query/path secret</li>
                            <li>Parses the SMS body (base64 decodes if JSON format)</li>
                            <li>Resolves the SIM by ICCID or phone number lookup</li>
                            <li>Auto-links the SIM to the gateway port &mdash; updates <code class="bg-dark-900 px-1 rounded text-accent">port</code> and <code class="bg-dark-900 px-1 rounded text-accent">gateway_id</code> on the SIM using the MAC address in the webhook</li>
                            <li>Generates a deduplication message ID (SHA-256 hash of from+to+body+timestamp)</li>
                            <li>Inserts the message into <code class="bg-dark-900 px-1 rounded text-accent">inbound_sms</code> table</li>
                            <li>Sends webhook to the SIM's assigned reseller (up to 5 retries with exponential backoff)</li>
                            <li>Records delivery result in <code class="bg-dark-900 px-1 rounded text-accent">webhook_deliveries</code> table</li>
                        </ol>
                        <div class="mt-3 p-3 bg-dark-900 rounded-lg border border-dark-500">
                            <h4 class="text-white font-medium mb-1">Port Conflict Resolution</h4>
                            <p>The gateway is the physical source of truth for which SIM occupies a slot. If the incoming SMS reports an ICCID on a port that the DB already attributes to a <em>different</em> SIM, sms-ingest will:</p>
                            <ol class="list-decimal list-inside space-y-1 ml-2 mt-1">
                                <li>Clear <code class="bg-dark-900 px-1 rounded text-accent">port</code> and <code class="bg-dark-900 px-1 rounded text-accent">gateway_id</code> on the old SIM (logged as <span class="text-yellow-400">Evicted SIM X from slot Y/Z</span>)</li>
                                <li>Assign the slot to the SIM whose ICCID just sent the SMS</li>
                            </ol>
                            <p class="mt-1">This handles cases where a physical SIM card is replaced in a hardware slot without a corresponding DB update (e.g. after a <span class="text-orange-400">helix_timeout</span> SIM is swapped out).</p>
                        </div>
                    </div>
                </div>

                <!-- Workers Page -->
                <div id="guide-workers" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Workers Page</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Manual trigger buttons for running workers on demand (normally they run on cron schedules).</p>
                        <ul class="list-disc list-inside space-y-1 ml-2">
                            <li><span class="text-white">Activate SIMs (Bulk)</span> &mdash; Triggers the bulk-activator to process pending rows from the CSV</li>
                            <li><span class="text-white">Finalize Details</span> &mdash; Runs details-finalizer to fetch phone numbers for provisioning SIMs</li>
                            <li><span class="text-white">Rotate Numbers</span> &mdash; Manually triggers nightly MDN rotation for all active SIMs</li>
                            <li><span class="text-white">Sync Phone Numbers</span> &mdash; Runs phone-number-sync to reconcile phone numbers from Helix to the DB</li>
                        </ul>
                    </div>
                </div>

                <!-- Gateway Page -->
                <div id="guide-gateway" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Gateway Page</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Displays real-time status of physical SMS gateway hardware. Shows each port's SIM status, signal strength, ICCID, IMEI, operator, and phone number.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Gateway types</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">Gateway 64-1</span> &mdash; 64 ports x 1 SIM slot = 64 SIM slots</li>
                                <li><span class="text-white">Gateway 512-1</span> &mdash; 64 ports x 8 SIM slots = 512 SIM slots (8 SIMs rotate per port, only 1 active at a time per cellular module)</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Per-port actions</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">Lock</span> &mdash; Locks the port to prevent SIM switching</li>
                                <li><span class="text-white">Unlock</span> &mdash; Unlocks the port for SIM switching</li>
                                <li><span class="text-white">Reboot</span> &mdash; Reboots the port's cellular module</li>
                                <li><span class="text-white">Reset</span> &mdash; Factory resets the port configuration</li>
                                <li><span class="text-white">Switch SIM</span> &mdash; Triggers SIM rotation on multi-slot ports</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">How gateway communication works</h4>
                            <p>The <span class="text-white">skyline-gateway</span> worker cannot reach the physical gateway directly (Cloudflare Workers can't access local IPs). It uses a <span class="text-white">Supabase Edge Function bridge</span> (<code class="bg-dark-900 px-1 rounded text-accent">skyline-bridge</code>) to proxy requests from the cloud to the gateway's local network.</p>
                        </div>
                    </div>
                </div>

                <!-- IMEI Pool -->
                <div id="guide-imei-pool" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">IMEI Pool</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Manages the inventory of IMEI numbers used across all SIM slots. Each gateway port/slot needs a unique IMEI registered with the carrier.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">IMEI statuses</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-green-400 font-medium">available</span> &mdash; Stock IMEI ready for assignment. Gets picked when Fix SIM or Change IMEI runs.</li>
                                <li><span class="text-blue-400 font-medium">in_use</span> &mdash; Currently assigned to a gateway port/slot and linked to a SIM.</li>
                                <li><span class="text-red-400 font-medium">retired</span> &mdash; Carrier rejected or permanently removed. Will never be reused.</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Stats</h4>
                            <p><span class="text-white">Slots</span> = total gateway slots (576). <span class="text-white">In Use</span> should match Slots. <span class="text-white">Available</span> = spare stock. <span class="text-white">Retired</span> = burned IMEIs.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Actions</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">Retire</span> &mdash; Moves an available or in_use IMEI to retired status</li>
                                <li><span class="text-white">Restore</span> &mdash; Moves a retired IMEI back to available</li>
                                <li><span class="text-white">Check IMEI</span> &mdash; Verifies eligibility with the carrier (Helix) for a specific plan</li>
                                <li><span class="text-white">Fix Incompatible IMEI</span> &mdash; Retires an incompatible IMEI and assigns a new one from the pool</li>
                                <li><span class="text-white">Fix Slot</span> &mdash; Reconciles a slot's IMEI between the pool, gateway, and carrier</li>
                                <li><span class="text-white">Import Gateway IMEIs</span> &mdash; Reads all IMEIs from a physical gateway and imports them into the pool</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <!-- Errors Page -->
                <div id="guide-errors" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Errors Page</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Centralized error tracking from all workers and SIM operations.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Error sources</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">system_errors table</span> &mdash; Errors logged by workers (mdn-rotator, bulk-activator, etc.) with full request/response details</li>
                                <li><span class="text-white">SIM last_activation_error</span> &mdash; Legacy activation errors stored directly on the SIM record</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Columns</h4>
                            <p>Source (which worker), ICCID, Error message, Severity, Status (open/resolved), Time.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Actions</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white">View</span> &mdash; Opens detail modal with full error context, Helix API request/response payloads</li>
                                <li><span class="text-white">Resolve</span> &mdash; Marks error as resolved (updates status in DB)</li>
                                <li><span class="text-white">OTA Refresh</span> &mdash; Quick-action to send OTA refresh for the affected SIM</li>
                                <li><span class="text-white">Bulk Resolve</span> &mdash; Select multiple errors and resolve them at once</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Slack notifications</h4>
                            <p>At <span class="text-white font-medium">07:00 UTC</span> daily, the mdn-rotator sends an error summary to Slack listing all unresolved errors from the last rotation run.</p>
                        </div>
                    </div>
                </div>

                <!-- Billing Page -->
                <div id="guide-billing" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Billing Page</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>Generates invoices as a CSV file you can import directly into QuickBooks Online. No OAuth connection required.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Setup — Customer Rates</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Click <span class="text-white">+ Add</span> in the Customer Rates section</li>
                                <li>Select the reseller, enter the customer name <span class="text-gray-400">(must match exactly how it appears in QuickBooks)</span>, and set the daily rate per SIM</li>
                                <li>Save — repeat for each reseller you bill</li>
                            </ol>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Generating an Invoice</h4>
                            <ol class="list-decimal list-inside space-y-1 ml-2">
                                <li>Select a reseller and date range (From / To)</li>
                                <li>Click <span class="text-white">Preview</span> — shows a breakdown of billable SIM-days (SIMs with SMS activity per EST calendar day)</li>
                                <li>Click <span class="text-white">Download for QuickBooks</span> to get a <code class="bg-dark-900 px-1 rounded text-accent">.csv</code> file</li>
                                <li>In QuickBooks Online: go to <span class="text-white">Invoices &rarr; Import</span> and upload the CSV</li>
                                <li>The invoice is recorded in Invoice History with a re-download link</li>
                            </ol>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">CSV Format</h4>
                            <p>Each row is one billing day. Columns: <code class="bg-dark-900 px-1 rounded text-accent">InvoiceNo, Customer, InvoiceDate, DueDate, Terms, ServiceDate, ProductService, Description, Qty, Rate, Amount</code>. Service item is <span class="text-white">US Business phone Rental</span>. Invoice date = end of period. Terms = Due on receipt. InvoiceNo is repeated on every row.</p>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Billing Logic</h4>
                            <p>A SIM is billable on a given EST date if it had at least 1 incoming SMS that day (<code class="bg-dark-900 px-1 rounded text-accent">sim_sms_daily.sms_count &gt; 0</code>). Each billable SIM counts as 1 unit at the configured daily rate.</p>
                        </div>
                    </div>
                </div>

                <!-- Reseller Webhooks -->
                <div id="guide-reseller-webhooks" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Reseller Webhooks</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>The system sends webhook notifications to resellers for key events.</p>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Webhook events</h4>
                            <ul class="list-disc list-inside space-y-1 ml-2">
                                <li><span class="text-white font-medium">number.online</span> &mdash; Sent after MDN rotation when a new phone number is verified and ready. Includes the phone number, ICCID, and <code class="bg-dark-900 px-1 rounded text-accent">online_until</code> timestamp (next 05:00 UTC rotation).</li>
                                <li><span class="text-white font-medium">sms.received</span> &mdash; Sent when an incoming SMS is received for a SIM assigned to the reseller. Includes from/to numbers, message body, and dedup message_id.</li>
                                <li><span class="text-white font-medium">sim.cancelled</span> &mdash; Sent when a SIM is canceled.</li>
                                <li><span class="text-white font-medium">sim.suspended</span> &mdash; Sent when a SIM is suspended.</li>
                                <li><span class="text-white font-medium">sim.restored</span> &mdash; Sent when a suspended SIM is restored.</li>
                            </ul>
                        </div>
                        <div class="mt-2">
                            <h4 class="text-white font-medium mb-1">Delivery</h4>
                            <p>Webhooks include a <code class="bg-dark-900 px-1 rounded text-accent">message_id</code> for deduplication. Failed deliveries retry up to 5 times with exponential backoff. All deliveries are recorded in <code class="bg-dark-900 px-1 rounded text-accent">webhook_deliveries</code> table.</p>
                        </div>
                    </div>
                </div>

                <!-- SIM Status Reference -->
                <div id="guide-statuses" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">SIM Status Reference</h3>
                    <div class="text-sm text-gray-300">
                        <div class="overflow-x-auto">
                            <table class="w-full">
                                <thead>
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-4 py-3 font-medium">Status</th>
                                        <th class="px-4 py-3 font-medium">Meaning</th>
                                        <th class="px-4 py-3 font-medium">Transitions To</th>
                                    </tr>
                                </thead>
                                <tbody class="text-sm">
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-yellow-400 font-medium">provisioning</span></td>
                                        <td class="px-4 py-3">SIM activated on Helix, waiting for phone number assignment</td>
                                        <td class="px-4 py-3">active, error</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-green-400 font-medium">active</span></td>
                                        <td class="px-4 py-3">Fully operational with assigned phone number</td>
                                        <td class="px-4 py-3">canceled, suspended, error</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-red-400 font-medium">canceled</span></td>
                                        <td class="px-4 py-3">Subscription cancelled on carrier</td>
                                        <td class="px-4 py-3">active (via Resume)</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-orange-400 font-medium">suspended</span></td>
                                        <td class="px-4 py-3">Temporarily suspended (billing or manual)</td>
                                        <td class="px-4 py-3">active (via Restore)</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-red-400 font-medium">error</span></td>
                                        <td class="px-4 py-3">Operation failed, needs manual intervention</td>
                                        <td class="px-4 py-3">active (via Fix SIM or manual fix)</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-yellow-300 font-medium">data_mismatch</span></td>
                                        <td class="px-4 py-3">OTA refresh rejected by Helix &mdash; subscriber number does not match carrier records. MDN in DB may be stale.</td>
                                        <td class="px-4 py-3">active (after correcting MDN + retrying OTA)</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3"><span class="text-orange-400 font-medium">helix_timeout</span></td>
                                        <td class="px-4 py-3">OTA refresh rejected &mdash; subscription does not belong to user. Helix cannot locate the subscription under the current account.</td>
                                        <td class="px-4 py-3">Investigate in Helix; no automatic recovery</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Helix Status Codes -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Helix Status Change Codes</h3>
                    <div class="text-sm text-gray-300">
                        <div class="overflow-x-auto">
                            <table class="w-full">
                                <thead>
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-4 py-3 font-medium">Action</th>
                                        <th class="px-4 py-3 font-medium">subscriberState</th>
                                        <th class="px-4 py-3 font-medium">reasonCode</th>
                                        <th class="px-4 py-3 font-medium">reasonCodeId</th>
                                    </tr>
                                </thead>
                                <tbody class="text-sm">
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3">Suspend</td>
                                        <td class="px-4 py-3"><code class="bg-dark-900 px-1 rounded text-accent">Suspend</code></td>
                                        <td class="px-4 py-3">CR</td>
                                        <td class="px-4 py-3">22</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3">Restore (unsuspend)</td>
                                        <td class="px-4 py-3"><code class="bg-dark-900 px-1 rounded text-accent">Unsuspend</code></td>
                                        <td class="px-4 py-3">CR</td>
                                        <td class="px-4 py-3">35</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3">Cancel</td>
                                        <td class="px-4 py-3"><code class="bg-dark-900 px-1 rounded text-accent">Cancel</code></td>
                                        <td class="px-4 py-3">CAN</td>
                                        <td class="px-4 py-3">1</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3">Resume (from cancel)</td>
                                        <td class="px-4 py-3"><code class="bg-dark-900 px-1 rounded text-accent">Resume On Cancel</code></td>
                                        <td class="px-4 py-3">BBL</td>
                                        <td class="px-4 py-3">20</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Cron Schedules -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">
                    <h3 class="text-lg font-semibold text-white mb-3">Cron Schedules</h3>
                    <div class="text-sm text-gray-300">
                        <div class="overflow-x-auto">
                            <table class="w-full">
                                <thead>
                                    <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                        <th class="px-4 py-3 font-medium">Time (UTC)</th>
                                        <th class="px-4 py-3 font-medium">Worker</th>
                                        <th class="px-4 py-3 font-medium">Action</th>
                                    </tr>
                                </thead>
                                <tbody class="text-sm">
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3 font-mono">00:00</td>
                                        <td class="px-4 py-3">ota-status-sync</td>
                                        <td class="px-4 py-3">Sync SIM statuses from Helix + OTA refresh all active SIMs</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3 font-mono">05:00</td>
                                        <td class="px-4 py-3">mdn-rotator</td>
                                        <td class="px-4 py-3">Nightly MDN rotation for all active SIMs</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3 font-mono">07:00</td>
                                        <td class="px-4 py-3">mdn-rotator</td>
                                        <td class="px-4 py-3">Send error summary to Slack</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3 font-mono">12:00</td>
                                        <td class="px-4 py-3">ota-status-sync</td>
                                        <td class="px-4 py-3">Second daily status sync from Helix</td>
                                    </tr>
                                    <tr class="border-b border-dark-700">
                                        <td class="px-4 py-3 font-mono">Periodic</td>
                                        <td class="px-4 py-3">details-finalizer</td>
                                        <td class="px-4 py-3">Finalize provisioning SIMs (get phone numbers from Helix)</td>
                                    </tr>
                                    <tr>
                                        <td class="px-4 py-3 font-mono">Periodic</td>
                                        <td class="px-4 py-3">reseller-sync</td>
                                        <td class="px-4 py-3">Send number.online webhooks to resellers for verified numbers</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- Auto IMEI Change (AT&T) -->
                <div id="guide-auto-imei-att" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">Auto IMEI Change (AT&amp;T Unsupported Device)</h3>
                    <div class="text-sm text-gray-300 space-y-3">
                        <p>When AT&amp;T flags a device IMEI as unsupported, it sends an SMS to the SIM&rsquo;s number. The <span class="text-white font-medium">sms-ingest</span> worker automatically detects this message and triggers a Change IMEI action.</p>
                        <p class="text-white font-medium">Detection</p>
                        <p>The SMS body is matched if it contains <em>both</em> of these phrases:</p>
                        <ul class="list-disc list-inside space-y-1 ml-2">
                            <li><code class="text-accent">no longer supported</code></li>
                            <li><code class="text-accent">Upgrade your device</code></li>
                        </ul>
                        <p class="text-white font-medium">What Happens</p>
                        <ol class="list-decimal list-inside space-y-1 ml-2">
                            <li>sms-ingest receives and stores the SMS as normal (both JSON and gateway paths).</li>
                            <li>If the SMS matches the AT&amp;T pattern and has a <code class="text-accent">sim_id</code>, a fire-and-forget <code class="text-accent">POST /sim-action</code> is sent to the <span class="text-white font-medium">mdn-rotator</span> worker via service binding.</li>
                            <li>mdn-rotator picks an available IMEI from the pool and writes it to the gateway via Skyline, then updates Helix.</li>
                        </ol>
                        <p class="text-white font-medium">Requirements</p>
                        <ul class="list-disc list-inside space-y-1 ml-2">
                            <li><code class="text-accent">MDN_ROTATOR</code> service binding configured in sms-ingest&rsquo;s wrangler.toml</li>
                            <li><code class="text-accent">ADMIN_RUN_SECRET</code> environment variable set for sms-ingest</li>
                        </ul>
                        <p class="text-white font-medium">Logs</p>
                        <p>Look for <code class="text-accent">[SMS] Auto IMEI change triggered for SIM &lt;id&gt;</code> in sms-ingest logs to confirm the trigger fired.</p>
                    </div>
                </div>

            </div>

            </div>
        </main>
    </div>

    <!-- Toast -->
    <div id="toast" class="hidden fixed bottom-4 right-4 px-6 py-4 rounded-lg shadow-lg max-w-md z-50">
        <p id="toast-message" class="text-sm"></p>
    </div>

    <!-- Fix SIM Modal -->
    <div id="fix-sim-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Fix SIM (IMEI + OTA + Cancel/Resume)</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter SIM IDs to fix (one per line):</p>
                <textarea id="fix-sim-input" rows="8" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="1"></textarea>
                <p class="text-xs text-gray-500 mt-2">Changes IMEI from pool, runs OTA Refresh, Cancel, Resume On Cancel</p>
                <div id="fix-sim-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Results:</h4>
                    <pre id="fix-sim-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-60 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideFixSimModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                <button onclick="fixSims()" id="fix-sim-btn" class="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition">Fix SIMs</button>
            </div>
        </div>
    </div>

    <!-- Add IMEIs Modal -->
    <div id="add-imei-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Add IMEIs to Pool</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter IMEIs to add (one per line, 15 digits each):</p>
                <textarea id="add-imei-input" rows="10" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="123456789012345"></textarea>
                <p class="text-xs text-gray-500 mt-2">Duplicates will be ignored automatically</p>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideAddImeiModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="addImeis()" id="add-imei-btn" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Add IMEIs</button>
            </div>
        </div>
    </div>

    <!-- Cancel Modal -->
    <div id="cancel-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Cancel SIMs</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter ICCIDs to cancel (one per line):</p>
                <textarea id="iccids-input" rows="8" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="89014103271467425631"></textarea>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideCancelModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="cancelSims()" class="px-4 py-2 text-sm bg-red-600 hover:bg-red-700 text-white rounded-lg transition">Cancel SIMs</button>
            </div>
        </div>
    </div>

    <!-- Suspend Modal -->
    <div id="suspend-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Suspend SIMs</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter SIM IDs to suspend (one per line):</p>
                <textarea id="suspend-input" rows="8" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="1"></textarea>
                <p class="text-xs text-gray-500 mt-2">Use SIM IDs from the dashboard table (first column)</p>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideSuspendModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="suspendSims()" class="px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Suspend SIMs</button>
            </div>
        </div>
    </div>

    <!-- Restore Modal -->
    <div id="restore-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Restore SIMs</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter SIM IDs to restore (one per line):</p>
                <textarea id="restore-input" rows="8" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="1"></textarea>
                <p class="text-xs text-gray-500 mt-2">Use SIM IDs from the dashboard table (first column)</p>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideRestoreModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="restoreSims()" class="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition">Restore SIMs</button>
            </div>
        </div>
    </div>

    <!-- Activate Modal -->
    <div id="activate-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Activate SIMs</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Paste from spreadsheet or enter one SIM per line:</p>
                <textarea id="activate-input" rows="10" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="89014103271467425631&#9;123456789012345&#9;1
89014103271467425632&#9;123456789012346&#9;1"></textarea>
                <p class="text-xs text-gray-500 mt-2">3 columns: ICCID (20 digits), IMEI (15 digits), Reseller ID — tab or comma separated</p>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideActivateModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="activateSims()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Activate SIMs</button>
            </div>
        </div>
    </div>

    <!-- Helix Query Modal -->
    <div id="helix-query-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">
            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>
                <button onclick="hideHelixQueryModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>
                <div id="helix-query-result" class="mt-4 hidden">
                    <div id="helix-db-update-banner" class="hidden mb-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                        <p class="text-xs font-semibold text-yellow-400 mb-1">&#x26A0; DB Auto-Synced — Line marked Cancelled</p>
                        <pre id="helix-db-update-output" class="text-xs font-mono text-yellow-300 whitespace-pre-wrap"></pre>
                    </div>
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>
                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
                <div id="helix-bulk-result" class="mt-4 hidden">
                    <div id="helix-bulk-summary" class="grid grid-cols-4 gap-2 mb-3"></div>
                    <div id="helix-bulk-changed" class="hidden">
                        <h4 class="text-sm font-medium text-gray-400 mb-2">Cancelled / Errors:</h4>
                        <pre id="helix-bulk-changed-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                    </div>
                    <div id="helix-bulk-more" class="hidden mt-3 flex justify-end">
                        <button id="helix-bulk-next-btn" onclick="queryHelixBulkNext()" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Run Next Batch</button>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-between items-center">
                <button onclick="queryHelixBulk()" id="helix-bulk-btn" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 border border-dark-500 text-gray-300 rounded-lg transition">Bulk Query All SIMs</button>
                <div class="flex gap-3">
                    <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                    <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Set Status Modal -->
    <div id="set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="set-status-title" class="text-lg font-semibold text-white">Set Status</h3>
                <button onclick="document.getElementById('set-status-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <select id="set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">
                    <option value="provisioning">provisioning</option>
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="canceled">canceled</option>
                    <option value="error">error</option>
                    <option value="pending">pending</option>
                    <option value="helix_timeout">helix_timeout</option>
                    <option value="data_mismatch">data_mismatch</option>
                </select>
                <div class="flex gap-2 justify-end">
                    <button onclick="document.getElementById('set-status-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg transition">Cancel</button>
                    <button onclick="runSetStatus()" class="px-4 py-2 text-sm bg-accent hover:bg-accent/80 text-white rounded-lg transition">Apply</button>
                </div>
            </div>
        </div>
    </div>

    <!-- SIM Action Modal -->
    <div id="sim-action-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="sim-action-title" class="text-lg font-semibold text-white">Action Result</h3>
                <button onclick="hideSimActionModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <div class="mb-4">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">API Response:</h4>
                    <pre id="sim-action-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600">Loading...</pre>
                </div>
                <!-- Helix API Logs section -->
                <div id="sim-action-logs-section" class="mt-6 border-t border-dark-600 pt-4 hidden">
                    <div class="flex items-center justify-between mb-3">
                        <h4 class="text-sm font-medium text-gray-300">Recent Helix API Logs</h4>
                        <button onclick="loadSimActionLogs()" class="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1">
                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                            Refresh
                        </button>
                    </div>
                    <div id="sim-action-logs-container" class="space-y-3">
                        <p class="text-gray-500 text-sm">Loading logs...</p>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="hideSimActionModal()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>
    <!-- Slot Picker Modal -->
    <div id="slot-picker-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 class="text-lg font-semibold text-white">Select Gateway Slot</h3>
                <button onclick="hideSlotPickerModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <p class="text-sm text-gray-400 mb-4">The SIM card was not found on any gateway. Select a slot to try, or enter slot details manually.</p>
                <div id="slot-picker-candidates" class="mb-4"></div>
                <div class="border-t border-dark-600 pt-4">
                    <h4 class="text-sm font-medium text-gray-300 mb-3">Manual Entry</h4>
                    <div class="flex gap-3 items-end">
                        <div>
                            <label class="block text-xs text-gray-500 mb-1">Gateway ID</label>
                            <input id="slot-picker-manual-gw" type="text" class="px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent w-28" placeholder="1"/>
                        </div>
                        <div>
                            <label class="block text-xs text-gray-500 mb-1">Port</label>
                            <input id="slot-picker-manual-port" type="text" class="px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent w-24" placeholder="01.01"/>
                        </div>
                        <button onclick="useManualSlot()" class="px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Use Slot</button>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="hideSlotPickerModal()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Cancel</button>
            </div>
        </div>
    </div>
    <!-- Rotate Specific SIMs Modal -->
    <div id="rotate-sim-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Rotate Specific SIMs</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter ICCIDs to rotate (one per line):</p>
                <textarea id="rotate-sim-input" rows="8" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="89014103271467425631"></textarea>
                <p class="text-xs text-gray-500 mt-2">Each SIM will get a new phone number immediately</p>
                <div id="rotate-sim-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Results:</h4>
                    <pre id="rotate-sim-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-60 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideRotateSimModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                <button onclick="rotateSpecificSims()" id="rotate-sim-btn" class="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Rotate SIMs</button>
            </div>
        </div>
    </div>

    <!-- Test SMS Modal -->
    <div id="test-sms-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Send Test SMS</h3>
            </div>
            <div class="p-5 space-y-4">
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Gateway</label>
                    <select id="test-sms-gateway" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent">
                        <option value="">Select a gateway...</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Port</label>
                    <input type="text" id="test-sms-port" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="e.g. 1A, 2B, or 1, 2"/>
                    <p class="text-xs text-gray-500 mt-1">Port on the selected gateway</p>
                </div>
                <div>
                    <label class="block text-sm text-gray-400 mb-2">To Number</label>
                    <input type="text" id="test-sms-to" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="e.g. 15551234567"/>
                </div>
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Message</label>
                    <textarea id="test-sms-message" rows="3" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="Your test message..."></textarea>
                </div>
                <div id="test-sms-result" class="hidden">
                    <pre id="test-sms-output" class="bg-dark-900 p-3 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideTestSmsModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="sendTestSms()" id="test-sms-btn" class="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-700 text-white rounded-lg transition">Send SMS</button>
            </div>
        </div>
    </div>

    <!-- Gateway Switch SIM Modal -->
    <div id="gw-switch-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Switch SIM</h3>
            </div>
            <div class="p-5 space-y-4">
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Port</label>
                    <input type="text" id="gw-switch-port" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="e.g. 1A, 2B"/>
                    <p class="text-xs text-gray-500 mt-1">Switches to the next SIM slot on the port</p>
                </div>
                <div id="gw-switch-result" class="hidden">
                    <pre id="gw-switch-output" class="bg-dark-900 p-3 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideGwModal('gw-switch-modal')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="gwSwitchSim()" id="gw-switch-btn" class="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Switch SIM</button>
            </div>
        </div>
    </div>

    <!-- Gateway IMEI Modal -->
    <div id="gw-imei-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">IMEI Management</h3>
            </div>
            <div class="p-5 space-y-4">
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Port</label>
                    <input type="text" id="gw-imei-port" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="e.g. 1A"/>
                </div>
                <div>
                    <label class="block text-sm text-gray-400 mb-2">IMEI (for Set only)</label>
                    <div class="flex gap-2">
                        <input type="text" id="gw-imei-value" class="flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="15-digit IMEI"/>
                        <button onclick="gwAutoPickImei()" id="gw-auto-pick-btn" class="px-3 py-2 text-sm bg-dark-600 hover:bg-dark-500 border border-dark-500 text-gray-300 rounded-lg transition whitespace-nowrap">Auto</button>
                    </div>
                </div>
                <div id="gw-imei-result" class="hidden">
                    <pre id="gw-imei-output" class="bg-dark-900 p-3 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600 max-h-48 overflow-y-auto"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideGwModal('gw-imei-modal')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                <button onclick="gwGetImei()" id="gw-get-imei-btn" class="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition">Get IMEI</button>
                <button onclick="gwSetImei()" id="gw-set-imei-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Set IMEI</button>
            </div>
        </div>
    </div>

    <!-- Gateway Port Command Modal -->
    <div id="gw-command-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-md">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white" id="gw-command-title">Port Command</h3>
            </div>
            <div class="p-5 space-y-4">
                <div>
                    <label class="block text-sm text-gray-400 mb-2">Port(s)</label>
                    <input type="text" id="gw-command-port" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="e.g. 1A or 1A,2A,3A"/>
                    <p class="text-xs text-gray-500 mt-1">Comma-separated for multiple ports</p>
                </div>
                <div id="gw-command-result" class="hidden">
                    <pre id="gw-command-output" class="bg-dark-900 p-3 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideGwModal('gw-command-modal')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                <button onclick="gwRunCommand()" id="gw-command-btn" class="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Execute</button>
            </div>
        </div>
    </div>

    <!-- Port Detail Modal -->
    <div id="port-detail-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                <h3 id="port-detail-title" class="text-lg font-semibold text-white">Port Details</h3>
                <button onclick="hideGwModal('port-detail-modal')" class="text-gray-400 hover:text-white transition text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto" id="port-detail-content">
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="hideGwModal('port-detail-modal')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
            </div>
        </div>
    </div>

    <!-- IMEI Eligibility Modal -->
    <div id="imei-eligibility-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="imei-eligibility-title" class="text-lg font-semibold text-white">IMEI Eligibility Check</h3>
                <button onclick="document.getElementById('imei-eligibility-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <div id="imei-eligibility-content" class="text-sm text-gray-300">Checking...</div>
                <div id="imei-eligibility-fix-btn" class="mt-4 hidden">
                    <button onclick="fixIncompatibleImei()" class="px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Fix (Replace with Pool IMEI)</button>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('imei-eligibility-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Check IMEIs Bulk Modal -->
    <div id="check-imeis-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 class="text-lg font-semibold text-white">Bulk IMEI Eligibility Check</h3>
                <button onclick="document.getElementById('check-imeis-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <p class="text-sm text-gray-400 mb-3">Paste IMEIs to check eligibility (one per line, max 100):</p>
                <textarea id="check-imeis-input" rows="6" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono mb-3" placeholder="351756051523999"></textarea>
                <button onclick="runBulkImeiCheck()" id="check-imeis-run-btn" class="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Run Check</button>
                <div id="check-imeis-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Results:</h4>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead><tr class="text-left text-xs text-gray-500 border-b border-dark-600">
                                <th class="py-2 pr-4">IMEI</th>
                                <th class="py-2 pr-4">Eligible</th>
                                <th class="py-2 pr-4">Device</th>
                                <th class="py-2">Plans</th>
                            </tr></thead>
                            <tbody id="check-imeis-tbody" class="text-gray-300"></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('check-imeis-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Change IMEI Modal -->
    <div id="change-imei-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="change-imei-title" class="text-lg font-semibold text-white">Change IMEI</h3>
                <button onclick="document.getElementById('change-imei-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <p id="change-imei-sim-info" class="text-sm text-gray-400 mb-4"></p>
                <div class="flex gap-3 mb-4">
                    <button id="change-imei-auto-btn" onclick="confirmChangeImei(true)" class="flex-1 px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Auto (Pick from Pool)</button>
                </div>
                <div class="border-t border-dark-600 pt-4">
                    <label class="block text-xs text-gray-500 mb-1">Manual IMEI (15 digits)</label>
                    <div class="flex gap-2">
                        <input id="change-imei-input" type="text" maxlength="15" class="flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="351756051523999">
                        <button onclick="checkManualImeiEligibility()" class="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition whitespace-nowrap">Check</button>
                    </div>
                    <div id="change-imei-eligibility-result" class="mt-2 text-xs"></div>
                </div>
                <div class="mt-4">
                    <button id="change-imei-confirm-btn" onclick="confirmChangeImei(false)" class="w-full px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Confirm Change IMEI</button>
                </div>
                <div id="change-imei-result-section" class="mt-4 hidden">
                    <pre id="change-imei-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('change-imei-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = '/api';

        
        const TAB_ROUTES = {
            'dashboard': '/',
            'sims': '/sims',
            'messages': '/messages',
            'workers': '/workers',
            'gateway': '/gateway',
            'imei-pool': '/imei-pool',
            'errors': '/errors',
            'billing': '/billing',
            'guide': '/guide',
        };
        const ROUTE_TO_TAB = Object.fromEntries(Object.entries(TAB_ROUTES).map(([k,v]) => [v, k]));

        function switchTab(tabName, push = true) {
            toggleSidebar(false);
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.sidebar-btn').forEach(el => {
                el.classList.remove('text-white');
                el.classList.add('text-dark-400');
            });
            const tabEl = document.getElementById(\`tab-\${tabName}\`);
            if (!tabEl) return;
            tabEl.classList.remove('hidden');
            // Highlight the correct sidebar button
            document.querySelectorAll('.sidebar-btn').forEach(b => {
                if (b.getAttribute('data-tab') === tabName) {
                    b.classList.add('text-white');
                    b.classList.remove('text-dark-400');
                }
            });
            if (push && TAB_ROUTES[tabName]) {
                history.pushState({ tab: tabName }, '', TAB_ROUTES[tabName]);
            }
            const PAGE_TITLES = { dashboard: 'Dashboard', sims: 'SIMs', messages: 'Messages', workers: 'Workers', gateway: 'Gateway', 'imei-pool': 'IMEI Pool', errors: 'Errors', billing: 'Billing', guide: 'Guide' };
            document.title = (PAGE_TITLES[tabName] || tabName) + ' — SMS Gateway';
            if (tabName === 'imei-pool') loadImeiPool();
            if (tabName === 'gateway') loadPortStatus();
            if (tabName === 'errors') loadErrors();
            if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }
        }

        // Handle browser back/forward
        window.addEventListener('popstate', (e) => {
            const tab = e.state?.tab || ROUTE_TO_TAB[location.pathname] || 'dashboard';
            switchTab(tab, false);
        });

        // Init tab from URL on page load

        // ===== Sort & Filter Engine =====
        const tableState = {
            sims: { data: [], sortKey: 'id', sortDir: 'asc', page: 1, pageSize: 50 },
            messages: { data: [], sortKey: 'received_at', sortDir: 'desc', page: 1, pageSize: 50 },
            imei: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },
            errors: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },
        };

        function sortTable(table, key) {
            const state = tableState[table];
            if (state.sortKey === key) {
                state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
                state.sortKey = key;
                state.sortDir = 'asc';
            }
            // Update arrows
            document.querySelectorAll(\`[data-table="\${table}"]\`).forEach(el => el.textContent = '');
            const arrow = document.querySelector(\`[data-table="\${table}"][data-col="\${key}"]\`);
            if (arrow) arrow.textContent = state.sortDir === 'asc' ? ' \u25B2' : ' \u25BC';
            state.page = 1;
            // Re-render
            if (table === 'sims') renderSims();
            else if (table === 'messages') renderMessages();
            else if (table === 'imei') renderImeiPool();
            else if (table === 'errors') renderErrors();
        }

        function genericSort(arr, key, dir) {
            return [...arr].sort((a, b) => {
                let va = a[key], vb = b[key];
                if (va == null) va = '';
                if (vb == null) vb = '';
                if (typeof va === 'number' && typeof vb === 'number') {
                    return dir === 'asc' ? va - vb : vb - va;
                }
                va = String(va).toLowerCase();
                vb = String(vb).toLowerCase();
                if (va < vb) return dir === 'asc' ? -1 : 1;
                if (va > vb) return dir === 'asc' ? 1 : -1;
                return 0;
            });
        }

        function normalizePastedSearch(el, e, cb) {
            var NL = String.fromCharCode(10);
            var CR = String.fromCharCode(13);
            var text = (e.clipboardData||window.clipboardData).getData('text');
            if (text.indexOf(NL) === -1 && text.indexOf(CR) === -1) return;
            e.preventDefault();
            var normalized = text.split(new RegExp('[' + CR + NL + ']+')).map(function(s){return s.trim();}).filter(Boolean).join(',');
            var s = el.selectionStart, end = el.selectionEnd;
            el.value = el.value.slice(0, s) + normalized + el.value.slice(end);
            cb();
        }

        function matchesSearch(obj, query) {
            if (!query) return true;
            const terms = query.split(/[,;\\n\\r]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
            if (!terms.length) return true;
            const DATE_FIELDS = ['activated_at','last_sms_received','last_mdn_rotated_at','last_notified_at','created_at','updated_at'];
            const strings = Object.entries(obj).flatMap(([k, v]) => {
              if (v == null) return [];
              const base = String(v);
              if (DATE_FIELDS.includes(k) && v) {
                const d = new Date(v);
                if (!isNaN(d)) return [base, d.toLocaleDateString(), d.toLocaleString(), d.toISOString().slice(0,10)];
              }
              return [base];
            });
            const lowerStrings = strings.map(s => s.toLowerCase());
            return terms.some(term => lowerStrings.some(s => s.includes(term)));
        }


        function initTabFromUrl() {
            const tab = ROUTE_TO_TAB[location.pathname] || 'dashboard';
            switchTab(tab, false);
        }



        function showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            const toastMessage = document.getElementById('toast-message');
            toastMessage.textContent = message;
            toast.className = \`fixed bottom-4 right-4 px-6 py-4 rounded-lg shadow-lg max-w-md z-50 \${
                type === 'error' ? 'bg-red-600' :
                type === 'success' ? 'bg-accent' :
                'bg-dark-700 border border-dark-500'
            } text-white\`;
            toast.classList.remove('hidden');
            const duration = type === 'error' ? 10000 : 4000;
            setTimeout(() => toast.classList.add('hidden'), duration);
            console.log(\`[\${type.toUpperCase()}] \${message}\`);
        }

        function updateActiveRing(active, total) {
            const percent = total > 0 ? Math.round((active / total) * 100) : 0;
            const circumference = 163.36;
            const offset = circumference - (percent / 100) * circumference;
            document.getElementById('active-ring').style.strokeDashoffset = offset;
            document.getElementById('active-percent').textContent = percent + '%';
        }

        async function loadData() {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                const response = await fetch(API_BASE + '/stats', { 
                    credentials: 'include',
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!response.ok) { const txt = await response.text(); throw new Error(response.status + ' ' + response.statusText + ' ' + txt.substring(0,50)); }
                const data = await response.json();
                document.getElementById('total-sims').textContent = data.total_sims || 0;
                document.getElementById('active-sims').textContent = data.active_sims || 0;
                document.getElementById('provisioning-sims').textContent = data.provisioning_sims || 0;
                document.getElementById('messages-24h').textContent = data.messages_24h || 0;
                updateActiveRing(data.active_sims || 0, data.total_sims || 0);
                document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
                loadSims(true);
                loadMessages();
            } catch (error) {
                showToast('Error loading dashboard data', 'error');
                console.error(error);
                document.getElementById('total-sims').innerHTML = '<span class="text-red-500 text-xs">' + error.message + '</span>';
            }
        }

        async function loadResellers() {
            try {
                const response = await fetch(\`\${API_BASE}/resellers\`);
                const resellers = await response.json();
                const select = document.getElementById('filter-reseller');
                const currentValue = select.value;
                select.innerHTML = '<option value="">All Resellers</option><option value="none">No Reseller</option>' +
                    resellers.map(r => \`<option value="\${r.id}">\${r.name}</option>\`).join('');
                select.value = currentValue;
            } catch (error) {
                console.error('Error loading resellers:', error);
            }
        }

        let lastSimsFetchedAt = 0;
        const SIM_CACHE_MS = 30 * 60 * 1000; // 30 minutes

        async function loadSims(force = false) {
            // Check cache: if data loaded < 30 min ago and not forced, skip fetch
            const now = Date.now();
            if (!force && lastSimsFetchedAt && (now - lastSimsFetchedAt) < SIM_CACHE_MS && tableState.sims.data.length > 0) {
                const cacheAge = Math.round((now - lastSimsFetchedAt) / 60000);
                const cacheLabel = document.getElementById('sims-cache-label');
                if (cacheLabel) cacheLabel.textContent = '(cached ' + cacheAge + 'm ago)';
                renderSims();
                return;
            }
            try {
                const statusFilter = document.getElementById('filter-status').value;
                const resellerFilter = document.getElementById('filter-reseller').value;

                const params = new URLSearchParams();
                if (statusFilter === 'all') {
                    params.set('hide_cancelled', 'false');
                } else if (statusFilter) {
                    params.set('status', statusFilter);
                    params.set('hide_cancelled', 'false');
                }
                if (resellerFilter && resellerFilter !== 'none') {
                    params.set('reseller_id', resellerFilter);
                }
                if (force) params.set('force', 'true');

                const url = API_BASE + '/sims?' + params.toString();
                const response = await fetch(url);
                const sims = await response.json();
                tableState.sims.data = sims;
                lastSimsFetchedAt = Date.now();
                // Populate gateway dropdown
                const gwSel = document.getElementById('filter-gateway');
                if (gwSel) {
                  const current = gwSel.value;
                  const gateways = [...new Set(sims.map(s => s.gateway_code).filter(Boolean))].sort();
                  gwSel.innerHTML = '<option value="">All Gateways</option>' + gateways.map(g => \`<option value="\${g}"\${current===g?' selected':''}>\${g}</option>\`).join('');
                }
                const cacheLabel = document.getElementById('sims-cache-label');
                if (cacheLabel) cacheLabel.textContent = '(just loaded)';
                const lastUpdated = document.getElementById('last-updated');
                if (lastUpdated) lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
                renderSims();
            } catch (error) {
                showToast('Error loading SIMs', 'error');
                console.error(error);
            }
        }

function renderSims() {
  const state = tableState.sims;
  const search = (document.getElementById('sims-search')?.value || '').trim();
  let data = state.data;
  if (search) data = data.filter(s => matchesSearch(s, search));
  const resellerFilterVal = document.getElementById('filter-reseller')?.value;
  if (resellerFilterVal === 'none') data = data.filter(s => !s.reseller_id);
  const gatewayFilterVal = document.getElementById('filter-gateway')?.value;
  if (gatewayFilterVal) data = data.filter(s => s.gateway_code === gatewayFilterVal);
  const activatedFrom = document.getElementById('filter-activated-from')?.value;
  const activatedTo = document.getElementById('filter-activated-to')?.value;
  if (activatedFrom) data = data.filter(s => s.activated_at && s.activated_at >= activatedFrom);
  if (activatedTo) data = data.filter(s => s.activated_at && s.activated_at <= activatedTo + 'T23:59:59');
  const specialFilter = document.getElementById('filter-special') && document.getElementById('filter-special').value;
  if (specialFilter === 'not_rotated_today') {
    const todayUTC = new Date().toISOString().slice(0, 10);
    data = data.filter(function(s) { return !s.last_mdn_rotated_at || s.last_mdn_rotated_at.slice(0, 10) < todayUTC; });
  } else if (specialFilter === 'no_sms_12h') {
    const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
    data = data.filter(function(s) { return !s.last_sms_received || new Date(s.last_sms_received).getTime() < cutoff12h; });
  }
  data = genericSort(data, state.sortKey, state.sortDir);

  const tbody = document.getElementById('sims-table');
  const countEl = document.getElementById('sims-count');
  countEl.textContent = \`\${data.length} of \${state.data.length} SIM(s)\`;

            const totalFiltered = data.length;
            data = paginate(data, 'sims');
            renderPaginationControls('sims-pagination', 'sims', totalFiltered);

            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="12" class="px-4 py-4 text-center text-gray-500">No SIMs found</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(sim => {
                const lastSms = sim.last_sms_received ? new Date(sim.last_sms_received).toLocaleString() : '-';
                const canSendOnline = sim.phone_number && sim.reseller_id && sim.status === 'active';
                const verifiedBadge = sim.verification_status === 'verified' ? '<span class="ml-1 text-accent" title="Verified">&#10003;</span>' : '';
                const gatewayDisplay = sim.gateway_code ? \`<span class="font-medium text-gray-200">\${sim.gateway_code}</span><span class="text-gray-500 text-xs ml-1">\${sim.port || ''}</span>\` : (sim.port || '-');
                const statusClass = {
                    'active': 'bg-accent/20 text-accent',
                    'provisioning': 'bg-yellow-500/20 text-yellow-400',
                    'suspended': 'bg-orange-500/20 text-orange-400',
                    'canceled': 'bg-red-500/20 text-red-400',
                    'error': 'bg-red-500/20 text-red-400',
                }[sim.status] || 'bg-gray-500/20 text-gray-400';
                return \`
                <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                    <td class="px-4 py-3"><input type="checkbox" class="sim-cb accent-green-500" value="\${sim.id}" onchange="updateSimActionBar()"></td>
                    <td class="px-4 py-3"><button onclick="showSimLogs(\${sim.id})" class="text-indigo-400 hover:text-indigo-200 hover:underline font-mono transition" title="View Helix logs">\${sim.id}</button></td>
                    <td class="px-4 py-3 text-gray-400" title="\${sim.gateway_name || ''}">\${gatewayDisplay}</td>
                    <td class="px-4 py-3 text-gray-400 font-mono text-xs">\${sim.iccid}</td>
                    <td class="px-4 py-3 text-gray-200">\${sim.phone_number || '-'}\${verifiedBadge}</td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-1 text-xs font-medium rounded-full \${statusClass}">\${sim.status}</span>
                    </td>
                    <td class="px-4 py-3 font-mono text-xs">\${sim.mobility_subscription_id ? \`<button onclick="queryHelixSubId('\${sim.mobility_subscription_id}')" class="text-indigo-400 hover:text-indigo-300 hover:underline">\${sim.mobility_subscription_id}</button>\` : '-'}</td>
                    <td class="px-4 py-3 text-gray-400">\${sim.reseller_name || '-'}</td>
                    <td class="px-4 py-3 text-gray-300">\${sim.sms_count || 0}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${lastSms}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).toLocaleString() : '-'}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${sim.activated_at ? new Date(sim.activated_at).toLocaleString() : '-'}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${sim.last_notified_at ? new Date(sim.last_notified_at).toLocaleString() : '-'}</td>
                    <td class="px-4 py-3 whitespace-nowrap">
                        \${canSendOnline ? \`<button onclick="sendSimOnline(\${sim.id}, '\${sim.phone_number}')" class="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition mr-1">Online</button>\` : ''}
                        \${sim.status === 'active' ? \`<button onclick="simAction(\${sim.id}, 'ota_refresh')" class="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition mr-1">OTA</button>\` : ''}
                        \${sim.status === 'error' ? \`<button onclick="retryActivation(\${sim.id})" class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1">Retry</button>\` : ''}
                        \${sim.reseller_id ? \`<button onclick="unassignReseller(\${sim.id})" class="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition" title="Unassign from reseller">Unassign</button>\` : \`<button onclick="assignReseller(\${sim.id})" class="px-2 py-1 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition" title="Assign to reseller">Assign</button>\`}
                        \${(sim.mobility_subscription_id && sim.gateway_id && sim.port) ? \`<button onclick="showChangeImeiModal(\${sim.id}, '\${sim.iccid}', \${sim.gateway_id}, '\${sim.port}')" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1" title="Change IMEI">IMEI</button>\` : ''}
                        \${\`<button onclick="showSetStatusModal(\${sim.id}, '\${sim.status}')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>\`}
                    </td>
                </tr>
                \`;
}).join('');
        }


async function sendSimOnline(simId, phoneNumber) {
  if (!(await showConfirm('Send Webhook', \`Send number.online webhook for \${phoneNumber}?\`))) {
                return;
            }
            showToast(\`Sending online webhook for \${phoneNumber}...\`, 'info');
            try {
                const response = await fetch(\`\${API_BASE}/sim-online\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: simId })
                });
                const result = await response.json();
                if (response.ok && result.ok) {
                    showToast(result.message, 'success');
                } else {
                    showToast(\`Error: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error sending online webhook', 'error');
                console.error(error);
            }
        }

        async function loadMessages() {
            try {
                const response = await fetch(\`\${API_BASE}/messages\`);
                const messages = await response.json();

                // Update main messages table
                tableState.messages.data = messages;
                renderMessages();
                // Update preview table (first 5)
                const preview = document.getElementById('messages-preview');
                const previewMsgs = messages.slice(0, 5);
                if (previewMsgs.length === 0) {
                    preview.innerHTML = '<tr><td colspan="4" class="px-5 py-4 text-center text-gray-500">No messages</td></tr>';
                } else {
                    preview.innerHTML = previewMsgs.map(msg => {
                        const date = new Date(msg.received_at);
                        const timeStr = date.toLocaleTimeString();
                        return \`
                            <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                                <td class="px-5 py-3 text-gray-400 text-xs">\${timeStr}</td>
                                <td class="px-5 py-3 text-gray-200">\${msg.to_number || '-'}</td>
                                <td class="px-5 py-3 text-gray-200">\${msg.from_number}</td>
                                <td class="px-5 py-3 text-gray-300 truncate max-w-xs cursor-pointer hover:text-white" onclick="showMsgBody(this.dataset.body)" data-body="\${(msg.body||'')}">\${msg.body}</td>
                            </tr>
                        \`;
                    }).join('');
                }
            } catch (error) {
                showToast('Error loading messages', 'error');
                console.error(error);
            }
        }

        function showMsgBody(text) {
            document.getElementById('msg-body-text').textContent = text;
            document.getElementById('msg-body-modal').classList.remove('hidden');
        }
        function hideMsgBodyModal() {
            document.getElementById('msg-body-modal').classList.add('hidden');
        }
        function renderMessages() {
            const state = tableState.messages;
            const search = (document.getElementById('messages-search')?.value || '').trim();
            let data = state.data;
            if (search) data = data.filter(m => matchesSearch(m, search));
            data = genericSort(data, state.sortKey, state.sortDir);

            const totalFiltered = data.length;
            data = paginate(data, 'messages');
            renderPaginationControls('messages-pagination', 'messages', totalFiltered);

            const tbody = document.getElementById('messages-table');
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-4 text-center text-gray-500">No messages found</td></tr>';
                return;
            }
            tbody.innerHTML = data.map(msg => {
                const timeStr = new Date(msg.received_at).toLocaleString();
                return \`
                    <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                        <td class="px-5 py-3 text-gray-400 text-xs">\${timeStr}</td>
                        <td class="px-5 py-3 text-gray-200">\${msg.to_number || '-'}</td>
                        <td class="px-5 py-3 text-gray-200">\${msg.from_number}</td>
                        <td class="px-5 py-3 text-gray-300 max-w-md truncate cursor-pointer hover:text-white" onclick="showMsgBody(this.dataset.body)" data-body="\${(msg.body||'')}">\${msg.body}</td>
                        <td class="px-5 py-3 text-gray-500 font-mono text-xs">\${msg.iccid || '-'}</td>
                    </tr>
                \`;
            }).join('');
        }


        function showRotateSimModal() {
            document.getElementById('rotate-sim-modal').classList.remove('hidden');
            document.getElementById('rotate-sim-result').classList.add('hidden');
            document.getElementById('rotate-sim-btn').disabled = false;
            document.getElementById('rotate-sim-btn').textContent = 'Rotate SIMs';
        }

        function hideRotateSimModal() {
            document.getElementById('rotate-sim-modal').classList.add('hidden');
            document.getElementById('rotate-sim-input').value = '';
            document.getElementById('rotate-sim-result').classList.add('hidden');
        }

        async function rotateSpecificSims() {
            const input = document.getElementById('rotate-sim-input').value.trim();
            if (!input) {
                showToast('Please enter at least one ICCID', 'error');
                return;
            }

            const iccids = input.split('\\n').map(l => l.trim()).filter(Boolean);
            if (iccids.length === 0) {
                showToast('Please enter at least one ICCID', 'error');
                return;
            }

            if (!(await showConfirm('Rotate SIMs', \`Rotate \${iccids.length} SIM(s)? This will assign new phone numbers immediately.\`))) {
                return;
            }

            const btn = document.getElementById('rotate-sim-btn');
            btn.disabled = true;
            btn.textContent = 'Rotating...';
            showToast(\`Rotating \${iccids.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/rotate-sim\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ iccids })
                });
                const result = await response.json();

                // Show results in the modal
                const resultDiv = document.getElementById('rotate-sim-result');
                const outputPre = document.getElementById('rotate-sim-output');
                resultDiv.classList.remove('hidden');
                outputPre.textContent = JSON.stringify(result, null, 2);

                if (response.ok && result.results) {
                    const succeeded = result.results.filter(r => r.ok).length;
                    const failed = result.results.filter(r => !r.ok).length;
                    if (failed === 0) {
                        showToast(\`All \${succeeded} SIM(s) rotated successfully\`, 'success');
                    } else {
                        showToast(\`\${succeeded} succeeded, \${failed} failed\`, failed > 0 ? 'error' : 'success');
                    }
                    loadData();
        loadErrors();
                } else {
                    showToast(\`Error: \${result.error || 'Unknown error'}\`, 'error');
                }
            } catch (error) {
                showToast('Error rotating SIMs', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Rotate SIMs';
            }
        }

        
        function showResellerSyncModal() {
            document.getElementById('reseller-sync-force').checked = false;
            document.getElementById('reseller-sync-modal').classList.remove('hidden');
        }

        function hideResellerSyncModal() {
            document.getElementById('reseller-sync-modal').classList.add('hidden');
        }

        async function doResellerSync() {
            const force = document.getElementById('reseller-sync-force').checked;
            hideResellerSyncModal();
            showToast('Running reseller-sync' + (force ? ' (force)' : '') + '...', 'info');
            try {
                const response = await fetch(API_BASE + '/run/reseller-sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force })
                });
                const result = await response.json();
                if (response.ok) {
                    const msg = 'Reseller sync done: ' + (result.synced || 0) + ' sent, ' + (result.skipped || 0) + ' skipped, ' + (result.errors || 0) + ' errors';
                    showToast(msg, 'success');
                    loadData();
                } else {
                    showToast('Error: ' + (result.error || 'unknown'), 'error');
                }
            } catch (e) {
                showToast('Error running reseller-sync', 'error');
                console.error(e);
            }
        }

        async function runWorker(workerName) {
            if (!(await showConfirm('Run Worker', \`Run \${workerName}?\`))) {
                return;
            }
            showToast(\`Running \${workerName}...\`, 'info');
            try {
                const response = await fetch(\`\${API_BASE}/run/\${workerName}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const result = await response.json();
                if (response.ok) {
                    showToast(\`\${workerName} completed successfully\`, 'success');
                    loadData();
                } else {
                    showToast(\`Error running \${workerName}: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast(\`Error running \${workerName}\`, 'error');
                console.error(error);
            }
        }

        function showCancelModal() {
            document.getElementById('cancel-modal').classList.remove('hidden');
        }

        function hideCancelModal() {
            document.getElementById('cancel-modal').classList.add('hidden');
            document.getElementById('iccids-input').value = '';
        }

        function showActivateModal() {
            document.getElementById('activate-modal').classList.remove('hidden');
        }

        function hideActivateModal() {
            document.getElementById('activate-modal').classList.add('hidden');
            document.getElementById('activate-input').value = '';
        }

        async function activateSims() {
            const input = document.getElementById('activate-input').value.trim();
            if (!input) {
                showToast('Please enter at least one SIM', 'error');
                return;
            }

            // Parse pasted data (tab-separated from spreadsheet, or comma-separated)
            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const sims = [];
            const errors = [];

            for (let i = 0; i < lines.length; i++) {
                const delimiter = lines[i].includes('\\t') ? '\\t' : ',';
                const parts = lines[i].split(delimiter).map(p => p.trim());
                if (parts.length !== 3) {
                    errors.push(\`Line \${i + 1}: Invalid format (expected 3 columns)\`);
                    continue;
                }

                const [iccid, imei, resellerId] = parts;

                if (iccid.length < 19 || iccid.length > 20) {
                    errors.push(\`Line \${i + 1}: Invalid ICCID length\`);
                    continue;
                }

                if (imei.length !== 15) {
                    errors.push(\`Line \${i + 1}: Invalid IMEI length (must be 15 digits)\`);
                    continue;
                }

                const resellerIdNum = parseInt(resellerId);
                if (!Number.isFinite(resellerIdNum)) {
                    errors.push(\`Line \${i + 1}: Invalid reseller_id (must be a number)\`);
                    continue;
                }

                sims.push({ iccid, imei, reseller_id: resellerIdNum });
            }

            if (errors.length > 0) {
                showToast(\`Validation errors: \${errors[0]}\`, 'error');
                return;
            }

            if (sims.length === 0) {
                showToast('No valid SIMs found', 'error');
                return;
            }

            if (!(await showConfirm('Activate SIMs', \`Are you sure you want to activate \${sims.length} SIM(s)? This will call the Helix API.\`))) {
                return;
            }

            hideActivateModal();
            showToast(\`Activating \${sims.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/activate\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sims })
                });

                const result = await response.json();

                if (response.ok) {
                    showToast(\`Activated \${result.processed} SIM(s), \${result.errors} error(s)\`,
                        result.errors > 0 ? 'error' : 'success');
                    loadData();
                } else {
                    showToast(\`Error activating SIMs: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error activating SIMs', 'error');
                console.error(error);
            }
        }

        async function cancelSims() {
            const input = document.getElementById('iccids-input').value.trim();
            if (!input) {
                showToast('Please enter at least one ICCID', 'error');
                return;
            }

            const iccids = input.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            if (iccids.length === 0) {
                showToast('No valid ICCIDs found', 'error');
                return;
            }

            if (!(await showConfirm('Cancel SIMs', \`Are you sure you want to cancel \${iccids.length} SIM(s)? This action cannot be undone.\`))) {
                return;
            }

            hideCancelModal();
            showToast(\`Cancelling \${iccids.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/cancel\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ iccids })
                });

                const result = await response.json();

                if (response.ok) {
                    let msg = \`Cancelled \${result.cancelled} SIM(s), \${result.errors} error(s)\`;
                    // Show first error detail if any
                    if (result.results) {
                        const firstError = result.results.find(r => !r.ok);
                        if (firstError) {
                            msg += \`: \${firstError.error || firstError.reason || 'Unknown error'}\`;
                        }
                    }
                    showToast(msg, result.errors > 0 ? 'error' : 'success');
                    console.log('Cancel results:', result);
                    loadData();
                } else {
                    showToast(\`Error cancelling SIMs: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error cancelling SIMs', 'error');
                console.error(error);
            }
        }

        function showSuspendModal() {
            document.getElementById('suspend-modal').classList.remove('hidden');
            document.getElementById('suspend-input').value = '';
            document.getElementById('suspend-input').focus();
        }

        function hideSuspendModal() {
            document.getElementById('suspend-modal').classList.add('hidden');
            document.getElementById('suspend-input').value = '';
        }

        async function suspendSims() {
            const input = document.getElementById('suspend-input').value.trim();
            if (!input) {
                showToast('Please enter at least one SIM ID', 'error');
                return;
            }

            const simIds = input.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(id => parseInt(id))
                .filter(id => !isNaN(id));

            if (simIds.length === 0) {
                showToast('No valid SIM IDs found', 'error');
                return;
            }

            if (!(await showConfirm('Suspend SIMs', \`Are you sure you want to suspend \${simIds.length} SIM(s)?\`))) {
                return;
            }

            hideSuspendModal();
            showToast(\`Suspending \${simIds.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/suspend\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: simIds })
                });

                const result = await response.json();

                if (response.ok) {
                    let msg = \`Suspended \${result.success} SIM(s), \${result.errors} error(s)\`;
                    if (result.results) {
                        const firstError = result.results.find(r => !r.ok && !r.skipped);
                        if (firstError) {
                            msg += \`: \${firstError.error || 'Unknown error'}\`;
                        }
                    }
                    showToast(msg, result.errors > 0 ? 'error' : 'success');
                    console.log('Suspend results:', result);
                    loadData();
                } else {
                    showToast(\`Error suspending SIMs: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error suspending SIMs', 'error');
                console.error(error);
            }
        }

        function showRestoreModal() {
            document.getElementById('restore-modal').classList.remove('hidden');
            document.getElementById('restore-input').value = '';
            document.getElementById('restore-input').focus();
        }

        function hideRestoreModal() {
            document.getElementById('restore-modal').classList.add('hidden');
            document.getElementById('restore-input').value = '';
        }

        async function restoreSims() {
            const input = document.getElementById('restore-input').value.trim();
            if (!input) {
                showToast('Please enter at least one SIM ID', 'error');
                return;
            }

            const simIds = input.split('\\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .map(id => parseInt(id))
                .filter(id => !isNaN(id));

            if (simIds.length === 0) {
                showToast('No valid SIM IDs found', 'error');
                return;
            }

            if (!(await showConfirm('Restore SIMs', \`Are you sure you want to restore \${simIds.length} SIM(s)?\`))) {
                return;
            }

            hideRestoreModal();
            showToast(\`Restoring \${simIds.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/restore\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: simIds })
                });

                const result = await response.json();

                if (response.ok) {
                    let msg = \`Restored \${result.success} SIM(s), \${result.errors} error(s)\`;
                    if (result.results) {
                        const firstError = result.results.find(r => !r.ok && !r.skipped);
                        if (firstError) {
                            msg += \`: \${firstError.error || 'Unknown error'}\`;
                        }
                    }
                    showToast(msg, result.errors > 0 ? 'error' : 'success');
                    console.log('Restore results:', result);
                    loadData();
                } else {
                    showToast(\`Error restoring SIMs: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error restoring SIMs', 'error');
                console.error(error);
            }
        }

        function showHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-subid-input').focus();
        }

        function queryHelixSubId(subId) {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = subId;
            queryHelix();
        }

        function hideHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
        }

        async function queryHelix() {
            const subId = document.getElementById('helix-subid-input').value.trim();
            if (!subId) {
                showToast('Please enter a Subscription ID', 'error');
                return;
            }

            const btn = document.getElementById('helix-query-btn');
            btn.disabled = true;
            btn.textContent = 'Querying...';
            document.getElementById('helix-bulk-result').classList.add('hidden');

            try {
                const response = await fetch(, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mobility_subscription_id: subId })
                });

                const result = await response.json();
                const outputEl = document.getElementById('helix-query-output');
                const resultDiv = document.getElementById('helix-query-result');
                const dbBanner = document.getElementById('helix-db-update-banner');
                const dbOutput = document.getElementById('helix-db-update-output');

                dbBanner.classList.add('hidden');

                if (response.ok && result.ok) {
                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;
                    let formatted = '';
                    if (data) {
                        const isCancelled = data.status === 'CANCELLED' || data.status === 'CANCELED';
                        formatted = \`<span class="text-blue-400 font-bold">status:</span> <span class="\${data.status === 'ACTIVE' ? 'text-accent' : isCancelled ? 'text-red-400' : 'text-orange-400'} font-bold">\${data.status || 'N/A'}</span>\n\`;
                        if (data.statusReason) {
                            formatted += \`<span class="text-blue-400 font-bold">statusReason:</span> <span class="text-orange-400 font-bold">\${data.statusReason}</span>\n\`;
                        }
                        if (data.canceledAt || data.cancelledAt) {
                            formatted += \`<span class="text-blue-400 font-bold">canceledAt:</span> <span class="text-red-300">\${data.canceledAt || data.cancelledAt}</span>\n\`;
                        }
                        formatted += \`\n<span class="text-gray-500">--- Full Response ---</span>\n\`;
                        formatted += JSON.stringify(data, null, 2);
                    } else {
                        formatted = JSON.stringify(result.helix_response, null, 2);
                    }
                    outputEl.innerHTML = formatted;

                    if (result.db_update) {
                        const u = result.db_update;
                        const dbLines = [];
                        if (!u.found) dbLines.push('SIM not found in DB for this sub ID');
                        else {
                            dbLines.push(\`ICCID: \${u.iccid}\`);
                            if (u.status_updated) dbLines.push(\`Status: \${u.previous_status} → canceled\`);
                            else if (u.status_already_canceled) dbLines.push('Status: already canceled in DB');
                            if (u.history_inserted) dbLines.push(\`Cancel date recorded: \${u.canceled_at}\`);
                            else if (u.history_exists) dbLines.push(\`Cancel date already in history: \${u.canceled_at}\`);
                            else if (u.no_cancel_date) dbLines.push('No canceledAt in Helix response — history not inserted');
                            if (u.error) dbLines.push(\`Error: \${u.error}\`);
                        }
                        dbOutput.textContent = dbLines.join('\n');
                        dbBanner.classList.remove('hidden');
                    }

                    resultDiv.classList.remove('hidden');
                } else {
                    outputEl.innerHTML = \`<span class="text-red-400">Error:</span> \${JSON.stringify(result, null, 2)}\`;
                    resultDiv.classList.remove('hidden');
                }
            } catch (error) {
                showToast('Error querying Helix', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Query';
            }
        }

        let _bulkNextOffset = 0;

        async function queryHelixBulk(offset) {
            const btn = document.getElementById('helix-bulk-btn');
            const nextBtn = document.getElementById('helix-bulk-next-btn');
            btn.disabled = true;
            btn.textContent = 'Running...';
            if (nextBtn) nextBtn.disabled = true;
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.remove('hidden');
            document.getElementById('helix-bulk-summary').innerHTML = '<div class="col-span-4 text-sm text-gray-400 py-2">Querying Helix… this may take up to 30 seconds.</div>';
            document.getElementById('helix-bulk-changed').classList.add('hidden');
            document.getElementById('helix-bulk-more').classList.add('hidden');

            try {
                const response = await fetch(, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ limit: 100, offset: offset || 0 })
                });
                const result = await response.json();

                if (!response.ok || result.error) {
                    document.getElementById('helix-bulk-summary').innerHTML =
                        \`<div class="col-span-4 text-sm text-red-400">Error: \${result.error || 'Unknown error'}</div>\`;
                    return;
                }

                _bulkNextOffset = result.next_offset || 0;

                const stats = [
                    { label: 'Queried', value: result.processed, color: 'text-white' },
                    { label: 'Cancelled Found', value: result.cancelled_found, color: result.cancelled_found > 0 ? 'text-red-400' : 'text-gray-400' },
                    { label: 'DB Updated', value: result.db_updated, color: result.db_updated > 0 ? 'text-yellow-400' : 'text-gray-400' },
                    { label: 'Errors', value: result.errors, color: result.errors > 0 ? 'text-orange-400' : 'text-gray-400' },
                ];
                document.getElementById('helix-bulk-summary').innerHTML = stats.map(s =>
                    \`<div class="bg-dark-900 rounded-lg p-3 text-center border border-dark-600"><div class="text-xl font-bold \${s.color}">\${s.value}</div><div class="text-xs text-gray-500 mt-1">\${s.label}</div></div>\`
                ).join('');

                if (result.changed && result.changed.length > 0) {
                    document.getElementById('helix-bulk-changed-output').textContent = JSON.stringify(result.changed, null, 2);
                    document.getElementById('helix-bulk-changed').classList.remove('hidden');
                }

                if (result.has_more) {
                    const moreEl = document.getElementById('helix-bulk-more');
                    moreEl.classList.remove('hidden');
                    moreEl.querySelector('button').textContent =
                        \`Run Next Batch (\${result.next_offset}–\${Math.min(result.next_offset + 100, result.total_eligible)} of \${result.total_eligible})\`;
                }

                if (result.cancelled_found > 0) {
                    showToast(\`\${result.cancelled_found} cancelled line\${result.cancelled_found > 1 ? 's' : ''} found — \${result.db_updated} DB updated\`, 'warning');
                } else {
                    showToast(\`Bulk query done — \${result.processed} SIMs checked, none cancelled\`, 'success');
                }

            } catch (error) {
                document.getElementById('helix-bulk-summary').innerHTML =
                    \`<div class="col-span-4 text-sm text-red-400">Error: \${error.message}</div>\`;
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Bulk Query All SIMs';
                if (nextBtn) nextBtn.disabled = false;
            }
        }

        function queryHelixBulkNext() {
            queryHelixBulk(_bulkNextOffset);
        }
        async function showTestSmsModal() {
            document.getElementById('test-sms-modal').classList.remove('hidden');
            document.getElementById('test-sms-result').classList.add('hidden');
            document.getElementById('test-sms-gateway').value = '';
            document.getElementById('test-sms-port').value = '';
            document.getElementById('test-sms-to').value = '';
            document.getElementById('test-sms-message').value = '';

            // Load gateways into dropdown
            const select = document.getElementById('test-sms-gateway');
            select.innerHTML = '<option value="">Loading gateways...</option>';

            try {
                const response = await fetch(\`\${API_BASE}/gateways\`);
                const gateways = await response.json();

                if (gateways.length === 0) {
                    select.innerHTML = '<option value="">No gateways found</option>';
                } else {
                    select.innerHTML = '<option value="">Select a gateway...</option>' +
                        gateways.map(gw => \`<option value="\${gw.id}" data-code="\${gw.code}">\${gw.code}\${gw.host ? ' (' + gw.host + ')' : ' (no credentials)'}</option>\`).join('');
                }
            } catch (error) {
                console.error('Failed to load gateways:', error);
                select.innerHTML = '<option value="">Error loading gateways</option>';
            }

            document.getElementById('test-sms-gateway').focus();
        }

        function hideTestSmsModal() {
            document.getElementById('test-sms-modal').classList.add('hidden');
        }

        async function sendTestSms() {
            const gatewayId = document.getElementById('test-sms-gateway').value;
            const port = document.getElementById('test-sms-port').value.trim();
            const toNumber = document.getElementById('test-sms-to').value.trim();
            const message = document.getElementById('test-sms-message').value.trim();

            if (!gatewayId || !port || !toNumber || !message) {
                showToast('Please fill in all fields', 'error');
                return;
            }

            const btn = document.getElementById('test-sms-btn');
            btn.disabled = true;
            btn.textContent = 'Sending...';

            try {
                const response = await fetch(\`\${API_BASE}/send-test-sms\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port, to_number: toNumber, message })
                });

                const result = await response.json();
                const outputEl = document.getElementById('test-sms-output');
                const resultDiv = document.getElementById('test-sms-result');

                if (response.ok && result.ok) {
                    outputEl.innerHTML = \`<span class="text-accent">Success!</span> \${result.message}\\n\\n\${JSON.stringify(result.skyline_response, null, 2)}\`;
                    showToast(result.message, 'success');
                } else {
                    outputEl.innerHTML = \`<span class="text-red-400">Error:</span> \${result.error}\\n\\n\${JSON.stringify(result.skyline_response || result, null, 2)}\`;
                    showToast(\`Error: \${result.error}\`, 'error');
                }
                resultDiv.classList.remove('hidden');
            } catch (error) {
                showToast('Error sending SMS', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Send SMS';
            }
        }

        // ===== Gateway Tab Functions =====

        let gwCurrentCommand = 'reboot';

        async function loadGatewayDropdown() {
            const select = document.getElementById('gw-select');
            try {
                const response = await fetch(\`\${API_BASE}/gateways\`);
                const gateways = await response.json();
                select.innerHTML = '<option value="">Select a gateway...</option>' +
                    gateways.map(gw => \`<option value="\${gw.id}">\${gw.code}\${gw.name ? ' - ' + gw.name : ''}</option>\`).join('');
            } catch (error) {
                console.error('Failed to load gateways:', error);
                select.innerHTML = '<option value="">Error loading gateways</option>';
            }
        }

        const PORT_STATUS_COLORS = {
            0: { bg: 'bg-red-500', label: 'No SIM' },
            1: { bg: 'bg-blue-500', label: 'Idle' },
            2: { bg: 'bg-yellow-500', label: 'Registering' },
            3: { bg: 'bg-green-500', label: 'Registered' },
            4: { bg: 'bg-green-400', label: 'Call' },
            5: { bg: 'bg-orange-500', label: 'No Balance' },
            6: { bg: 'bg-red-500', label: 'Reg Failed' },
            7: { bg: 'bg-gray-500', label: 'Dev Locked' },
            8: { bg: 'bg-gray-500', label: 'Op Locked' },
            9: { bg: 'bg-red-600', label: 'SIM Error' },
            12: { bg: 'bg-gray-500', label: 'User Locked' },
            15: { bg: 'bg-blue-400', label: 'Mobile Net' },
            16: { bg: 'bg-red-500', label: 'Timeout' },
        };

        async function loadPortStatus() {
            const gatewayId = document.getElementById('gw-select').value;
            const grid = document.getElementById('port-grid');
            const label = document.getElementById('gw-status-label');

            if (!gatewayId) {
                grid.innerHTML = '<p class="text-gray-500 text-sm col-span-full text-center py-8">Select a gateway to view port status</p>';
                label.textContent = '';
                return;
            }

            grid.innerHTML = '<p class="text-gray-400 text-sm col-span-full text-center py-8">Loading...</p>';

            try {
                const response = await fetch(\`\${API_BASE}/skyline/port-info?gateway_id=\${gatewayId}&all_slots=1\`);
                const result = await response.json();

                if (!result.ok) {
                    grid.innerHTML = \`<p class="text-red-400 text-sm col-span-full text-center py-8">Error: \${result.error}</p>\`;
                    label.textContent = '';
                    return;
                }

                const ports = result.ports || [];
                if (ports.length === 0) {
                    grid.innerHTML = '<p class="text-gray-500 text-sm col-span-full text-center py-8">No port data returned</p>';
                    label.textContent = 'No data';
                    return;
                }

                label.textContent = \`\${ports.length} slot(s) - Updated \${new Date().toLocaleTimeString()}\`;
                window.portData = ports;

                grid.innerHTML = ports.map(p => {
                    const portLabel = p.port || '?';
                    const st = p.st ?? -1;
                    const info = PORT_STATUS_COLORS[st] || { bg: 'bg-gray-600', label: 'Unknown' };
                    const number = p.number ? p.number.replace('+1', '') : '';
                    const sig = p.signal != null ? p.signal : '-';
                    const shortIccid = p.iccid ? '...' + p.iccid.slice(-6) : '';

                    const tooltip = [
                        'Port ' + portLabel + ': ' + info.label + ' (st=' + st + ')',
                        p.number ? 'Number: ' + p.number : 'No number assigned',
                        p.iccid ? 'ICCID: ' + p.iccid : '',
                        p.imei ? 'IMEI: ' + p.imei : '',
                        p.operator ? 'Operator: ' + p.operator : '',
                        'Signal: ' + sig,
                        p.sim_status ? 'SIM Status: ' + p.sim_status : '',
                    ].filter(Boolean).join('\\n');

                    return \`
                        <div class="flex flex-col items-center p-2 rounded-lg bg-dark-700 border border-dark-500 hover:border-dark-400 transition cursor-pointer group relative" title="\${tooltip}" onclick="selectPort('\${portLabel}')">
                            <div class="flex items-center gap-1 mb-1">
                                <div class="w-3 h-3 rounded-full \${info.bg}"></div>
                                <span class="text-[10px] text-gray-500">\${sig}</span>
                            </div>
                            <span class="text-xs font-bold text-gray-200">\${portLabel.split('.')[0]}</span>
                            \${number ? \`<span class="text-[10px] text-accent font-medium truncate max-w-full">\${number}</span>\` : \`<span class="text-[10px] text-gray-600">---</span>\`}
                            <span class="text-[10px] text-gray-500">\${info.label}</span>
                        </div>
                    \`;
                }).join('');
            } catch (error) {
                grid.innerHTML = \`<p class="text-red-400 text-sm col-span-full text-center py-8">Error: \${error}</p>\`;
                label.textContent = '';
            }
        }

        const SLOT_TO_LETTER = { '01':'A', '02':'B', '03':'C', '04':'D', '05':'E', '06':'F', '07':'G', '08':'H' };

        function selectPort(portLabel) {
            if (!window.portData) return;
            // Port format from gateway: "1.01", "1.02", "2.01" etc. (port.slot)
            const match = portLabel.match(/^(\\d+)\\.(\\d+)$/);
            if (!match) return;
            const portNum = match[1];
            const slotNum = match[2];
            const slotLetter = SLOT_TO_LETTER[slotNum] || slotNum;

            // Find all slots on this physical port
            const siblings = window.portData.filter(p => {
                const m = (p.port || '').match(/^(\\d+)\\./);
                return m && m[1] === portNum;
            }).sort((a, b) => (a.port || '').localeCompare(b.port || ''));

            document.getElementById('port-detail-title').textContent = \`Port \${portNum} \u2014 \${portLabel} / \${portNum}\${slotLetter}\`;

            const content = document.getElementById('port-detail-content');
            content.innerHTML = \`
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-left text-gray-400 border-b border-dark-600">
                            <th class="pb-2 pr-3">Slot</th>
                            <th class="pb-2 pr-3">Status</th>
                            <th class="pb-2 pr-3">Number</th>
                            <th class="pb-2 pr-3">ICCID</th>
                            <th class="pb-2 pr-3">IMEI</th>
                            <th class="pb-2 pr-3">Signal</th>
                            <th class="pb-2">Operator</th>
                            <th class="pb-2 pl-3">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${siblings.map(p => {
                            const pm = (p.port || '').match(/^(\\d+)\\.(\\d+)$/);
                            const sn = pm ? pm[2] : '?';
                            const sl = SLOT_TO_LETTER[sn] || sn;
                            const st = p.st ?? -1;
                            const info = PORT_STATUS_COLORS[st] || { bg: 'bg-gray-600', label: 'Unknown' };
                            const isCurrent = p.port === portLabel;
                            const rowBg = isCurrent ? 'bg-dark-600' : '';
                            const number = p.number ? p.number.replace('+1', '') : '';
                            return \`
                                <tr class="\${rowBg} border-b border-dark-700">
                                    <td class="py-2 pr-3 font-mono text-gray-200">
                                        <span class="font-bold">\${p.port}</span>
                                        <span class="text-gray-500 ml-1">\${portNum}\${sl}</span>
                                    </td>
                                    <td class="py-2 pr-3">
                                        <span class="inline-flex items-center gap-1.5">
                                            <span class="w-2.5 h-2.5 rounded-full \${info.bg} inline-block"></span>
                                            <span class="text-gray-300">\${info.label}</span>
                                        </span>
                                    </td>
                                    <td class="py-2 pr-3 font-mono \${number ? 'text-accent' : 'text-gray-600'}">\${number || '---'}</td>
                                    <td class="py-2 pr-3 font-mono text-gray-400 text-xs">\${p.iccid || '---'}</td>
                                    <td class="py-2 pr-3 font-mono text-gray-400 text-xs">\${p.imei || '---'}</td>
                                    <td class="py-2 pr-3 text-gray-300">\${p.signal != null ? p.signal : '-'}</td>
                                    <td class="py-2 text-gray-300">\${p.operator || '---'}</td>
                                    <td class="py-2 pl-3 whitespace-nowrap">
                                        <button onclick="gwSlotAction('lock','\${p.port}')" class="px-2 py-1 text-xs bg-orange-700 hover:bg-orange-600 text-white rounded transition mr-1" title="Lock SIM slot">Lock</button>
                                        <button onclick="gwSlotAction('unlock','\${p.port}')" class="px-2 py-1 text-xs bg-green-700 hover:bg-green-600 text-white rounded transition mr-1" title="Unlock SIM slot">Unlock</button>
                                        <button onclick="gwSlotAction('switch','\${p.port}')" class="px-2 py-1 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded transition" title="Switch to this SIM slot">Switch</button>
                                    </td>
                                </tr>
                            \`;
                        }).join('')}
                    </tbody>
                </table>
                \${siblings.length === 1 ? '<p class="text-xs text-gray-500 mt-3">This port has a single SIM slot.</p>' : \`<p class="text-xs text-gray-500 mt-3">\${siblings.length} SIM slot(s) on this port. Current slot highlighted.</p>\`}
            \`;

            document.getElementById('port-detail-modal').classList.remove('hidden');
        }

        function getSelectedGatewayId() {
            return document.getElementById('gw-select').value;
        }

        function hideGwModal(modalId) {
            document.getElementById(modalId).classList.add('hidden');
        }

        // Direct slot actions from port-detail modal (lock / unlock / switch-sim)
        async function gwSlotAction(action, port) {
            const gatewayId = getSelectedGatewayId();
            if (!gatewayId) { showToast('No gateway selected', 'error'); return; }
            const label = action === 'switch' ? 'Switch SIM on' : (action.charAt(0).toUpperCase() + action.slice(1));
            if (!(await showConfirm('Gateway Action', label + ' slot ' + port + '?'))) return;
            showToast(label + ' ' + port + '...', 'info');
            try {
                const endpoint = action === 'switch' ? 'switch-sim' : action;
                const resp = await fetch(API_BASE + '/skyline/' + endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port })
                });
                const result = await resp.json();
                showToast(result.ok ? (result.message || label + ' OK') : ('Error: ' + result.error), result.ok ? 'success' : 'error');
                if (result.ok) setTimeout(loadPortStatus, 2000);
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
        }

        // --- Switch SIM ---
        function showGwSwitchSimModal() {
            if (!getSelectedGatewayId()) { showToast('Select a gateway first', 'error'); return; }
            document.getElementById('gw-switch-modal').classList.remove('hidden');
            document.getElementById('gw-switch-result').classList.add('hidden');
            document.getElementById('gw-switch-port').value = '';
            document.getElementById('gw-switch-port').focus();
        }

        async function gwSwitchSim() {
            const gatewayId = getSelectedGatewayId();
            const port = document.getElementById('gw-switch-port').value.trim();
            if (!port) { showToast('Enter a port', 'error'); return; }

            const btn = document.getElementById('gw-switch-btn');
            btn.disabled = true; btn.textContent = 'Switching...';

            try {
                const response = await fetch(\`\${API_BASE}/skyline/switch-sim\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port })
                });
                const result = await response.json();
                document.getElementById('gw-switch-result').classList.remove('hidden');
                document.getElementById('gw-switch-output').textContent = JSON.stringify(result, null, 2);
                showToast(result.ok ? result.message : \`Error: \${result.error}\`, result.ok ? 'success' : 'error');
                if (result.ok) setTimeout(loadPortStatus, 3000);
            } catch (error) {
                showToast('Error switching SIM', 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Switch SIM';
            }
        }

        // --- IMEI ---
        function showGwImeiModal() {
            if (!getSelectedGatewayId()) { showToast('Select a gateway first', 'error'); return; }
            document.getElementById('gw-imei-modal').classList.remove('hidden');
            document.getElementById('gw-imei-result').classList.add('hidden');
            document.getElementById('gw-imei-port').value = '';
            document.getElementById('gw-imei-value').value = '';
            document.getElementById('gw-imei-port').focus();
        }

        async function gwGetImei() {
            const gatewayId = getSelectedGatewayId();
            const port = document.getElementById('gw-imei-port').value.trim();
            if (!port) { showToast('Enter a port', 'error'); return; }

            const btn = document.getElementById('gw-get-imei-btn');
            btn.disabled = true; btn.textContent = 'Reading...';

            try {
                const response = await fetch(\`\${API_BASE}/skyline/get-imei\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port })
                });
                const result = await response.json();
                document.getElementById('gw-imei-result').classList.remove('hidden');
                document.getElementById('gw-imei-output').textContent = JSON.stringify(result, null, 2);
                showToast(result.ok ? 'IMEI read successfully' : \`Error: \${result.error}\`, result.ok ? 'success' : 'error');
            } catch (error) {
                showToast('Error reading IMEI', 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Get IMEI';
            }
        }

        async function gwAutoPickImei() {
            const btn = document.getElementById('gw-auto-pick-btn');
            btn.disabled = true; btn.textContent = '...';
            try {
                const res = await fetch(API_BASE + '/imei-pool/pick');
                const data = await res.json();
                if (data.ok) {
                    document.getElementById('gw-imei-value').value = data.imei;
                    showToast('IMEI auto-selected: ' + data.imei, 'success');
                } else {
                    showToast(data.error || 'No available IMEIs in pool', 'error');
                }
            } catch (e) {
                showToast('Failed to pick IMEI', 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Auto';
            }
        }

        async function gwSetImei() {
            const gatewayId = getSelectedGatewayId();
            const port = document.getElementById('gw-imei-port').value.trim();
            const imei = document.getElementById('gw-imei-value').value.trim();
            if (!port || !imei) { showToast('Enter port and IMEI', 'error'); return; }
            if (imei.length !== 15) { showToast('IMEI must be 15 digits', 'error'); return; }
            if (!(await showConfirm('Set IMEI', \`Set IMEI \${imei} on port \${port}?\`))) return;

            const btn = document.getElementById('gw-set-imei-btn');
            btn.disabled = true; btn.textContent = 'Setting...';

            try {
                const response = await fetch(\`\${API_BASE}/skyline/set-imei\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port, imei })
                });
                const result = await response.json();
                document.getElementById('gw-imei-result').classList.remove('hidden');
                document.getElementById('gw-imei-output').textContent = JSON.stringify(result, null, 2);
                showToast(result.ok ? result.message : \`Error: \${result.error}\`, result.ok ? 'success' : 'error');
            } catch (error) {
                showToast('Error setting IMEI', 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Set IMEI';
            }
        }

        // --- Port Commands (reboot, reset, lock, unlock) ---
        function showGwCommandModal(command) {
            if (!getSelectedGatewayId()) { showToast('Select a gateway first', 'error'); return; }
            gwCurrentCommand = command;
            document.getElementById('gw-command-title').textContent = command.charAt(0).toUpperCase() + command.slice(1) + ' Port';
            document.getElementById('gw-command-btn').textContent = command.charAt(0).toUpperCase() + command.slice(1);
            document.getElementById('gw-command-modal').classList.remove('hidden');
            document.getElementById('gw-command-result').classList.add('hidden');
            document.getElementById('gw-command-port').value = '';
            document.getElementById('gw-command-port').focus();
        }

        async function gwRunCommand() {
            const gatewayId = getSelectedGatewayId();
            const port = document.getElementById('gw-command-port').value.trim();
            if (!port) { showToast('Enter a port', 'error'); return; }
            if (!(await showConfirm('Port Command', \`\${gwCurrentCommand} port \${port}?\`))) return;

            const btn = document.getElementById('gw-command-btn');
            btn.disabled = true; btn.textContent = 'Running...';

            try {
                const response = await fetch(\`\${API_BASE}/skyline/\${gwCurrentCommand}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: gatewayId, port })
                });
                const result = await response.json();
                document.getElementById('gw-command-result').classList.remove('hidden');
                document.getElementById('gw-command-output').textContent = JSON.stringify(result, null, 2);
                showToast(result.ok ? result.message : \`Error: \${result.error}\`, result.ok ? 'success' : 'error');
                if (result.ok) setTimeout(loadPortStatus, 3000);
            } catch (error) {
                showToast(\`Error running \${gwCurrentCommand}\`, 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = gwCurrentCommand.charAt(0).toUpperCase() + gwCurrentCommand.slice(1);
            }
        }

        // --- Fix SIM ---
        function showFixSimModal() {
            document.getElementById('fix-sim-modal').classList.remove('hidden');
            document.getElementById('fix-sim-result').classList.add('hidden');
            document.getElementById('fix-sim-btn').disabled = false;
            document.getElementById('fix-sim-btn').textContent = 'Fix SIMs';
        }

        function hideFixSimModal() {
            document.getElementById('fix-sim-modal').classList.add('hidden');
            document.getElementById('fix-sim-input').value = '';
            document.getElementById('fix-sim-result').classList.add('hidden');
        }

        async function fixSims() {
            const input = document.getElementById('fix-sim-input').value.trim();
            if (!input) { showToast('Please enter at least one SIM ID', 'error'); return; }

            const simIds = input.split('\\n').map(l => l.trim()).filter(Boolean).map(id => parseInt(id)).filter(id => !isNaN(id));
            if (simIds.length === 0) { showToast('No valid SIM IDs found', 'error'); return; }

            if (!(await showConfirm('Fix SIMs', \`Fix \${simIds.length} SIM(s)? This will change IMEI and run OTA/Cancel/Resume.\`))) return;

            const btn = document.getElementById('fix-sim-btn');
            btn.disabled = true;
            btn.textContent = 'Fixing...';
            showToast(\`Fixing \${simIds.length} SIM(s)...\`, 'info');

            try {
                const response = await fetch(\`\${API_BASE}/fix-sim\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: simIds })
                });
                const result = await response.json();

                const resultDiv = document.getElementById('fix-sim-result');
                const outputPre = document.getElementById('fix-sim-output');
                resultDiv.classList.remove('hidden');
                outputPre.textContent = JSON.stringify(result, null, 2);

                if (response.ok && result.results) {
                    const succeeded = result.results.filter(r => r.ok).length;
                    const failed = result.results.filter(r => !r.ok).length;
                    showToast(\`Fixed \${succeeded}, failed \${failed}\`, failed > 0 ? 'error' : 'success');
                } else {
                    showToast(\`Error: \${result.error || 'Unknown'}\`, 'error');
                }
            } catch (error) {
                showToast('Error fixing SIMs', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Fix SIMs';
            }
        }

        // --- IMEI Pool ---
        function showAddImeiModal() {
            document.getElementById('add-imei-modal').classList.remove('hidden');
            document.getElementById('add-imei-input').value = '';
        }

        function hideAddImeiModal() {
            document.getElementById('add-imei-modal').classList.add('hidden');
            document.getElementById('add-imei-input').value = '';
        }

        async function addImeis() {
            const input = document.getElementById('add-imei-input').value.trim();
            if (!input) { showToast('Please enter at least one IMEI', 'error'); return; }

            const imeis = input.split('\\n').map(l => l.trim()).filter(Boolean);
            if (imeis.length === 0) { showToast('No IMEIs entered', 'error'); return; }

            const btn = document.getElementById('add-imei-btn');
            btn.disabled = true;
            btn.textContent = 'Adding...';

            try {
                const response = await fetch(\`\${API_BASE}/imei-pool\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'add', imeis })
                });
                const result = await response.json();

                if (result.ok) {
                    showToast(\`Added \${result.added} IMEI(s), \${result.duplicates} duplicate(s), \${result.invalid} invalid\`, 'success');
                    hideAddImeiModal();
                    loadImeiPool();
                } else {
                    showToast(\`Error: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error adding IMEIs', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Add IMEIs';
            }
        }

        async function retireImei(id) {
            if (!(await showConfirm('Retire IMEI', 'Retire this IMEI? It will no longer be available for allocation.'))) return;

            try {
                const response = await fetch(\`\${API_BASE}/imei-pool\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'retire', id })
                });
                const result = await response.json();

                if (result.ok) {
                    showToast('IMEI retired', 'success');
                    loadImeiPool();
                } else {
                    showToast(\`Error: \${result.error}\`, 'error');
                }
            } catch (error) {
                showToast('Error retiring IMEI', 'error');
            }
        }

        async function syncGatewaySlots() {
            const gatewayId = document.getElementById('gw-select').value;
            if (!gatewayId) {
                showToast('Select a gateway first', 'error');
                return;
            }
            const btn = document.getElementById('gw-sync-slots-btn');
            const origLabel = btn.querySelector('span').textContent;
            btn.querySelector('span').textContent = 'Syncing...';
            btn.disabled = true;
            try {
                const res = await fetch(\`\${API_BASE}/sync-gateway-slots\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),
                });
                const data = await res.json();
                if (!res.ok || !data.ok) {
                    showToast(data.error || 'Sync failed', 'error');
                    return;
                }
                showToast(\`Synced \${data.synced} slots (\${data.not_found} SIMs not in DB)\`, 'success');
                loadPortStatus();
            } catch (err) {
                showToast('Sync error: ' + err, 'error');
            } finally {
                btn.querySelector('span').textContent = origLabel;
                btn.disabled = false;
            }
        }

        async function importGatewayImeis() {
            const gatewayId = document.getElementById('gw-select').value;
            if (!gatewayId) {
                showToast('Select a gateway first', 'error');
                return;
            }

            const btn = document.getElementById('gw-import-imei-btn');
            const origLabel = btn.querySelector('span').textContent;
            btn.querySelector('span').textContent = 'Importing...';
            btn.disabled = true;

            try {
                const res = await fetch(\`\${API_BASE}/import-gateway-imeis\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),
                });
                const data = await res.json();

                if (!res.ok || !data.ok) {
                    showToast(data.error || 'Import failed', 'error');
                    return;
                }

                const msg = \`Added \${data.added} IMEIs (\${data.in_sync} in sync, \${data.skipped_no_imei} slots had no IMEI)\`;
                showToast(msg, 'success');

                if (data.discrepancies && data.discrepancies.length > 0) {
                    const gwSelect = document.getElementById('gw-select');
                    const selOpt = gwSelect.options[gwSelect.selectedIndex];
                    const gwName = selOpt ? selOpt.text : ('Gateway ' + gatewayId);
                    const tagged = data.discrepancies.map(d => Object.assign({}, d, { gateway_id: parseInt(gatewayId), gateway_name: gwName }));
                    showDiscrepancyModal(tagged);
                }

                if (document.getElementById('tab-imei-pool') && !document.getElementById('tab-imei-pool').classList.contains('hidden')) {
                    loadImeiPool();
                }
            } catch (err) {
                showToast('Import error: ' + err, 'error');
            } finally {
                btn.querySelector('span').textContent = origLabel;
                btn.disabled = false;
            }
        }

        async function loadImeiPool() {
            try {
                const response = await fetch(\`\${API_BASE}/imei-pool\`);
                const data = await response.json();

                tableState.imei.data = data.pool || [];
                tableState.imei.stats = data.stats || {};
                renderImeiPool();
            } catch (error) {
                console.error('Error loading IMEI pool:', error);
            }
        }

         function renderImeiPool() {
            const state = tableState.imei;
            const stats = state.stats || {};
            const search = (document.getElementById('imei-search')?.value || '').trim();
            const statusFilter = (document.getElementById('imei-status-filter')?.value || '');

            document.getElementById('imei-slots').textContent = stats.slots || 0;
            document.getElementById('imei-in-use').textContent = stats.in_use || 0;
            document.getElementById('imei-available').textContent = stats.available || 0;
            document.getElementById('imei-retired').textContent = stats.retired || 0;
            document.getElementById('imei-total').textContent = stats.total || 0;

            let data = state.data;
            if (statusFilter) data = data.filter(e => e.status === statusFilter);
            if (search) data = data.filter(e => matchesSearch(e, search));
            data = genericSort(data, state.sortKey, state.sortDir);

            const totalFiltered = data.length;
            data = paginate(data, 'imei');
            renderPaginationControls('imei-pagination', 'imei', totalFiltered);

            const tbody = document.getElementById('imei-pool-table');
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">No IMEIs match filters</td></tr>';
                return;
            }

            tbody.innerHTML = data.map(entry => {
                const statusClass = {
                    'available': 'bg-accent/20 text-accent',
                    'in_use': 'bg-blue-500/20 text-blue-400',
                    'retired': 'bg-gray-500/20 text-gray-400',
                }[entry.status] || 'bg-gray-500/20 text-gray-400';
                const simInfo = entry.sims ? \`\${entry.sims.iccid || ''} (port \${entry.sims.port || '?'})\` : (entry.sim_id ? \`SIM #\${entry.sim_id}\` : '-');
                const assignedAt = entry.assigned_at ? new Date(entry.assigned_at).toLocaleString() : '-';
                const canRetire = entry.status === 'available' || entry.status === 'in_use';
                return \`
                <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                    <td class="px-4 py-3 text-gray-400">\${entry.id}</td>
                    <td class="px-4 py-3 font-mono text-sm text-gray-200">\${entry.imei}</td>
                    <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \${statusClass}">\${entry.status}</span></td>
                    <td class="px-4 py-3 text-gray-400 text-xs">\${simInfo}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${entry.gateway_id || '-'}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${entry.port || '-'}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${assignedAt}</td>
                    <td class="px-4 py-3 whitespace-nowrap">
                        \${canRetire ? \`<button onclick="retireImei(\${entry.id})" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition mr-1" title="Carrier rejected — retire this IMEI">Retire</button>\` : ''}
                        \${entry.status === 'retired' ? \`<button onclick="unretireImei(\${entry.id})" class="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition" title="Restore to available stock">Restore</button>\` : ''}
                    
                        <button onclick="checkImeiEligibility('\${entry.imei}', '\${entry.gateway_id || ''}', '\${entry.port || ''}', '\${entry.status}')" class="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition ml-1" title="Check carrier eligibility">Check</button>
                    </td>
                </tr>\`;
            }).join('');
        }



        // ===== Pagination =====
        function paginate(data, table) {
            const state = tableState[table];
            const start = (state.page - 1) * state.pageSize;
            return data.slice(start, start + state.pageSize);
        }

        function changePageSize(table, size) {
            tableState[table].pageSize = parseInt(size);
            tableState[table].page = 1;
            const renderMap = { sims: renderSims, messages: renderMessages, imei: renderImeiPool, errors: renderErrors };
            if (renderMap[table]) renderMap[table]();
        }

        function goToPage(table, page) {
            tableState[table].page = page;
            const renderMap = { sims: renderSims, messages: renderMessages, imei: renderImeiPool, errors: renderErrors };
            if (renderMap[table]) renderMap[table]();
        }

        function renderPaginationControls(containerId, table, totalItems) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const state = tableState[table];
            const totalPages = Math.ceil(totalItems / state.pageSize) || 1;
            if (state.page > totalPages) state.page = totalPages;

            const pageSizeOptions = [25, 50, 100, 250].map(s =>
                \`<option value="\${s}" \${s === state.pageSize ? 'selected' : ''}>\${s}</option>\`
            ).join('');

            let pageButtons = '';
            const maxBtns = 7;
            let startPage = Math.max(1, state.page - Math.floor(maxBtns / 2));
            let endPage = Math.min(totalPages, startPage + maxBtns - 1);
            if (endPage - startPage < maxBtns - 1) startPage = Math.max(1, endPage - maxBtns + 1);

            if (startPage > 1) pageButtons += \`<button onclick="goToPage('\${table}', 1)" class="px-2 py-1 text-xs rounded bg-dark-700 text-gray-300 hover:bg-dark-600">1</button>\`;
            if (startPage > 2) pageButtons += '<span class="text-gray-500 text-xs">...</span>';
            for (let i = startPage; i <= endPage; i++) {
                const active = i === state.page ? 'bg-accent text-white' : 'bg-dark-700 text-gray-300 hover:bg-dark-600';
                pageButtons += \`<button onclick="goToPage('\${table}', \${i})" class="px-2 py-1 text-xs rounded \${active}">\${i}</button>\`;
            }
            if (endPage < totalPages - 1) pageButtons += '<span class="text-gray-500 text-xs">...</span>';
            if (endPage < totalPages) pageButtons += \`<button onclick="goToPage('\${table}', \${totalPages})" class="px-2 py-1 text-xs rounded bg-dark-700 text-gray-300 hover:bg-dark-600">\${totalPages}</button>\`;

            container.innerHTML = \`
                <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-500">Show</span>
                    <select onchange="changePageSize('\${table}', this.value)" class="text-xs bg-dark-700 border border-dark-500 rounded px-2 py-1 text-gray-300">\${pageSizeOptions}</select>
                    <span class="text-xs text-gray-500">of \${totalItems}</span>
                </div>
                <div class="flex items-center gap-1">\${pageButtons}</div>
            \`;
        }

        // ===== Errors Tab =====
        async function loadErrors() {
            try {
                const statusFilter = document.getElementById('errors-status-filter')?.value || 'open';
                const response = await fetch(\`\${API_BASE}/errors?status=\${statusFilter}\`);
                const data = await response.json();
                tableState.errors.data = Array.isArray(data) ? data : [];
                renderErrors();
                // Update badge with open errors count
                const badge = document.getElementById('error-badge');
                if (badge) {
                    const openCount = tableState.errors.data.filter(e => e.status === 'open').length;
                    badge.textContent = openCount;
                    badge.classList.toggle('hidden', openCount === 0);
                }
            } catch (error) {
                showToast('Error loading errors', 'error');
                console.error(error);
            }
        }

        function classifyError(errorText) {
            if (!errorText) return 'unknown';
            const lower = errorText.toLowerCase();
            if (lower.includes('must be active')) return 'must_be_active';
            if (lower.includes('cancel')) return 'cancel_failed';
            if (lower.includes('resume')) return 'resume_failed';
            if (lower.includes('ota') || lower.includes('refresh')) return 'ota_failed';
            if (lower.includes('imei')) return 'imei_failed';
            if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
            return 'other';
        }

        function renderErrors() {
            const state = tableState.errors;
            const search = (document.getElementById('errors-search')?.value || '').trim();
            let data = state.data;
            if (search) data = data.filter(s => matchesSearch(s, search));
            data = genericSort(data, state.sortKey, state.sortDir);

            // Summary cards by source
            const sources = {};
            state.data.forEach(e => {
                const src = e.source || 'unknown';
                sources[src] = (sources[src] || 0) + 1;
            });
            const summaryEl = document.getElementById('error-summary');
            summaryEl.innerHTML = Object.entries(sources).map(([src, count]) => \`
                <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                    <span class="text-sm text-gray-400">\${src}</span>
                    <p class="text-2xl font-bold text-red-400">\${count}</p>
                </div>
            \`).join('');

            // Paginate
            const totalFiltered = data.length;
            const pageData = paginate(data, 'errors');
            renderPaginationControls('errors-pagination', 'errors', totalFiltered);

            const tbody = document.getElementById('errors-table');
            if (pageData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">No errors found</td></tr>';
                return;
            }
            tbody.innerHTML = pageData.map(err => {
                const sevClass = {
                    'critical': 'bg-red-600/30 text-red-300',
                    'error': 'bg-red-500/20 text-red-400',
                    'warning': 'bg-yellow-500/20 text-yellow-400',
                }[err.severity] || 'bg-gray-500/20 text-gray-400';
                const statusClass = {
                    'open': 'bg-red-500/20 text-red-400',
                    'acknowledged': 'bg-yellow-500/20 text-yellow-400',
                    'resolved': 'bg-accent/20 text-accent',
                }[err.status] || 'bg-gray-500/20 text-gray-400';
                const time = err.created_at ? new Date(err.created_at).toLocaleString() : '-';
                const simLabel = err.iccid ? err.iccid : (err.sim_id ? \`SIM #\${err.sim_id}\` : '-');
                const errorPreview = (err.error_message || '').slice(0, 80) + ((err.error_message || '').length > 80 ? '...' : '');
                const errId = err._legacy ? err.id : err.id;
                return \`
                <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                    <td class="px-4 py-3"><input type="checkbox" class="error-cb accent-green-500" value="\${errId}" onchange="updateErrorActionBar()"></td>
                    <td class="px-4 py-3 text-gray-300">
                        <span class="px-2 py-0.5 text-xs font-medium rounded bg-dark-600 text-gray-300">\${err.source || '-'}</span>
                        \${err.action ? \`<span class="text-xs text-gray-500 ml-1">\${err.action}</span>\` : ''}
                    </td>
                    <td class="px-4 py-3 font-mono text-xs text-gray-400">\${simLabel}</td>
                    <td class="px-4 py-3 text-gray-300 text-xs max-w-xs truncate" title="\${(err.error_message || '').replace(/"/g, '&quot;')}">\${errorPreview}</td>
                    <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \${sevClass}">\${err.severity || '-'}</span></td>
                    <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \${statusClass}">\${err.status || '-'}</span></td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\${time}</td>
                    <td class="px-4 py-3 whitespace-nowrap">
                        <button onclick="showFullError('\${errId}')" class="px-2 py-1 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded transition mr-1">View</button>
                        \${err.status !== 'resolved' ? \`<button onclick="resolveError('\${errId}')" class="px-2 py-1 text-xs bg-accent hover:bg-green-600 text-white rounded transition mr-1">Resolve</button>\` : ''}
                        \${err.sim_id && err.status !== 'resolved' ? \`<button onclick="simAction(\${err.sim_id}, 'ota_refresh')" class="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition">OTA</button>\` : ''}
                    </td>
                </tr>
                \`;
            }).join('');
        }

        function toggleAllErrors(checkbox) {
            document.querySelectorAll('.error-cb').forEach(cb => cb.checked = checkbox.checked);
            updateErrorActionBar();
        }

        function updateErrorActionBar() {
            const checked = document.querySelectorAll('.error-cb:checked');
            const bar = document.getElementById('error-action-bar');
            document.getElementById('error-selected-count').textContent = checked.length + ' selected';
            bar.classList.toggle('hidden', checked.length === 0);
        }

        function hideErrorDetail() {
            document.getElementById('error-detail').classList.add('hidden');
        }

        async function resolveError(errorId) {
            if (!(await showConfirm('Resolve Error', 'Mark this error as resolved?'))) return;
            try {
                const ids = typeof errorId === 'string' && errorId.startsWith('sim_') ? [errorId] : [parseInt(errorId)];
                const resp = await fetch(\`\${API_BASE}/resolve-error\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error_ids: ids })
                });
                const result = await resp.json();
                if (result.ok) {
                    showToast('Error resolved', 'success');
                    loadErrors();
                    if (action === "ota_refresh") loadSims(true);
                } else {
                    showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                }
            } catch (err) {
                showToast('Error resolving: ' + err, 'error');
            }
        }

        async function bulkResolveErrors() {
            const ids = [...document.querySelectorAll('.error-cb:checked')].map(cb => {
                const val = cb.value;
                return val.startsWith('sim_') ? val : parseInt(val);
            });
            if (ids.length === 0) return;
            if (!(await showConfirm('Resolve Errors', \`Mark \${ids.length} error(s) as resolved?\`))) return;
            try {
                const resp = await fetch(\`\${API_BASE}/resolve-error\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ error_ids: ids })
                });
                const result = await resp.json();
                if (result.ok) {
                    showToast(\`\${result.resolved} error(s) resolved\`, 'success');
                    loadErrors();
                } else {
                    showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                }
            } catch (err) {
                showToast('Error resolving: ' + err, 'error');
            }
        }

        async function showFullError(errorId) {
            const err = tableState.errors.data.find(e => String(e.id) === String(errorId));
            if (!err) return;

            document.getElementById('error-detail-title').textContent = \`Error Detail - \${err.source || 'Unknown'} #\${errorId}\`;

            // Show info cards
            document.getElementById('error-detail-info').innerHTML = \`
                <div class="bg-dark-900 rounded-lg p-3 border border-dark-600">
                    <span class="text-xs text-gray-500">Source</span>
                    <p class="text-sm text-gray-200">\${err.source || '-'}</p>
                </div>
                <div class="bg-dark-900 rounded-lg p-3 border border-dark-600">
                    <span class="text-xs text-gray-500">Action</span>
                    <p class="text-sm text-gray-200">\${err.action || '-'}</p>
                </div>
                <div class="bg-dark-900 rounded-lg p-3 border border-dark-600">
                    <span class="text-xs text-gray-500">ICCID / SIM</span>
                    <p class="text-sm font-mono text-gray-200">\${err.iccid || (err.sim_id ? 'SIM #' + err.sim_id : '-')}</p>
                </div>
                <div class="bg-dark-900 rounded-lg p-3 border border-dark-600">
                    <span class="text-xs text-gray-500">Status</span>
                    <p class="text-sm text-gray-200">\${err.status || '-'} \${err.resolved_at ? '(' + new Date(err.resolved_at).toLocaleString() + ')' : ''}</p>
                </div>
            \`;

            document.getElementById('error-detail-content').textContent = err.error_message || 'No error text';

            // Show JSON details if available — split into request/response if structured
            const extraSection = document.getElementById('error-detail-extra');
            const jsonPre = document.getElementById('error-detail-json');
            if (err.error_details) {
                extraSection.classList.remove('hidden');
                const d = err.error_details;
                let html = '';
                if (d.request || d.response) {
                    // Structured error_details with request/response
                    if (d.request) {
                        html += '<div class="mb-3"><details open><summary class="text-xs font-semibold text-blue-400 cursor-pointer hover:text-blue-300 mb-1">Request Body</summary>';
                        html += '<pre class="text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">' + JSON.stringify(d.request, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></details></div>';
                    }
                    if (d.response) {
                        html += '<div class="mb-3"><details open><summary class="text-xs font-semibold text-orange-400 cursor-pointer hover:text-orange-300 mb-1">Response Body</summary>';
                        html += '<pre class="text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">' + JSON.stringify(d.response, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></details></div>';
                    }
                    if (d.status) {
                        html += '<p class="text-xs text-gray-500">HTTP Status: <span class="font-mono ' + (d.status >= 200 && d.status < 300 ? 'text-accent' : 'text-red-400') + '">' + d.status + '</span></p>';
                    }
                    jsonPre.innerHTML = html;
                } else {
                    // Unstructured — show raw JSON
                    try {
                        jsonPre.textContent = JSON.stringify(d, null, 2);
                    } catch {
                        jsonPre.textContent = String(d);
                    }
                }
            } else {
                extraSection.classList.add('hidden');
            }

            document.getElementById('error-detail').classList.remove('hidden');
            document.getElementById('error-detail').scrollIntoView({ behavior: 'smooth' });

            // Load Helix API logs if we have a sim_id or iccid
            const logsSection = document.getElementById('error-logs-section');
            const logsContainer = document.getElementById('error-logs-container');
            const simId = err.sim_id || (err._legacy ? parseInt(String(err.id).replace('sim_', '')) : null);
            const iccid = err.iccid;
            if (!simId && !iccid) {
                logsSection.classList.add('hidden');
                return;
            }
            logsSection.classList.add('hidden');
            logsContainer.innerHTML = '<p class="text-gray-500 text-sm">Loading Helix API logs...</p>';
            try {
                const params = simId ? 'sim_id=' + simId : 'iccid=' + encodeURIComponent(iccid);
                const resp = await fetch(\`\${API_BASE}/error-logs?\${params}\`);
                const logs = await resp.json();
                if (Array.isArray(logs) && logs.length > 0) {
                    logsSection.classList.remove('hidden');
                    logsContainer.innerHTML = logs.map(log => {
                        const statusColor = (log.response_status >= 200 && log.response_status < 300) ? 'text-accent' : 'text-red-400';
                        let reqBody = '-';
                        if (log.request_body) {
                            try { reqBody = JSON.stringify(log.request_body, null, 2); } catch { reqBody = String(log.request_body); }
                        }
                        let resBody = '-';
                        if (log.response_body_json) {
                            try { resBody = JSON.stringify(log.response_body_json, null, 2); } catch { resBody = String(log.response_body_json); }
                        } else if (log.response_body_text) {
                            resBody = log.response_body_text;
                        }
                        const time = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
                        return \`
                        <div class="bg-dark-900 rounded-lg border border-dark-600 p-3">
                            <div class="flex items-center justify-between mb-2">
                                <div class="flex items-center gap-3">
                                    <span class="text-xs font-semibold text-blue-400">\${log.step || '-'}</span>
                                    <span class="text-xs \${statusColor} font-mono">HTTP \${log.response_status || '?'}</span>
                                    <span class="text-xs text-gray-500 font-mono">\${log.request_method || 'GET'}</span>
                                </div>
                                <span class="text-xs text-gray-500">\${time}</span>
                            </div>
                            <div class="text-xs text-gray-400 font-mono mb-2 truncate" title="\${(log.request_url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">\${log.request_url || '-'}</div>
                            <details class="mb-1">
                                <summary class="text-xs text-blue-400 cursor-pointer hover:text-blue-300">Request Body</summary>
                                <pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">\${reqBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                            </details>
                            <details open>
                                <summary class="text-xs text-orange-400 cursor-pointer hover:text-orange-300">Response Body</summary>
                                <pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">\${resBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                            </details>
                            \${log.error ? \`<p class="text-xs text-red-400 mt-1">Error: \${log.error}</p>\` : ''}
                        </div>
                        \`;
                    }).join('');
                } else {
                    logsSection.classList.add('hidden');
                }
            } catch (logErr) {
                console.error('Error loading Helix logs:', logErr);
            }
        }

        // ===== SIM Actions =====
        let currentSimActionId = null;
        let currentSimActionIccid = null;

        function hideSimActionModal() {
            document.getElementById('sim-action-modal').classList.add('hidden');
            document.getElementById('sim-action-output').classList.remove('hidden');
        }

        function showSimLogs(simId) {
            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));
            currentSimActionId = simId;
            currentSimActionIccid = sim?.iccid || null;
            document.getElementById('sim-action-title').textContent = 'Helix Logs — SIM #' + simId;
            document.getElementById('sim-action-output').textContent = '';
            document.getElementById('sim-action-output').classList.add('hidden');
            document.getElementById('sim-action-logs-section').classList.remove('hidden');
            document.getElementById('sim-action-modal').classList.remove('hidden');
            loadSimActionLogs();
        }

        let _setStatusSimId = null;
        function showSetStatusModal(simId, currentStatus) {
            _setStatusSimId = simId;
            document.getElementById('set-status-title').textContent = 'Set Status - SIM #' + simId;
            document.getElementById('set-status-select').value = currentStatus;
            document.getElementById('set-status-modal').classList.remove('hidden');
        }

        async function runSetStatus() {
            const status = document.getElementById('set-status-select').value;
            document.getElementById('set-status-modal').classList.add('hidden');
            try {
                const res = await fetch(API_BASE + '/set-sim-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: _setStatusSimId, status })
                });
                const result = await res.json();
                if (result.ok) {
                    showToast('SIM #' + _setStatusSimId + ' status set to ' + status, 'success');
                    loadSims(true);
                } else {
                    showToast('Error: ' + (result.error || 'Failed'), 'error');
                }
            } catch (e) {
                showToast('Error setting status', 'error');
                console.error(e);
            }
        }

        async function simAction(simId, action, skipConfirm = false) {
            if (!skipConfirm && !(await showConfirm('Run Action', \`Run \${action} on SIM #\${simId}?\`))) return;

            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));
            currentSimActionId = simId;
            currentSimActionIccid = sim?.iccid || null;

            document.getElementById('sim-action-title').textContent = \`\${action} - SIM #\${simId}\`;
            document.getElementById('sim-action-output').textContent = \`Running \${action}...\`;
            document.getElementById('sim-action-logs-section').classList.add('hidden');
            document.getElementById('sim-action-modal').classList.remove('hidden');

            try {
                const response = await fetch(\`\${API_BASE}/sim-action\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: simId, action })
                });
                const result = await response.json();

                if (result.slot_not_found) {
                    hideSimActionModal();
                    showSlotPickerModal(simId, [], 'fix');
                    return;
                }

                document.getElementById('sim-action-output').textContent = JSON.stringify(result, null, 2);

                if (result.ok) {
                    showToast(\`\${action} completed successfully\`, 'success');
                    loadErrors();
                } else {
                    showToast(\`Error: \${result.error || 'Action failed'}\`, 'error');
                }
                // Reload SIM table if the action changed the SIM's status
                if (result.status_updated) {
                    loadSims(true);
                }
            } catch (error) {
                document.getElementById('sim-action-output').textContent = String(error);
                showToast(\`Error running \${action}\`, 'error');
                console.error(error);
            }

            loadSimActionLogs();
        }

        async function retryActivation(simId, gatewayId, port) {
            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));
            currentSimActionId = simId;
            currentSimActionIccid = sim?.iccid || null;

            document.getElementById('sim-action-title').textContent = 'Retry Activation - SIM #' + simId;
            document.getElementById('sim-action-output').textContent = 'Scanning gateways for SIM...';
            document.getElementById('sim-action-logs-section').classList.add('hidden');
            document.getElementById('sim-action-modal').classList.remove('hidden');

            try {
                const reqBody = { sim_id: simId, action: 'retry_activation' };
                if (gatewayId) reqBody.gateway_id = gatewayId;
                if (port) reqBody.port = port;

                const response = await fetch(API_BASE + '/sim-action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody)
                });
                const result = await response.json();

                if (result.slot_not_found) {
                    hideSimActionModal();
                    showSlotPickerModal(simId, result.candidates || []);
                    return;
                }

                document.getElementById('sim-action-output').textContent = JSON.stringify(result, null, 2);
                if (result.ok) {
                    showToast('Retry activation submitted — SIM moving to provisioning', 'success');
                    loadSims(true);
                    loadErrors();
                } else {
                    showToast('Retry failed: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                document.getElementById('sim-action-output').textContent = String(error);
                showToast('Error running retry activation', 'error');
                console.error(error);
            }

            loadSimActionLogs();
        }

        let _slotPickerSimId = null;
        let _slotPickerMode = 'retry';

        function showSlotPickerModal(simId, candidates, mode) {
            _slotPickerMode = mode || 'retry';
            _slotPickerSimId = simId;
            const container = document.getElementById('slot-picker-candidates');
            container.innerHTML = '';
            if (!candidates || candidates.length === 0) {
                container.innerHTML = '<p class="text-sm text-gray-500">No unoccupied slots found on any gateway.</p>';
            } else {
                const table = document.createElement('table');
                table.className = 'w-full text-sm text-gray-300';
                table.innerHTML = '<thead><tr class="text-xs text-gray-500 border-b border-dark-600">' +
                    '<th class="py-2 text-left">Gateway</th><th class="py-2 text-left">Port</th>' +
                    '<th class="py-2 text-left">ICCID in Slot</th><th class="py-2 text-left">IMEI</th>' +
                    '<th class="py-2"></th></tr></thead><tbody id="slot-picker-tbody"></tbody>';
                container.appendChild(table);
                const tbody = document.getElementById('slot-picker-tbody');
                candidates.forEach(function(c) {
                    const tr = document.createElement('tr');
                    tr.className = 'border-b border-dark-700';
                    tr.innerHTML = '<td class="py-2 pr-4">' + (c.gateway_code || c.gateway_id) + '</td>' +
                        '<td class="py-2 pr-4 font-mono">' + (c.port || '-') + '</td>' +
                        '<td class="py-2 pr-4 font-mono text-xs">' + (c.iccid || '-') + '</td>' +
                        '<td class="py-2 pr-4 font-mono text-xs">' + (c.current_imei || '-') + '</td>' +
                        '<td class="py-2"></td>';
                    const btn = document.createElement('button');
                    btn.className = 'px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition';
                    btn.textContent = 'Use Slot';
                    btn.addEventListener('click', (function(gid, p) {
                        return function() { retryActivation(simId, gid, p); };
                    })(c.gateway_id, c.port));
                    tr.lastElementChild.appendChild(btn);
                    tbody.appendChild(tr);
                });
            }
            document.getElementById('slot-picker-modal').classList.remove('hidden');
        }

        function hideSlotPickerModal() {
            document.getElementById('slot-picker-modal').classList.add('hidden');
            _slotPickerSimId = null;
        }

        function useManualSlot() {
            const gwId = document.getElementById('slot-picker-manual-gw').value.trim();
            const port = document.getElementById('slot-picker-manual-port').value.trim();
            if (!gwId || !port) { showToast('Enter gateway ID and port', 'error'); return; }
            const simId = _slotPickerSimId;
            hideSlotPickerModal();
            if (_slotPickerMode === 'fix') {
                fixSimWithSlot(simId, gwId, port);
            } else {
                retryActivation(simId, gwId, port);
            }
        }

        async function fixSimWithSlot(simId, gatewayId, port) {
            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));
            currentSimActionId = simId;
            currentSimActionIccid = sim?.iccid || null;
            document.getElementById('sim-action-title').textContent = \`fix - SIM #\${simId}\`;
            document.getElementById('sim-action-output').textContent = 'Queuing fix...';
            document.getElementById('sim-action-logs-section').classList.add('hidden');
            document.getElementById('sim-action-modal').classList.remove('hidden');
            try {
                const response = await fetch(\`\${API_BASE}/sim-action\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: simId, action: 'fix', gateway_id: gatewayId, port })
                });
                const result = await response.json();
                document.getElementById('sim-action-output').textContent = JSON.stringify(result, null, 2);
                if (result.ok) {
                    showToast('Fix queued successfully', 'success');
                } else {
                    showToast('Fix failed: ' + (result.error || 'Unknown error'), 'error');
                }
            } catch (error) {
                document.getElementById('sim-action-output').textContent = String(error);
                showToast('Error queuing fix', 'error');
            }
            loadSimActionLogs();
        }

        async function loadSimActionLogs() {
            if (!currentSimActionId && !currentSimActionIccid) return;

            const logsSection = document.getElementById('sim-action-logs-section');
            const logsContainer = document.getElementById('sim-action-logs-container');

            logsSection.classList.remove('hidden');
            logsContainer.innerHTML = '<p class="text-gray-500 text-sm">Loading Helix logs...</p>';

            try {
                const params = currentSimActionIccid
                    ? 'iccid=' + encodeURIComponent(currentSimActionIccid)
                    : 'sim_id=' + currentSimActionId;
                const response = await fetch(\`\${API_BASE}/error-logs?\${params}\`);
                const logs = await response.json();

                if (!Array.isArray(logs) || logs.length === 0) {
                    logsSection.classList.add('hidden');
                    return;
                }

                logsContainer.innerHTML = logs.map(log => {
                    const statusColor = (log.response_status >= 200 && log.response_status < 300) ? 'text-accent' : 'text-red-400';
                    let reqBody = '-';
                    if (log.request_body) {
                        try { reqBody = JSON.stringify(log.request_body, null, 2); } catch { reqBody = String(log.request_body); }
                    }
                    let resBody = '-';
                    if (log.response_body_json) {
                        try { resBody = JSON.stringify(log.response_body_json, null, 2); } catch { resBody = String(log.response_body_json); }
                    } else if (log.response_body_text) {
                        resBody = log.response_body_text;
                    }
                    const time = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
                    return \`
                    <div class="bg-dark-900 rounded-lg border border-dark-600 p-3">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-3">
                                <span class="text-xs font-semibold text-blue-400">\${log.step || '-'}</span>
                                <span class="text-xs \${statusColor} font-mono">HTTP \${log.response_status || '?'}</span>
                                <span class="text-xs text-gray-500 font-mono">\${log.request_method || 'GET'}</span>
                            </div>
                            <span class="text-xs text-gray-500">\${time}</span>
                        </div>
                        <div class="text-xs text-gray-400 font-mono mb-2 truncate" title="\${(log.request_url || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}">\${log.request_url || '-'}</div>
                        <details class="mb-1">
                            <summary class="text-xs text-blue-400 cursor-pointer hover:text-blue-300">Request Body</summary>
                            <pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">\${reqBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                        </details>
                        <details open>
                            <summary class="text-xs text-orange-400 cursor-pointer hover:text-orange-300">Response Body</summary>
                            <pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">\${resBody.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                        </details>
                        \${log.error ? \`<p class="text-xs text-red-400 mt-1">Error: \${log.error}</p>\` : ''}
                        \${(!log.response_ok || log.error) ? \`<div class="mt-2"><button onclick="retryLogStep('\${log.step}')" class="px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">&#8635; Retry</button></div>\` : ''}
                    </div>
                    \`;
                }).join('');
            } catch (err) {
                console.error('Failed to load Helix API logs:', err);
                logsContainer.innerHTML = '<p class="text-red-400 text-sm">Failed to load API logs</p>';
            }
        }
        // Retry a failed Helix API log step for the currently-viewed SIM
        function retryLogStep(step) {
            if (!currentSimActionId) { showToast('No SIM selected', 'error'); return; }
            var actionMap = {
                'mdn_change': 'rotate',
                'ota_refresh': 'ota_refresh',
                'retry_activation': 'retry_activation'
            };
            var action = actionMap[step] || 'fix';
            simAction(currentSimActionId, action);
        }

        function toggleAllSims(checkbox) {
            document.querySelectorAll('.sim-cb').forEach(cb => cb.checked = checkbox.checked);
            updateSimActionBar();
        }

        function updateSimActionBar() {
            const checked = document.querySelectorAll('.sim-cb:checked');
            const bar = document.getElementById('sim-action-bar');
            document.getElementById('sim-selected-count').textContent = checked.length + ' selected';
            bar.classList.toggle('hidden', checked.length === 0);
        }

        async function bulkSimAction(action) {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            if (!(await showConfirm('Run Action', \`Run \${action} on \${simIds.length} SIM(s)?\`))) return;
            for (const id of simIds) {
                await simAction(id, action, true);
            }
            loadSims(true);
        }

        async function bulkResetToProvisioning() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            if (!(await showConfirm('Reset SIMs', \`Reset \${simIds.length} SIM(s) to provisioning? The details-finalizer cron will re-process and correct ICCID mappings.\`))) return;
            try {
                const resp = await fetch(API_BASE + '/reset-to-provisioning', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: simIds })
                });
                const data = await resp.json();
                if (data.ok) {
                    showToast(\`Reset \${data.reset} SIM(s) to provisioning. Cron will re-process shortly.\`, 'success');
                    loadSims(true);
                } else {
                    showToast('Error: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (e) {
                showToast('Error: ' + e.message, 'error');
            }
        }

        function showBulkSendSmsModal() {
            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (selectedIds.length === 0) {
                showToast('Select at least one SIM first', 'error');
                return;
            }
            document.getElementById('bulk-sms-count').textContent = selectedIds.length;
            document.getElementById('bulk-sms-results').classList.add('hidden');
            document.getElementById('bulk-sms-result-body').innerHTML = '';
            const sendBtn = document.getElementById('bulk-sms-send-btn');
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send';
            document.getElementById('bulk-send-sms-modal').classList.remove('hidden');
        }

        async function runBulkSendSms() {
            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (selectedIds.length === 0) { showToast('No SIMs selected', 'error'); return; }
            const message = document.getElementById('bulk-sms-message').value.trim();
            if (!message) { showToast('Please enter a message', 'error'); return; }
            const sendBtn = document.getElementById('bulk-sms-send-btn');
            sendBtn.disabled = true;
            sendBtn.textContent = 'Sending...';
            try {
                const resp = await fetch(API_BASE + '/bulk-send-test-sms', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_sim_ids: selectedIds, message })
                });
                const data = await resp.json();
                const tbody = document.getElementById('bulk-sms-result-body');
                tbody.innerHTML = '';
                if (data.results) {
                    for (const r of data.results) {
                        const tr = document.createElement('tr');
                        tr.className = 'border-b border-dark-700';
                        tr.innerHTML = '<td class="py-1 pr-3">' + r.target_sim_id + '</td>' +
                            '<td class="py-1 pr-3 font-mono">' + (r.target_mdn || '-') + '</td>' +
                            '<td class="py-1 pr-3">' + (r.sender_port || '-') + '</td>' +
                            '<td class="py-1">' + (r.ok ? '<span class="text-green-400">\u2713</span>' : '<span class="text-red-400">\u2717 ' + (r.error || '') + '</span>') + '</td>';
                        tbody.appendChild(tr);
                    }
                }
                if (data.skipped_list) {
                    for (const sk of data.skipped_list) {
                        const tr = document.createElement('tr');
                        tr.className = 'border-b border-dark-700 opacity-50';
                        tr.innerHTML = '<td class="py-1 pr-3">' + sk.target_sim_id + '</td>' +
                            '<td class="py-1 pr-3">-</td>' +
                            '<td class="py-1 pr-3">-</td>' +
                            '<td class="py-1 text-gray-400">skipped: ' + sk.reason + '</td>';
                        tbody.appendChild(tr);
                    }
                }
                if (data.error && !data.results) {
                    document.getElementById('bulk-sms-summary').textContent = 'Error: ' + data.error;
                } else {
                    const parts = [];
                    if (data.sent != null) parts.push(data.sent + ' sent');
                    if (data.skipped) parts.push(data.skipped + ' skipped (no MDN)');
                    if (data.errors) parts.push(data.errors + ' error(s)');
                    document.getElementById('bulk-sms-summary').textContent = parts.join(', ');
                }
                document.getElementById('bulk-sms-results').classList.remove('hidden');
            } catch (e) {
                document.getElementById('bulk-sms-summary').textContent = 'Request failed: ' + e;
                document.getElementById('bulk-sms-results').classList.remove('hidden');
            } finally {
                sendBtn.disabled = false;
                sendBtn.textContent = 'Send';
            }
        }

        async function bulkSendOnline() {
            const selectedIds = new Set([...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value)));
            const eligible = tableState.sims.data.filter(s =>
                selectedIds.has(s.id) && s.phone_number && s.reseller_id && s.status === 'active'
            );
            if (eligible.length === 0) {
                showToast('No eligible SIMs selected (must be active with phone and reseller)', 'error');
                return;
            }
            if (!(await showConfirm('Send Webhooks', 'Send number.online webhook for ' + eligible.length + ' SIM(s)?'))) return;
            let ok = 0, fail = 0;
            for (const sim of eligible) {
                try {
                    const resp = await fetch(API_BASE + '/sim-online', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sim_id: sim.id })
                    });
                    const result = await resp.json();
                    if (resp.ok && result.ok) { ok++; } else { fail++; }
                } catch { fail++; }
            }
            showToast(ok + ' sent' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');
        }

        async function unassignReseller(simId) {
            if (!(await showConfirm('Unassign SIM', 'Unassign this SIM from its reseller? This stops webhooks and billing for this line.'))) return;
            try {
                const resp = await fetch(API_BASE + '/unassign-reseller', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: [simId] })
                });
                const result = await resp.json();
                if (result.ok) {
                    showToast('SIM unassigned from reseller', 'success');
                    loadSims(true);
                } else {
                    showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                }
            } catch (err) {
                showToast('Error unassigning: ' + err, 'error');
            }
        }

        async function assignReseller(simId) {
            const sel = document.getElementById('filter-reseller');
            const opts = [...sel.options].filter(o => o.value);
            if (opts.length === 0) {
                showToast('No resellers available', 'error');
                return;
            }
            const existing = document.getElementById('assign-reseller-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'assign-reseller-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
            const box = document.createElement('div');
            box.className = 'bg-gray-800 rounded-xl shadow-xl w-80 p-6';
            const titleEl = document.createElement('h3');
            titleEl.className = 'text-lg font-semibold text-white mb-4';
            titleEl.textContent = 'Assign to Reseller';
            const select = document.createElement('select');
            select.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-300 mb-4';
            opts.forEach(function(o) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.text;
                select.appendChild(opt);
            });
            const btnRow = document.createElement('div');
            btnRow.className = 'flex gap-2 justify-end mt-4';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = function() { modal.remove(); };
            const assignBtn = document.createElement('button');
            assignBtn.className = 'px-3 py-1.5 text-sm bg-green-700 hover:bg-green-800 text-white rounded transition';
            assignBtn.textContent = 'Assign';
            assignBtn.onclick = async function() {
                const resellerId = parseInt(select.value);
                modal.remove();
                try {
                    const resp = await fetch(API_BASE + '/assign-reseller', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })
                    });
                    const result = await resp.json();
                    if (result.ok) {
                        showToast('SIM assigned to reseller', 'success');
                        loadSims(true);
                    } else {
                        showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                    }
                } catch (err) {
                    showToast('Error assigning: ' + err, 'error');
                }
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(assignBtn);
            box.appendChild(titleEl);
            box.appendChild(select);
            box.appendChild(btnRow);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }

        async function bulkAssignReseller() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            const sel = document.getElementById('filter-reseller');
            const opts = [...sel.options].filter(o => o.value);
            if (opts.length === 0) {
                showToast('No resellers available', 'error');
                return;
            }
            const existing = document.getElementById('assign-reseller-modal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'assign-reseller-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
            const box = document.createElement('div');
            box.className = 'bg-gray-800 rounded-xl shadow-xl w-80 p-6';
            const titleEl = document.createElement('h3');
            titleEl.className = 'text-lg font-semibold text-white mb-1';
            titleEl.textContent = 'Assign to Reseller';
            const subtitle = document.createElement('p');
            subtitle.className = 'text-xs text-gray-400 mb-4';
            subtitle.textContent = simIds.length + ' SIM(s) selected';
            const select = document.createElement('select');
            select.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-300';
            opts.forEach(function(o) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.text;
                select.appendChild(opt);
            });
            const btnRow = document.createElement('div');
            btnRow.className = 'flex gap-2 justify-end mt-4';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = function() { modal.remove(); };
            const assignBtn = document.createElement('button');
            assignBtn.className = 'px-3 py-1.5 text-sm bg-green-700 hover:bg-green-800 text-white rounded transition';
            assignBtn.textContent = 'Assign';
            assignBtn.onclick = async function() {
                const resellerId = parseInt(select.value);
                modal.remove();
                let assigned = 0, failed = 0;
                for (const simId of simIds) {
                    try {
                        const resp = await fetch(API_BASE + '/assign-reseller', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })
                        });
                        const result = await resp.json();
                        if (result.ok) assigned++; else failed++;
                    } catch (err) {
                        failed++;
                    }
                }
                if (failed) showToast(assigned + ' assigned, ' + failed + ' failed', 'error');
                else showToast(assigned + ' SIM(s) assigned to reseller', 'success');
                loadSims(true);
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(assignBtn);
            box.appendChild(titleEl);
            box.appendChild(subtitle);
            box.appendChild(select);
            box.appendChild(btnRow);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }

        async function bulkAssignResellerAndNotify() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            const sel = document.getElementById('filter-reseller');
            const opts = [...sel.options].filter(o => o.value);
            if (opts.length === 0) { showToast('No resellers available', 'error'); return; }
            const existing = document.getElementById('assign-reseller-modal');
            if (existing) existing.remove();
            const modal = document.createElement('div');
            modal.id = 'assign-reseller-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
            const box = document.createElement('div');
            box.className = 'bg-gray-800 rounded-xl shadow-xl w-80 p-6';
            const titleEl = document.createElement('h3');
            titleEl.className = 'text-lg font-semibold text-white mb-1';
            titleEl.textContent = 'Assign + Notify';
            const subtitle = document.createElement('p');
            subtitle.className = 'text-xs text-gray-400 mb-4';
            subtitle.textContent = simIds.length + ' SIM(s) — assigns reseller then sends number.online for active SIMs';
            const select = document.createElement('select');
            select.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-300';
            opts.forEach(function(o) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.text;
                select.appendChild(opt);
            });
            const btnRow = document.createElement('div');
            btnRow.className = 'flex gap-2 justify-end mt-4';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = function() { modal.remove(); };
            const assignBtn = document.createElement('button');
            assignBtn.className = 'px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded transition';
            assignBtn.textContent = 'Assign & Notify';
            assignBtn.onclick = async function() {
                const resellerId = parseInt(select.value);
                modal.remove();
                let assigned = 0, notified = 0, failed = 0;
                for (const simId of simIds) {
                    try {
                        const resp = await fetch(API_BASE + '/assign-reseller', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })
                        });
                        const result = await resp.json();
                        if (result.ok) {
                            assigned++;
                            const simData = tableState.sims.data.find(s => s.id === simId);
                            if (simData && simData.status === 'active' && simData.phone_number) {
                                try {
                                    const onlineResp = await fetch(API_BASE + '/sim-online', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ sim_id: simId })
                                    });
                                    const onlineResult = await onlineResp.json();
                                    if (onlineResp.ok && onlineResult.ok) notified++;
                                } catch (e) {}
                            }
                        } else { failed++; }
                    } catch (e) { failed++; }
                }
                const msg = assigned + ' assigned, ' + notified + ' notified' + (failed ? ', ' + failed + ' failed' : '');
                showToast(msg, failed ? 'error' : 'success');
                loadSims(true);
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(assignBtn);
            box.appendChild(titleEl);
            box.appendChild(subtitle);
            box.appendChild(select);
            box.appendChild(btnRow);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }

        async function bulkModifyImei() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            const singleMode = simIds.length === 1;
            const existing = document.getElementById('bulk-imei-modal');
            if (existing) existing.remove();
            const modal = document.createElement('div');
            modal.id = 'bulk-imei-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
            const box = document.createElement('div');
            box.className = 'bg-gray-800 rounded-xl shadow-xl w-96 p-6';
            const titleEl = document.createElement('h3');
            titleEl.className = 'text-lg font-semibold text-white mb-1';
            titleEl.textContent = 'Modify IMEI';
            const subtitle = document.createElement('p');
            subtitle.className = 'text-xs text-gray-400 mb-4';
            subtitle.textContent = simIds.length + ' SIM(s) selected — SIMs must have gateway_id and port set';
            const modeDiv = document.createElement('div');
            modeDiv.className = 'mb-4';
            const autoLabel = document.createElement('label');
            autoLabel.className = 'flex items-center gap-2 text-sm text-gray-300 cursor-pointer mb-2';
            const autoRadio = document.createElement('input');
            autoRadio.type = 'radio';
            autoRadio.name = 'imei-mode';
            autoRadio.value = 'auto';
            autoRadio.checked = true;
            autoLabel.appendChild(autoRadio);
            autoLabel.appendChild(document.createTextNode('Auto (pick from pool)'));
            modeDiv.appendChild(autoLabel);
            const manualLabel = document.createElement('label');
            manualLabel.className = 'flex items-center gap-2 text-sm text-gray-300 cursor-pointer mb-2';
            const manualRadio = document.createElement('input');
            manualRadio.type = 'radio';
            manualRadio.name = 'imei-mode';
            manualRadio.value = 'manual';
            if (!singleMode) manualRadio.disabled = true;
            manualLabel.appendChild(manualRadio);
            manualLabel.appendChild(document.createTextNode('Manual IMEI' + (singleMode ? '' : ' (single SIM only)')));
            const imeiInput = document.createElement('input');
            imeiInput.type = 'text';
            imeiInput.placeholder = '15-digit IMEI';
            imeiInput.maxLength = 15;
            imeiInput.disabled = true;
            imeiInput.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded px-3 py-1.5 text-gray-300 font-mono mt-1';
            modeDiv.appendChild(manualLabel);
            modeDiv.appendChild(imeiInput);
            autoRadio.onchange = function() { imeiInput.disabled = true; };
            manualRadio.onchange = function() { imeiInput.disabled = false; imeiInput.focus(); };
            const btnRow = document.createElement('div');
            btnRow.className = 'flex gap-2 justify-end mt-4';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.onclick = function() { modal.remove(); };
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'px-3 py-1.5 text-sm bg-violet-600 hover:bg-violet-700 text-white rounded transition';
            confirmBtn.textContent = 'Apply';
            confirmBtn.onclick = async function() {
                const isAuto = autoRadio.checked;
                let manualImei = null;
                if (!isAuto) {
                    manualImei = imeiInput.value.trim();
                    if (!/^\d{15}$/.test(manualImei)) { showToast('Enter a valid 15-digit IMEI', 'error'); return; }
                }
                if (!(await showConfirm('Change IMEI', (isAuto ? 'Auto-assign new IMEI from pool' : 'Change IMEI to ' + manualImei) + ' for ' + simIds.length + ' SIM(s)?'))) return;
                modal.remove();
                let ok = 0, fail = 0;
                for (const simId of simIds) {
                    try {
                        const bodyObj = { sim_id: simId, action: 'change_imei', auto_imei: isAuto };
                        if (!isAuto) bodyObj.new_imei = manualImei;
                        const resp = await fetch(API_BASE + '/sim-action', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(bodyObj)
                        });
                        const result = await resp.json();
                        if (result.ok) { ok++; } else { fail++; }
                    } catch (e) { fail++; }
                }
                showToast(ok + ' IMEI(s) changed' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');
                loadSims(true);
                loadImeiPool();
            };
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(confirmBtn);
            box.appendChild(titleEl);
            box.appendChild(subtitle);
            box.appendChild(modeDiv);
            box.appendChild(btnRow);
            modal.appendChild(box);
            document.body.appendChild(modal);
        }


        async function bulkUnassignReseller() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            if (!(await showConfirm('Unassign SIMs', 'Unassign ' + simIds.length + ' SIM(s) from their resellers? This stops webhooks and billing.'))) return;
            try {
                const resp = await fetch(API_BASE + '/unassign-reseller', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_ids: simIds })
                });
                const result = await resp.json();
                if (result.ok) {
                    showToast(result.unassigned + ' SIM(s) unassigned', 'success');
                    loadSims(true);
                } else {
                    showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                }
            } catch (err) {
                showToast('Error unassigning: ' + err, 'error');
            }
        }

        async function bulkErrorAction(action) {
            const simIds = [...document.querySelectorAll('.error-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            if (!(await showConfirm('Run Action', \`Run \${action} on \${simIds.length} SIM(s)?\`))) return;
            for (const id of simIds) {
                await simAction(id, action, true);
            }
            loadErrors();
        }

        // ===== IMEI Sync/Block =====
        async function syncAllGatewayImeis() {
            const btn = document.getElementById('sync-gateways-btn');
            btn.textContent = 'Syncing...';
            btn.disabled = true;
            try {
                const gwResp = await fetch(\`\${API_BASE}/gateways\`);
                const gateways = await gwResp.json();
                let totalAdded = 0, totalInSync = 0;
                const allDiscrepancies = [];
                for (const gw of gateways) {
                    try {
                        const res = await fetch(\`\${API_BASE}/import-gateway-imeis\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ gateway_id: gw.id })
                        });
                        const data = await res.json();
                        if (data.ok) {
                            totalAdded += data.added || 0;
                            totalInSync += data.in_sync || 0;
                            if (data.discrepancies && data.discrepancies.length > 0) {
                                data.discrepancies.forEach(d => allDiscrepancies.push(Object.assign({}, d, { gateway_id: gw.id, gateway_name: gw.name || gw.code })));
                            }
                        }
                    } catch {}
                }
                showToast(\`Sync complete: \${totalAdded} added, \${totalInSync} in sync\`, 'success');
                if (allDiscrepancies.length > 0) showDiscrepancyModal(allDiscrepancies);
                loadImeiPool();
            } catch (error) {
                showToast('Sync error: ' + error, 'error');
            } finally {
                btn.textContent = 'Sync from Gateways';
                btn.disabled = false;
            }
        }

        async function fixSlot(gateway_id, port, db_imei, gateway_imei, btn) {
            btn.textContent = 'Fixing...';
            btn.disabled = true;
            try {
                const res = await fetch(\`\${API_BASE}/imei-pool/fix-slot\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id, port, db_imei, gateway_imei }),
                });
                const data = await res.json();
                if (data.ok) {
                    btn.textContent = 'Fixed ✓';
                    btn.disabled = true;
                    btn.style.background = '#15803d';
                } else {
                    btn.textContent = 'Fix';
                    btn.disabled = false;
                    showToast('Fix failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (err) {
                btn.textContent = 'Fix';
                btn.disabled = false;
                showToast('Fix error: ' + err, 'error');
            }
        }

        async function fixAllSlots() {
            const list = window._discrepancies || [];
            for (let i = 0; i < list.length; i++) {
                const btn = document.getElementById('fix-btn-' + i);
                if (btn && !btn.disabled) {
                    await fixSlot(list[i].gateway_id, list[i].port, list[i].db_imei, list[i].gateway_imei, btn);
                }
            }
            loadImeiPool();
        }

        // ===== IMEI Eligibility =====
        window._imeiEligibilityContext = null;

        async function checkImeiEligibility(imei, gatewayId, port, status) {
            window._imeiEligibilityContext = { imei, gatewayId, port, status };
            const modal = document.getElementById('imei-eligibility-modal');
            document.getElementById('imei-eligibility-title').textContent = 'IMEI Check: ' + imei;
            document.getElementById('imei-eligibility-content').innerHTML = '<p class="text-gray-400">Checking eligibility...</p>';
            document.getElementById('imei-eligibility-fix-btn').classList.add('hidden');
            modal.classList.remove('hidden');

            try {
                const res = await fetch(API_BASE + '/check-imei?imei=' + encodeURIComponent(imei));
                const data = await res.json();
                const el = document.getElementById('imei-eligibility-content');
                if (data.eligible) {
                    const deviceInfo = (data.result && (data.result.brand || data.result.deviceType)) || '';
                    const plans = Array.isArray(data.result && data.result.plans) ? data.result.plans.map(function(p) { return p.name || p.planName || JSON.stringify(p); }).join(', ') : '';
                    el.innerHTML = '<div class="space-y-3">' +
                        '<p><span class="inline-block px-2 py-0.5 text-xs rounded-full bg-accent/20 text-accent font-medium">&#10003; Eligible</span></p>' +
                        (deviceInfo ? '<p class="text-gray-400">Device: <span class="text-gray-200">' + deviceInfo + '</span></p>' : '') +
                        (plans ? '<p class="text-gray-400">Plans: <span class="text-gray-200">' + plans + '</span></p>' : '') +
                        '<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">Raw response</summary><pre class="mt-1 text-xs font-mono text-gray-400 overflow-x-auto bg-dark-900 p-2 rounded">' + JSON.stringify(data.result, null, 2) + '</pre></details>' +
                        '</div>';
                } else {
                    el.innerHTML = '<div class="space-y-3">' +
                        '<p><span class="inline-block px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 font-medium">&#10007; Not Eligible</span></p>' +
                        (data.error ? '<p class="text-red-400 text-xs">' + data.error + '</p>' : '') +
                        '<details class="mt-2"><summary class="text-xs text-gray-500 cursor-pointer">Raw response</summary><pre class="mt-1 text-xs font-mono text-gray-400 overflow-x-auto bg-dark-900 p-2 rounded">' + JSON.stringify(data.result || {}, null, 2) + '</pre></details>' +
                        '</div>';
                    if (status === 'in_use' && gatewayId && port) {
                        document.getElementById('imei-eligibility-fix-btn').classList.remove('hidden');
                    }
                }
            } catch (err) {
                document.getElementById('imei-eligibility-content').innerHTML = '<p class="text-red-400">Error: ' + err + '</p>';
            }
        }

        async function fixIncompatibleImei() {
            const ctx = window._imeiEligibilityContext;
            if (!ctx || !ctx.imei || !ctx.gatewayId || !ctx.port) { showToast('Missing context for fix', 'error'); return; }
            const fixBtn = document.querySelector('#imei-eligibility-fix-btn button');
            if (fixBtn) { fixBtn.disabled = true; fixBtn.textContent = 'Fixing...'; }
            try {
                const res = await fetch(API_BASE + '/imei-pool/fix-incompatible', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imei: ctx.imei, gateway_id: ctx.gatewayId, port: ctx.port }),
                });
                const data = await res.json();
                const el = document.getElementById('imei-eligibility-content');
                if (data.ok) {
                    el.innerHTML += '<div class="mt-4 p-3 bg-accent/10 border border-accent/30 rounded-lg"><p class="text-accent font-medium text-sm">&#10003; Fixed!</p><p class="text-gray-300 text-xs mt-1">New IMEI: <span class="font-mono">' + data.new_imei + '</span></p></div>';
                    document.getElementById('imei-eligibility-fix-btn').classList.add('hidden');
                    loadImeiPool();
                } else {
                    el.innerHTML += '<div class="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg"><p class="text-red-400 text-sm">Fix failed: ' + (data.error || 'Unknown error') + '</p></div>';
                }
            } catch (err) {
                showToast('Fix error: ' + err, 'error');
            } finally {
                if (fixBtn) { fixBtn.disabled = false; fixBtn.textContent = 'Fix (Replace with Pool IMEI)'; }
            }
        }

        // ===== Bulk IMEI Check Tool =====
        function showCheckImeisModal() {
            document.getElementById('check-imeis-input').value = '';
            document.getElementById('check-imeis-result').classList.add('hidden');
            document.getElementById('check-imeis-modal').classList.remove('hidden');
        }

        async function runBulkImeiCheck() {
            const raw = document.getElementById('check-imeis-input').value.trim();
            const imeis = raw.split(/\\n/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
            if (imeis.length === 0) { showToast('Enter at least one IMEI', 'error'); return; }
            const btn = document.getElementById('check-imeis-run-btn');
            btn.disabled = true; btn.textContent = 'Checking...';
            try {
                const res = await fetch(API_BASE + '/check-imeis', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imeis: imeis }),
                });
                const data = await res.json();
                const tbody = document.getElementById('check-imeis-tbody');
                if (Array.isArray(data.results)) {
                    tbody.innerHTML = data.results.map(function(r) {
                        const eligClass = r.eligible ? 'text-accent' : 'text-red-400';
                        const eligText = r.eligible ? '&#10003; Yes' : '&#10007; No';
                        const device = (r.result && (r.result.brand || r.result.deviceType)) || '-';
                        const plans = Array.isArray(r.result && r.result.plans) ? r.result.plans.length + ' plan(s)' : '-';
                        return '<tr class="border-b border-dark-600"><td class="py-2 pr-4 font-mono text-xs">' + r.imei + '</td><td class="py-2 pr-4 ' + eligClass + ' text-sm">' + eligText + '</td><td class="py-2 pr-4 text-gray-400 text-xs">' + device + '</td><td class="py-2 text-gray-400 text-xs">' + plans + '</td></tr>';
                    }).join('');
                } else {
                    tbody.innerHTML = '<tr><td colspan="4" class="py-3 text-red-400">' + (data.error || 'Unknown error') + '</td></tr>';
                }
                document.getElementById('check-imeis-result').classList.remove('hidden');
            } catch (err) {
                showToast('Check error: ' + err, 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Run Check';
            }
        }

        // ===== Change IMEI =====
        window._changeImeiContext = null;

        function showChangeImeiModal(simId, iccid, gatewayId, port) {
            window._changeImeiContext = { simId: simId, iccid: iccid, gatewayId: gatewayId, port: port };
            document.getElementById('change-imei-title').textContent = 'Change IMEI — SIM ' + simId;
            document.getElementById('change-imei-sim-info').textContent = 'ICCID: ' + iccid + ' | Gateway: ' + gatewayId + ' | Port: ' + port;
            document.getElementById('change-imei-input').value = '';
            document.getElementById('change-imei-eligibility-result').textContent = '';
            document.getElementById('change-imei-result-section').classList.add('hidden');
            document.getElementById('change-imei-modal').classList.remove('hidden');
        }

        async function checkManualImeiEligibility() {
            const imei = document.getElementById('change-imei-input').value.trim();
            if (!/^\d{15}$/.test(imei)) {
                document.getElementById('change-imei-eligibility-result').innerHTML = '<span class="text-yellow-400">Enter a valid 15-digit IMEI first</span>';
                return;
            }
            document.getElementById('change-imei-eligibility-result').innerHTML = '<span class="text-gray-400">Checking...</span>';
            try {
                const res = await fetch(API_BASE + '/check-imei?imei=' + encodeURIComponent(imei));
                const data = await res.json();
                if (data.eligible) {
                    document.getElementById('change-imei-eligibility-result').innerHTML = '<span class="text-accent">&#10003; Eligible</span>';
                } else {
                    document.getElementById('change-imei-eligibility-result').innerHTML = '<span class="text-red-400">&#10007; Not eligible for this carrier/plan</span>';
                }
            } catch (err) {
                document.getElementById('change-imei-eligibility-result').innerHTML = '<span class="text-red-400">Check failed: ' + err + '</span>';
            }
        }

        async function confirmChangeImei(autoImei) {
            const ctx = window._changeImeiContext;
            if (!ctx) { showToast('No SIM context', 'error'); return; }
            let newImei = null;
            if (!autoImei) {
                newImei = document.getElementById('change-imei-input').value.trim();
                if (!/^\d{15}$/.test(newImei)) { showToast('Enter a valid 15-digit IMEI or use Auto', 'error'); return; }
                if (!(await showConfirm('Change IMEI', 'Change IMEI for SIM ' + ctx.simId + ' to ' + newImei + '?'))) return;
            } else {
                if (!(await showConfirm('Change IMEI', 'Auto-pick an available IMEI from pool and apply to SIM ' + ctx.simId + '?'))) return;
            }
            const autoBtn = document.getElementById('change-imei-auto-btn');
            const confirmBtn = document.getElementById('change-imei-confirm-btn');
            if (autoImei && autoBtn) { autoBtn.disabled = true; autoBtn.textContent = 'Working...'; }
            if (!autoImei && confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Working...'; }
            try {
                const body = { sim_id: ctx.simId, action: 'change_imei', auto_imei: autoImei };
                if (!autoImei) body.new_imei = newImei;
                const res = await fetch(API_BASE + '/sim-action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                const data = await res.json();
                document.getElementById('change-imei-output').textContent = JSON.stringify(data, null, 2);
                document.getElementById('change-imei-result-section').classList.remove('hidden');
                if (data.ok) {
                    document.getElementById('sim-action-title').textContent = 'Change IMEI — ' + ctx.iccid;
                    document.getElementById('sim-action-output').textContent = JSON.stringify(data, null, 2);
                    document.getElementById('sim-action-logs-section').classList.remove('hidden');
                    window._simActionIccid = ctx.iccid;
                    document.getElementById('change-imei-modal').classList.add('hidden');
                    document.getElementById('sim-action-modal').classList.remove('hidden');
                    loadSimActionLogs();
                    loadImeiPool();
                    loadSims(true);
                }
            } catch (err) {
                showToast('Change IMEI error: ' + err, 'error');
            } finally {
                if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = 'Auto (Pick from Pool)'; }
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Change IMEI'; }
            }
        }

        function showDiscrepancyModal(discrepancies) {
            const existing = document.getElementById('discrepancy-modal');
            if (existing) existing.remove();
            window._discrepancies = discrepancies;

            const modal = document.createElement('div');
            modal.id = 'discrepancy-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';

            const container = document.createElement('div');
            container.className = 'bg-gray-800 rounded-xl shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col';

            const headerDiv = document.createElement('div');
            headerDiv.className = 'flex items-center justify-between p-4 border-b border-gray-700';

            const title = document.createElement('h3');
            title.className = 'text-lg font-semibold text-white';
            title.textContent = 'IMEI Discrepancies (' + discrepancies.length + ')';

            const btnGroup = document.createElement('div');
            btnGroup.className = 'flex gap-2';

            const fixAllBtn = document.createElement('button');
            fixAllBtn.className = 'px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition';
            fixAllBtn.textContent = 'Fix All';
            fixAllBtn.onclick = fixAllSlots;

            const closeBtn = document.createElement('button');
            closeBtn.className = 'px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition';
            closeBtn.textContent = 'Close';
            closeBtn.onclick = function() {
                const m = document.getElementById('discrepancy-modal');
                if (m) m.remove();
            };

            btnGroup.appendChild(fixAllBtn);
            btnGroup.appendChild(closeBtn);
            headerDiv.appendChild(title);
            headerDiv.appendChild(btnGroup);

            const note = document.createElement('p');
            note.className = 'text-xs text-gray-400 px-4 pt-3';
            note.textContent = 'DB (green) is the source of truth. Fix pushes the DB IMEI to the gateway slot and retires the wrong IMEI.';

            const tableWrap = document.createElement('div');
            tableWrap.className = 'overflow-auto flex-1 p-4';

            const table = document.createElement('table');
            table.className = 'w-full text-sm text-left';
            table.innerHTML =
                '<thead><tr class="text-gray-400 text-xs border-b border-gray-700">' +
                '<th class="py-2 px-3">Gateway</th>' +
                '<th class="py-2 px-3">Port/Slot</th>' +
                '<th class="py-2 px-3">DB IMEI (correct)</th>' +
                '<th class="py-2 px-3">Gateway IMEI (wrong)</th>' +
                '<th class="py-2 px-3"></th>' +
                '</tr></thead><tbody></tbody>';

            const tbody = table.querySelector('tbody');
            discrepancies.forEach(function(d, i) {
                const tr = document.createElement('tr');
                tr.className = 'border-b border-gray-700';
                tr.innerHTML =
                    '<td class="py-2 px-3 text-gray-300">' + (d.gateway_name || 'GW ' + d.gateway_id) + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm">' + d.port + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm text-green-400">' + d.db_imei + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm text-red-400">' + d.gateway_imei + '</td>' +
                    '<td class="py-2 px-3"></td>';
                const fixBtn = document.createElement('button');
                fixBtn.id = 'fix-btn-' + i;
                fixBtn.className = 'px-3 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition';
                fixBtn.textContent = 'Fix';
                (function(gwId, p, dbI, gwI, b) {
                    b.onclick = function() { fixSlot(gwId, p, dbI, gwI, b); };
                })(d.gateway_id, d.port, d.db_imei, d.gateway_imei, fixBtn);
                tr.querySelector('td:last-child').appendChild(fixBtn);
                tbody.appendChild(tr);
            });

            tableWrap.appendChild(table);
            container.appendChild(headerDiv);
            container.appendChild(note);
            container.appendChild(tableWrap);
            modal.appendChild(container);
            document.body.appendChild(modal);
        }

        async function unretireImei(id) {
            if (!(await showConfirm('Restore IMEI', 'Restore this IMEI to available stock?'))) return;
            try {
                const r = await fetch(\`\${API_BASE}/imei-pool\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'unretire', id })
                });
                const res = await r.json();
                showToast(res.ok ? 'IMEI restored to available' : \`Error: \${res.error}\`, res.ok ? 'success' : 'error');
                loadImeiPool();
            } catch (error) {
                showToast('Error restoring IMEI', 'error');
            }
        }


        // ===== Billing =====
        let invoicePreviewData = null;

        async function loadBillingResellers() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-mappings\`);
                if (!resp.ok) return;
                const mappings = await resp.json();
                const sel = document.getElementById("invoice-reseller");
                sel.innerHTML = '<option value="">-- Select Reseller --</option>';
                mappings.forEach(m => {
                    const opt = document.createElement("option");
                    opt.value = m.reseller_id || "";
                    opt.textContent = m.reseller_name || m.qbo_display_name || String(m.reseller_id);
                    sel.appendChild(opt);
                });
            } catch (e) { console.error("loadBillingResellers:", e); }
        }

        async function loadMappings() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-mappings\`);
                if (!resp.ok) { document.getElementById("mapping-table").innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No entries yet</td></tr>'; return; }
                const mappings = await resp.json();
                const tbody = document.getElementById("mapping-table");
                if (!mappings.length) { tbody.innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No entries yet</td></tr>'; return; }
                tbody.innerHTML = mappings.map(m => \`
                    <tr class="border-b border-dark-600">
                        <td class="px-4 py-3 text-gray-300">\${m.reseller_name || "-"}</td>
                        <td class="px-4 py-3 text-gray-300">\${m.qbo_display_name || "-"}</td>
                        <td class="px-4 py-3 text-gray-300">$\${Number(m.daily_rate).toFixed(2)}</td>
                        <td class="px-4 py-3 text-gray-300">\${m.sim_count || "-"}</td>
                        <td class="px-4 py-3"><button onclick="deleteMapping(\${m.id})" class="text-xs text-red-400 hover:text-red-300">Delete</button></td>
                    </tr>
                \`).join("");
            } catch (error) {
                console.error("Error loading mappings:", error);
            }
        }

        function showAddMappingModal() {
            document.getElementById("mapping-customer-name").value = "";
            document.getElementById("mapping-rate").value = "0.50";
            const sel = document.getElementById("mapping-reseller");
            sel.innerHTML = '<option value="">-- Select Reseller --</option>';
            fetch(\`\${API_BASE}/resellers\`).then(r => r.json()).then(resellers => {
                resellers.forEach(r => {
                    const opt = document.createElement("option");
                    opt.value = r.id; opt.textContent = r.name;
                    sel.appendChild(opt);
                });
            });
            document.getElementById("add-mapping-modal").classList.remove("hidden");
        }

        function closeMappingModal() {
            document.getElementById("add-mapping-modal").classList.add("hidden");
        }

        async function saveMapping() {
            const resellerId = document.getElementById("mapping-reseller").value;
            const customerName = document.getElementById("mapping-customer-name").value.trim();
            const rate = document.getElementById("mapping-rate").value;
            if (!customerName) { showToast("Enter a customer name", "error"); return; }
            try {
                const body = {
                    reseller_id: resellerId ? parseInt(resellerId) : null,
                    qbo_customer_id: customerName,
                    qbo_display_name: customerName,
                    daily_rate: parseFloat(rate)
                };
                const resp = await fetch(\`\${API_BASE}/qbo-mappings\`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (resp.ok) {
                    showToast("Saved", "success");
                    closeMappingModal();
                    loadMappings();
                    loadBillingResellers();
                } else {
                    const err = await resp.json();
                    showToast("Error: " + (err.error || JSON.stringify(err)), "error");
                }
            } catch (error) {
                showToast("Error saving: " + error, "error");
            }
        }

        async function deleteMapping(id) {
            if (!(await showConfirm('Delete Entry', "Delete this entry?"))) return;
            try {
                await fetch(\`\${API_BASE}/qbo-mappings?id=\${id}\`, { method: "DELETE" });
                showToast("Deleted", "success");
                loadMappings();
                loadBillingResellers();
            } catch (error) {
                showToast("Error: " + error, "error");
            }
        }

        async function previewInvoices() {
            const resellerId = document.getElementById("invoice-reseller").value;
            const start = document.getElementById("invoice-start").value;
            const end = document.getElementById("invoice-end").value;
            if (!resellerId || !start || !end) { showToast("Select reseller and date range", "error"); return; }
            try {
                const resp = await fetch(\`\${API_BASE}/billing/preview?reseller_id=\${encodeURIComponent(resellerId)}&start=\${start}&end=\${end}\`);
                const data = await resp.json();
                if (data.error) { showToast(data.error, "error"); return; }
                invoicePreviewData = data;
                if (!data.days || data.days.length === 0) {
                    document.getElementById("invoice-preview").innerHTML = '<p class="text-gray-500">No billable SIM-days in this range.</p>';
                    document.getElementById("download-invoice-btn").classList.add("hidden");
                    return;
                }
                if (!data.mapping) {
                    document.getElementById("invoice-preview").innerHTML = '<p class="text-yellow-400">No customer rate configured for this reseller. Add one in Customer Rates above.</p>';
                    document.getElementById("download-invoice-btn").classList.add("hidden");
                    return;
                }
                let html = '<div class="mb-3 text-sm text-gray-400">Customer: <span class="text-white">' + data.mapping.qbo_display_name + '</span> &nbsp;·&nbsp; Daily Rate: <span class="text-accent">$' + Number(data.daily_rate).toFixed(2) + '</span></div>';
                html += '<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-500 border-b border-dark-600"><th class="py-2 pr-4">Date (EST)</th><th class="py-2 pr-4">SIMs w/ SMS</th><th class="py-2">Amount</th></tr></thead><tbody>';
                data.days.forEach(d => {
                    html += \`<tr class="border-b border-dark-700"><td class="py-2 pr-4 text-gray-300">\${d.date}</td><td class="py-2 pr-4 text-gray-300">\${d.sim_count}</td><td class="py-2 text-gray-300">$\${Number(d.amount).toFixed(2)}</td></tr>\`;
                });
                html += \`<tr class="border-t border-dark-500"><td class="py-2 pr-4 text-white font-semibold">Total</td><td class="py-2 pr-4 text-white font-semibold">\${data.total_sim_days} SIM-days</td><td class="py-2 text-accent font-bold">$\${Number(data.total_amount).toFixed(2)}</td></tr>\`;
                html += "</tbody></table></div>";
                document.getElementById("invoice-preview").innerHTML = html;
                document.getElementById("download-invoice-btn").classList.remove("hidden");
            } catch (error) {
                showToast("Error previewing: " + error, "error");
            }
        }

        async function downloadInvoiceIIF() {
            if (!invoicePreviewData || !invoicePreviewData.days || invoicePreviewData.days.length === 0) return;
            const resellerId = document.getElementById("invoice-reseller").value;
            const start = document.getElementById("invoice-start").value;
            const end = document.getElementById("invoice-end").value;
            try {
                const resp = await fetch(\`\${API_BASE}/billing/download-invoice?reseller_id=\${encodeURIComponent(resellerId)}&start=\${start}&end=\${end}\`);
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    showToast("Error: " + (err.error || resp.statusText), "error");
                    return;
                }
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                const filename = \`invoice_\${invoicePreviewData.mapping?.qbo_display_name?.replace(/[^a-z0-9]/gi, "_") || resellerId}_\${start}_\${end}.csv\`;
                a.href = url; a.download = filename; a.click();
                URL.revokeObjectURL(url);
                showToast("Downloaded CSV — import via QuickBooks > Invoices > Import", "success");
                loadInvoiceHistory();
            } catch (error) {
                showToast("Error downloading: " + error, "error");
            }
        }

        async function downloadHistoryIIF(invoiceId) {
            try {
                const resp = await fetch(\`\${API_BASE}/billing/download-invoice?invoice_id=\${invoiceId}\`);
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    showToast("Error: " + (err.error || resp.statusText), "error");
                    return;
                }
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url; a.download = \`invoice_\${invoiceId}.csv\`; a.click();
                URL.revokeObjectURL(url);
            } catch (error) {
                showToast("Error: " + error, "error");
            }
        }

        async function loadInvoiceHistory() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-invoices\`);
                if (!resp.ok) return;
                const invoices = await resp.json();
                const tbody = document.getElementById("invoice-history-table");
                if (!invoices.length) { tbody.innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No invoices yet</td></tr>'; return; }
                tbody.innerHTML = invoices.map(inv => \`
                    <tr class="border-b border-dark-600">
                        <td class="px-4 py-3 text-gray-300">\${inv.customer_name || "-"}</td>
                        <td class="px-4 py-3 text-gray-400 text-xs">\${inv.week_start} – \${inv.week_end}</td>
                        <td class="px-4 py-3 text-gray-300">\${inv.sim_count}</td>
                        <td class="px-4 py-3 text-accent">$\${Number(inv.total).toFixed(2)}</td>
                        <td class="px-4 py-3"><button onclick="downloadHistoryIIF(\${inv.id})" class="text-xs text-blue-400 hover:text-blue-300">Download CSV</button></td>
                    </tr>\`
                ).join("");
            } catch (error) {
                console.error("Error loading invoice history:", error);
            }
        }

        // ===== Wing Bill Verification =====

        async function uploadWingBill() {
            const fileInput = document.getElementById('wing-csv-file');
            if (!fileInput.files.length) { showToast('Select a CSV file first', 'error'); return; }
            const file = fileInput.files[0];
            const btn = document.getElementById('wing-upload-btn');
            btn.disabled = true; btn.textContent = 'Verifying...';
            try {
                const formData = new FormData();
                formData.append('file', file);
                const resp = await fetch(API_BASE + '/wing-bill/upload', {
                    method: 'POST',
                    credentials: 'include',
                    body: formData,
                });
                const data = await resp.json();
                if (data.error) { showToast(data.error, 'error'); return; }
                window._wingUploadId = data.upload_id;
                renderWingResults(data);
                loadWingHistory();
                showToast('Verification complete: ' + data.discrepancy_count + ' discrepancies, $' + Number(data.overcharge_amount).toFixed(2) + ' overcharge',
                    data.discrepancy_count > 0 ? 'error' : 'success');
            } catch (e) {
                showToast('Upload failed: ' + e, 'error');
            } finally {
                btn.disabled = false; btn.textContent = 'Verify Bill';
            }
        }

        function renderWingResults(data) {
            document.getElementById('wing-summary').classList.remove('hidden');
            document.getElementById('wing-total-rows').textContent = data.total_rows;
            document.getElementById('wing-total-amount').textContent = '$' + Number(data.total_amount).toFixed(2);
            document.getElementById('wing-total-expected').textContent = '$' + Number(data.total_expected).toFixed(2);
            document.getElementById('wing-overcharge').textContent = '$' + Number(data.overcharge_amount).toFixed(2);
            const discEl = document.getElementById('wing-discrepancy-count');
            discEl.textContent = data.discrepancy_count;
            discEl.className = 'text-xl font-bold ' + (data.discrepancy_count > 0 ? 'text-red-400' : 'text-accent');
            document.getElementById('wing-missing-count').textContent = data.missing_count || 0;

            const typeColors = {
                'not_billable': 'text-red-400',
                'overcharge': 'text-orange-400',
                'unknown_iccid': 'text-purple-400',
                'rate_mismatch': 'text-yellow-400',
                'duplicate_charge': 'text-pink-400',
            };
            const typeLabels = {
                'not_billable': 'Not Billable',
                'overcharge': 'Overcharge',
                'unknown_iccid': 'Unknown ICCID',
                'rate_mismatch': 'Rate Mismatch',
                'duplicate_charge': 'Duplicate',
            };

            const discSection = document.getElementById('wing-discrepancies');
            const discTable = document.getElementById('wing-discrepancy-table');
            if (data.discrepancies && data.discrepancies.length > 0) {
                discSection.classList.remove('hidden');
                discTable.innerHTML = data.discrepancies.map(d => '<tr class="border-b border-dark-700">' +
                    '<td class="px-3 py-2 ' + (typeColors[d.discrepancy_type] || 'text-gray-300') + ' font-medium text-xs">' + (typeLabels[d.discrepancy_type] || d.discrepancy_type) + '</td>' +
                    '<td class="px-3 py-2 text-gray-300 font-mono text-xs">' + (d.subscription_iccid || '-') + '</td>' +
                    '<td class="px-3 py-2 text-gray-400">' + (d.description || '-') + '</td>' +
                    '<td class="px-3 py-2 text-gray-400 text-xs">' + formatWingDate(d.from_date) + ' - ' + formatWingDate(d.to_date) + '</td>' +
                    '<td class="px-3 py-2 text-gray-300">$' + Number(d.price).toFixed(2) + '</td>' +
                    '<td class="px-3 py-2 text-accent">$' + Number(d.expected_price || 0).toFixed(2) + '</td>' +
                    '<td class="px-3 py-2 text-gray-400">' + (d.billable_days != null ? d.billable_days + '/' + d.total_days : '-') + '</td>' +
                    '<td class="px-3 py-2 text-gray-400">' + (d.sim_status || 'N/A') + '</td>' +
                    '<td class="px-3 py-2 text-gray-400 text-xs">' + (d.discrepancy_detail || '') + '</td>' +
                    '</tr>').join('');
            } else {
                discSection.classList.add('hidden');
            }

            const missingSection = document.getElementById('wing-missing');
            const missingTable = document.getElementById('wing-missing-table');
            if (data.missing_from_bill && data.missing_from_bill.length > 0) {
                missingSection.classList.remove('hidden');
                missingTable.innerHTML = data.missing_from_bill.map(s => '<tr class="border-b border-dark-700">' +
                    '<td class="px-3 py-2 text-gray-300">' + s.sim_id + '</td>' +
                    '<td class="px-3 py-2 text-gray-300 font-mono text-xs">' + s.iccid + '</td>' +
                    '<td class="px-3 py-2 text-gray-400">' + s.status + '</td>' +
                    '</tr>').join('');
            } else {
                missingSection.classList.add('hidden');
            }
        }

        function formatWingDate(isoStr) {
            if (!isoStr) return '-';
            const d = new Date(isoStr);
            return (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();
        }

        async function loadWingHistory() {
            try {
                const resp = await fetch(API_BASE + '/wing-bill/uploads', {
                    credentials: 'include',
                });
                if (!resp.ok) return;
                const uploads = await resp.json();
                const tbody = document.getElementById('wing-history-table');
                if (!uploads || !uploads.length) {
                    tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-4 text-center text-gray-500">No verifications yet</td></tr>';
                    return;
                }
                tbody.innerHTML = uploads.map(u => '<tr class="border-b border-dark-600">' +
                    '<td class="px-4 py-3 text-gray-400 text-xs">' + new Date(u.created_at).toLocaleString() + '</td>' +
                    '<td class="px-4 py-3 text-gray-300">' + (u.filename || '-') + '</td>' +
                    '<td class="px-4 py-3 text-gray-400 text-xs">' + (u.billing_period_start || '?') + ' - ' + (u.billing_period_end || '?') + '</td>' +
                    '<td class="px-4 py-3 text-gray-300">' + u.total_rows + '</td>' +
                    '<td class="px-4 py-3 text-gray-300">$' + Number(u.total_amount).toFixed(2) + '</td>' +
                    '<td class="px-4 py-3 ' + (u.overcharge_amount > 0 ? 'text-red-400 font-semibold' : 'text-accent') + '">$' + Number(u.overcharge_amount || 0).toFixed(2) + '</td>' +
                    '<td class="px-4 py-3 ' + (u.discrepancy_count > 0 ? 'text-red-400 font-semibold' : 'text-accent') + '">' + u.discrepancy_count + '</td>' +
                    '<td class="px-4 py-3"><button onclick="viewWingResults(' + u.id + ')" class="text-xs text-blue-400 hover:text-blue-300 mr-2">View</button>' +
                    '<button onclick="exportWingAudit(' + u.id + ')" class="text-xs text-accent hover:text-green-300">Export</button></td>' +
                    '</tr>').join('');
            } catch (e) { console.error('loadWingHistory:', e); }
        }

        async function viewWingResults(uploadId) {
            try {
                const resp = await fetch(API_BASE + '/wing-bill/results?upload_id=' + uploadId, {
                    credentials: 'include',
                });
                const data = await resp.json();
                if (data.error) { showToast(data.error, 'error'); return; }
                window._wingUploadId = uploadId;
                renderWingResults({
                    total_rows: data.upload.total_rows,
                    total_amount: data.upload.total_amount,
                    total_expected: data.upload.total_expected,
                    overcharge_amount: data.upload.overcharge_amount,
                    discrepancy_count: data.upload.discrepancy_count,
                    discrepancies: data.discrepancies,
                    missing_from_bill: [],
                    missing_count: 0,
                });
            } catch (e) { showToast('Error: ' + e, 'error'); }
        }

        function exportWingAudit(uploadId) {
            if (!uploadId) { showToast('No verification to export', 'error'); return; }
            window.open(API_BASE + '/wing-bill/export?upload_id=' + uploadId, '_blank');
        }

        // Close any visible modal on Escape key or backdrop click
        document.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape') return;
            document.querySelectorAll('[id$="-modal"]:not(.hidden)').forEach(function(m) {
                m.classList.add('hidden');
            });
        });
        document.addEventListener('click', function(e) {
            var t = e.target;
            if (t.id && t.id.endsWith('-modal') && !t.classList.contains('hidden')) {
                t.classList.add('hidden');
            }
        });

        loadGatewayDropdown();
        loadResellers();
        loadData();
        setInterval(loadData, 3600000);
        initTabFromUrl();
    </script>
        <!-- Add Mapping Modal -->
        <div id="add-mapping-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div class="bg-dark-800 rounded-xl border border-dark-600 p-6 w-full max-w-md">
                <h3 class="text-lg font-semibold text-white mb-4">Add Customer Rate</h3>
                <div class="space-y-3">
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">Reseller</label>
                        <select id="mapping-reseller" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300"></select>
                    </div>
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">Customer Name (as it appears in QuickBooks)</label>
                        <input type="text" id="mapping-customer-name" placeholder="e.g. Acme Corp" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                    </div>
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">Daily Rate ($/SIM/day)</label>
                        <input type="number" id="mapping-rate" step="0.01" value="0.50" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                    </div>
                </div>
                <div class="flex justify-end gap-3 mt-5">
                    <button onclick="closeMappingModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
                    <button onclick="saveMapping()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Save</button>
                </div>
            </div>
        </div>
        <!-- Bulk Send SMS Modal -->
        
    <!-- Message Body Modal -->
    <div id="msg-body-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onclick="hideMsgBodyModal()">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg" onclick="event.stopPropagation()">
            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                <h3 class="text-base font-semibold text-white">Message</h3>
                <button onclick="hideMsgBodyModal()" class="text-gray-500 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <p id="msg-body-text" class="text-sm text-gray-200 whitespace-pre-wrap break-words"></p>
            </div>
        </div>
    </div>

    <div id="bulk-send-sms-modal" class="fixed inset-0 bg-black/70 z-50 hidden flex items-center justify-center p-4">
            <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg">
                <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                    <h3 class="text-white font-semibold">Send Test SMS</h3>
                    <button onclick="document.getElementById('bulk-send-sms-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
                </div>
                <div class="p-5 space-y-4">
                    <p class="text-sm text-gray-400">Sending to <span id="bulk-sms-count" class="text-white font-semibold">0</span> selected SIM(s).</p>
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">Message <span class="text-xs">(max 160 chars)</span></label>
                        <textarea id="bulk-sms-message" maxlength="160" rows="3" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 resize-none">Test SMS â can you receive this message?</textarea>
                    </div>
                    <p class="text-xs text-gray-500">Sender picked randomly from active SIMs, rotated to avoid spam.</p>
                    <div id="bulk-sms-results" class="hidden">
                        <p id="bulk-sms-summary" class="text-sm text-gray-300 mb-2"></p>
                        <div class="overflow-auto max-h-64">
                            <table class="w-full text-xs">
                                <thead>
                                    <tr class="text-gray-400 border-b border-dark-600">
                                        <th class="text-left py-1 pr-3">SIM</th>
                                        <th class="text-left py-1 pr-3">MDN</th>
                                        <th class="text-left py-1 pr-3">Sender Port</th>
                                        <th class="text-left py-1">Status</th>
                                    </tr>
                                </thead>
                                <tbody id="bulk-sms-result-body" class="text-gray-300"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
                <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                    <button onclick="document.getElementById('bulk-send-sms-modal').classList.add('hidden')" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                    <button id="bulk-sms-send-btn" onclick="runBulkSendSms()" class="px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition">Send</button>
                </div>
            </div>
        </div>
    <!-- Custom Confirm Modal -->
    <div id="confirm-modal" class="fixed inset-0 z-[100] hidden items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="handleConfirm(false)"></div>
        <div class="relative bg-dark-900 border border-white/10 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div class="flex items-center gap-4 mb-4">
                <div class="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                    <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                </div>
                <h3 id="confirm-title" class="text-xl font-bold text-white tracking-tight">Confirmation Required</h3>
            </div>
            <p id="confirm-message" class="text-dark-300 mb-6 leading-relaxed">Are you sure you want to proceed with this action?</p>
            <div class="flex items-center justify-end gap-3">
                <button onclick="handleConfirm(false)" class="px-5 py-2.5 text-sm font-medium text-dark-400 hover:text-white hover:bg-white/5 rounded-xl transition-all border border-transparent hover:border-white/10">Cancel</button>
                <button id="confirm-yes-btn" onclick="handleConfirm(true)" class="px-6 py-2.5 text-sm font-bold bg-accent hover:bg-blue-600 text-white rounded-xl transition-all shadow-lg shadow-accent/20 hover:shadow-accent/40 hover:-translate-y-0.5 active:translate-y-0">Confirm Action</button>
            </div>
        </div>
    </div>
</body>
</html>`;
}
