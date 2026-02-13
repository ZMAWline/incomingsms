// =========================================================
// MDN ROTATOR WORKER
// Daily phone number rotation at 5:00 AM UTC
// Error summary notification at 7:00 AM UTC
// Includes: webhook deduplication and retry
// =========================================================

export default {
  // HTTP endpoint for manual triggering
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const limit = parseInt(url.searchParams.get("limit") || "0", 10) || null;
      const result = await queueSimsForRotation(env, { limit });
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/rotate-sim") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const iccid = url.searchParams.get("iccid") || "";
      if (!iccid) {
        return new Response(JSON.stringify({ error: "iccid parameter is required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      const result = await rotateSpecificSim(env, iccid);
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname === "/fix-sim" && request.method === "POST") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const body = await request.json();
        const simIds = body.sim_ids || [];
        if (!Array.isArray(simIds) || simIds.length === 0) {
          return new Response(JSON.stringify({ error: "sim_ids array is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const token = await getCachedToken(env);
        const results = [];
        for (const simId of simIds) {
          try {
            const result = await fixSim(env, token, simId, { autoRotate: false });
            results.push({ sim_id: simId, ok: true, ...result });
          } catch (err) {
            results.push({ sim_id: simId, ok: false, error: String(err) });
          }
        }

        return new Response(JSON.stringify({ ok: true, results }, null, 2), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (url.pathname === "/error-summary") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await sendErrorSummaryToSlack(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("mdn-rotator ok. Use /run?secret=...&limit=1, /rotate-sim?secret=...&iccid=..., or /error-summary?secret=...", { status: 200 });
  },

  // Cron handler
  // - 05:00 UTC: rotation
  // - 07:00 UTC: error summary to Slack
  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime).getUTCHours();

    if (hour === 5) {
      ctx.waitUntil(queueSimsForRotation(env));
    } else if (hour === 7) {
      ctx.waitUntil(sendErrorSummaryToSlack(env));
    }
  },

  // Queue consumer - processes SIMs in batches with cached token
  // After 3 failures, performs cancel + restore cycle then retries once more
  async queue(batch, env) {
    // Get cached token once for the entire batch
    const token = await getCachedToken(env);

    for (const message of batch.messages) {
      const sim = message.body;
      const attempts = message.attempts || 0;

      try {
        await rotateSingleSim(env, token, sim);
        message.ack();
        console.log(`SIM ${sim.iccid}: rotation complete`);
      } catch (err) {
        console.error(`SIM ${sim.iccid} failed (attempt ${attempts + 1}): ${err}`);

        if (attempts >= 2) {
          // 3rd failure — run fix-sim recovery then re-queue
          console.log(`SIM ${sim.iccid}: 3 failures reached, starting fix-sim recovery`);
          try {
            await fixSim(env, token, sim.id, { autoRotate: true });
            message.ack();
            console.log(`SIM ${sim.iccid}: fix-sim complete, re-queued for rotation`);
          } catch (recoveryErr) {
            console.error(`SIM ${sim.iccid}: fix-sim failed: ${recoveryErr}`);
            await updateSimRotationError(env, sim.id, `Fix-SIM failed: ${recoveryErr}`).catch(() => {});
            message.ack();
          }
        } else {
          // Still have retries left — let the queue retry
          message.retry();
        }
      }
    }
  },
};

// ===========================
// Queue all SIMs for rotation (runs at 05:00 UTC or on manual trigger)
// ===========================
async function queueSimsForRotation(env, options = {}) {
  const isManualRun = options.limit && options.limit < 10000;
  const queryLimit = options.limit || 10000;

  // Build query - manual runs prioritize SIMs that were rotated longest ago
  // NULLS FIRST ensures SIMs that have never been rotated get processed first
  let query = `sims?select=id,iccid,mobility_subscription_id,status&mobility_subscription_id=not.is.null&status=eq.active`;

  if (isManualRun) {
    // Manual run: order by oldest rotation first (nulls first = never rotated)
    query += `&order=last_mdn_rotated_at.asc.nullsfirst&limit=${queryLimit}`;
    console.log(`[Manual Run] Fetching ${queryLimit} SIMs ordered by oldest rotation first`);
  } else {
    // Automatic run: process all active SIMs
    query += `&order=id.asc&limit=${queryLimit}`;
    console.log(`[Scheduled Run] Fetching all active SIMs`);
  }

  const sims = await supabaseSelect(env, query);

  if (!Array.isArray(sims) || sims.length === 0) {
    console.log("No active SIMs found.");
    return { ok: true, queued: 0, message: "No SIMs to rotate" };
  }

  console.log(`Queuing ${sims.length} SIMs for rotation...`);

  // Queue each SIM (queue operations don't count toward subrequest limit)
  const messages = sims.map(sim => ({ body: sim }));

  // Send in batches of 100 (queue API limit)
  let queued = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    await env.MDN_QUEUE.sendBatch(batch);
    queued += batch.length;
  }

  console.log(`Queued ${queued} SIMs for rotation.`);
  return { ok: true, queued, total: sims.length, manual: isManualRun };
}

// ===========================
// Rotate a specific SIM by ICCID (manual trigger)
// ===========================
async function rotateSpecificSim(env, iccid) {
  try {
    // Look up the SIM by ICCID
    const sims = await supabaseSelect(
      env,
      `sims?select=id,iccid,mobility_subscription_id,status&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
    );

    if (!Array.isArray(sims) || sims.length === 0) {
      return { ok: false, error: `SIM not found with ICCID: ${iccid}` };
    }

    const sim = sims[0];

    if (!sim.mobility_subscription_id) {
      return { ok: false, error: `SIM ${iccid} has no mobility_subscription_id` };
    }

    if (sim.status !== 'active') {
      return { ok: false, error: `SIM ${iccid} is not active (status: ${sim.status})` };
    }

    const token = await getCachedToken(env);

    // Try rotation up to 3 times, then cancel+restore and try once more
    const maxAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`SIM ${iccid}: rotation attempt ${attempt}/${maxAttempts}`);
        await rotateSingleSim(env, token, sim);
        return { ok: true, iccid, message: `SIM ${iccid} rotated successfully`, attempts: attempt };
      } catch (err) {
        lastError = err;
        console.error(`SIM ${iccid}: attempt ${attempt} failed: ${err}`);
        if (attempt < maxAttempts) {
          await sleep(2000);
        }
      }
    }

    // All 3 attempts failed — run fix-sim recovery then retry once
    console.log(`SIM ${iccid}: 3 attempts failed, starting fix-sim recovery`);
    try {
      await fixSim(env, token, sim.id, { autoRotate: false });
      console.log(`SIM ${iccid}: fix-sim complete, attempting final rotation`);
      await rotateSingleSim(env, token, sim);
      return { ok: true, iccid, message: `SIM ${iccid} rotated successfully after fix-sim recovery`, recovered: true };
    } catch (recoveryErr) {
      console.error(`SIM ${iccid}: recovery failed: ${recoveryErr}`);
      await updateSimRotationError(env, sim.id, `Fix-SIM recovery failed: ${recoveryErr}`).catch(() => {});
      return {
        ok: false,
        iccid,
        error: `Rotation failed after 3 attempts and fix-sim recovery. Last rotation error: ${lastError}. Recovery error: ${recoveryErr}`,
      };
    }
  } catch (err) {
    console.error(`Manual rotation failed for ${iccid}: ${err}`);
    return { ok: false, iccid, error: String(err) };
  }
}

// ===========================
// Rotate a single SIM (called by queue consumer)
// Each SIM uses ~7 subrequests, well under the 1000 limit
// ===========================
async function rotateSingleSim(env, token, sim) {
  const subId = sim.mobility_subscription_id;
  const iccid = sim.iccid;

  if (!subId) {
    console.log(`SIM ${iccid}: no mobility_subscription_id, skipping`);
    return;
  }

  // Generate unique run_id for this rotation operation
  const runId = `rotate_${iccid}_${Date.now()}`;

  // 1) MDN change - request new number from carrier
  const mdnChange = await hxMdnChange(env, token, subId, runId, iccid);

  // 2) Get the new phone number
  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const d = Array.isArray(details) ? details[0] : null;
  const phoneNumber = d?.phoneNumber;
  const detailsIccid = d?.iccid || iccid;

  if (!phoneNumber) {
    throw new Error(`No phoneNumber returned for SUBID ${subId}`);
  }

  const e164 = normalizeUS(phoneNumber);

  // 3) Close current number (set valid_to timestamp)
  await closeCurrentNumber(env, sim.id);

  // 4) Insert new number (with valid_from timestamp, valid_to = null)
  await insertNewNumber(env, sim.id, e164);

  // 5) Update SIM rotation tracking
  await updateSimRotationTimestamp(env, sim.id);

  // 6) Send number.online webhook immediately
  await sendNumberOnlineWebhook(env, sim.id, e164, detailsIccid, subId);

  console.log(`SIM ${iccid}: rotated to ${e164}`);
}

// ===========================
// Send number.online webhook
// ===========================
async function sendNumberOnlineWebhook(env, simId, number, iccid, mobilitySubscriptionId) {
  const resellerId = await findResellerIdBySimId(env, simId);
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);

  if (!webhookUrl) return;

  await sendWebhookWithDeduplication(env, webhookUrl, {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      sim_id: simId,
      number,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid,
      mobilitySubscriptionId,
    }
  }, {
    idComponents: {
      simId,
      iccid,
      number,
    },
    resellerId,
  });
}

// ===========================
// Helix API
// ===========================
const TOKEN_CACHE_KEY = "helix_token";
const TOKEN_TTL_SECONDS = 1800; // 30 minutes

async function getCachedToken(env) {
  // Try to get cached token from KV
  if (env.TOKEN_CACHE) {
    const cached = await env.TOKEN_CACHE.get(TOKEN_CACHE_KEY);
    if (cached) {
      console.log("Using cached Helix token");
      return cached;
    }
  }

  // Fetch new token
  console.log("Fetching new Helix token");
  const token = await hxGetBearerToken(env);

  // Cache the token in KV
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

async function hxMdnChange(env, token, mobilitySubscriptionId, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/ctn`;
  const method = "PATCH";
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
  try {
    json = JSON.parse(responseText);
  } catch {}

  // Log the API call with correct schema columns
  await logHelixApiCall(env, {
    run_id: runId,
    step: "mdn_change",
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `MDN change failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`MDN change failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
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
  try {
    json = JSON.parse(responseText);
  } catch {}

  // Log the API call with correct schema columns
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

  if (!res.ok) {
    throw new Error(`Details failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

// ===========================
// Fix SIM - IMEI change + OTA Refresh + Cancel + Resume
// ===========================
async function fixSim(env, token, simId, { autoRotate = false } = {}) {
  // 1) Load SIM details from DB
  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,mobility_subscription_id,gateway_id,port,slot,current_imei_pool_id&id=eq.${encodeURIComponent(String(simId))}&limit=1`
  );
  if (!Array.isArray(sims) || sims.length === 0) {
    throw new Error(`SIM not found: ${simId}`);
  }
  const sim = sims[0];
  const iccid = sim.iccid;
  const subId = sim.mobility_subscription_id;
  const runId = `fixsim_${iccid}_${Date.now()}`;

  if (!subId) throw new Error(`SIM ${iccid}: no mobility_subscription_id`);
  if (!sim.gateway_id) throw new Error(`SIM ${iccid}: no gateway_id`);
  if (!sim.port) throw new Error(`SIM ${iccid}: no port`);

  console.log(`[FixSim] Starting for SIM ${simId} (${iccid})`);

  // 2) Release old IMEI pool entry if exists
  if (sim.current_imei_pool_id) {
    await releaseImeiPoolEntry(env, sim.current_imei_pool_id, simId);
  }

  // 3) Allocate new IMEI from pool
  const poolEntry = await allocateImeiFromPool(env, simId);
  const newImei = poolEntry.imei;
  console.log(`[FixSim] SIM ${iccid}: allocated IMEI ${newImei} (pool entry ${poolEntry.id})`);

  // 4) Set IMEI on gateway via service binding
  await callSkylineSetImei(env, sim.gateway_id, sim.port, newImei);
  console.log(`[FixSim] SIM ${iccid}: IMEI set on gateway`);

  // 5) Wait for gateway to process
  await sleep(2000);

  // 6) Get subscriber details (attBan, phoneNumber)
  const details = await hxSubscriberDetails(env, token, subId, runId, iccid);
  const d = Array.isArray(details) ? details[0] : null;
  const subscriberNumber = d?.phoneNumber;
  const attBan = d?.attBan || d?.ban || null;
  const subscriberStatus = (d?.status || '').toUpperCase();

  if (!subscriberNumber) {
    throw new Error(`SIM ${iccid}: no phoneNumber from Helix`);
  }

  const mdn = String(subscriberNumber).replace(/\D/g, "").replace(/^1/, "");

  // 7) OTA Refresh (skip if no attBan)
  if (attBan) {
    console.log(`[FixSim] SIM ${iccid}: OTA Refresh (ban=${attBan})`);
    await hxOtaRefresh(env, token, {
      ban: attBan,
      subscriberNumber: mdn,
      iccid,
    }, runId, iccid);
    await sleep(3000);
  } else {
    console.log(`[FixSim] SIM ${iccid}: skipping OTA Refresh (no attBan)`);
  }

  // 8) Cancel (only if subscriber is active on carrier side)
  if (subscriberStatus === 'ACTIVATED' || subscriberStatus === 'ACTIVE') {
    console.log(`[FixSim] SIM ${iccid}: canceling subscriber ${mdn} (status=${subscriberStatus})`);
    await hxChangeSubscriberStatus(env, token, {
      mobilitySubscriptionId: subId,
      subscriberNumber: mdn,
      reasonCode: "CAN",
      reasonCodeId: 1,
      subscriberState: "Cancel",
    }, runId, iccid, "fix_cancel");
    await sleep(3000);
  } else {
    console.log(`[FixSim] SIM ${iccid}: skipping cancel (carrier status=${subscriberStatus})`);
  }

  // 9) Resume On Cancel
  console.log(`[FixSim] SIM ${iccid}: resuming subscriber ${mdn}`);
  await hxChangeSubscriberStatus(env, token, {
    mobilitySubscriptionId: subId,
    subscriberNumber: mdn,
    reasonCode: "BBL",
    reasonCodeId: 20,
    subscriberState: "Resume On Cancel",
  }, runId, iccid, "fix_resume");
  await sleep(3000);

  // 10) Update SIM record with new IMEI and pool entry
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    { imei: newImei, current_imei_pool_id: poolEntry.id }
  );

  // 11) If autoRotate, re-queue for MDN rotation
  if (autoRotate) {
    await env.MDN_QUEUE.send({
      id: sim.id,
      iccid: sim.iccid,
      mobility_subscription_id: subId,
      status: 'active',
      _recoveryAttempt: true,
    });
    console.log(`[FixSim] SIM ${iccid}: re-queued for rotation`);
  }

  console.log(`[FixSim] SIM ${iccid}: fix complete (IMEI=${newImei})`);
  return { imei: newImei, pool_entry_id: poolEntry.id };
}

// ===========================
// IMEI Pool helpers
// ===========================
async function allocateImeiFromPool(env, simId) {
  // Find first available IMEI
  const available = await supabaseSelect(
    env,
    `imei_pool?select=id,imei&status=eq.available&order=id.asc&limit=1`
  );
  if (!Array.isArray(available) || available.length === 0) {
    throw new Error("No available IMEIs in pool");
  }

  const entry = available[0];

  // Claim it with status filter for safety (prevents double-allocation)
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${entry.id}&status=eq.available`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      status: "in_use",
      sim_id: simId,
      assigned_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Failed to allocate IMEI: ${res.status} ${txt}`);

  const updated = JSON.parse(txt);
  if (!Array.isArray(updated) || updated.length === 0) {
    throw new Error("IMEI allocation race condition — entry already claimed");
  }

  return updated[0];
}

async function releaseImeiPoolEntry(env, poolEntryId, simId) {
  console.log(`[IMEI Pool] Releasing entry ${poolEntryId} from SIM ${simId}`);
  await supabasePatch(
    env,
    `imei_pool?id=eq.${encodeURIComponent(String(poolEntryId))}`,
    {
      status: "available",
      sim_id: null,
      assigned_at: null,
      previous_sim_id: simId,
      updated_at: new Date().toISOString(),
    }
  );
}

// ===========================
// Skyline Gateway - Set IMEI via service binding
// ===========================
async function callSkylineSetImei(env, gatewayId, port, imei) {
  if (!env.SKYLINE_GATEWAY) {
    throw new Error("SKYLINE_GATEWAY service binding not configured");
  }
  if (!env.SKYLINE_SECRET) {
    throw new Error("SKYLINE_SECRET not configured");
  }

  const skUrl = `https://skyline-gateway/set-imei?secret=${encodeURIComponent(env.SKYLINE_SECRET)}`;
  const res = await env.SKYLINE_GATEWAY.fetch(skUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gateway_id: gatewayId, port, imei }),
  });

  const txt = await res.text();
  let json = {};
  try { json = JSON.parse(txt); } catch {}

  if (!res.ok || !json.ok) {
    throw new Error(`Set IMEI failed: ${res.status} ${txt}`);
  }

  return json;
}

// ===========================
// Helix OTA Refresh
// ===========================
async function hxOtaRefresh(env, token, payload, runId, iccid) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/reset-ota`;
  const method = "PATCH";
  const requestBody = [payload];

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

  if (!res.ok) {
    throw new Error(`OTA Refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function hxChangeSubscriberStatus(env, token, statusPayload, runId, iccid, stepName) {
  const url = `${env.HX_API_BASE}/api/mobility-subscriber/ctn`;
  const method = "PATCH";
  const requestBody = statusPayload;

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
  try {
    json = JSON.parse(responseText);
  } catch {}

  await logHelixApiCall(env, {
    run_id: runId,
    step: stepName,
    iccid,
    request_url: url,
    request_method: method,
    request_body: requestBody,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: json,
    error: res.ok ? null : `${stepName} failed: ${res.status}`,
  });

  if (!res.ok) {
    throw new Error(`${stepName} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function normalizeUS(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return phone;
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

  // Log what was actually updated
  try {
    const data = JSON.parse(txt);
    console.log(`[DB] PATCH result: ${data.length} rows updated`);
  } catch {}
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase INSERT failed: ${res.status} ${txt}`);

  // Log what was actually inserted
  try {
    const data = JSON.parse(txt);
    console.log(`[DB] INSERT result: ${data.length} rows inserted`);
  } catch {}
}

// ===========================
// Helix API Logging
// ===========================
async function logHelixApiCall(env, logData) {
  // Use correct schema columns for helix_api_logs table
  const logPayload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_headers: logData.request_headers || null,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_headers: logData.response_headers || null,
    response_body_text: logData.response_body_text || null,
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };

  // Always log to console for Cloudflare logs
  console.log(`[Helix API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? 'OK' : 'FAIL'}`);
  console.log(`[Helix API] Request: ${JSON.stringify(logData.request_body)}`);
  console.log(`[Helix API] Response: ${JSON.stringify(logData.response_body_json)}`);

  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(logPayload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[Helix API Log] Failed to save to Supabase: ${res.status} ${errText}`);
    } else {
      console.log(`[Helix API Log] Saved to helix_api_logs table`);
    }
  } catch (err) {
    console.error(`[Helix API Log] Exception saving to Supabase: ${err}`);
  }
}

async function closeCurrentNumber(env, simId) {
  console.log(`[DB] Closing current number for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
  console.log(`[DB] Closed current number for sim_id=${simId}`);
}

async function insertNewNumber(env, simId, e164) {
  console.log(`[DB] Inserting new number ${e164} for sim_id=${simId}`);
  await supabaseInsert(env, "sim_numbers", [
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
    },
  ]);
  console.log(`[DB] Inserted new number ${e164} for sim_id=${simId}`);
}

async function updateSimRotationTimestamp(env, simId) {
  const now = new Date().toISOString();
  console.log(`[DB] Updating rotation timestamp for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    {
      last_mdn_rotated_at: now,
      last_rotation_at: now,
      rotation_status: 'success',
      last_rotation_error: null,
    }
  );
  console.log(`[DB] Updated rotation timestamp for sim_id=${simId}`);
}

async function updateSimRotationError(env, simId, errorMessage) {
  console.log(`[DB] Recording rotation error for sim_id=${simId}`);
  await supabasePatch(
    env,
    `sims?id=eq.${encodeURIComponent(String(simId))}`,
    {
      rotation_status: 'failed',
      last_rotation_error: errorMessage,
      last_rotation_at: new Date().toISOString(),
    }
  );
  console.log(`[DB] Recorded rotation error for sim_id=${simId}`);
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${q}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

// ===========================
// WEBHOOK UTILITIES (with deduplication and retry)
// ===========================

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  const roundedTs = timestamp
    ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
    : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), roundedTs].join('|');

  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${eventType}_${hashHex}`;
}

async function wasWebhookDelivered(env, messageId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/webhook_deliveries?message_id=eq.${encodeURIComponent(messageId)}&status=eq.delivered&limit=1`,
    {
      method: 'GET',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function recordWebhookDelivery(env, delivery) {
  const { messageId, eventType, resellerId, webhookUrl, payload, status, attempts } = delivery;

  await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_deliveries`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({
      message_id: messageId,
      event_type: eventType,
      reseller_id: resellerId,
      webhook_url: webhookUrl,
      payload,
      status,
      attempts,
      last_attempt_at: new Date().toISOString(),
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
    }),
  });
}

async function postWebhookWithRetry(url, payload, options = {}) {
  const { maxRetries = 4, initialDelayMs = 1000, messageId = 'unknown' } = options;

  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`[Webhook] Attempt ${attempt}/${maxRetries + 1} for ${messageId} to ${url}`);

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      lastStatus = res.status;

      if (res.ok) {
        console.log(`[Webhook] Success ${res.status} for ${messageId} after ${attempt} attempt(s)`);
        return { ok: true, status: res.status, attempts: attempt };
      }

      if (res.status >= 400 && res.status < 500) {
        const txt = await res.text().catch(() => '');
        console.log(`[Webhook] Client error ${res.status} for ${messageId}: ${txt.slice(0, 200)}`);
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}` };
      }

      const txt = await res.text().catch(() => '');
      lastError = `Server error ${res.status}: ${txt.slice(0, 200)}`;
      console.log(`[Webhook] ${lastError} for ${messageId}`);

    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
      console.log(`[Webhook] ${lastError} for ${messageId}`);
    }

    if (attempt <= maxRetries) {
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      console.log(`[Webhook] Retrying ${messageId} in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  console.log(`[Webhook] Failed ${messageId} after ${maxRetries + 1} attempts: ${lastError}`);
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError };
}

async function sendWebhookWithDeduplication(env, webhookUrl, payload, options = {}) {
  if (!webhookUrl) {
    return { ok: false, status: 0, attempts: 0, error: 'No webhook URL' };
  }

  let messageId = options.messageId;
  if (!messageId && options.idComponents) {
    messageId = await generateMessageIdAsync({
      eventType: payload.event_type,
      ...options.idComponents,
    });
  }
  if (!messageId) {
    messageId = `${payload.event_type}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  payload.message_id = messageId;

  const alreadySent = await wasWebhookDelivered(env, messageId);
  if (alreadySent) {
    console.log(`[Webhook] Skipping duplicate ${messageId}`);
    return { ok: true, status: 200, attempts: 0, skipped: true };
  }

  const result = await postWebhookWithRetry(webhookUrl, payload, { messageId });

  try {
    await recordWebhookDelivery(env, {
      messageId,
      eventType: payload.event_type,
      resellerId: options.resellerId,
      webhookUrl,
      payload,
      status: result.ok ? 'delivered' : 'failed',
      attempts: result.attempts,
    });
  } catch (err) {
    console.log(`[Webhook] Failed to record delivery: ${err}`);
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextRotationUtcISO() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    5, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

// ===========================
// SLACK ERROR SUMMARY
// ===========================

async function sendErrorSummaryToSlack(env) {
  if (!env.SLACK_WEBHOOK_URL) {
    console.log("[Slack] No SLACK_WEBHOOK_URL configured, skipping error summary");
    return { ok: false, error: "No SLACK_WEBHOOK_URL configured" };
  }

  // Get errors from the last 24 hours
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const query = `helix_api_logs?select=iccid,step,error,response_status,request_body,created_at&or=(response_ok.eq.false,error.not.is.null)&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc`;

  let errors = [];
  try {
    errors = await supabaseSelect(env, query);
  } catch (err) {
    console.error(`[Slack] Failed to fetch errors: ${err}`);
    return { ok: false, error: `Failed to fetch errors: ${err}` };
  }

  if (!Array.isArray(errors) || errors.length === 0) {
    console.log("[Slack] No errors in the last 24 hours");
    // Optionally send a success message
    if (env.SLACK_NOTIFY_SUCCESS === "true") {
      await postToSlack(env.SLACK_WEBHOOK_URL, {
        text: ":white_check_mark: MDN Rotator: No errors in the last 24 hours"
      });
    }
    return { ok: true, errors: 0, message: "No errors to report" };
  }

  // Deduplicate by ICCID - keep only the most recent error per SIM
  const errorsByIccid = new Map();
  for (const err of errors) {
    const iccid = err.iccid || "unknown";
    if (!errorsByIccid.has(iccid)) {
      errorsByIccid.set(iccid, err);
    }
  }

  const uniqueErrors = Array.from(errorsByIccid.values());
  console.log(`[Slack] Found ${errors.length} total errors, ${uniqueErrors.length} unique SIMs`);

  // Format Slack message
  const errorLines = uniqueErrors.slice(0, 20).map(err => {
    const subId = err.request_body?.mobilitySubscriptionId || err.request_body?.mobilitySubscriptionId || null;
    const identifier = subId ? `SUB:${subId}` : (err.iccid || "unknown");
    const step = err.step || "unknown";
    const status = err.response_status || "N/A";
    const errorMsg = (err.error || "Unknown error").slice(0, 100);
    return `• \`${identifier}\` [${step}] HTTP ${status}: ${errorMsg}`;
  });

  if (uniqueErrors.length > 20) {
    errorLines.push(`_...and ${uniqueErrors.length - 20} more SIMs with errors_`);
  }

  const slackPayload = {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `:warning: MDN Rotator Error Summary`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${uniqueErrors.length} SIM(s)* encountered errors in the last 24 hours:`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: errorLines.join("\n")
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Total error events: ${errors.length} | Unique SIMs: ${uniqueErrors.length} | Generated: ${new Date().toISOString()}`
          }
        ]
      }
    ]
  };

  const result = await postToSlack(env.SLACK_WEBHOOK_URL, slackPayload);

  return {
    ok: result.ok,
    totalErrors: errors.length,
    uniqueSims: uniqueErrors.length,
    slackStatus: result.status
  };
}

async function postToSlack(webhookUrl, payload) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(`[Slack] Failed to post: ${res.status} ${txt}`);
      return { ok: false, status: res.status };
    }

    console.log("[Slack] Message posted successfully");
    return { ok: true, status: res.status };
  } catch (err) {
    console.error(`[Slack] Exception: ${err}`);
    return { ok: false, status: 0, error: String(err) };
  }
}
