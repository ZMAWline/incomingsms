export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname !== "/suspend" && url.pathname !== "/restore") {
      return new Response(
        "sim-status-changer ok. Use POST /suspend or /restore with ?secret=...",
        { status: 200 }
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Security
    const secret = url.searchParams.get("secret") || "";
    if (!env.STATUS_SECRET || secret !== env.STATUS_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Determine action based on path
    const action = url.pathname === "/suspend" ? "suspend" : "restore";
    const subscriberState = action === "suspend" ? "Suspend" : "Unsuspend";
    const reasonCode = "CR";
    const reasonCodeId = action === "suspend" ? 22 : 35;
    const newDbStatus = action === "suspend" ? "suspended" : "active";
    const webhookEvent = action === "suspend" ? "sim.suspended" : "sim.restored";

    try {
      const body = await request.json();
      const simIds = body.sim_ids || [];

      if (!Array.isArray(simIds) || simIds.length === 0) {
        return json({ ok: false, error: "sim_ids array is required" }, 400);
      }

      // Get Helix bearer token
      const token = await hxGetBearerToken(env);

      let processed = 0;
      let success = 0;
      let errors = 0;
      const results = [];

      // Process each SIM ID
      for (const simId of simIds) {
        try {
          // Get SIM and current phone number from database
          const sims = await supabaseSelect(
            env,
            `sims?select=id,iccid,mobility_subscription_id,status&id=eq.${encodeURIComponent(simId)}&limit=1`
          );

          if (!sims || sims.length === 0) {
            errors++;
            results.push({
              sim_id: simId,
              ok: false,
              error: "SIM not found in database"
            });
            continue;
          }

          const sim = sims[0];
          const { iccid, mobility_subscription_id: subId, status } = sim;

          // Skip if already in target state
          if ((action === "suspend" && status === "suspended") ||
              (action === "restore" && status === "active")) {
            results.push({
              sim_id: simId,
              ok: true,
              skipped: true,
              reason: `Already ${newDbStatus}`
            });
            continue;
          }

          if (!subId) {
            errors++;
            results.push({
              sim_id: simId,
              ok: false,
              error: "No mobility_subscription_id found"
            });
            continue;
          }

          // Get current phone number
          const numbers = await supabaseSelect(
            env,
            `sim_numbers?select=e164&sim_id=eq.${simId}&valid_to=is.null&limit=1`
          );

          const phoneNumber = numbers?.[0]?.e164;
          if (!phoneNumber) {
            errors++;
            results.push({
              sim_id: simId,
              ok: false,
              error: "No active phone number found"
            });
            continue;
          }

          // Strip +1 prefix for Helix API (expects 10-digit MDN)
          const mdn = phoneNumber.replace(/^\+1/, "");

          // Call Helix API to change status
          await hxChangeStatus(env, token, mdn, subscriberState, reasonCode, reasonCodeId, iccid);

          // Update SIM status in database
          await supabasePatch(
            env,
            `sims?id=eq.${simId}`,
            {
              status: newDbStatus,
              status_reason: `${subscriberState} via sim-status-changer`
            }
          );

          // Send webhook notification (if configured)
          try {
            const resellerId = await findResellerIdBySimId(env, simId);
            if (resellerId) {
              const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
              if (webhookUrl) {
                await postResellerWebhook(webhookUrl, {
                  event_type: webhookEvent,
                  created_at: new Date().toISOString(),
                  data: {
                    sim_id: simId,
                    iccid: iccid,
                    phone_number: phoneNumber,
                    mobility_subscription_id: subId,
                    action: subscriberState
                  }
                });
              }
            }
          } catch (webhookError) {
            console.log(`Webhook error for SIM ${simId}:`, String(webhookError));
          }

          success++;
          processed++;
          results.push({
            sim_id: simId,
            iccid,
            phone_number: phoneNumber,
            ok: true,
            action: subscriberState,
            mobility_subscription_id: subId
          });

        } catch (error) {
          errors++;
          results.push({
            sim_id: simId,
            ok: false,
            error: String(error)
          });
        }

        // Small delay between operations
        await sleep(2000);
      }

      return json({
        ok: errors === 0,
        action: subscriberState,
        processed,
        success,
        errors,
        total_requested: simIds.length,
        results
      });

    } catch (error) {
      return json({ ok: false, error: String(error) }, 500);
    }
  },
};

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* ================= HELIX API ================= */

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

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok || !json?.access_token) {
    throw new Error(`Token failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`);
  }
  return json.access_token;
}

async function hxChangeStatus(env, token, mdn, subscriberState, reasonCode, reasonCodeId, iccid) {
  const runId = `status_${Date.now().toString(36)}`;

  const statusUrl = `${env.HX_API_BASE}/api/mobility-subscriber/ctn`;
  const statusBody = [{
    subscriberNumber: mdn,
    reasonCode,
    reasonCodeId,
    subscriberState
  }];

  const statusRes = await fetch(statusUrl, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(statusBody),
  });

  const statusData = await safeReadJsonOrText(statusRes);

  // Log the request
  await logHelixApi(env, {
    runId,
    step: `change_status_${subscriberState.toLowerCase()}`,
    iccid,
    requestUrl: statusUrl,
    requestMethod: "PATCH",
    requestBody: statusBody,
    responseStatus: statusRes.status,
    responseOk: statusRes.ok,
    responseBodyText: statusData.text,
    responseBodyJson: statusData.json,
  });

  if (!statusRes.ok) {
    throw new Error(
      `Status change failed ${statusRes.status}: ${JSON.stringify(statusData.json ?? { raw: statusData.text })}`
    );
  }

  // Check for rejected operations
  if (statusData.json?.rejected?.length > 0) {
    throw new Error(
      `Status change rejected: ${JSON.stringify(statusData.json.rejected)}`
    );
  }

  console.log(`[Helix] Successfully ${subscriberState} MDN ${mdn}`);
  return statusData.json;
}

async function logHelixApi(env, data) {
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        run_id: data.runId,
        step: data.step,
        iccid: data.iccid,
        request_url: data.requestUrl,
        request_method: data.requestMethod,
        request_body: data.requestBody,
        response_status: data.responseStatus,
        response_ok: data.responseOk,
        response_body_text: data.responseBodyText?.slice(0, 10000),
        response_body_json: data.responseBodyJson,
        error: data.error,
      }),
    });
  } catch (e) {
    console.log(`[LogHelixApi] Failed to log: ${e}`);
  }
}

/* ================= SUPABASE ================= */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase select failed ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!text.trim()) return [];

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Supabase select JSON parse failed: ${String(e)}. Raw: ${text.slice(0, 300)}`
    );
  }
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase patch failed ${res.status}: ${text.slice(0, 300)}`);
  }

  return true;
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  const res = await supabaseSelect(env, q);
  return Array.isArray(res) && res[0]?.reseller_id ? res[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  const res = await supabaseSelect(env, q);
  return Array.isArray(res) && res[0]?.url ? res[0].url : null;
}

async function postResellerWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;

  console.log(`[Status Webhook] Sending to ${webhookUrl}:`, JSON.stringify(payload));

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`[Status Webhook] Failed ${res.status}: ${txt.slice(0, 300)}`);
    } else {
      console.log(`[Status Webhook] Success ${res.status}`);
    }
  } catch (err) {
    console.log(`[Status Webhook] Error:`, String(err));
  }
}

/* ================= RESPONSE PARSING ================= */

async function safeReadJsonOrText(res) {
  const text = await res.text();
  if (!text) return { json: null, text: "" };

  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}
