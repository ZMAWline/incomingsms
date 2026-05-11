// =========================================================
// RESELLER SYNC WORKER
// Syncs verified numbers to resellers via webhook
// Includes: webhook deduplication and retry
// =========================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/run") {
      return new Response("reseller-sync ok. Use /run?secret=...&limit=2000&force=false", { status: 200 });
    }

    const secret = url.searchParams.get("secret") || "";
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 2000, 1) : 2000;
    const force = url.searchParams.get("force") === "true";

    const online = await runResellerSync(env, limit, force);
    const offline = await runOfflineRetrySweep(env);
    return json({ ok: true, online, offline }, 200);
  },

  // Daily backstop cron: 15:00 UTC (10 AM EST / after all rotations complete)
  // Catches any SIMs whose number.online failed during the mdn-rotator rotation run.
  // Uses force=false so dedup skips already-delivered SIMs and only re-sends misses.
  // Then runs runOfflineRetrySweep to retry any failed number.offline deliveries
  // from the last 24h.
  async scheduled(event, env, ctx) {
    console.log('[Cron] reseller-sync daily backstop starting');
    const online = await runResellerSync(env, 2000, false);
    console.log(`[Cron] reseller-sync online: ${online.synced} sent, ${online.skipped} skipped, ${online.errors} errors`);
    const offline = await runOfflineRetrySweep(env);
    console.log(`[Cron] reseller-sync offline: ${offline.retried} retried, ${offline.recovered} recovered, ${offline.stillFailed} still failed`);
  },
};

/* ---------------- Core ---------------- */

async function runResellerSync(env, limit, force = false) {
  const startedAt = new Date().toISOString();

  // Fetch active SIMs with current numbers, reseller info, and webhook URLs in ONE query.
  // The or=(vendor.neq.wing_iot,rotation_status.is.null,rotation_status.neq.failed) clause
  // excludes ONLY wing_iot SIMs whose rotation_status='failed'. That state means the SIM
  // is stuck on the ABIR (non-dialable) plan — broadcasting a 5xxx interim MDN as "online"
  // would let resellers route inbound SMS to a number that can't receive normal calls/messages.
  // For teltik/atomic/helix, a failed rotation just means the carrier API errored mid-rotation
  // (e.g., Teltik 502, ATOMIC swapMSISDN timeout) — the OLD MDN remains valid in sim_numbers
  // and should still be broadcast as online. Suppressing those silently strands lines from
  // the reseller's view (incident: 2026-05-09 — 71 teltik SIMs invisible after Teltik 502 outage).
  // The is.null branch is required because PostgreSQL evaluates `NULL != 'failed'` as NULL
  // (not TRUE), so a bare `neq.failed` would silently drop fresh activations with NULL status.
  const sims = await sbGetArray(
    env,
    `sims?select=id,iccid,status,vendor,rotation_interval_hours,last_notified_at,last_mdn_rotated_at,sim_numbers!inner(e164),reseller_sims!inner(reseller_id,resellers!inner(reseller_webhooks(url,enabled)))&status=eq.active&or=(vendor.neq.wing_iot,rotation_status.is.null,rotation_status.neq.failed)&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=last_notified_at.asc.nullsfirst&limit=${limit}`
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
      const resellerId = sim.reseller_sims?.[0]?.reseller_id;
      const webhook = sim.reseller_sims?.[0]?.resellers?.reseller_webhooks?.find(w => w.enabled);
      const webhookUrl = webhook?.url;

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

      if (!force) {
        const intervalMs = (sim.rotation_interval_hours || 24) * 60 * 60 * 1000;
        const cutoff = new Date(Date.now() - intervalMs).toISOString();
        if (sim.last_notified_at && sim.last_notified_at > cutoff) {
          skipped++;
          details.push({ sim_id: simId, ok: true, skipped: true, reason: "Notified within rotation interval" });
          continue;
        }
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
          online_until: midnightNYAfterInterval(sim.last_mdn_rotated_at, sim.rotation_interval_hours || 24),
          carrier: sim.vendor === 'teltik' ? 'T-Mobile' : 'att',
          verified: true,
        },
      }, {
        idComponents: {
          simId,
          iccid: sim.iccid,
          number: currentNumber,
        },
        resellerId,
        force,
      });

      if (result.ok && !result.skipped) {
        await fetch(`${env.SUPABASE_URL}/rest/v1/sims?id=eq.${simId}`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ last_notified_at: new Date().toISOString() }),
        });

        // Capture rental_id from the reseller's webhook response and persist it on
        // reseller_sims so the reseller-portal can show "Rental #N" instead of ICCID.
        // Reseller responds with a body like {"success":true,"rentalId":1401254}.
        const rentalId = parseRentalIdFromResponse(result.responseBody);
        if (rentalId != null) {
          await fetch(`${env.SUPABASE_URL}/rest/v1/reseller_sims?reseller_id=eq.${resellerId}&sim_id=eq.${simId}`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ last_rental_id: rentalId }),
          }).catch(err => console.log(`[ResellerSync] Failed to write last_rental_id for sim ${simId}: ${err}`));
        }
      }

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

/* ---------------- Relay ---------------- */

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(`${env.RELAY_URL}/${url}`, {
      ...init,
      headers: { ...(init?.headers || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
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

async function sbPatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase PATCH ${res.status}: ${t}`);
  }
}

/* ---------------- Offline retry sweep ---------------- */
// Iterates webhook_deliveries rows where event_type='number.offline' AND status='failed'
// AND created_at within the last 24h. Re-posts each one with the original message_id
// (so dedup still applies on the receiver side) and updates the row status on success.

async function runOfflineRetrySweep(env) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const failed = await sbGetArray(env,
    `webhook_deliveries?select=id,webhook_url,payload,attempts,reseller_id,message_id` +
    `&event_type=eq.number.offline&status=eq.failed` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&limit=500`
  );
  let retried = 0, recovered = 0, stillFailed = 0;
  for (const row of failed) {
    retried++;
    try {
      const result = await postWebhookWithRetry(env, row.webhook_url, row.payload, { messageId: row.message_id });
      const total = (row.attempts || 0) + (result.attempts || 0);
      if (result.ok) {
        recovered++;
        await sbPatch(env, `webhook_deliveries?id=eq.${row.id}`, {
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          last_attempt_at: new Date().toISOString(),
          attempts: total,
        });
      } else {
        stillFailed++;
        await sbPatch(env, `webhook_deliveries?id=eq.${row.id}`, {
          attempts: total,
          last_attempt_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      stillFailed++;
      console.error(`[OfflineRetry] row ${row.id} threw: ${e}`);
    }
  }
  return { retried, recovered, stillFailed };
}

/* ---------------- Webhook Utilities ---------------- */

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  // number.online / number.offline: deduplicate per day so mdn-rotator,
  // details-finalizer, and reseller-sync share the same key.
  // Other events: deduplicate per minute.
  let dedupeTs;
  if (eventType === 'number.online' || eventType === 'number.offline') {
    dedupeTs = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    dedupeTs = timestamp
      ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
      : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), dedupeTs].join('|');

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
      response_body: delivery.responseBody ? String(delivery.responseBody).slice(0, 2000) : null,
    }),
  });
}

async function postWebhookWithRetry(env, url, payload, options = {}) {
  const { maxRetries = 4, initialDelayMs = 1000, messageId = 'unknown' } = options;

  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`[Webhook] Attempt ${attempt}/${maxRetries + 1} for ${messageId} to ${url}`);

      const res = await relayFetch(env, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      lastStatus = res.status;

      const responseBody = await res.text().catch(() => '');

      if (res.ok) {
        console.log(`[Webhook] Success ${res.status} for ${messageId} after ${attempt} attempt(s)`);
        return { ok: true, status: res.status, attempts: attempt, responseBody };
      }

      if (res.status >= 400 && res.status < 500) {
        console.log(`[Webhook] Client error ${res.status} for ${messageId}: ${responseBody.slice(0, 200)}`);
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      }

      lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
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
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
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

  if (!options.force) {
    const alreadySent = await wasWebhookDelivered(env, messageId);
    if (alreadySent) {
      console.log(`[Webhook] Skipping duplicate ${messageId}`);
      return { ok: true, status: 200, attempts: 0, skipped: true };
    }
  }

  const result = await postWebhookWithRetry(env, webhookUrl, payload, { messageId });

  try {
    await recordWebhookDelivery(env, {
      messageId,
      eventType: payload.event_type,
      resellerId: options.resellerId,
      webhookUrl,
      payload,
      status: result.ok ? 'delivered' : 'failed',
      attempts: result.attempts,
      responseBody: result.responseBody || null,
    });
  } catch (err) {
    console.log(`[Webhook] Failed to record delivery: ${err}`);
  }

  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a rental_id from a reseller's webhook response body.
// TrustOTP returns {"success":true,"message":"Rental created","rentalId":1401254}.
// We accept rentalId / rental_id / id (loose so other resellers don't need a rewrite),
// and fall back to a regex if JSON.parse fails (malformed/partial bodies).
function parseRentalIdFromResponse(body) {
  if (!body) return null;
  const s = String(body);
  try {
    const obj = JSON.parse(s);
    const v = obj && (obj.rentalId ?? obj.rental_id ?? obj.id);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  const m = s.match(/"rental[_]?[Ii]d"\s*:\s*([0-9]+)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function midnightNYAfterInterval(lastRotatedAt, intervalHours) {
  // Returns midnight NY time of the day that is intervalDays after lastRotatedAt's NY date.
  // e.g. rotated March 25, intervalHours=48 → returns March 27 00:00 ET
  const baseDt = new Date(lastRotatedAt || Date.now());
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(baseDt);
  const [y, m, d] = nyDate.split('-').map(Number);
  const intervalDays = Math.ceil((intervalHours || 24) / 24);
  const probe = new Date(Date.UTC(y, m - 1, d + intervalDays, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-4';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-4');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
}

function nextRotationUtcISO() {
  // DST-aware: midnight NY = 05:00 UTC (EST) or 04:00 UTC (EDT).
  // Probe 5 AM UTC of tomorrow's calendar date — always within 1h of NY midnight,
  // which correctly reflects the offset in effect at that midnight.
  const now = new Date();
  const nyDateToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const [y, m, d] = nyDateToday.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0));
  const probeNyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(probe);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'shortOffset'
  }).formatToParts(probe).find(p => p.type === 'timeZoneName')?.value ?? 'GMT-5';
  const offsetHours = -parseInt(tzPart.replace('GMT', '') || '-5');
  return new Date(`${probeNyDate}T${String(offsetHours).padStart(2, '0')}:00:00.000Z`).toISOString();
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
