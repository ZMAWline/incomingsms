export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== "/run") {
      return new Response("details-finalizer ok. Use /run?secret=...&batch=5&wait=12000", { status: 200 });
    }

    const secret = url.searchParams.get("secret") || "";
    if (!env.FINALIZER_RUN_SECRET || secret !== env.FINALIZER_RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const batch = clampInt(url.searchParams.get("batch"), 1, 20, 5);
    const waitMs = clampInt(url.searchParams.get("wait"), 0, 60000, 12000);

    const result = await runFinalizerBatch(env, { batch, waitMs });
    return json(result, 200);
  },

  async scheduled(event, env, ctx) {
    // Cron defaults (settable via Worker variables)
    const batch = clampInt(env.CRON_BATCH, 1, 20, 5);
    const waitMs = clampInt(env.CRON_WAIT_MS, 0, 60000, 12000);

    ctx.waitUntil(runFinalizerBatch(env, { batch, waitMs }));
  },
};

/* ---------------- Core ---------------- */

async function runFinalizerBatch(env, { batch, waitMs }) {
  const startedAt = new Date().toISOString();

  // Get bearer token once per run
  const token = await hxGetBearerToken(env);

  // Pull up to `batch` provisioning sims
  const sims = await sbGetArray(
    env,
    `sims?select=id,iccid,mobility_subscription_id,status&status=eq.provisioning&order=id.asc&limit=${batch}`
  );

  let attempted = sims.length;
  let finalized = 0;
  let skipped_missing_mdn = 0;
  let errors = 0;
  let stopped_early = false;
  const details = [];

  for (const sim of sims) {
    const simId = sim.id;
    const subId = sim.mobility_subscription_id;

    // Wait between Helix calls (carrier-friendly pacing)
    if (waitMs > 0) await sleep(waitMs);

    try {
      const d = await hxSubscriberDetailsOne(env, token, subId);

      // If phone number not assigned yet: skip and leave status as provisioning
      if (!d.phoneNumber) {
        skipped_missing_mdn++;
        details.push({ sim_id: simId, subId, ok: true, skipped: true, reason: "phoneNumber null" });
        continue;
      }

      const e164 = normalizeUS(d.phoneNumber);

      // Write sim_numbers current number
      await closeCurrentNumber(env, simId);
      await insertNewNumber(env, simId, e164);

      // Mark SIM active
      await sbPatch(env, `sims?id=eq.${encodeURIComponent(String(simId))}`, {
        status: "active",
        status_reason: null,
      });

      // Send number.online webhook (per-reseller routing)
      await sendNumberOnlineWebhook(env, simId, {
        number: e164,
        iccid: sim.iccid,
        mobilitySubscriptionId: subId,
      });

      finalized++;
      details.push({ sim_id: simId, subId, ok: true, number: e164 });
    } catch (e) {
      const msg = String(e);

      // If Helix rate-limits: stop early and let next cron run continue
      if (msg.includes("Too many subrequests")) {
        stopped_early = true;
        details.push({ sim_id: simId, subId, ok: false, error: "Helix rate limit: Too many subrequests (stopping early)" });
        break;
      }

      errors++;
      details.push({ sim_id: simId, subId, ok: false, error: msg });
    }
  }

  return {
    ok: true,
    startedAt,
    batch,
    waitMs,
    attempted,
    finalized,
    skipped_missing_mdn,
    errors,
    stopped_early,
    details,
  };
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
      password: env.HX_GRANT_PASSWORD,
    }),
  });

  const { json, text } = await safeReadJsonOrText(res);
  if (!res.ok || !json?.access_token) {
    throw new Error(`Token failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`);
  }
  return json.access_token;
}

async function hxSubscriberDetailsOne(env, token, mobilitySubscriptionId) {
  const res = await fetch(`${env.HX_API_BASE}/api/mobility-subscriber/details`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ mobilitySubscriptionId }),
  });

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok) {
    // Bubble up Helix throttling message if present
    const msg = JSON.stringify(json ?? { raw: text });
    throw new Error(`Details failed ${res.status}: ${msg}`);
  }

  const d = Array.isArray(json) ? json[0] : null;
  return {
    phoneNumber: d?.phoneNumber || null,
    iccid: d?.iccid || null,
  };
}

async function safeReadJsonOrText(res) {
  const text = await res.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
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
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase PATCH failed ${res.status}: ${txt.slice(0, 500)}`);
  }
}

async function closeCurrentNumber(env, simId) {
  await sbPatch(
    env,
    `sim_numbers?sim_id=eq.${encodeURIComponent(String(simId))}&valid_to=is.null`,
    { valid_to: new Date().toISOString() }
  );
}

async function insertNewNumber(env, simId, e164) {
  await sbInsert(env, "sim_numbers", [
    { sim_id: simId, e164, valid_from: new Date().toISOString() },
  ]);
}

async function sbInsert(env, table, rows) {
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

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Supabase INSERT failed ${res.status}: ${txt.slice(0, 500)}`);
  }
}

/* ---------------- Webhook routing ---------------- */

async function sendNumberOnlineWebhook(env, simId, { number, iccid, mobilitySubscriptionId }) {
  const rs = await sbGetArray(
    env,
    `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(String(simId))}&active=eq.true&limit=1`
  );
  const resellerId = rs?.[0]?.reseller_id;
  if (!resellerId) return;

  const wh = await sbGetArray(
    env,
    `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(String(resellerId))}&enabled=eq.true&limit=1`
  );
  const hookUrl = wh?.[0]?.url;
  if (!hookUrl) return;

  const payload = {
    event_type: "number.online",
    created_at: new Date().toISOString(),
    data: {
      number,
      online: true,
      online_until: nextRotationUtcISO(),
      iccid,
      mobilitySubscriptionId,
    },
  };

  const res = await fetch(hookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Webhook failed ${res.status}: ${txt.slice(0, 300)}`);
  }
}

/* ---------------- Misc ---------------- */

function normalizeUS(phone) {
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return String(phone);
}

function nextRotationUtcISO() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function clampInt(val, min, max, def) {
  const n = parseInt(String(val ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

