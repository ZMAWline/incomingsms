// =========================================================
// RESELLER SYNC WORKER
// Syncs verified numbers to resellers via webhook
// Includes: webhook deduplication and retry
// =========================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/run") {
      return new Response("reseller-sync ok. Use /run?secret=...&limit=100", { status: 200 });
    }

    const secret = url.searchParams.get("secret") || "";
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 100, 1) : 100;

    const result = await runResellerSync(env, limit);
    return json(result, 200);
  },

  async scheduled(event, env, ctx) {
    const limit = clampInt(env.CRON_BATCH, 1, 1000, 100);
    ctx.waitUntil(runResellerSync(env, limit));
  },
};

/* ---------------- Core ---------------- */

async function runResellerSync(env, limit) {
  const startedAt = new Date().toISOString();

  // Fetch active SIMs with current numbers, reseller info, and webhook URLs in ONE query
  // Only sync verified numbers (or skipped verification)
  const sims = await sbGetArray(
    env,
    `sims?select=id,iccid,status,sim_numbers!inner(e164,verification_status),reseller_sims!inner(reseller_id,resellers!inner(reseller_webhooks!inner(url)))&status=eq.active&sim_numbers.valid_to=is.null&sim_numbers.verification_status=in.(verified,skipped)&reseller_sims.active=eq.true&reseller_webhooks.enabled=eq.true&order=id.asc&limit=${limit}`
  );

  let attempted = sims.length;
  let synced = 0;
  let skipped = 0;
  let errors = 0;
  const details = [];

  for (const sim of sims) {
    const simId = sim.id;

    try {
      const currentNumber = sim.sim_numbers?.[0]?.e164;
      const verificationStatus = sim.sim_numbers?.[0]?.verification_status;
      const resellerId = sim.reseller_sims?.[0]?.reseller_id;
      const webhookUrl = sim.reseller_sims?.[0]?.resellers?.reseller_webhooks?.[0]?.url;

      if (!currentNumber) {
        skipped++;
        details.push({ sim_id: simId, ok: true, skipped: true, reason: "No current number" });
        continue;
      }

      if (!resellerId) {
        skipped++;
        details.push({ sim_id: simId, ok: true, skipped: true, reason: "No reseller assigned" });
        continue;
      }

      if (!webhookUrl) {
        skipped++;
        details.push({ sim_id: simId, reseller_id: resellerId, ok: true, skipped: true, reason: "No webhook configured" });
        continue;
      }

      const result = await sendWebhookWithDeduplication(env, webhookUrl, {
        event_type: "number.online",
        created_at: new Date().toISOString(),
        data: {
          sim_id: simId,
          iccid: sim.iccid,
          number: currentNumber,
          status: sim.status,
          online: true,
          online_until: nextRotationUtcISO(),
          verified: verificationStatus === 'verified',
        },
      }, {
        idComponents: {
          simId,
          iccid: sim.iccid,
          number: currentNumber,
        },
        resellerId,
      });

      if (result.skipped) {
        skipped++;
        details.push({
          sim_id: simId,
          reseller_id: resellerId,
          ok: true,
          skipped: true,
          reason: "Webhook already sent (deduplicated)"
        });
      } else {
        synced++;
        details.push({
          sim_id: simId,
          reseller_id: resellerId,
          ok: result.ok,
          number: currentNumber,
          attempts: result.attempts,
        });
      }
    } catch (e) {
      const msg = String(e);
      errors++;
      details.push({ sim_id: simId, ok: false, error: msg });
    }
  }

  return {
    ok: true,
    startedAt,
    limit,
    attempted,
    synced,
    skipped,
    errors,
    details,
  };
}

/* ---------------- Supabase ---------------- */

async function sbGetArray(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) throw new Error(`Supabase ${res.status}: ${JSON.stringify(data)}`);
  if (!Array.isArray(data)) throw new Error(`Supabase returned non-array: ${JSON.stringify(data)}`);
  return data;
}

/* ---------------- Webhook Utilities ---------------- */

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

/* ---------------- Misc ---------------- */

function clampInt(val, min, max, def) {
  const n = parseInt(String(val ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
