// =========================================================
// MDN ROTATOR WORKER
// Daily phone number rotation at 5:00 AM UTC
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

    return new Response("mdn-rotator ok. Use /run?secret=...&limit=1", { status: 200 });
  },

  // Cron handler - runs at 05:00 UTC for rotation
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
async function queueSimsForRotation(env, options = {}) {
  const queryLimit = options.limit || 10000;

  // Fetch active SIMs
  const sims = await supabaseSelect(env,
    `sims?select=id,iccid,mobility_subscription_id,status&mobility_subscription_id=not.is.null&status=eq.active&limit=${queryLimit}`
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

  // 4) Insert new number
  await insertNewNumber(env, sim.id, e164);

  // 5) Send number.online webhook immediately
  await sendNumberOnlineWebhook(env, sim.id, e164, iccid, subId);

  console.log(`SIM ${sim.iccid}: rotated to ${e164}`);
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
async function hxGetBearerToken(env) {
  const params = new URLSearchParams({
    grant_type: "password",
    client_id: env.HX_CLIENT_ID,
    audience: env.HX_AUDIENCE,
    username: env.HX_GRANT_USERNAME,
    password: env.HX_GRANT_PASSWORD,
  });

  const res = await fetch(env.HX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
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
    {
      sim_id: simId,
      e164,
      valid_from: new Date().toISOString(),
    },
  ]);
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
