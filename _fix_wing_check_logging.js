// Add carrier_api_logs logging to handleWingCheck and add logCarrierApiCall function
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

// Step 1: Add logCarrierApiCall function after logSystemError
const LOGSYSERR_END = `  } catch (e) {
    console.error('[logSystemError] Failed to log error:', e);
  }
}

async function handleImeiGatewaySync`;

const LOGSYSERR_NEW = `  } catch (e) {
    console.error('[logSystemError] Failed to log error:', e);
  }
}

async function logCarrierApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;
  const vendor = logData.vendor || 'helix';
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

async function handleImeiGatewaySync`;

if (!content.includes(LOGSYSERR_END)) {
  console.error('PATCH FAILED: logSystemError end pattern not found');
  process.exit(1);
}
content = content.replace(LOGSYSERR_END, LOGSYSERR_NEW);
console.log('1. Added logCarrierApiCall function');

// Step 2: Update handleWingCheck to use logging
const WING_OLD = `async function handleWingCheck(request, env, corsHeaders) {
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

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth }
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}`;

const WING_NEW = `async function handleWingCheck(request, env, corsHeaders) {
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

    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: auth }
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

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}`;

if (!content.includes(WING_OLD)) {
  console.error('PATCH FAILED: handleWingCheck pattern not found');
  process.exit(1);
}
content = content.replace(WING_OLD, WING_NEW);
console.log('2. Updated handleWingCheck with logging');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch complete: wing_check queries now logged to carrier_api_logs');
