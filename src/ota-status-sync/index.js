// ota-status-sync worker
// Runs every 12 hours (00:00 and 12:00 UTC).
// For each active/suspended SIM:
//   - Helix: Fetch details, run OTA refresh, update status
//   - ATOMIC: Run OTA refresh via resendOtaProfile
//   - Wing IoT: Skip (no OTA endpoint)
//   - Teltik: Skip (handled by teltik-worker)

import { syncSimFromHelixDetails } from '../shared/subscriber-sync.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret") || "";
    if (secret !== env.WORKER_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/run") {
      const result = await runOtaStatusSync(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("ota-status-sync ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOtaStatusSync(env));
  },
};

// ===========================
// Main sync loop
// ===========================
async function runOtaStatusSync(env) {
  // Get all active/suspended SIMs, excluding wing_iot and teltik (no OTA support)
  const sims = await supabaseSelect(
    env,
    "sims?select=id,iccid,mobility_subscription_id,msisdn,status,imei,activated_at,vendor&status=in.(active,suspended)&vendor=not.in.(wing_iot,teltik)&order=id.asc&limit=10000"
  );

  if (!Array.isArray(sims) || sims.length === 0) {
    console.log("[OTA Sync] No SIMs to sync");
    return { ok: true, synced: 0, errors: 0, skipped: 0 };
  }

  // Filter: helix needs subId, atomic needs msisdn
  const validSims = sims.filter(sim => {
    const vendor = sim.vendor || 'helix';
    if (vendor === 'helix') return !!sim.mobility_subscription_id;
    if (vendor === 'atomic') return !!sim.msisdn;
    return false;
  });

  console.log(`[OTA Sync] Starting sync for ${validSims.length} SIMs (${sims.length - validSims.length} skipped)`);

  // Get Helix token only if we have helix SIMs
  const hasHelix = validSims.some(s => (s.vendor || 'helix') === 'helix');
  let token = null;
  if (hasHelix) {
    token = await getCachedToken(env);
  }

  let synced = 0;
  let errors = 0;

  for (const sim of validSims) {
    try {
      await syncSimStatus(env, token, sim);
      synced++;
    } catch (err) {
      console.error(`[OTA Sync] SIM ${sim.iccid} failed: ${err}`);
      errors++;
    }
  }

  console.log(`[OTA Sync] Done. synced=${synced} errors=${errors} total=${validSims.length}`);
  return { ok: true, synced, errors, total: validSims.length, skipped: sims.length - validSims.length };
}

// ===========================
// Per-SIM status sync - routes by vendor
// ===========================
async function syncSimStatus(env, token, sim) {
  const { id, iccid } = sim;
  const vendor = sim.vendor || 'helix';
  const runId = `ota_sync_${iccid}_${Date.now()}`;

  if (vendor === 'atomic') {
    await syncSimStatusAtomic(env, sim, runId);
  } else {
    await syncSimStatusHelix(env, token, sim, runId);
  }
}

async function syncSimStatusAtomic(env, sim, runId) {
  const { id, iccid, msisdn } = sim;

  // ATOMIC: Send OTA refresh
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';
  const requestBody = {
    wholeSaleApi: {
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      wholeSaleRequest: {
        requestType: 'resendOtaProfile',
        MSISDN: msisdn,
        sim: iccid,
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logCarrierApiCall(env, {
    run_id: runId,
    step: 'ota_refresh',
    iccid,
    vendor: 'atomic',
    request_url: url,
    request_method: 'POST',
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `ATOMIC OTA failed: ${res.status}`,
  });

  // ATOMIC OTA doesn't return status like Helix - just confirms the refresh was sent
  if (res.ok && json?.wholeSaleApi?.wholeSaleResponse?.statusCode === '00') {
    console.log(`[OTA Sync] SIM ${iccid} (atomic): OTA refresh sent`);
  } else {
    console.warn(`[OTA Sync] SIM ${iccid} (atomic): OTA refresh failed`);
  }
}

async function syncSimStatusHelix(env, token, sim, runId) {
  const { id, iccid, mobility_subscription_id: subId } = sim;

  // Get subscriber details for MDN and BAN
  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const d = Array.isArray(details) ? details[0] : null;
  const phoneNumber = d && d.phoneNumber;

  // Sync DB with Helix details (activated_at backfill, ICCID/IMEI mismatch logging)
  syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));
  const attBan = (d && d.attBan) || (d && d.ban) || null;

  if (!phoneNumber || !attBan) {
    console.warn(`[OTA Sync] SIM ${iccid}: missing phoneNumber or attBan, skipping`);
    return;
  }

  const mdn = String(phoneNumber).replace(/\D/g, "").replace(/^1/, "");

  // Run OTA refresh — response contains the current subscriber status
  let otaResult;
  try {
    otaResult = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);
  } catch (otaErr) {
    if (otaErr.isHelixTimeout) {
      await supabasePatch(env, `sims?id=eq.${id}`, { status: 'helix_timeout' });
      console.log(`[OTA Sync] SIM ${iccid}: sub not found → helix_timeout`);
      return;
    }
    if (otaErr.isSimMismatch) {
      await supabasePatch(env, `sims?id=eq.${id}`, { status: 'data_mismatch' });
      console.log(`[OTA Sync] SIM ${iccid}: sim mismatch → data_mismatch`);
      return;
    }
    throw otaErr;
  }

  // Extract status from fulfilled[0].status and update DB
  const fulfilled = otaResult && otaResult.fulfilled;
  if (!Array.isArray(fulfilled) || fulfilled.length === 0) return;

  const helixStatus = fulfilled[0] && fulfilled[0].status;
  const dbStatus = mapHelixStatus(helixStatus);
  if (!dbStatus) return;

  await supabasePatch(env, `sims?id=eq.${id}`, { status: dbStatus });
  console.log(`[OTA Sync] SIM ${iccid}: ${helixStatus} -> ${dbStatus}`);
}

// Maps Helix status strings to DB-allowed values
function mapHelixStatus(helixStatus) {
  if (!helixStatus) return null;
  const lower = helixStatus.toLowerCase();
  if (lower === "active") return "active";
  if (lower === "suspended") return "suspended";
  if (lower === "canceled" || lower === "cancelled") return "canceled";
  return null;
}

// ===========================
// Helix API
// ===========================
const TOKEN_CACHE_KEY = "helix_token";
const TOKEN_TTL_SECONDS = 1800;

async function getCachedToken(env) {
  if (env.TOKEN_CACHE) {
    const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY);
    if (cached) return cached;
  }
  const token = await hxGetBearerToken(env);
  if (env.TOKEN_CACHE) {
    await env.TOKEN_CACHE.put(TOKEN_CACHE_KEY, token, { expirationTtl: TOKEN_TTL_SECONDS });
  }
  return token;
}

async function hxGetBearerToken(env) {
  const res = await fetch(env.HX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: env.HX_CLIENT_ID,
      audience: env.HX_AUDIENCE,
      username: env.HX_GRANT_USERNAME,
      password: env.HX_GRANT_PASSWORD,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Token failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json.access_token;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/details`;
  const method = "POST";
  const requestBody = { mobilitySubscriptionId };

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: "subscriber_details",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `Details failed: ${res.status}`,
  });

  if (!res.ok) throw new Error(`Details failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function hxOtaRefresh(env, token, data, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/reset-ota`;
  const method = "PATCH";
  const requestBody = [data];

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const responseText = await res.text();
  let json = {};
  try { json = JSON.parse(responseText); } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: "ota_refresh",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `OTA Refresh failed: ${res.status}`,
  });

  const allErrorText = [
    responseText,
    ...(Array.isArray(json.rejected) ? json.rejected.map(r => r.message || '') : []),
    json.errorMessage || '',
    json.message || '',
  ].join(' ').toLowerCase();

  if (!res.ok) {
    if (allErrorText.includes('does not belong to the user')) {
      const err = new Error(`OTA Refresh rejected: ${json.errorMessage || responseText}`);
      err.isHelixTimeout = true;
      throw err;
    }
    if (allErrorText.includes('sim number does not match')) {
      const err = new Error(`OTA Refresh rejected: ${json.errorMessage || responseText}`);
      err.isSimMismatch = true;
      throw err;
    }
    throw new Error(`OTA Refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }

  const rejected = Array.isArray(json.rejected) ? json.rejected : [];
  const subNotFound = rejected.find(r => r.message && r.message.toLowerCase().includes('does not belong to the user'));
  if (subNotFound) {
    const err = new Error(`OTA Refresh rejected: ${subNotFound.message}`);
    err.isHelixTimeout = true;
    throw err;
  }
  const simMismatch = rejected.find(r => r.message && r.message.toLowerCase().includes('sim number does not match'));
  if (simMismatch) {
    const err = new Error(`OTA Refresh rejected: ${simMismatch.message}`);
    err.isSimMismatch = true;
    throw err;
  }

  return json;
}

// ===========================
// Supabase helpers
// ===========================
async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Supabase SELECT failed: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function supabasePatch(env, path, bodyObj) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(bodyObj),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status} ${txt}`);
}

// ===========================
// Carrier API Logging
// ===========================
async function logCarrierApiCall(env, logData) {
  const vendor = logData.vendor || 'helix';
  console.log(`[${vendor.toUpperCase()} API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? "OK" : "FAIL"}`);

  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        run_id: logData.run_id,
        step: logData.step,
        iccid: logData.iccid || null,
        vendor,
        request_url: logData.request_url,
        request_method: logData.request_method,
        request_body: logData.request_body || null,
        response_status: logData.response_status,
        response_ok: logData.response_ok,
        response_body_text: logData.response_body_text || null,
        response_body_json: logData.response_body_json || null,
        error: logData.error || null,
        created_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn(`[Carrier API Log] Failed to save: ${err}`);
  }
}

// Backward compatibility alias
async function logHelixApiCall(env, logData) {
  return logCarrierApiCall(env, { ...logData, vendor: 'helix' });
}
