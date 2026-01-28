export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname !== "/cancel") {
      return new Response(
        "sim-canceller ok. Use POST /cancel?secret=...",
        { status: 200 }
      );
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Security
    const secret = url.searchParams.get("secret") || "";
    if (!env.CANCEL_SECRET || secret !== env.CANCEL_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const body = await request.json();
      const iccids = body.iccids || [];

      if (!Array.isArray(iccids) || iccids.length === 0) {
        return json({ ok: false, error: "iccids array is required" }, 400);
      }

      // Get Helix bearer token
      const token = await hxGetBearerToken(env);

      let processed = 0;
      let cancelled = 0;
      let errors = 0;
      const results = [];

      // Process each ICCID
      for (const iccid of iccids) {
        try {
          // Get SIM from database
          const sims = await supabaseSelect(
            env,
            `sims?select=id,iccid,mobility_subscription_id,status&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
          );

          if (!sims || sims.length === 0) {
            errors++;
            results.push({
              iccid,
              ok: false,
              error: "SIM not found in database"
            });
            continue;
          }

          const sim = sims[0];
          const { id: simId, mobility_subscription_id: subId, status } = sim;

          // Skip if already cancelled
          if (status === 'cancelled') {
            results.push({
              iccid,
              ok: true,
              skipped: true,
              reason: "Already cancelled"
            });
            continue;
          }

          if (!subId) {
            errors++;
            results.push({
              iccid,
              ok: false,
              error: "No mobility_subscription_id found"
            });
            continue;
          }

          // Cancel with Helix
          await hxCancelSubscription(env, token, subId);

          // Update SIM status to cancelled
          await supabasePatch(
            env,
            `sims?id=eq.${simId}`,
            {
              status: 'cancelled',
              status_reason: 'Cancelled via sim-canceller'
            }
          );

          // Expire current phone number
          const now = new Date().toISOString();
          await supabasePatch(
            env,
            `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`,
            { valid_to: now }
          );

          // Send webhook notification (if configured)
          try {
            const resellerId = await findResellerIdBySimId(env, simId);
            if (resellerId) {
              const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
              if (webhookUrl) {
                await postResellerWebhook(webhookUrl, {
                  event_type: "sim.cancelled",
                  created_at: new Date().toISOString(),
                  data: {
                    sim_id: simId,
                    iccid: iccid,
                    mobility_subscription_id: subId
                  }
                });
              }
            }
          } catch (webhookError) {
            console.log(`Webhook error for ${iccid}:`, String(webhookError));
          }

          cancelled++;
          processed++;
          results.push({
            iccid,
            ok: true,
            cancelled: true,
            sim_id: simId,
            mobility_subscription_id: subId
          });

        } catch (error) {
          errors++;
          results.push({
            iccid,
            ok: false,
            error: String(error)
          });
        }

        // Small delay between cancellations
        await sleep(2000);
      }

      return json({
        ok: true,
        processed,
        cancelled,
        errors,
        total_requested: iccids.length,
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

async function hxCancelSubscription(env, token, subscriptionId) {
  const res = await fetch(
    `${env.HX_API_BASE}/api/mobility-subscriber/disconnect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mobilitySubscriptionId: subscriptionId }),
    }
  );

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok) {
    throw new Error(
      `Cancel subscription failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`
    );
  }

  return json;
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

  console.log(`[Cancel Webhook] Sending to ${webhookUrl}:`, JSON.stringify(payload));

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`[Cancel Webhook] Failed ${res.status}: ${txt.slice(0, 300)}`);
    } else {
      console.log(`[Cancel Webhook] Success ${res.status}`);
    }
  } catch (err) {
    console.log(`[Cancel Webhook] Error:`, String(err));
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
