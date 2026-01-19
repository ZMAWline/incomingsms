export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/run") {
      return new Response("details-finalizer ok. Use /run?secret=...", { status: 200 });
    }

    const secret = url.searchParams.get("secret") || "";
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Run the same logic as cron, but with query params support
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : 1000;

    const result = await runFinalizer(env, limit);
    return json(result);
  },

  async scheduled(event, env, ctx) {
    // Cron can’t pass query params; pick a safe default batch size
    // (Strongly recommend small batches, not 1000 + sleep)
    const limit = 25
    ;

    // If you want to ensure cron never overlaps, you’d do it via Durable Object / KV lock.
    ctx.waitUntil(runFinalizer(env, limit));
  }
};

/* ---------------- core runner ---------------- */

async function runFinalizer(env, limit) {
  const token = await hxGetBearerToken(env);

  const sims = await supabaseSelect(
    env,
    `sims?select=id,iccid,mobility_subscription_id,status&status=eq.provisioning&limit=${limit}`
  );

  let processed = 0;
  let activated = 0;

  for (const sim of sims) {
    processed++;

    const simId = sim.id;
    const subId = sim.mobility_subscription_id;
    if (!subId) continue;

    // ⚠️ Avoid sleeping in Workers; better to run smaller batches on cron.
    // If you absolutely must keep it, this may still be risky on long runs:
    // await sleep(15000);

    let details;
    try {
      details = await hxSubscriberDetails(env, token, subId);
    } catch (e) {
      console.log(`SUBID ${subId}: details error`, String(e));
      continue;
    }

    const d = Array.isArray(details) ? details[0] : null;
    const phoneNumber = d?.phoneNumber;

    if (!phoneNumber) {
      console.log(`SUBID ${subId}: phoneNumber still null, skipping`);
      continue;
    }

    const e164 = normalizeUS(phoneNumber);

    await closeCurrentNumber(env, simId);
    await insertNewNumber(env, simId, e164);

    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(simId))}`,
      { status: "active", status_reason: null }
    );

    try {
      await sendNumberOnlineWebhook(env, simId, {
        number: e164,
        iccid: sim.iccid,
        mobilitySubscriptionId: subId
      });
    } catch (e) {
      console.log(`SIM ${simId}: webhook failed`, String(e));
    }

    activated++;
  }

  return {
    ok: true,
    processed,
    activated,
    remaining: Math.max(sims.length - processed, 0)
  };
}

/* ---------------- helpers  ---------------- */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json" }
  });
}

function normalizeUS(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return phone;
}

/* ---------------- Helix ---------------- */

async function hxGetBearerToken(env) {
  const res = await fetch(env.HX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: env.HX_CLIENT_ID,
      audience: env.HX_AUDIENCE,
      username: env.HX_GRANT_USERNAME,
      password: env.HX_GRANT_PASSWORD
    })
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error("Failed to get Helix token");
  }
  return json.access_token;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId) {
  const res = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ mobilitySubscriptionId })
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Details failed ${res.status}`);
  }
  return json;
}

/* ---------------- Supabase ---------------- */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  return await res.json();
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("Supabase patch failed");
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) throw new Error("Supabase insert failed");
}

async function closeCurrentNumber(env, simId) {
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
}

async function insertNewNumber(env, simId, e164) {
  await supabaseInsert(env, "sim_numbers", [{
    sim_id: simId,
    e164,
    valid_from: new Date().toISOString()
  }]);
}

/* ---------------- Webhook ---------------- */

async function sendNumberOnlineWebhook(env, simId, { number, iccid, mobilitySubscriptionId }) {
  const rs = await supabaseSelect(
    env,
    `reseller_sims?select=reseller_id&sim_id=eq.${simId}&active=eq.true&limit=1`
  );
  const resellerId = rs?.[0]?.reseller_id;
  if (!resellerId) return;

  const wh = await supabaseSelect(
    env,
    `reseller_webhooks?select=url&reseller_id=eq.${resellerId}&enabled=eq.true&limit=1`
  );
  const url = wh?.[0]?.url;
  if (!url) return;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_type: "number.online",
      created_at: new Date().toISOString(),
      data: {
        number,
        iccid,
        mobilitySubscriptionId,
        online: true
      }
    })
  });
}

