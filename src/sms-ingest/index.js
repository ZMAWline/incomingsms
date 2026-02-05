// =========================================================
// SMS INGEST WORKER
// Receives incoming SMS from gateway, stores in DB, and sends webhooks
// Includes: deduplication and retry
// =========================================================

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);

    // =========================
    // AUTH (3 supported ways)
    // 1) Header: x-gateway-secret: <secret>
    // 2) Query:  ?secret=<secret>
    // 3) Path:   /s/<secret>   (BEST for gateways that always append ?params)
    // =========================
    const pathParts = url.pathname.split("/").filter(Boolean);
    const secretFromPath =
      pathParts[0] === "s" && pathParts[1] ? String(pathParts[1]) : "";

    const gotSecret =
      request.headers.get("x-gateway-secret") ||
      url.searchParams.get("secret") ||
      secretFromPath ||
      "";

    if (!env.GATEWAY_SECRET || gotSecret !== env.GATEWAY_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const ct = (request.headers.get("content-type") || "").toLowerCase();

    // =========================================================
    // CASE A: JSON recv-sms (if you ever switch to SKYLINE API push)
    // =========================================================
    if (ct.includes("application/json")) {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (!payload || payload.type !== "recv-sms" || !Array.isArray(payload.sms)) {
        return new Response("Not a recv-sms payload", { status: 400 });
      }

      const inserts = [];

      for (const row of payload.sms) {
        if (!Array.isArray(row) || row.length < 6) continue;

        const flag = row[0]; // 0 normal, 1 report
        const port = String(row[1] ?? "");
        const ts = Number(row[2] ?? 0);
        const from = String(row[3] ?? "");
        const toRaw = String(row[4] ?? "");
        const content = String(row[5] ?? "");

        if (flag === 1) continue;

        const to = normalizeToE164(toRaw);

        // content is typically base64 UTF-8
        let body = content;
        try {
          const bin = atob(content);
          const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
          body = new TextDecoder().decode(bytes);
        } catch {}

        const receivedAt =
          ts > 0 ? new Date(ts * 1000).toISOString() : new Date().toISOString();

        const simId = await findSimIdByCurrentNumber(env, to);

        // Update the SIM's port for Skyline SMS sending
        if (simId && port) {
          await updateSimPort(env, simId, port);
        }

        // Generate unique message ID for deduplication
        const messageId = await generateMessageIdAsync({
          eventType: 'sms.received',
          simId,
          number: to,
          from,
          body,
          timestamp: receivedAt,
        });

        // Check for duplicate message
        const existingMsg = await checkDuplicateMessage(env, messageId);
        if (existingMsg) {
          console.log(`[SMS] Duplicate message ${messageId}, skipping`);
          continue;
        }

        inserts.push({
          sim_id: simId,
          to_number: to,
          from_number: from,
          body,
          received_at: receivedAt,
          port,
          message_id: messageId,
          raw: payload,
        });
      }

      if (inserts.length === 0) return new Response("OK", { status: 200 });

      const ins = await supabaseInsert(env, "inbound_sms", inserts);
      if (!ins.ok) return new Response(await ins.text(), { status: 500 });

      return new Response("OK", { status: 200 });
    }

    // =========================================================
    // CASE B: Your gateway "SMS to HTTP" screen (octet-stream)
    // Gateway appends query params like:
    //   ?port=61A&sender=...&mac=...&iccid=...
    // Body contains a text block; actual SMS is after blank line.
    // =========================================================

    const iccid = String(url.searchParams.get("iccid") || "").trim();
    const senderQ = String(url.searchParams.get("sender") || "").trim();
    const port = String(url.searchParams.get("port") || "").trim();
    const mac = String(url.searchParams.get("mac") || "").trim();

    const rawText = await request.text();

    const from = senderQ || extractLineValue("Sender", rawText) || "";
    const body = extractSmsBody(rawText);

    // Best mapping for rotating numbers: ICCID -> sim_id -> current phone number
    const simId = iccid ? await findSimIdByIccid(env, iccid) : null;
    const toNumber = simId ? await findCurrentNumberBySimId(env, simId) : "";

    // Update the SIM's port and gateway for Skyline SMS sending
    if (simId) {
      await updateSimPortAndGateway(env, simId, port, mac);
    }

    const receivedAt = new Date().toISOString();

    // Generate unique message ID for deduplication
    const messageId = await generateMessageIdAsync({
      eventType: 'sms.received',
      simId,
      iccid,
      number: toNumber,
      from,
      body,
      timestamp: receivedAt,
    });

    // Check for duplicate message
    const existingMsg = await checkDuplicateMessage(env, messageId);
    if (existingMsg) {
      console.log(`[SMS] Duplicate message ${messageId}, skipping`);
      return new Response("OK (duplicate)", { status: 200 });
    }

    // Insert the SMS
    const ins = await supabaseInsert(env, "inbound_sms", [
      {
        sim_id: simId,
        to_number: toNumber,
        from_number: from,
        body,
        received_at: receivedAt,
        port,
        message_id: messageId,
        raw: {
          content_type: ct,
          url: request.url,
          query: Object.fromEntries(url.searchParams.entries()),
          rawText,
        },
      },
    ]);

    if (!ins.ok) return new Response(await ins.text(), { status: 500 });

    // =========================================================
    // NOTIFY RESELLER WEBHOOK (with deduplication and retry)
    // =========================================================
    if (simId) {
      const resellerId = await findResellerIdBySimId(env, simId);
      if (resellerId) {
        const webhookUrl = await findWebhookUrlByResellerId(env, resellerId);
        if (webhookUrl) {
          await sendWebhookWithDeduplication(env, webhookUrl, {
            event_type: "sms.received",
            created_at: new Date().toISOString(),
            data: {
              sim_id: simId,
              number: toNumber,
              from: from,
              message: body,
              received_at: receivedAt,
              iccid: iccid,
              port: port
            }
          }, {
            messageId,
            resellerId,
          });
        }
      }
    }

    return new Response("OK", { status: 200 });

  },

};

// ====================
// Helpers
// ====================

function normalizeToE164(to) {
  const s = String(to || "");
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+")) return s;
  return s;
}

// Extract "value" from lines like: Sender: 12345  OR  Receiver: "61.01"
function extractLineValue(label, text) {
  const t = String(text || "");
  const re = new RegExp(`${label}:\\s*"?([^"\\r\\n]+)"?`, "i");
  const m = t.match(re);
  return m ? m[1].trim() : "";
}

// IMPORTANT: actual SMS content is after the first blank line
function extractSmsBody(text) {
  const t = String(text || "").replace(/\r\n/g, "\n");
  // Split on first empty line
  const parts = t.split(/\n\s*\n/);
  if (parts.length >= 2) {
    return parts.slice(1).join("\n\n").trim();
  }
  // Fallback: last non-empty line
  const lines = t.split("\n").map(s => s.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

// ====================
// Supabase helpers
// ====================
async function supabaseGet(env, path) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
}

async function supabaseInsert(env, table, rows) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
}

// Check if message already exists (deduplication)
async function checkDuplicateMessage(env, messageId) {
  const q = `inbound_sms?select=id&message_id=eq.${encodeURIComponent(messageId)}&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return false;
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

// Find sim_id by ICCID
async function findSimIdByIccid(env, iccid) {
  const q = `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.id ? data[0].id : null;
}

// Update SIM's port and gateway in the sims table
// Links SIM to gateway based on MAC address
async function updateSimPortAndGateway(env, simId, port, mac) {
  if (!simId) return;

  const updates = {};
  if (port) updates.port = port;

  // Look up gateway by MAC address
  if (mac) {
    const gatewayId = await findGatewayIdByMac(env, mac);
    if (gatewayId) {
      updates.gateway_id = gatewayId;
    }
  }

  if (Object.keys(updates).length === 0) return;

  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/sims?id=eq.${encodeURIComponent(String(simId))}`,
      {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(updates),
      }
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        console.log(`[SMS] Updated SIM ${simId}: port=${port}, gateway=${updates.gateway_id || 'unchanged'}`);
      }
    }
  } catch (err) {
    console.log(`[SMS] Failed to update SIM: ${err}`);
  }
}

// Find gateway ID by MAC address
async function findGatewayIdByMac(env, mac) {
  if (!mac) return null;
  const q = `gateways?select=id&mac_address=eq.${encodeURIComponent(mac)}&active=eq.true&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.id ? data[0].id : null;
}

// Find CURRENT number for sim_id (valid_to is null)
async function findCurrentNumberBySimId(env, simId) {
  const q = `sim_numbers?select=e164&sim_id=eq.${encodeURIComponent(
    String(simId)
  )}&valid_to=is.null&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return "";
  const data = await res.json();
  return Array.isArray(data) && data[0]?.e164 ? data[0].e164 : "";
}

// Optional helper if you ever route by number
async function findSimIdByCurrentNumber(env, e164) {
  const q = `sim_numbers?select=sim_id&e164=eq.${encodeURIComponent(
    e164
  )}&valid_to=is.null&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.sim_id ? data[0].sim_id : null;
}

async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.reseller_id ? data[0].reseller_id : null;
}

async function findWebhookUrlByResellerId(env, resellerId) {
  if (!resellerId) return null;
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`;
  const res = await supabaseGet(env, q);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) && data[0]?.url ? data[0].url : null;
}

// ====================
// WEBHOOK UTILITIES (with deduplication and retry)
// ====================

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
