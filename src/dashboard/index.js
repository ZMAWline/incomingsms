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

    // Serve HTML dashboard
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(getHTML(), {
        headers: { 'Content-Type': 'text/html' }
      });
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

    return new Response('Not Found', { status: 404 });
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
    let query = `sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=100`;

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
    const formatted = await Promise.all(filteredSims.map(async sim => {
      // Get SMS count and last received timestamp
      const smsQuery = `inbound_sms?select=id,received_at&sim_id=eq.${sim.id}&order=received_at.desc&limit=1`;
      const smsResponse = await supabaseGet(env, smsQuery);
      const smsData = await smsResponse.json();

      // Get total count
      const countQuery = `inbound_sms?select=id&sim_id=eq.${sim.id}`;
      const countResponse = await fetch(`${env.SUPABASE_URL}/rest/v1/${countQuery}`, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: 'application/json',
          Prefer: 'count=exact'
        }
      });

      const countHeader = countResponse.headers.get('content-range');
      const smsCount = countHeader ? parseInt(countHeader.split('/')[1]) : 0;
      const lastReceived = smsData.length > 0 ? smsData[0].received_at : null;

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
        sms_count: smsCount,
        last_sms_received: lastReceived,
        reseller_id: resellerId,
        reseller_name: resellerName,
        gateway_id: sim.gateway_id,
        gateway_code: sim.gateways?.code || null,
        gateway_name: sim.gateways?.name || null
      };
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
      return new Response(JSON.stringify({
        error: `Worker returned non-JSON response (${workerResponse.status}): ${responseText.slice(0, 200)}`
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify(result), {
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
    } catch {}

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
      skylineResponse = await env.SKYLINE_GATEWAY.fetch(targetUrl, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    }

    const responseText = await skylineResponse.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = { raw: responseText }; }

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
                    <div class="p-5 grid grid-cols-2 md:grid-cols-6 gap-3">
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
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600">
                        <div class="flex flex-wrap items-center justify-between gap-4">
                            <h2 class="text-lg font-semibold text-white">SIM Status</h2>
                            <div class="flex flex-wrap items-center gap-3">
                                <select id="filter-status" onchange="loadSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All (except cancelled)</option>
                                    <option value="all">All (include cancelled)</option>
                                    <option value="active">Active</option>
                                    <option value="provisioning">Provisioning</option>
                                    <option value="pending">Pending</option>
                                    <option value="suspended">Suspended</option>
                                    <option value="canceled">Cancelled</option>
                                    <option value="error">Error</option>
                                </select>
                                <select id="filter-reseller" onchange="loadSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Resellers</option>
                                </select>
                                <span id="sims-count" class="text-sm text-gray-500"></span>
                            </div>
                        </div>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-4 py-3 font-medium">ID</th>
                                    <th class="px-4 py-3 font-medium">Gateway</th>
                                    <th class="px-4 py-3 font-medium">ICCID</th>
                                    <th class="px-4 py-3 font-medium">Phone</th>
                                    <th class="px-4 py-3 font-medium">Status</th>
                                    <th class="px-4 py-3 font-medium">Sub ID</th>
                                    <th class="px-4 py-3 font-medium">Reseller</th>
                                    <th class="px-4 py-3 font-medium">SMS</th>
                                    <th class="px-4 py-3 font-medium">Last SMS</th>
                                    <th class="px-4 py-3 font-medium">Actions</th>
                                </tr>
                            </thead>
                            <tbody id="sims-table" class="text-sm">
                                <tr><td colspan="10" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <!-- Messages Tab -->
            <div id="tab-messages" class="tab-content hidden">
                <div class="bg-dark-800 rounded-xl border border-dark-600">
                    <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                        <h2 class="text-lg font-semibold text-white">SMS Messages</h2>
                        <button onclick="loadMessages()" class="text-xs text-accent hover:text-green-400 transition">Refresh</button>
                    </div>
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">
                                    <th class="px-5 py-3 font-medium">Time</th>
                                    <th class="px-5 py-3 font-medium">To</th>
                                    <th class="px-5 py-3 font-medium">From</th>
                                    <th class="px-5 py-3 font-medium">Message</th>
                                    <th class="px-5 py-3 font-medium">ICCID</th>
                                </tr>
                            </thead>
                            <tbody id="messages-table" class="text-sm">
                                <tr><td colspan="5" class="px-5 py-4 text-center text-gray-500">Loading...</td></tr>
                            </tbody>
                        </table>
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
                    <div class="p-5 grid grid-cols-2 md:grid-cols-5 gap-3">
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
                    </div>
                </div>
            </div>
        </main>
    </div>

    <!-- Toast -->
    <div id="toast" class="hidden fixed bottom-4 right-4 px-6 py-4 rounded-lg shadow-lg max-w-md z-50">
        <p id="toast-message" class="text-sm"></p>
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
                <p class="text-sm text-gray-400 mb-3">Enter SIM data (CSV: iccid,imei,reseller_id):</p>
                <textarea id="activate-input" rows="10" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="89014103271467425631,123456789012345,1"></textarea>
                <p class="text-xs text-gray-500 mt-2">Format: ICCID (20 digits), IMEI (15 digits), Reseller ID</p>
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
                    <input type="text" id="gw-imei-value" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent" placeholder="15-digit IMEI"/>
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

    <script>
        const API_BASE = '/api';

        function switchTab(tabName) {
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.querySelectorAll('.sidebar-btn').forEach(el => {
                el.classList.remove('bg-dark-600', 'text-white');
                el.classList.add('text-gray-400');
            });
            document.getElementById(\`tab-\${tabName}\`).classList.remove('hidden');
            event.currentTarget.classList.add('bg-dark-600', 'text-white');
            event.currentTarget.classList.remove('text-gray-400');
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
                const response = await fetch(\`\${API_BASE}/stats\`);
                const data = await response.json();
                document.getElementById('total-sims').textContent = data.total_sims || 0;
                document.getElementById('active-sims').textContent = data.active_sims || 0;
                document.getElementById('provisioning-sims').textContent = data.provisioning_sims || 0;
                document.getElementById('messages-24h').textContent = data.messages_24h || 0;
                updateActiveRing(data.active_sims || 0, data.total_sims || 0);
                document.getElementById('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
                loadSims();
                loadMessages();
            } catch (error) {
                showToast('Error loading dashboard data', 'error');
                console.error(error);
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

        async function loadSims() {
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

                const url = \`\${API_BASE}/sims?\${params.toString()}\`;
                const response = await fetch(url);
                const sims = await response.json();
                const tbody = document.getElementById('sims-table');
                const countEl = document.getElementById('sims-count');
                countEl.textContent = \`\${sims.length} SIM(s)\`;

                if (sims.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="10" class="px-4 py-4 text-center text-gray-500">No SIMs found</td></tr>';
                    return;
                }
                tbody.innerHTML = sims.map(sim => {
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
                        <td class="px-4 py-3">
                            \${canSendOnline ? \`<button onclick="sendSimOnline(\${sim.id}, '\${sim.phone_number}')" class="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition">Online</button>\` : '-'}
                        </td>
                    </tr>
                \`;
                }).join('');
            } catch (error) {
                showToast('Error loading SIMs', 'error');
                console.error(error);
            }
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
                const tbody = document.getElementById('messages-table');
                if (messages.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="px-5 py-4 text-center text-gray-500">No messages found</td></tr>';
                } else {
                    tbody.innerHTML = messages.map(msg => {
                        const date = new Date(msg.received_at);
                        const timeStr = date.toLocaleString();
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

            // Parse CSV data
            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const sims = [];
            const errors = [];

            for (let i = 0; i < lines.length; i++) {
                const parts = lines[i].split(',').map(p => p.trim());
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
                const response = await fetch(\`\${API_BASE}/skyline/port-info?gateway_id=\${gatewayId}\`);
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

                label.textContent = \`\${ports.length} port(s) - Updated \${new Date().toLocaleTimeString()}\`;

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

        function selectPort(port) {
            showToast(\`Port \${port} selected\`, 'info');
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

        loadGatewayDropdown();
        loadResellers();
        loadData();
        setInterval(loadData, 30000);
    </script>
</body>
</html>`;
}
