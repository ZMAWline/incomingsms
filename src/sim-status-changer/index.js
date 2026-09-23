import { carrierFetch, supabaseFetch, webhookFetch } from '../shared/fetch-timeout.mjs';
import { sbGet, sbPatch } from '../shared/supabase-rest.mjs';
import { buildNumberEvent } from '../shared/number-event.mjs';
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
    const newDbStatus = action === "suspend" ? "suspended" : "active";

    try {
      const body = await request.json();
      const simIds = body.sim_ids || [];

      if (!Array.isArray(simIds) || simIds.length === 0) {
        return json({ ok: false, error: "sim_ids array is required" }, 400);
      }

      let processed = 0;
      let success = 0;
      let errors = 0;
      const results = [];

      // Process each SIM ID
      for (const simId of simIds) {
        try {
          // Get SIM and current phone number from database
          const sims = await sbGet(
            env,
            `sims?select=id,iccid,mobility_subscription_id,msisdn,status,vendor&id=eq.${encodeURIComponent(simId)}&limit=1`
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
          const { iccid, mobility_subscription_id: subId, msisdn, status } = sim;
          const vendor = sim.vendor;

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

          // Only ATOMIC supports suspend/restore (Teltik has no carrier API for it)
          if (vendor !== 'atomic') {
            errors++;
            results.push({
              sim_id: simId,
              ok: false,
              error: `${vendor} SIMs do not support suspend/restore`
            });
            continue;
          }

          // Check for required identifier
          if (vendor === 'atomic' && !msisdn) {
            errors++;
            results.push({
              sim_id: simId,
              ok: false,
              error: "No msisdn found (atomic)"
            });
            continue;
          }

          await atomicChangeStatus(env, msisdn, action, iccid);

          // Update SIM status in database
          await sbPatch(
            env,
            `sims?id=eq.${simId}`,
            {
              status: newDbStatus,
              status_reason: `${subscriberState} via sim-status-changer`
            }
          );

          // Tell the reseller: a suspended line is offline, a restored one is
          // online. A webhook failure is logged only; the status change has
          // already succeeded.
          try {
            const resellerId = await findResellerIdBySimId(env, simId);
            if (resellerId) {
              const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
              if (webhookUrl) {
                const numbers = await sbGet(env, `sim_numbers?select=e164&sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null&limit=1`);
                await postResellerWebhook(env, webhookUrl, await buildNumberEvent({
                  online: action === "restore",
                  simId,
                  iccid,
                  number: numbers?.[0]?.e164 || msisdn,
                  mobilitySubscriptionId: subId,
                  vendor,
                  reason: action === "restore" ? "restored" : "suspended",
                }));
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
            phone_number: msisdn,
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

/* ================= RELAY ================= */

function relayFetch(env, url, init, send = carrierFetch) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return send(env, `${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return send(env, url, init);
}

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

/* ================= ATOMIC API ================= */

async function atomicChangeStatus(env, msisdn, action, iccid) {
  const runId = `status_${Date.now().toString(36)}`;
  const url = env.ATOMIC_API_URL || 'https://solutionsatt-atomic.telgoo5.com:22712';

  const requestType = action === 'suspend' ? 'suspendSubscriber' : 'restoreSubscriber';
  const reasonCode = action === 'suspend' ? 'NPG' : 'CR';

  const requestBody = {
    wholeSaleApi: {
      session: {
        userName: env.ATOMIC_USERNAME,
        token: env.ATOMIC_TOKEN,
        pin: env.ATOMIC_PIN,
      },
      wholeSaleRequest: {
        requestType,
        MSISDN: msisdn,
        reasonCode,
      },
    },
  };

  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const responseData = await safeReadJsonOrText(res);

  await logCarrierApi(env, {
    runId,
    step: `change_status_${action}`,
    iccid,
    vendor: 'atomic',
    requestUrl: url,
    requestMethod: 'POST',
    requestBody,
    responseStatus: res.status,
    responseOk: res.ok,
    responseBodyText: responseData.text,
    responseBodyJson: responseData.json,
  });

  if (!res.ok) {
    throw new Error(`ATOMIC ${requestType} failed ${res.status}: ${responseData.text}`);
  }

  const statusCode = responseData.json?.wholeSaleApi?.wholeSaleResponse?.statusCode;
  if (statusCode !== '00') {
    const desc = responseData.json?.wholeSaleApi?.wholeSaleResponse?.description || 'Unknown error';
    throw new Error(`ATOMIC ${requestType} failed: ${desc}`);
  }

  console.log(`[ATOMIC] Successfully ${action} MSISDN ${msisdn}`);
  return responseData.json;
}


async function logCarrierApi(env, data) {
  const vendor = data.vendor || 'atomic';
  try {
    await supabaseFetch(env, `${env.SUPABASE_URL}/rest/v1/carrier_api_logs`, {
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
        vendor,
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
    console.log(`[LogCarrierApi] Failed to log: ${e}`);
  }
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  const res = await sbGet(env, q);
  return Array.isArray(res) && res[0]?.reseller_id ? res[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  const res = await sbGet(env, q);
  return Array.isArray(res) && res[0]?.url ? res[0].url : null;
}

async function postResellerWebhook(env, webhookUrl, payload) {
  if (!webhookUrl) return;

  console.log(`[Status Webhook] Sending to ${webhookUrl}:`, JSON.stringify(payload));

  try {
    const res = await relayFetch(env, webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, webhookFetch);

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
