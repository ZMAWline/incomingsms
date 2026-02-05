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

    if (url.pathname === '/api/cancel') {
      return handleCancelSims(request, env, corsHeaders);
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
    <title>Incoming SMS Dashboard</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50">
    <div class="min-h-screen">
        <header class="bg-white shadow">
            <div class="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
                <h1 class="text-3xl font-bold text-gray-900">Incoming SMS Dashboard</h1>
                <p class="text-sm text-gray-600 mt-1">Monitor SIMs, messages, and system status</p>
            </div>
        </header>

        <main class="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div class="bg-white rounded-lg shadow p-6">
                    <div class="flex items-center">
                        <div class="flex-shrink-0 bg-blue-500 rounded-md p-3">
                            <svg class="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path>
                            </svg>
                        </div>
                        <div class="ml-4">
                            <p class="text-sm font-medium text-gray-500">Total SIMs</p>
                            <p class="text-2xl font-semibold text-gray-900" id="total-sims">-</p>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-lg shadow p-6">
                    <div class="flex items-center">
                        <div class="flex-shrink-0 bg-green-500 rounded-md p-3">
                            <svg class="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                        </div>
                        <div class="ml-4">
                            <p class="text-sm font-medium text-gray-500">Active SIMs</p>
                            <p class="text-2xl font-semibold text-gray-900" id="active-sims">-</p>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-lg shadow p-6">
                    <div class="flex items-center">
                        <div class="flex-shrink-0 bg-yellow-500 rounded-md p-3">
                            <svg class="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                        </div>
                        <div class="ml-4">
                            <p class="text-sm font-medium text-gray-500">Provisioning</p>
                            <p class="text-2xl font-semibold text-gray-900" id="provisioning-sims">-</p>
                        </div>
                    </div>
                </div>

                <div class="bg-white rounded-lg shadow p-6">
                    <div class="flex items-center">
                        <div class="flex-shrink-0 bg-purple-500 rounded-md p-3">
                            <svg class="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path>
                            </svg>
                        </div>
                        <div class="ml-4">
                            <p class="text-sm font-medium text-gray-500">Messages (24h)</p>
                            <p class="text-2xl font-semibold text-gray-900" id="messages-24h">-</p>
                        </div>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-lg shadow mb-6">
                <div class="px-6 py-4 border-b border-gray-200">
                    <h2 class="text-lg font-semibold text-gray-900">Worker Controls</h2>
                </div>
                <div class="p-6">
                    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <button onclick="showActivateModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            🚀 Activate SIMs
                        </button>
                        <button onclick="runWorker('details-finalizer', 10)" class="bg-green-600 hover:bg-green-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            ✅ Finalize Details
                        </button>
                        <button onclick="runWorker('mdn-rotator', 5)" class="bg-orange-600 hover:bg-orange-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            🔄 Rotate Numbers
                        </button>
                        <button onclick="runWorker('phone-number-sync', null)" class="bg-purple-600 hover:bg-purple-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            🔍 Sync Phone Numbers
                        </button>
                        <button onclick="runWorker('reseller-sync', 50)" class="bg-teal-600 hover:bg-teal-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            📤 Reseller Sync
                        </button>
                        <button onclick="showCancelModal()" class="bg-red-600 hover:bg-red-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            ❌ Cancel SIMs
                        </button>
                        <button onclick="showHelixQueryModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            🔎 Query Helix
                        </button>
                        <button onclick="loadData()" class="bg-gray-600 hover:bg-gray-700 text-white font-medium py-3 px-4 rounded-lg transition duration-150">
                            🔄 Refresh Dashboard
                        </button>
                    </div>
                </div>
            </div>

            <div class="bg-white rounded-lg shadow mb-6">
                <div class="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
                    <h2 class="text-lg font-semibold text-gray-900">Recent SMS Messages</h2>
                    <button onclick="loadMessages()" class="text-sm text-blue-600 hover:text-blue-700">Refresh</button>
                </div>
                <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">To</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">From</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Message</th>
                                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICCID</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200" id="messages-table">
                            <tr>
                                <td colspan="5" class="px-6 py-4 text-center text-sm text-gray-500">Loading...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="bg-white rounded-lg shadow">
                <div class="px-6 py-4 border-b border-gray-200">
                    <div class="flex justify-between items-center mb-4">
                        <h2 class="text-lg font-semibold text-gray-900">SIM Status</h2>
                        <button onclick="loadSims()" class="text-sm text-blue-600 hover:text-blue-700">Refresh</button>
                    </div>
                    <div class="flex flex-wrap gap-4 items-center">
                        <div class="flex items-center gap-2">
                            <label class="text-sm font-medium text-gray-700">Status:</label>
                            <select id="filter-status" onchange="loadSims()" class="text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500">
                                <option value="">All (except cancelled)</option>
                                <option value="all">All (include cancelled)</option>
                                <option value="active">Active</option>
                                <option value="provisioning">Provisioning</option>
                                <option value="pending">Pending</option>
                                <option value="suspended">Suspended</option>
                                <option value="canceled">Cancelled</option>
                                <option value="error">Error</option>
                            </select>
                        </div>
                        <div class="flex items-center gap-2">
                            <label class="text-sm font-medium text-gray-700">Reseller:</label>
                            <select id="filter-reseller" onchange="loadSims()" class="text-sm border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring-blue-500">
                                <option value="">All Resellers</option>
                            </select>
                        </div>
                        <span id="sims-count" class="text-sm text-gray-500"></span>
                    </div>
                </div>
                <div class="overflow-x-auto">
                    <table class="min-w-full divide-y divide-gray-200">
                        <thead class="bg-gray-50">
                            <tr>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ID</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Gateway</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ICCID</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phone Number</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sub ID</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Reseller</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">SMS</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last SMS</th>
                                <th class="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody class="bg-white divide-y divide-gray-200" id="sims-table">
                            <tr>
                                <td colspan="10" class="px-4 py-4 text-center text-sm text-gray-500">Loading...</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <div id="toast" class="hidden fixed bottom-4 right-4 bg-gray-900 text-white px-6 py-4 rounded-lg shadow-lg">
                <p id="toast-message"></p>
            </div>

            <!-- Cancel Modal -->
            <div id="cancel-modal" class="hidden fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
                <div class="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
                    <div class="mt-3">
                        <h3 class="text-lg font-medium leading-6 text-gray-900 mb-4">Cancel SIMs</h3>
                        <div class="mt-2">
                            <p class="text-sm text-gray-500 mb-3">
                                Enter ICCIDs to cancel (one per line):
                            </p>
                            <textarea
                                id="iccids-input"
                                rows="10"
                                class="w-full px-3 py-2 text-gray-700 border rounded-lg focus:outline-none focus:border-blue-500"
                                placeholder="89014103271467425631\n89014103271467425581\n..."
                            ></textarea>
                        </div>
                        <div class="flex justify-end space-x-3 mt-4">
                            <button
                                onclick="hideCancelModal()"
                                class="px-4 py-2 bg-gray-300 text-gray-800 rounded-lg hover:bg-gray-400"
                            >
                                Cancel
                            </button>
                            <button
                                onclick="cancelSims()"
                                class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                            >
                                Cancel SIMs
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Activate Modal -->
            <div id="activate-modal" class="hidden fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
                <div class="relative top-10 mx-auto p-5 border w-2xl max-w-3xl shadow-lg rounded-md bg-white">
                    <div class="mt-3">
                        <h3 class="text-lg font-medium leading-6 text-gray-900 mb-4">Activate SIMs</h3>
                        <div class="mt-2">
                            <p class="text-sm text-gray-500 mb-3">
                                Enter SIM data (CSV format: iccid,imei,reseller_id - one per line):
                            </p>
                            <textarea
                                id="activate-input"
                                rows="12"
                                class="w-full px-3 py-2 text-gray-700 border rounded-lg focus:outline-none focus:border-blue-500 font-mono text-sm"
                                placeholder="89014103271467425631,123456789012345,1\n89014103271467425581,123456789012346,1\n..."
                            ></textarea>
                            <p class="text-xs text-gray-400 mt-1">
                                Format: ICCID (20 digits), IMEI (15 digits), Reseller ID (number)
                            </p>
                        </div>
                        <div class="flex justify-end space-x-3 mt-4">
                            <button
                                onclick="hideActivateModal()"
                                class="px-4 py-2 bg-gray-300 text-gray-800 rounded-lg hover:bg-gray-400"
                            >
                                Cancel
                            </button>
                            <button
                                onclick="activateSims()"
                                class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                            >
                                Activate SIMs
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Helix Query Modal -->
            <div id="helix-query-modal" class="hidden fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
                <div class="relative top-10 mx-auto p-5 border w-full max-w-2xl shadow-lg rounded-md bg-white">
                    <div class="mt-3">
                        <h3 class="text-lg font-medium leading-6 text-gray-900 mb-4">Query Helix Subscriber</h3>
                        <div class="mt-2">
                            <p class="text-sm text-gray-500 mb-3">
                                Enter a Mobility Subscription ID to query Helix API:
                            </p>
                            <input
                                type="text"
                                id="helix-subid-input"
                                class="w-full px-3 py-2 text-gray-700 border rounded-lg focus:outline-none focus:border-indigo-500 font-mono"
                                placeholder="e.g. 40033"
                            />
                        </div>
                        <div id="helix-query-result" class="mt-4 hidden">
                            <h4 class="text-sm font-medium text-gray-700 mb-2">Result:</h4>
                            <pre id="helix-query-output" class="bg-gray-100 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-96 overflow-y-auto"></pre>
                        </div>
                        <div class="flex justify-end space-x-3 mt-4">
                            <button
                                onclick="hideHelixQueryModal()"
                                class="px-4 py-2 bg-gray-300 text-gray-800 rounded-lg hover:bg-gray-400"
                            >
                                Close
                            </button>
                            <button
                                onclick="queryHelix()"
                                id="helix-query-btn"
                                class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                            >
                                Query
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>

    <script>
        const API_BASE = '/api';

        function showToast(message, type = 'info') {
            const toast = document.getElementById('toast');
            const toastMessage = document.getElementById('toast-message');
            toastMessage.textContent = message;
            toast.className = \`fixed bottom-4 right-4 px-6 py-4 rounded-lg shadow-lg max-w-lg \${
                type === 'error' ? 'bg-red-600' :
                type === 'success' ? 'bg-green-600' :
                'bg-gray-900'
            } text-white\`;
            toast.classList.remove('hidden');
            // Errors stay longer (10s), success/info stay 4s
            const duration = type === 'error' ? 10000 : 4000;
            setTimeout(() => toast.classList.add('hidden'), duration);
            // Also log to console for easy copying
            console.log(\`[\${type.toUpperCase()}] \${message}\`);
        }

        async function loadData() {
            try {
                const response = await fetch(\`\${API_BASE}/stats\`);
                const data = await response.json();
                document.getElementById('total-sims').textContent = data.total_sims || 0;
                document.getElementById('active-sims').textContent = data.active_sims || 0;
                document.getElementById('provisioning-sims').textContent = data.provisioning_sims || 0;
                document.getElementById('messages-24h').textContent = data.messages_24h || 0;
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
                countEl.textContent = \`Showing \${sims.length} SIM(s)\`;

                if (sims.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="10" class="px-4 py-4 text-center text-sm text-gray-500">No SIMs found</td></tr>';
                    return;
                }
                tbody.innerHTML = sims.map(sim => {
                    const lastSms = sim.last_sms_received ? new Date(sim.last_sms_received).toLocaleString() : '-';
                    const canSendOnline = sim.phone_number && sim.reseller_id && sim.status === 'active';
                    const verifiedBadge = sim.verification_status === 'verified' ? '<span class="ml-1 text-green-600" title="Verified">&#10003;</span>' : '';
                    const gatewayDisplay = sim.gateway_code ? \`<span class="font-semibold">\${sim.gateway_code}</span><span class="text-gray-400 text-xs ml-1">\${sim.port || ''}</span>\` : (sim.port || '-');
                    return \`
                    <tr class="hover:bg-gray-50">
                        <td class="px-4 py-4 whitespace-nowrap text-sm font-medium text-gray-900">\${sim.id}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-700" title="\${sim.gateway_name || ''}">\${gatewayDisplay}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500 font-mono text-xs">\${sim.iccid}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-900">\${sim.phone_number || '-'}\${verifiedBadge}</td>
                        <td class="px-4 py-4 whitespace-nowrap">
                            <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full \${
                                sim.status === 'active' ? 'bg-green-100 text-green-800' :
                                sim.status === 'provisioning' ? 'bg-yellow-100 text-yellow-800' :
                                sim.status === 'canceled' ? 'bg-red-100 text-red-800' :
                                sim.status === 'error' ? 'bg-red-100 text-red-800' :
                                'bg-gray-100 text-gray-800'
                            }">
                                \${sim.status}
                            </span>
                        </td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm font-mono text-xs">\${sim.mobility_subscription_id ? \`<button onclick="queryHelixSubId('\${sim.mobility_subscription_id}')" class="text-indigo-600 hover:text-indigo-800 hover:underline">\${sim.mobility_subscription_id}</button>\` : '-'}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500">\${sim.reseller_name || '-'}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-900">\${sim.sms_count || 0}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm text-gray-500">\${lastSms}</td>
                        <td class="px-4 py-4 whitespace-nowrap text-sm">
                            \${canSendOnline ? \`<button onclick="sendSimOnline(\${sim.id}, '\${sim.phone_number}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium py-1 px-2 rounded transition">Send Online</button>\` : '-'}
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
                const tbody = document.getElementById('messages-table');
                if (messages.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-4 text-center text-sm text-gray-500">No messages found</td></tr>';
                    return;
                }
                tbody.innerHTML = messages.map(msg => {
                    const date = new Date(msg.received_at);
                    const timeStr = date.toLocaleString();
                    return \`
                        <tr class="hover:bg-gray-50">
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">\${timeStr}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">\${msg.to_number || '-'}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">\${msg.from_number}</td>
                            <td class="px-6 py-4 text-sm text-gray-900 max-w-md truncate">\${msg.body}</td>
                            <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">\${msg.iccid || '-'}</td>
                        </tr>
                    \`;
                }).join('');
            } catch (error) {
                showToast('Error loading messages', 'error');
                console.error(error);
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
                    // Format the helix response nicely
                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;

                    // Highlight status and statusReason
                    let formatted = '';
                    if (data) {
                        formatted = \`<span class="text-blue-600 font-bold">status:</span> <span class="\${data.status === 'ACTIVE' ? 'text-green-600' : 'text-red-600'} font-bold">\${data.status || 'N/A'}</span>\\n\`;
                        if (data.statusReason) {
                            formatted += \`<span class="text-blue-600 font-bold">statusReason:</span> <span class="text-orange-600 font-bold">\${data.statusReason}</span>\\n\`;
                        }
                        formatted += \`\\n<span class="text-gray-500">--- Full Response ---</span>\\n\`;
                        formatted += JSON.stringify(data, null, 2);
                    } else {
                        formatted = JSON.stringify(result.helix_response, null, 2);
                    }

                    outputEl.innerHTML = formatted;
                    resultDiv.classList.remove('hidden');
                } else {
                    outputEl.innerHTML = \`<span class="text-red-600">Error:</span> \${JSON.stringify(result, null, 2)}\`;
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

        loadResellers();
        loadData();
        setInterval(loadData, 30000);
    </script>
</body>
</html>`;
}
