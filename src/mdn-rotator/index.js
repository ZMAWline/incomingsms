export default {
  // HTTP endpoint for manual triggering
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await queueSimsForRotation(env);
      return new Response(JSON.stringify(result, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("mdn-rotator ok. Use /run?secret=...", { status: 200 });
  },

  // Daily cron at 05:00 UTC - queues all SIMs for rotation
  async scheduled(event, env, ctx) {
    ctx.waitUntil(queueSimsForRotation(env));
  },

  // Queue consumer - processes one SIM at a time (no subrequest limit issues)
  async queue(batch, env) {
    for (const message of batch.messages) {
      const sim = message.body;
      try {
        // Get fresh token for each SIM (tokens may expire during long queues)
        const token = await hxGetBearerToken(env);
        await rotateSingleSim(env, token, sim);
        message.ack();
        console.log(`SIM ${sim.iccid}: rotation complete`);
      } catch (err) {
        console.error(`SIM ${sim.iccid} failed: ${err}`);
        // Retry up to 3 times (configured in wrangler.toml)
        message.retry();
      }
    }
  },
};

// ===========================
// Queue all SIMs for rotation (runs at 05:00 UTC or on manual trigger)
// ===========================
async function queueSimsForRotation(env) {
  // Fetch all active SIMs
  const sims = await supabaseSelect(env,
    "sims?select=id,iccid,mobility_subscription_id,status&mobility_subscription_id=not.is.null&status=eq.active&limit=10000"
  );

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
  return { ok: true, queued, total: sims.length };
}

// ===========================
// Rotate a single SIM (called by queue consumer)
// Each SIM uses ~7 subrequests, well under the 1000 limit
// ===========================
async function rotateSingleSim(env, token, sim) {
  const subId = sim.mobility_subscription_id;
  if (!subId) {
    console.log(`SIM ${sim.iccid}: no mobility_subscription_id, skipping`);
    return;
  }

  // 1) MDN change - request new number from carrier
  const mdnChange = await hxMdnChange(env, token, subId);

  // 2) Get the new phone number
  const details = await hxSubscriberDetails(env, token, subId);
  const d = Array.isArray(details) ? details[0] : null;
  const phoneNumber = d?.phoneNumber;
  const iccid = d?.iccid || sim.iccid;

  if (!phoneNumber) {
    throw new Error(`No phoneNumber returned for SUBID ${subId}`);
  }

  const e164 = normalizeUS(phoneNumber);

  // 3) Update sim_numbers history in database
  await closeCurrentNumber(env, sim.id);
  await insertNewNumber(env, sim.id, e164);

  // 4) Send webhook to reseller
  const resellerId = await findResellerIdBySimId(env, sim.id);
  const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);

  await postWebhook(webhookUrl, {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      number: e164,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid: iccid,
      mobilitySubscriptionId: subId
    }
  });

  console.log(`SIM ${sim.iccid}: rotated to ${e164}`);
}

// ===========================
// Helix API
// ===========================
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

async function hxMdnChange(env, token, mobilitySubscriptionId) {
  const res = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/ctn`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mobilitySubscriptionId }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`MDN change failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId) {
  const res = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mobilitySubscriptionId }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Details failed: ${res.status} ${JSON.stringify(json)}`);
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
      Prefer: "return=minimal",
    },
    body: JSON.stringify(bodyObj),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase PATCH failed: ${res.status} ${txt}`);
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase INSERT failed: ${res.status} ${txt}`);
}

async function closeCurrentNumber(env, simId) {
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
}

async function insertNewNumber(env, simId, e164) {
  await supabaseInsert(env, "sim_numbers", [
    { sim_id: simId, e164, valid_from: new Date().toISOString() },
  ]);
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

async function postWebhook(url, payload) {
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const txt = await res.text();
      console.log("Webhook failed:", res.status, txt);
    }
  } catch (err) {
    console.log("Webhook error:", String(err));
  }
}
