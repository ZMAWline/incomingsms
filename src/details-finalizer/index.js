// =========================================================
// DETAILS FINALIZER WORKER
// Finalizes SIM provisioning by getting phone numbers from Helix
// Includes: verification SMS, webhook deduplication
// =========================================================

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

    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : 1000;

    const result = await runFinalizer(env, limit);
    return json(result);
  },

  async scheduled(event, env, ctx) {
    const limit = 25;
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
  let verificationSent = 0;

  for (const sim of sims) {
    processed++;

    const simId = sim.id;
    const subId = sim.mobility_subscription_id;
    if (!subId) continue;

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

    // Close any existing number
    await closeCurrentNumber(env, simId);

    // Generate verification code
    const verificationCode = generateVerificationCode();

    // Insert new number with pending verification
    await insertNewNumberWithVerification(env, simId, e164, verificationCode);

    // Update SIM status to active
    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(simId))}`,
      { status: "active", status_reason: null }
    );

    activated++;

    // Find another SIM to send verification SMS from
    const senderSim = await findSenderSimForVerification(env, simId);

    if (senderSim) {
      // Send verification SMS
      const smsResult = await sendVerificationSms(env, token, senderSim, e164, verificationCode);

      if (smsResult.ok) {
        await updateVerificationStatus(env, simId, 'sent');
        verificationSent++;
        console.log(`SIM ${sim.iccid}: verification SMS sent from ${senderSim.e164} to ${e164}`);
      } else {
        // SMS failed, skip verification and send webhook
        console.log(`SIM ${sim.iccid}: verification SMS failed, sending webhook directly`);
        await updateVerificationStatus(env, simId, 'skipped');
        await sendNumberOnlineWebhook(env, simId, {
          number: e164,
          iccid: sim.iccid,
          mobilitySubscriptionId: subId,
          verified: false,
        });
      }
    } else {
      // No sender SIM, skip verification
      console.log(`SIM ${sim.iccid}: no sender SIM available, sending webhook directly`);
      await updateVerificationStatus(env, simId, 'skipped');
      await sendNumberOnlineWebhook(env, simId, {
        number: e164,
        iccid: sim.iccid,
        mobilitySubscriptionId: subId,
        verified: false,
      });
    }
  }

  return {
    ok: true,
    processed,
    activated,
    verificationSent,
    remaining: Math.max(sims.length - processed, 0)
  };
}

/* ---------------- helpers  ---------------- */

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

async function insertNewNumberWithVerification(env, simId, e164, verificationCode) {
  await supabaseInsert(env, "sim_numbers", [{
    sim_id: simId,
    e164,
    valid_from: new Date().toISOString(),
    verification_code: verificationCode,
    verification_status: 'pending',
  }]);
}

async function updateVerificationStatus(env, simId, status) {
  await supabasePatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    {
      verification_status: status,
      verification_sent_at: status === 'sent' ? new Date().toISOString() : undefined,
    }
  );
}

/* ---------------- Verification SMS ---------------- */

async function findSenderSimForVerification(env, excludeSimId) {
  const query = `sims?select=id,iccid,mobility_subscription_id,sim_numbers!inner(e164,verification_status)&status=eq.active&mobility_subscription_id=not.is.null&id=neq.${encodeURIComponent(String(excludeSimId))}&sim_numbers.valid_to=is.null&limit=10`;

  const res = await supabaseSelect(env, query);

  if (!Array.isArray(res) || res.length === 0) {
    return null;
  }

  const verifiedSims = res.filter(s => s.sim_numbers?.[0]?.verification_status === 'verified');
  const candidate = verifiedSims.length > 0 ? verifiedSims[0] : res[0];

  return {
    id: candidate.id,
    iccid: candidate.iccid,
    mobility_subscription_id: candidate.mobility_subscription_id,
    e164: candidate.sim_numbers?.[0]?.e164,
  };
}

async function sendVerificationSms(env, token, senderSim, recipientNumber, verificationCode) {
  // Use Skyline API to send SMS via the gateway device
  // Requires SK_HOST, SK_USERNAME, SK_PASSWORD, SK_PORT environment variables

  if (!env.SK_HOST || !env.SK_USERNAME || !env.SK_PASSWORD) {
    console.log(`[VerifySMS] Skyline credentials not configured, skipping SMS`);
    return { ok: false, error: "Skyline credentials not configured" };
  }

  try {
    const skylinePort = env.SK_PORT || "80";
    const url = `http://${env.SK_HOST}:${skylinePort}/goip_post_sms.html`;

    // Find the port/slot for this SIM based on ICCID (stored in sims table)
    // For now, we'll need to map the sender SIM to a Skyline port
    // This requires a port mapping in the database or config
    const portSlot = await findSkylinePortForSim(env, senderSim.id);

    if (!portSlot) {
      console.log(`[VerifySMS] No Skyline port mapping found for SIM ${senderSim.iccid}`);
      return { ok: false, error: "No Skyline port mapping for sender SIM" };
    }

    const payload = {
      type: "send-sms",
      task_num: 1,
      tasks: [
        {
          tid: Date.now(), // Unique task ID
          port: portSlot, // e.g., "1A" for port 1, slot A
          to: recipientNumber.replace(/^\+1/, ""), // Remove +1 prefix if present
          sms: `VERIFY ${verificationCode}`,
          smstype: 0, // 0 = SMS, 1 = MMS
          coding: 0   // 0 = GSM 7-bit
        }
      ]
    };

    // Skyline uses Basic Auth
    const authHeader = "Basic " + btoa(`${env.SK_USERNAME}:${env.SK_PASSWORD}`);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => ({}));

    if (json.code !== 200) {
      console.log(`[VerifySMS] Skyline SMS failed: ${json.code} ${json.reason}`);
      return { ok: false, error: `Skyline SMS failed: ${json.reason || res.status}` };
    }

    console.log(`[VerifySMS] Sent VERIFY ${verificationCode} from ${senderSim.e164} (port ${portSlot}) to ${recipientNumber}`);
    return { ok: true };
  } catch (err) {
    console.log(`[VerifySMS] Error: ${err}`);
    return { ok: false, error: String(err) };
  }
}

// Find the Skyline port for a SIM
// This looks up the port column in the sims table (updated by sms-ingest)
async function findSkylinePortForSim(env, simId) {
  try {
    const res = await supabaseSelect(env, `sims?select=port&id=eq.${simId}&limit=1`);
    return res?.[0]?.port || null;
  } catch (err) {
    console.log(`[VerifySMS] Error finding Skyline port: ${err}`);
    return null;
  }
}

/* ---------------- Webhook ---------------- */

async function sendNumberOnlineWebhook(env, simId, { number, iccid, mobilitySubscriptionId, verified }) {
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

  await sendWebhookWithDeduplication(env, url, {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      number,
      iccid,
      mobilitySubscriptionId,
      online: true,
      online_until: nextRotationUtcISO(),
      verified,
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

/* ---------------- Webhook Utilities ---------------- */

function generateVerificationCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

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
