// ota-status-sync worker
// Runs every 12 hours (00:00 and 12:00 UTC).
// For each active/suspended SIM with a Helix subscription ID:
//   1. Fetch subscriber details to get MDN and BAN
//   2. Run OTA refresh via Helix
//   3. Extract the status from the response and update sims.status in DB

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
  const sims = await supabaseSelect(
    env,
    "sims?select=id,iccid,mobility_subscription_id&mobility_subscription_id=not.is.null&status=in.(active,suspended)&order=id.asc&limit=10000"
  );

  if (!Array.isArray(sims) || sims.length === 0) {
    console.log("[OTA Sync] No SIMs to sync");
    return { ok: true, synced: 0, errors: 0 };
  }

  console.log(`[OTA Sync] Starting sync for ${sims.length} SIMs`);
  const token = await getCachedToken(env);

  let synced = 0;
  let errors = 0;

  for (const sim of sims) {
    try {
      await syncSimStatus(env, token, sim);
      synced++;
    } catch (err) {
      console.error(`[OTA Sync] SIM ${sim.iccid} failed: ${err}`);
      errors++;
    }
  }

  console.log(`[OTA Sync] Done. synced=${synced} errors=${errors} total=${sims.length}`);
  return { ok: true, synced, errors, total: sims.length };
}

// ===========================
// Per-SIM status sync
// ===========================
async function syncSimStatus(env, token, sim) {
  const { id, iccid, mobility_subscription_id: subId } = sim;
  const runId = `ota_sync_${iccid}_${Date.now()}`;

  // Get subscriber details for MDN and BAN
  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const d = Array.isArray(details) ? details[0] : null;
  const phoneNumber = d && d.phoneNumber;
  const attBan = (d && d.attBan) || (d && d.ban) || null;

  if (!phoneNumber || !attBan) {
    console.warn(`[OTA Sync] SIM ${iccid}: missing phoneNumber or attBan, skipping`);
    return;
  }

  const mdn = String(phoneNumber).replace(/\D/g, "").replace(/^1/, "");

  // Run OTA refresh — response contains the current subscriber status
  const result = await hxOtaRefresh(env, token, { ban: attBan, subscriberNumber: mdn, iccid }, runId, iccid);

  // Extract status from fulfilled[0].status and update DB
  const fulfilled = result && result.fulfilled;
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

  if (!res.ok) throw new Error(`OTA Refresh failed: ${res.status} ${JSON.stringify(json)}`);
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
// Helix API Logging
// ===========================
async function logHelixApiCall(env, logData) {
  console.log(`[Helix API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? "OK" : "FAIL"}`);

  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
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
    console.warn(`[Helix API Log] Failed to save: ${err}`);
  }
}
