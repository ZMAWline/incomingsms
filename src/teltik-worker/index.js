// =========================================================
// TELTIK WORKER
// Manages T-Mobile SIMs via Teltik REST API (api.smsgateway.xyz)
// Routes: POST /import, POST /webhook, POST /rotate, GET /setup-webhook
// Cron: every 30 min for MDN rotation (48h interval)
// =========================================================

const TELTIK_BASE = 'https://api.smsgateway.xyz';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret') || '';

    if (url.pathname === '/import' && request.method === 'POST') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await importTeltikLines(env);
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (!env.TELTIK_WEBHOOK_SECRET || secret !== env.TELTIK_WEBHOOK_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      return handleTeltikSmsWebhook(request, env);
    }

    if (url.pathname === '/rotate' && request.method === 'POST') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await rotateTeltikSims(env);
        return jsonResponse(result, 200);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    if (url.pathname === '/setup-webhook') {
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const result = await setupTeltikForwardUrl(env);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (err) {
        return jsonResponse({ ok: false, error: String(err) }, 500);
      }
    }

    return new Response('teltik-worker ok', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    console.log('[Cron] teltik-worker rotation starting');
    try {
      const result = await rotateTeltikSims(env);
      console.log(`[Cron] rotation done: rotated=${result.rotated} errors=${result.errors} skipped=${result.skipped}`);
    } catch (err) {
      console.error(`[Cron] rotation failed: ${err}`);
    }
  },
};

// =========================================================
// IMPORT — fetch all Teltik lines and upsert into DB
// =========================================================
async function importTeltikLines(env) {
  const apiKey = env.TELTIK_API_KEY;

  // 1. Fetch all lines
  const allLinesRes = await fetch(`${TELTIK_BASE}/v1/all-lines/?apikey=${apiKey}`);
  if (!allLinesRes.ok) {
    throw new Error(`Teltik all-lines failed: ${allLinesRes.status} ${await allLinesRes.text()}`);
  }
  const allLines = await allLinesRes.json();

  if (!Array.isArray(allLines) || allLines.length === 0) {
    return { ok: true, imported: 0, updated: 0, unchanged: 0, message: 'No lines returned from Teltik' };
  }

  let imported = 0, updated = 0, unchanged = 0;

  for (const line of allLines) {
    // Extract MDN from line object (try common field names)
    const rawMdn = line.mdn || line.phone_number || line.number || line.phonenumber || '';
    if (!rawMdn) {
      console.log(`[Import] Skipping line with no MDN: ${JSON.stringify(line)}`);
      continue;
    }
    const mdn = normalizeToE164(rawMdn);
    if (!mdn) {
      console.log(`[Import] Could not normalize MDN: ${rawMdn}`);
      continue;
    }

    await sleep(100); // Rate limit: 100ms between calls

    // 2. Get ICCID via get-info (MDN without + prefix)
    let iccid = line.iccid || '';
    if (!iccid) {
      const mdnDigits = mdn.replace('+', ''); // Teltik uses 11-digit format without +
      const infoRes = await fetch(`${TELTIK_BASE}/v1/get-info?apikey=${apiKey}&mdn=${encodeURIComponent(mdnDigits)}`);
      if (infoRes.ok) {
        const info = await infoRes.json();
        iccid = info.iccid || '';
      } else {
        console.log(`[Import] get-info failed for ${mdn}: ${infoRes.status}`);
      }
    }

    if (!iccid) {
      console.log(`[Import] Could not get ICCID for MDN ${mdn}, skipping`);
      continue;
    }

    // 3. Check if SIM already exists
    const existing = await supabaseGetOne(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);

    // 4. Upsert SIM record (gateway_id/port/slot/imei null — Teltik has no physical gateway)
    const simData = {
      iccid,
      vendor: 'teltik',
      carrier: 'tmobile',
      rotation_interval_hours: 48,
      status: 'active',
      gateway_id: null,
      port: null,
      slot: null,
      imei: null,
    };

    const upsertRes = await supabaseUpsert(env, 'sims', simData, 'iccid');
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.log(`[Import] Upsert failed for ICCID ${iccid}: ${upsertRes.status} ${errText}`);
      continue;
    }

    // 5. Get SIM ID after upsert
    const simRows = await supabaseGetArray(env, `sims?iccid=eq.${encodeURIComponent(iccid)}&select=id&limit=1`);
    if (!Array.isArray(simRows) || simRows.length === 0) {
      console.log(`[Import] Could not find SIM after upsert for ICCID ${iccid}`);
      continue;
    }
    const simId = simRows[0].id;

    // 6. Sync sim_numbers — close old if different, insert new
    const currentNumbers = await supabaseGetArray(
      env,
      `sim_numbers?sim_id=eq.${simId}&valid_to=is.null&select=e164&limit=1`
    );
    const currentE164 = currentNumbers[0]?.e164;

    if (currentE164 === mdn) {
      unchanged++;
    } else {
      // Close old number row if exists
      if (currentE164) {
        await supabasePatch(env, `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`, {
          valid_to: new Date().toISOString(),
        });
      }
      // Insert new number
      const insRes = await supabaseInsert(env, 'sim_numbers', [{
        sim_id: simId,
        e164: mdn,
        valid_from: new Date().toISOString(),
        verification_status: 'verified',
      }]);
      if (!insRes.ok) {
        console.log(`[Import] sim_numbers insert failed for ${mdn}: ${insRes.status}`);
      }

      if (existing) {
        updated++;
      } else {
        imported++;
      }
    }
  }

  return { ok: true, imported, updated, unchanged };
}

// =========================================================
// WEBHOOK — receive inbound SMS pushed by Teltik
// Teltik SMSItem: { mdn, status, timestamp, sms, code }
// =========================================================
async function handleTeltikSmsWebhook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const mdn = normalizeToE164(body.mdn || '');
  const smsBody = body.sms || '';
  const receivedAt = body.timestamp
    ? new Date(body.timestamp).toISOString()
    : new Date().toISOString();

  if (!mdn) {
    console.log('[Webhook] No MDN in payload, ignoring');
    return new Response('OK', { status: 200 });
  }

  // Look up sim_id by current E.164 number
  const simNumbers = await supabaseGetArray(
    env,
    `sim_numbers?e164=eq.${encodeURIComponent(mdn)}&valid_to=is.null&select=sim_id&limit=1`
  );
  const simId = simNumbers[0]?.sim_id || null;

  // Generate deterministic message ID for dedup
  const messageId = await generateMessageIdAsync({
    eventType: 'sms.received',
    simId,
    number: mdn,
    from: '',
    body: smsBody,
    timestamp: receivedAt,
  });

  // Dedup check
  const existingMsg = await supabaseGetArray(
    env,
    `inbound_sms?message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`
  );
  if (existingMsg.length > 0) {
    console.log(`[Webhook] Duplicate ${messageId}, skipping`);
    return new Response('OK', { status: 200 });
  }

  // Insert into inbound_sms
  const insRes = await supabaseInsert(env, 'inbound_sms', [{
    sim_id: simId,
    to_number: mdn,
    from_number: '',   // Teltik push has no sender field
    body: smsBody,
    received_at: receivedAt,
    port: null,        // no physical port for Teltik
    message_id: messageId,
    raw: body,
  }]);

  if (!insRes.ok) {
    console.log(`[Webhook] inbound_sms insert failed: ${insRes.status}`);
  }

  // Send reseller sms.received webhook if SIM is assigned
  if (simId) {
    const resellerRows = await supabaseGetArray(
      env,
      `reseller_sims?sim_id=eq.${simId}&active=eq.true&select=reseller_id,resellers!inner(reseller_webhooks(url,enabled))&limit=1`
    );
    const resellerId = resellerRows[0]?.reseller_id;
    const webhook = resellerRows[0]?.resellers?.reseller_webhooks?.find(w => w.enabled);
    const webhookUrl = webhook?.url;

    if (resellerId && webhookUrl) {
      await sendWebhookWithDeduplication(env, webhookUrl, {
        event_type: 'sms.received',
        created_at: new Date().toISOString(),
        data: {
          sim_id: simId,
          number: mdn,
          from: '',
          message: smsBody,
          received_at: receivedAt,
          iccid: null,
          port: null,
        },
      }, {
        messageId,
        resellerId,
      });
    }
  }

  return new Response('OK', { status: 200 });
}

// =========================================================
// ROTATE — MDN rotation for Teltik SIMs (cron + manual)
// =========================================================
async function rotateTeltikSims(env) {
  const apiKey = env.TELTIK_API_KEY;
  const now = Date.now();

  // 1. Query active Teltik SIMs assigned to active resellers
  const sims = await supabaseGetArray(
    env,
    `sims?vendor=eq.teltik&status=eq.active&select=id,iccid,last_mdn_rotated_at,rotation_interval_hours,reseller_sims!inner(reseller_id,active)&reseller_sims.active=eq.true&order=last_mdn_rotated_at.asc.nullsfirst&limit=5000`
  );

  // Filter: include if never rotated OR overdue based on rotation_interval_hours
  const due = sims.filter(sim => {
    if (!sim.last_mdn_rotated_at) return true;
    const intervalMs = (sim.rotation_interval_hours || 48) * 60 * 60 * 1000;
    return (now - new Date(sim.last_mdn_rotated_at).getTime()) >= intervalMs;
  });

  console.log(`[Rotate] ${sims.length} active Teltik SIMs, ${due.length} due for rotation`);

  let rotated = 0, errors = 0, skipped = 0;

  for (const sim of due) {
    try {
      // Re-read last_mdn_rotated_at (dedup guard — queue message may be stale)
      const freshRows = await supabaseGetArray(
        env,
        `sims?id=eq.${sim.id}&select=last_mdn_rotated_at,rotation_interval_hours&limit=1`
      );
      const freshRotatedAt = freshRows[0]?.last_mdn_rotated_at;
      const intervalHours = freshRows[0]?.rotation_interval_hours || 48;
      if (freshRotatedAt) {
        const intervalMs = intervalHours * 60 * 60 * 1000;
        if ((now - new Date(freshRotatedAt).getTime()) < intervalMs) {
          console.log(`[Rotate] SIM ${sim.iccid}: already rotated recently, skipping`);
          skipped++;
          continue;
        }
      }

      // 2. Initiate number change
      const changeRes = await fetch(
        `${TELTIK_BASE}/v1/change-number/?apikey=${apiKey}&iccid=${encodeURIComponent(sim.iccid)}`
      );
      if (!changeRes.ok) {
        const errText = await changeRes.text();
        throw new Error(`change-number failed ${changeRes.status}: ${errText}`);
      }
      const changeData = await changeRes.json();
      const requestId = changeData.requestId || changeData.request_id;
      if (!requestId) {
        throw new Error(`No requestId in change-number response: ${JSON.stringify(changeData)}`);
      }

      // 3. Poll for completion — max 6 attempts with exponential backoff
      const delays = [2000, 4000, 8000, 16000, 16000, 16000];
      let newMdn = null;

      for (let attempt = 0; attempt < delays.length; attempt++) {
        await sleep(delays[attempt]);
        let pollRes;
        try {
          pollRes = await fetch(
            `${TELTIK_BASE}/v1/change-number/${encodeURIComponent(requestId)}?apikey=${apiKey}`
          );
        } catch (err) {
          console.log(`[Rotate] SIM ${sim.iccid}: poll attempt ${attempt + 1} network error: ${err}`);
          continue;
        }
        if (!pollRes.ok) {
          console.log(`[Rotate] SIM ${sim.iccid}: poll attempt ${attempt + 1} status ${pollRes.status}`);
          continue;
        }
        const pollData = await pollRes.json();
        const status = (pollData.status || '').toLowerCase();

        if (status === 'completed' || status === 'success' || status === 'msg_received') {
          newMdn = normalizeToE164(
            pollData.new_number || pollData.mdn || pollData.phone_number || pollData.number || ''
          );
          if (newMdn) break;
        }
        if (status === 'failed' || status === 'error' || status === 'timeout') {
          throw new Error(`Rotation failed: ${JSON.stringify(pollData)}`);
        }
        // Still pending — continue polling
        console.log(`[Rotate] SIM ${sim.iccid}: attempt ${attempt + 1} status=${pollData.status || 'unknown'}, continuing`);
      }

      if (!newMdn) {
        throw new Error(`Rotation timed out for ICCID ${sim.iccid} after 6 attempts`);
      }

      // 4. Close old sim_numbers row and insert new
      await supabasePatch(
        env,
        `sim_numbers?sim_id=eq.${sim.id}&valid_to=is.null`,
        { valid_to: new Date().toISOString() }
      );
      await supabaseInsert(env, 'sim_numbers', [{
        sim_id: sim.id,
        e164: newMdn,
        valid_from: new Date().toISOString(),
        verification_status: 'verified',
      }]);

      // 5. Update sims.last_mdn_rotated_at
      const rotatedAt = new Date().toISOString();
      await supabasePatch(env, `sims?id=eq.${sim.id}`, { last_mdn_rotated_at: rotatedAt });

      // 6. Send number.online webhook to reseller
      const resellerId = sim.reseller_sims?.[0]?.reseller_id;
      if (resellerId) {
        const webhookRows = await supabaseGetArray(
          env,
          `reseller_webhooks?reseller_id=eq.${resellerId}&enabled=eq.true&select=url&limit=1`
        );
        const webhookUrl = webhookRows[0]?.url;
        if (webhookUrl) {
          const result = await sendWebhookWithDeduplication(env, webhookUrl, {
            event_type: 'number.online',
            created_at: new Date().toISOString(),
            data: {
              sim_id: sim.id,
              number: newMdn,
              online: true,
              online_until: teltikOnlineUntil(),
              iccid: sim.iccid,
              mobilitySubscriptionId: null,
              verified: true,
            },
          }, {
            idComponents: {
              simId: sim.id,
              iccid: sim.iccid,
              number: newMdn,
            },
            resellerId,
            force: true, // always send on actual rotation
          });

          if (result.ok && !result.skipped) {
            await supabasePatch(env, `sims?id=eq.${sim.id}`, { last_notified_at: new Date().toISOString() });
          }
        }
      }

      console.log(`[Rotate] SIM ${sim.iccid}: rotated → ${newMdn}`);
      rotated++;

    } catch (err) {
      console.error(`[Rotate] SIM ${sim.iccid}: error: ${err}`);
      errors++;
    }
  }

  return { ok: true, total: sims.length, due: due.length, rotated, errors, skipped };
}

// =========================================================
// SETUP WEBHOOK — register this worker's /webhook URL with Teltik (one-time)
// =========================================================
async function setupTeltikForwardUrl(env) {
  const apiKey = env.TELTIK_API_KEY;
  const webhookSecret = env.TELTIK_WEBHOOK_SECRET;
  const workerUrl = `https://teltik-worker.zalmen-531.workers.dev/webhook?secret=${webhookSecret}`;

  const res = await fetch(`${TELTIK_BASE}/v1/forward-url?apikey=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ primary_url: workerUrl }),
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text };
  }

  return { ok: true, status: res.status, webhookUrl: workerUrl, response: text };
}

// =========================================================
// Helpers
// =========================================================

function teltikOnlineUntil() {
  return new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
}

function normalizeToE164(to) {
  const s = String(to || '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (s.startsWith('+')) return s;
  return s;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =========================================================
// Supabase Helpers
// =========================================================

async function supabaseGetArray(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : []; } catch { data = []; }
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data : [];
}

async function supabaseGetOne(env, path) {
  const rows = await supabaseGetArray(env, path);
  return rows[0] || null;
}

async function supabaseInsert(env, table, rows) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  });
}

async function supabaseUpsert(env, table, data, onConflict) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(data),
  });
}

async function supabasePatch(env, path, data) {
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

// =========================================================
// Webhook Helpers (copied from reseller-sync)
// =========================================================

async function generateMessageIdAsync(components) {
  const { eventType, simId, iccid, number, from, body, timestamp } = components;

  let dedupeTs;
  if (eventType === 'number.online') {
    dedupeTs = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    dedupeTs = timestamp
      ? new Date(Math.floor(new Date(timestamp).getTime() / 60000) * 60000).toISOString()
      : new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  }

  const str = [eventType, simId, iccid, number, from, (body || '').slice(0, 100), dedupeTs].join('|');
  const encoder = new TextEncoder();
  const d = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', d);
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

async function postWebhookWithRetry(url, payload, options = {}) {
  const { maxRetries = 4, initialDelayMs = 1000, messageId = 'unknown' } = options;
  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      lastStatus = res.status;
      const responseBody = await res.text().catch(() => '');
      if (res.ok) return { ok: true, status: res.status, attempts: attempt, responseBody };
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, status: res.status, attempts: attempt, error: `Client error: ${res.status}`, responseBody };
      }
      lastError = `Server error ${res.status}: ${responseBody.slice(0, 200)}`;
    } catch (err) {
      lastError = `Network error: ${String(err)}`;
      lastStatus = 0;
    }
    if (attempt <= maxRetries) {
      await sleep(initialDelayMs * Math.pow(2, attempt - 1));
    }
  }
  return { ok: false, status: lastStatus, attempts: maxRetries + 1, error: lastError, responseBody: lastError };
}

async function sendWebhookWithDeduplication(env, webhookUrl, payload, options = {}) {
  if (!webhookUrl) return { ok: false, status: 0, attempts: 0, error: 'No webhook URL' };

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
      responseBody: result.responseBody || null,
    });
  } catch (err) {
    console.log(`[Webhook] Failed to record delivery: ${err}`);
  }

  return result;
}
