// ota-status-sync worker
// Runs every 12 hours (00:00 and 12:00 UTC).
// For each active/suspended ATOMIC SIM: run OTA refresh via resendOtaProfile.
// Teltik SIMs are skipped (handled by teltik-worker).

import { carrierFetch, supabaseFetch } from '../shared/fetch-timeout.mjs';
import { sbGet } from '../shared/supabase-rest.mjs';

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
// Relay fetch helper
// ===========================
function relayFetch(env, url, init, send = carrierFetch) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return send(env, `${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return send(env, url, init);
}

// ===========================
// Main sync loop
// ===========================
async function runOtaStatusSync(env) {
  const sims = await sbGet(
    env,
    "sims?select=id,iccid,msisdn,status,vendor&status=in.(active,suspended)&vendor=eq.atomic&order=id.asc&limit=10000"
  );

  if (!Array.isArray(sims) || sims.length === 0) {
    console.log("[OTA Sync] No SIMs to sync");
    return { ok: true, synced: 0, errors: 0, skipped: 0 };
  }

  const validSims = sims.filter(sim => !!sim.msisdn);

  console.log(`[OTA Sync] Starting sync for ${validSims.length} SIMs (${sims.length - validSims.length} skipped)`);

  let synced = 0;
  let errors = 0;

  for (const sim of validSims) {
    try {
      await syncSimStatusAtomic(env, sim, `ota_sync_${sim.iccid}_${Date.now()}`);
      synced++;
    } catch (err) {
      console.error(`[OTA Sync] SIM ${sim.iccid} failed: ${err}`);
      errors++;
    }
  }

  console.log(`[OTA Sync] Done. synced=${synced} errors=${errors} total=${validSims.length}`);
  return { ok: true, synced, errors, total: validSims.length, skipped: sims.length - validSims.length };
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

  const res = await relayFetch(env, url, {
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

  // ATOMIC OTA returns no line status - just confirms the refresh was sent
  if (res.ok && json?.wholeSaleApi?.wholeSaleResponse?.statusCode === '00') {
    console.log(`[OTA Sync] SIM ${iccid} (atomic): OTA refresh sent`);
  } else {
    console.warn(`[OTA Sync] SIM ${iccid} (atomic): OTA refresh failed`);
  }
}


// ===========================
// Carrier API Logging
// ===========================
async function logCarrierApiCall(env, logData) {
  const vendor = logData.vendor || 'atomic';
  console.log(`[${vendor.toUpperCase()} API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? "OK" : "FAIL"}`);

  try {
    await supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
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
