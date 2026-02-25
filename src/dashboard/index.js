
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

    if (url.pathname === '/api/send-test-sms') {
      return handleSendTestSms(request, env, corsHeaders);
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

    if (url.pathname === '/api/sim-action' && request.method === 'POST') {
      return handleSimAction(request, env, corsHeaders);
    }

    if (url.pathname.startsWith('/api/qbo/')) {
      return handleQboRoute(request, env, corsHeaders, url);
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

    if (url.pathname === '/api/qbo-invoice-preview') {
      return handleQboInvoicePreview(url, env, corsHeaders);
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
    let query = `sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=500`;

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

    // Get SMS stats for each SIM
    // Batch SMS stats: paginate (PostgREST caps at 1000 rows/request)
    const simIds = filteredSims.map(s => s.id);
    const smsMap = {}; // sim_id -> { count, last_received }
    if (simIds.length > 0) {
      const idList = simIds.join(',');
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const smsUrl = env.SUPABASE_URL + '/rest/v1/inbound_sms?select=sim_id,received_at&sim_id=in.(' + idList + ')&received_at=gte.' + since + '&order=sim_id,received_at.desc&limit=1000';
      const smsResp = await fetch(smsUrl, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
          Accept: 'application/json',
        }
      });
      const smsRows = await smsResp.json();
      for (const row of smsRows) {
        if (!smsMap[row.sim_id]) {
          smsMap[row.sim_id] = { count: 0, last_received: row.received_at };
        }
        smsMap[row.sim_id].count++;
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
    const query = `inbound_sms?select=id,to_number,from_number,body,received_at,sim_id,sims(iccid)&order=received_at.desc&limit=50`;
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

    const workerUrl = limit
      ? `https://worker/run?secret=${encodeURIComponent(config.secret)}&limit=${limit}`
      : `https://worker/run?secret=${encodeURIComponent(config.secret)}`;

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

    // Get Helix bearer token
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

    // Query subscriber details
    const detailsUrl = `${env.HX_API_BASE}/api/mobility-subscriber/details`;
    const detailsRes = await fetch(detailsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mobilitySubscriptionId: parseInt(subId) }),
    });

    const detailsText = await detailsRes.text();
    let detailsData;
    try {
      detailsData = JSON.parse(detailsText);
    } catch {
      return new Response(JSON.stringify({
        error: 'Invalid JSON response from Helix',
        raw: detailsText.slice(0, 500)
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!detailsRes.ok) {
      return new Response(JSON.stringify({
        error: 'Helix API error',
        status: detailsRes.status,
        details: detailsData
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Return the full response
    return new Response(JSON.stringify({
      ok: true,
      mobility_subscription_id: subId,
      helix_response: detailsData
    }, null, 2), {
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
          await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {
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
      inserted = Array.isArray(insertedArr) ? insertedArr.length : 0;
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

    // Link sim_id on imei_pool entries for active SIM slots
    let linked = 0;
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
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ sim_id: entry.sim_id }),
          }
        );
        if (linkRes.ok) linked++;
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

    // Merge: system_errors first, then legacy activation errors
    const sysFormatted = (Array.isArray(systemErrors) ? systemErrors : []).map(e => ({ ...e, _legacy: false }));
    const merged = [...sysFormatted, ...legacyErrors];

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

    // Filter out legacy sim_ IDs and handle them separately
    const systemIds = error_ids.filter(id => typeof id === 'number');
    const legacySimIds = error_ids.filter(id => typeof id === 'string' && id.startsWith('sim_')).map(id => parseInt(id.replace('sim_', '')));

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

    return new Response(JSON.stringify({ ok: true, resolved: systemIds.length + legacySimIds.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
      body: JSON.stringify({ sim_id, action })
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
  try {
    const weekStart = url.searchParams.get('week_start');
    if (!weekStart) return new Response(JSON.stringify({ error: 'week_start required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // Get all mappings
    const mapResp = await supabaseGet(env, `qbo_customer_map?select=id,reseller_id,customer_name,qbo_display_name,daily_rate`);
    const mappings = await mapResp.json();

    const invoices = [];
    for (const m of mappings) {
      // Count active SIMs for this reseller
      let simCount = 0;
      if (m.reseller_id) {
        const simResp = await supabaseGet(env, `reseller_sims?select=sim_id,sims(status)&reseller_id=eq.${m.reseller_id}&active=eq.true&sims.status=in.(active,ACTIVATED)`);
        const sims = await simResp.json();
        simCount = Array.isArray(sims) ? sims.filter(s => s.sims).length : 0;
      }
      if (simCount > 0) {
        invoices.push({
          mapping_id: m.id,
          customer_name: m.qbo_display_name,
          sim_count: simCount,
          daily_rate: m.daily_rate,
          total: simCount * 7 * parseFloat(m.daily_rate),
        });
      }
    }
    return new Response(JSON.stringify({ invoices }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            theme: {
                extend: {
                    colors: {
                        dark: {
                            900: '#0d1117',
                            800: '#161b22',
                            700: '#1c2128',
                            600: '#252c35',
                            500: '#2d333b',
                        },
                        accent: '#22c55e',
                    }
                }
            }
        }
    </script>
    <style>
        .progress-ring { transform: rotate(-90deg); }
        .progress-ring__circle { transition: stroke-dashoffset 0.5s ease; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-track { background: #161b22; }
        ::-webkit-scrollbar-thumb { background: #2d333b; border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: #3d444d; }
    </style>
</head>
<body class="bg-dark-900 text-gray-100">
    <div class="flex min-h-screen">
        <!-- Sidebar -->
        <aside class="w-16 bg-dark-800 flex flex-col items-center py-4 border-r border-dark-600">
            <div class="w-10 h-10 bg-accent rounded-lg flex items-center justify-center mb-8">
                <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
                </svg>
            </div>
            <nav class="flex flex-col gap-4">
                <button onclick="switchTab('dashboard')" class="sidebar-btn active w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="Dashboard">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path></svg>
                </button>
                <button onclick="switchTab('sims')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="SIMs">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                </button>
                <button onclick="switchTab('messages')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="Messages">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                </button>
                <button onclick="switchTab('workers')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="Workers">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                </button>
                <button onclick="switchTab('gateway')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="Gateway">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg>
                </button>
                <button onclick="switchTab('imei-pool')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="IMEI Pool">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                </button>
                <button onclick="switchTab('errors')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition relative" title="Errors">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>
                    <span id="error-badge" class="hidden absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center">0</span>
                </button>
                <button onclick="switchTab('billing')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition" title="Billing">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </button>
            </nav>
            <div class="mt-auto">
                <button onclick="loadData()" class="w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-accent hover:bg-dark-600 transition" title="Refresh">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                </button>
            </div>
        </aside>

        <!-- Main Content -->
        <main class="flex-1 p-6 overflow-auto">
            <!-- Header -->
            <header class="flex items-center justify-between mb-6">
                <div>
                    <h1 class="text-2xl font-bold text-white">SMS Gateway</h1>
                    <p class="text-sm text-gray-400">Monitor SIMs, messages, and system status</p>
                </div>
                <div class="flex items-center gap-4">
                    <span id="last-updated" class="text-xs text-gray-500"></span>
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
                    <button onclick="bulkUnassignReseller()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Unassign Reseller</button>
                    <button onclick="bulkSimAction('cancel')" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Cancel</button>
                    <button onclick="bulkSimAction('resume')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>
                    <button onclick="bulkSendOnline()" class="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition">Send Online</button>
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
                                    <option value="active">Active</option>
                                    <option value="provisioning">Provisioning</option>
                                    <option value="pending">Pending</option>
                                    <option value="suspended">Suspended</option>
                                    <option value="canceled">Cancelled</option>
                                    <option value="error">Error</option>
                                </select>
                                <select id="filter-reseller" onchange="loadSims(true)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Resellers</option>
                                </select>
                                <input id="sims-search" type="text" placeholder="Search..." oninput="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-40">
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
                        <button onclick="runWorker('bulk-activator', 10)" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Bulk Activator</p>
                                <p class="text-xs text-gray-400">Activate pending SIMs</p>
                            </div>
                        </button>
                        <button onclick="runWorker('details-finalizer', 10)" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Details Finalizer</p>
                                <p class="text-xs text-gray-400">Finalize provisioning SIMs</p>
                            </div>
                        </button>
                        <button onclick="runWorker('mdn-rotator', 5)" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
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
                        <button onclick="runWorker('phone-number-sync', null)" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Phone Number Sync</p>
                                <p class="text-xs text-gray-400">Sync numbers from Helix</p>
                            </div>
                        </button>
                        <button onclick="runWorker('reseller-sync', 50)" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-teal-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Reseller Sync</p>
                                <p class="text-xs text-gray-400">Send webhooks to resellers</p>
                            </div>
                        </button>
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

                <!-- QBO Connection -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <h3 class="text-lg font-semibold text-white mb-3">QuickBooks Connection</h3>
                    <div id="qbo-status" class="text-gray-400">Checking connection...</div>
                    <div class="mt-3" id="qbo-actions"></div>
                </div>

                <!-- Customer Mapping -->
                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-white">Customer Mapping</h3>
                        <button onclick="showAddMappingModal()" class="px-3 py-1.5 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add Mapping</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">Reseller</th>
                                    <th class="px-4 py-3 font-medium">QBO Customer</th>
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
                    <h3 class="text-lg font-semibold text-white mb-3">Generate Invoices</h3>
                    <div class="flex items-center gap-3 mb-4">
                        <label class="text-sm text-gray-400">Week Start:</label>
                        <input type="date" id="invoice-week-start" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        <button onclick="previewInvoices()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Preview</button>
                        <button onclick="createInvoices()" id="create-invoices-btn" class="hidden px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Create in QBO</button>
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
                                    <th class="px-4 py-3 font-medium">Week</th>
                                    <th class="px-4 py-3 font-medium">SIMs</th>
                                    <th class="px-4 py-3 font-medium">Total</th>
                                    <th class="px-4 py-3 font-medium">Status</th>
                                </tr>
                            </thead>
                            <tbody id="invoice-history-table" class="text-sm">
                                <tr><td colspan="5" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
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
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>
                <div id="helix-query-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>
                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>
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
        };
        const ROUTE_TO_TAB = Object.fromEntries(Object.entries(TAB_ROUTES).map(([k,v]) => [v, k]));

        function switchTab(tabName, push = true) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.sidebar-btn').forEach(el => {
                el.classList.remove('bg-dark-600', 'text-white');
                el.classList.add('text-gray-400');
            });
            const tabEl = document.getElementById(\`tab-\${tabName}\`);
            if (!tabEl) return;
            tabEl.classList.remove('hidden');
            // Highlight the correct sidebar button
            const btns = document.querySelectorAll('.sidebar-btn');
            const tabNames = Object.keys(TAB_ROUTES);
            tabNames.forEach((name, i) => {
                if (name === tabName && btns[i]) {
                    btns[i].classList.add('bg-dark-600', 'text-white');
                    btns[i].classList.remove('text-gray-400');
                }
            });
            if (push && TAB_ROUTES[tabName]) {
                history.pushState({ tab: tabName }, '', TAB_ROUTES[tabName]);
            }
            if (tabName === 'imei-pool') loadImeiPool();
            if (tabName === 'gateway') loadPortStatus();
            if (tabName === 'errors') loadErrors();
            if (tabName === 'billing') loadBillingStatus();
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

        function matchesSearch(obj, query) {
            if (!query) return true;
            const q = query.toLowerCase();
            return Object.values(obj).some(v => v != null && String(v).toLowerCase().includes(q));
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
                select.innerHTML = '<option value="">All Resellers</option>' +
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
                if (resellerFilter) {
                    params.set('reseller_id', resellerFilter);
                }
                if (force) params.set('force', 'true');

                const url = API_BASE + '/sims?' + params.toString();
                const response = await fetch(url);
                const sims = await response.json();
                tableState.sims.data = sims;
                lastSimsFetchedAt = Date.now();
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
                    <td class="px-4 py-3 text-gray-300">\${sim.id}</td>
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
                    <td class="px-4 py-3 whitespace-nowrap">
                        \${canSendOnline ? \`<button onclick="sendSimOnline(\${sim.id}, '\${sim.phone_number}')" class="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition mr-1">Online</button>\` : ''}
                        \${sim.status === 'active' ? \`<button onclick="simAction(\${sim.id}, 'ota_refresh')" class="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition mr-1">OTA</button>\` : ''}
                        \${sim.reseller_id ? \`<button onclick="unassignReseller(\${sim.id})" class="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition" title="Unassign from reseller">Unassign</button>\` : ''}
                    </td>
                </tr>
                \`;
}).join('');
        }


async function sendSimOnline(simId, phoneNumber) {
  if (!confirm(\`Send number.online webhook for \${phoneNumber}?\`)) {
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
                                <td class="px-5 py-3 text-gray-300 truncate max-w-xs">\${msg.body}</td>
                            </tr>
                        \`;
                    }).join('');
                }
            } catch (error) {
                showToast('Error loading messages', 'error');
                console.error(error);
            }
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
                        <td class="px-5 py-3 text-gray-300 max-w-md truncate">\${msg.body}</td>
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

            if (!confirm(\`Rotate \${iccids.length} SIM(s)? This will assign new phone numbers immediately.\`)) {
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

        async function runWorker(workerName, limit) {
            if (!confirm(\`Run \${workerName}\${limit ? \` (limit: \${limit})\` : ''}?\`)) {
                return;
            }
            showToast(\`Running \${workerName}...\`, 'info');
            try {
                const response = await fetch(\`\${API_BASE}/run/\${workerName}\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ limit })
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

            if (!confirm(\`Are you sure you want to activate \${sims.length} SIM(s)? This will call the Helix API.\`)) {
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

            if (!confirm(\`Are you sure you want to cancel \${iccids.length} SIM(s)? This action cannot be undone.\`)) {
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

            if (!confirm(\`Are you sure you want to suspend \${simIds.length} SIM(s)?\`)) {
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

            if (!confirm(\`Are you sure you want to restore \${simIds.length} SIM(s)?\`)) {
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
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-subid-input').focus();
        }

        function queryHelixSubId(subId) {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = subId;
            queryHelix();
        }

        function hideHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-query-result').classList.add('hidden');
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

            try {
                const response = await fetch(\`\${API_BASE}/helix-query\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mobility_subscription_id: subId })
                });

                const result = await response.json();
                const outputEl = document.getElementById('helix-query-output');
                const resultDiv = document.getElementById('helix-query-result');

                if (response.ok && result.ok) {
                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;
                    let formatted = '';
                    if (data) {
                        formatted = \`<span class="text-blue-400 font-bold">status:</span> <span class="\${data.status === 'ACTIVE' ? 'text-accent' : 'text-red-400'} font-bold">\${data.status || 'N/A'}</span>\\n\`;
                        if (data.statusReason) {
                            formatted += \`<span class="text-blue-400 font-bold">statusReason:</span> <span class="text-orange-400 font-bold">\${data.statusReason}</span>\\n\`;
                        }
                        formatted += \`\\n<span class="text-gray-500">--- Full Response ---</span>\\n\`;
                        formatted += JSON.stringify(data, null, 2);
                    } else {
                        formatted = JSON.stringify(result.helix_response, null, 2);
                    }
                    outputEl.innerHTML = formatted;
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
            if (!confirm(\`Set IMEI \${imei} on port \${port}?\`)) return;

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
            if (!confirm(\`\${gwCurrentCommand} port \${port}?\`)) return;

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

            if (!confirm(\`Fix \${simIds.length} SIM(s)? This will change IMEI and run OTA/Cancel/Resume.\`)) return;

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
            if (!confirm('Retire this IMEI? It will no longer be available for allocation.')) return;

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
            if (!confirm('Mark this error as resolved?')) return;
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
            if (!confirm(\`Mark \${ids.length} error(s) as resolved?\`)) return;
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
        }

        async function simAction(simId, action, skipConfirm = false) {
            if (!skipConfirm && !confirm(\`Run \${action} on SIM #\${simId}?\`)) return;

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

                document.getElementById('sim-action-output').textContent = JSON.stringify(result, null, 2);

                if (result.ok) {
                    showToast(\`\${action} completed successfully\`, 'success');
                    loadErrors();
                } else {
                    showToast(\`Error: \${result.error || 'Action failed'}\`, 'error');
                }
            } catch (error) {
                document.getElementById('sim-action-output').textContent = String(error);
                showToast(\`Error running \${action}\`, 'error');
                console.error(error);
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
                    </div>
                    \`;
                }).join('');
            } catch (err) {
                console.error('Failed to load Helix API logs:', err);
                logsContainer.innerHTML = '<p class="text-red-400 text-sm">Failed to load API logs</p>';
            }
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
            if (!confirm(\`Run \${action} on \${simIds.length} SIM(s)?\`)) return;
            for (const id of simIds) {
                await simAction(id, action, true);
            }
            loadSims(true);
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
            if (!confirm('Send number.online webhook for ' + eligible.length + ' SIM(s)?')) return;
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
            if (!confirm('Unassign this SIM from its reseller? This stops webhooks and billing for this line.')) return;
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

        async function bulkUnassignReseller() {
            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (simIds.length === 0) return;
            if (!confirm('Unassign ' + simIds.length + ' SIM(s) from their resellers? This stops webhooks and billing.')) return;
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
            if (!confirm(\`Run \${action} on \${simIds.length} SIM(s)?\`)) return;
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
            if (!confirm('Restore this IMEI to available stock?')) return;
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


        // ===== Billing (QBO) =====
        let selectedQboCustomer = null;
        let invoicePreviewData = null;

        async function loadBillingStatus() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo/status\`);
                const data = await resp.json();
                const statusEl = document.getElementById("qbo-status");
                const actionsEl = document.getElementById("qbo-actions");
                if (data.connected) {
                    statusEl.innerHTML = \`<span class="text-accent font-semibold">Connected</span> <span class="text-gray-500 text-sm">(Company: \${data.company_name || data.realm_id || "unknown"})</span>\`;
                    actionsEl.innerHTML = \`<button onclick="disconnectQbo()" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Disconnect</button>\`;
                    loadMappings();
                    loadInvoiceHistory();
                } else {
                    statusEl.innerHTML = \`<span class="text-yellow-400">Not connected</span>\`;
                    actionsEl.innerHTML = \`<button onclick="connectQbo()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Connect to QuickBooks</button>\`;
                }
            } catch (error) {
                document.getElementById("qbo-status").innerHTML = \`<span class="text-red-400">Error: \${error}</span>\`;
            }
        }

        async function connectQbo() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo/auth-url\`);
                const data = await resp.json();
                if (data.url) window.open(data.url, "_blank");
                else showToast("Error getting auth URL: " + JSON.stringify(data), "error");
            } catch (error) {
                showToast("Error: " + error, "error");
            }
        }

        async function disconnectQbo() {
            if (!confirm("Disconnect from QuickBooks?")) return;
            try {
                await fetch(\`\${API_BASE}/qbo/disconnect\`, { method: "POST" });
                showToast("Disconnected from QuickBooks", "success");
                loadBillingStatus();
            } catch (error) {
                showToast("Error: " + error, "error");
            }
        }

        async function loadMappings() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-mappings\`);
                if (!resp.ok) { document.getElementById("mapping-table").innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No mappings yet</td></tr>'; return; }
                const mappings = await resp.json();
                const tbody = document.getElementById("mapping-table");
                if (!mappings.length) { tbody.innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No mappings yet</td></tr>'; return; }
                tbody.innerHTML = mappings.map(m => \`
                    <tr class="border-b border-dark-600">
                        <td class="px-4 py-3 text-gray-300">\${m.reseller_name || m.customer_name || "-"}</td>
                        <td class="px-4 py-3 text-gray-300">\${m.qbo_display_name}</td>
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
            selectedQboCustomer = null;
            document.getElementById("mapping-qbo-search").value = "";
            document.getElementById("qbo-search-results").classList.add("hidden");
            document.getElementById("mapping-rate").value = "0.50";
            // Populate reseller dropdown
            const sel = document.getElementById("mapping-reseller");
            sel.innerHTML = '<option value="">-- Select Reseller --</option>';
            // Load resellers from existing data
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

        let qboSearchTimeout = null;
        async function searchQboCustomers() {
            clearTimeout(qboSearchTimeout);
            const q = document.getElementById("mapping-qbo-search").value.trim();
            if (q.length < 2) { document.getElementById("qbo-search-results").classList.add("hidden"); return; }
            qboSearchTimeout = setTimeout(async () => {
                try {
                    const resp = await fetch(\`\${API_BASE}/qbo/customers/search?q=\${encodeURIComponent(q)}\`);
                    const data = await resp.json();
                    const container = document.getElementById("qbo-search-results");
                    if (data.customers && data.customers.length > 0) {
                        container.innerHTML = data.customers.map(c => \`
                            <div class="px-3 py-2 text-sm text-gray-300 hover:bg-dark-600 cursor-pointer" onclick="selectQboCustomer(\${c.Id}, '\${(c.DisplayName || "").replace(/'/g, "\\'")}')">
                                \${c.DisplayName}
                            </div>
                        \`).join("");
                        container.classList.remove("hidden");
                    } else {
                        container.innerHTML = '<div class="px-3 py-2 text-sm text-gray-500">No customers found</div>';
                        container.classList.remove("hidden");
                    }
                } catch (error) {
                    console.error("QBO search error:", error);
                }
            }, 300);
        }

        function selectQboCustomer(id, name) {
            selectedQboCustomer = { id: String(id), name };
            document.getElementById("mapping-qbo-search").value = name;
            document.getElementById("qbo-search-results").classList.add("hidden");
        }

        async function saveMapping() {
            const resellerId = document.getElementById("mapping-reseller").value;
            const rate = document.getElementById("mapping-rate").value;
            if (!selectedQboCustomer) { showToast("Select a QBO customer first", "error"); return; }
            try {
                const body = {
                    reseller_id: resellerId ? parseInt(resellerId) : null,
                    qbo_customer_id: selectedQboCustomer.id,
                    qbo_display_name: selectedQboCustomer.name,
                    daily_rate: parseFloat(rate)
                };
                const resp = await fetch(\`\${API_BASE}/qbo-mappings\`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body)
                });
                if (resp.ok) {
                    showToast("Mapping saved", "success");
                    closeMappingModal();
                    loadMappings();
                } else {
                    const err = await resp.json();
                    showToast("Error: " + (err.error || JSON.stringify(err)), "error");
                }
            } catch (error) {
                showToast("Error saving mapping: " + error, "error");
            }
        }

        async function deleteMapping(id) {
            if (!confirm("Delete this mapping?")) return;
            try {
                await fetch(\`\${API_BASE}/qbo-mappings?id=\${id}\`, { method: "DELETE" });
                showToast("Mapping deleted", "success");
                loadMappings();
            } catch (error) {
                showToast("Error: " + error, "error");
            }
        }

        async function previewInvoices() {
            const weekStart = document.getElementById("invoice-week-start").value;
            if (!weekStart) { showToast("Select a week start date", "error"); return; }
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-invoice-preview?week_start=\${weekStart}\`);
                const data = await resp.json();
                invoicePreviewData = data;
                if (!data.invoices || data.invoices.length === 0) {
                    document.getElementById("invoice-preview").innerHTML = '<p class="text-gray-500">No invoices to generate for this period.</p>';
                    document.getElementById("create-invoices-btn").classList.add("hidden");
                    return;
                }
                let html = '<table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-500 border-b border-dark-600"><th class="py-2">Customer</th><th class="py-2">SIMs</th><th class="py-2">Days</th><th class="py-2">Rate</th><th class="py-2">Total</th></tr></thead><tbody>';
                data.invoices.forEach(inv => {
                    html += \`<tr class="border-b border-dark-700"><td class="py-2 text-gray-300">\${inv.customer_name}</td><td class="py-2 text-gray-300">\${inv.sim_count}</td><td class="py-2 text-gray-300">7</td><td class="py-2 text-gray-300">$\${Number(inv.daily_rate).toFixed(2)}</td><td class="py-2 text-accent font-semibold">$\${Number(inv.total).toFixed(2)}</td></tr>\`;
                });
                html += "</tbody></table>";
                document.getElementById("invoice-preview").innerHTML = html;
                document.getElementById("create-invoices-btn").classList.remove("hidden");
            } catch (error) {
                showToast("Error previewing: " + error, "error");
            }
        }

        async function createInvoices() {
            if (!invoicePreviewData || !invoicePreviewData.invoices) return;
            const weekStart = document.getElementById("invoice-week-start").value;
            if (!confirm(\`Create \${invoicePreviewData.invoices.length} invoice(s) in QuickBooks?\`)) return;
            try {
                const resp = await fetch(\`\${API_BASE}/qbo/invoice/create\`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ week_start: weekStart })
                });
                const result = await resp.json();
                if (result.ok) {
                    showToast(\`Created \${result.created} invoice(s)\`, "success");
                    document.getElementById("create-invoices-btn").classList.add("hidden");
                    loadInvoiceHistory();
                } else {
                    showToast("Error: " + (result.error || JSON.stringify(result)), "error");
                }
            } catch (error) {
                showToast("Error creating invoices: " + error, "error");
            }
        }

        async function loadInvoiceHistory() {
            try {
                const resp = await fetch(\`\${API_BASE}/qbo-invoices\`);
                if (!resp.ok) return;
                const invoices = await resp.json();
                const tbody = document.getElementById("invoice-history-table");
                if (!invoices.length) { tbody.innerHTML = '<tr><td colspan=5 class="px-4 py-4 text-center text-gray-500">No invoices yet</td></tr>'; return; }
                tbody.innerHTML = invoices.map(inv => {
                    const statusClass = {
                        draft: "bg-gray-500/20 text-gray-400",
                        sent: "bg-blue-500/20 text-blue-400",
                        paid: "bg-accent/20 text-accent",
                        error: "bg-red-500/20 text-red-400"
                    }[inv.status] || "bg-gray-500/20 text-gray-400";
                    return \`
                    <tr class="border-b border-dark-600">
                        <td class="px-4 py-3 text-gray-300">\${inv.customer_name || "-"}</td>
                        <td class="px-4 py-3 text-gray-400 text-xs">\${inv.week_start} - \${inv.week_end}</td>
                        <td class="px-4 py-3 text-gray-300">\${inv.sim_count}</td>
                        <td class="px-4 py-3 text-accent">$\${Number(inv.total).toFixed(2)}</td>
                        <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \${statusClass}">\${inv.status}</span></td>
                    </tr>\`;
                }).join("");
            } catch (error) {
                console.error("Error loading invoice history:", error);
            }
        }

        loadGatewayDropdown();
        loadResellers();
        loadData();
        setInterval(loadData, 3600000);
        initTabFromUrl();
    </script>
        <!-- Add Mapping Modal -->
        <div id="add-mapping-modal" class="hidden fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div class="bg-dark-800 rounded-xl border border-dark-600 p-6 w-full max-w-md">
                <h3 class="text-lg font-semibold text-white mb-4">Add Customer Mapping</h3>
                <div class="space-y-3">
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">Reseller</label>
                        <select id="mapping-reseller" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300"></select>
                    </div>
                    <div>
                        <label class="text-sm text-gray-400 block mb-1">QBO Customer (search)</label>
                        <input type="text" id="mapping-qbo-search" placeholder="Type to search QBO customers..." oninput="searchQboCustomers()" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">
                        <div id="qbo-search-results" class="mt-1 bg-dark-700 rounded-lg border border-dark-500 max-h-32 overflow-y-auto hidden"></div>
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
</body>
</html>`;
}
