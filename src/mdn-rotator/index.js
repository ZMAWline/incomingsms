export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Manual test endpoint (protected)
    if (url.pathname === "/run") {
      const secret = url.searchParams.get("secret") || "";
      if (!env.ADMIN_RUN_SECRET || secret !== env.ADMIN_RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }

      await runDailyMdnRotation(env);
      return new Response("MDN rotation triggered manually", { status: 200 });
    }

    return new Response("mdn-rotator ok", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyMdnRotation(env));
  },
};


// ===========================
// Main job
// ===========================
async function runDailyMdnRotation(env) {
  // 1) Get bearer token
  const token = await hxGetBearerToken(env);

  // 2) Fetch all sims that have mobility_subscription_id
  const sims = await supabaseSelect(env,
    "sims?select=id,iccid,mobility_subscription_id,status&mobility_subscription_id=not.is.null&status=eq.active&limit=10000"
  );

  if (!Array.isArray(sims) || sims.length === 0) {
    console.log("No active sims with mobility_subscription_id found.");
    return;
  }

  console.log(`Found ${sims.length} sims to rotate.`);

  // 3) Rotate each SIM
  for (const s of sims) {
    try {
      const subId = s.mobility_subscription_id;
      if (!subId) continue;

      // 3a) MDN change
      const mdnChange = await hxMdnChange(env, token, subId);

      // 3b) Query subscriber details to get the NEW phone number
      const details = await hxSubscriberDetails(env, token, subId);

      // details comes as an array
      const d = Array.isArray(details) ? details[0] : null;
      const phoneNumber = d?.phoneNumber; // 10-digit in example
      const iccid = d?.iccid;

      if (!phoneNumber || !iccid) {
        console.log(`SUBID ${subId}: missing phoneNumber/iccid in details`, details);
        continue;
      }

      // Normalize to E.164 (US) for storage: +1 + 10 digits
      const e164 = normalizeUS(phoneNumber);

      // 3c) Update sim_numbers history:
      // - close previous current number
      // - insert new current number
      await closeCurrentNumber(env, s.id);
      await insertNewNumber(env, s.id, e164);

      const resellerId = await findResellerIdBySimId(env, s.id);
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
      console.log(`SUBID ${subId}: rotated -> ${e164}.`, mdnChange?.changeStatus ?? "");

    } catch (err) {
      console.log("Rotation error:", String(err));
      // continue to next SIM
    }
  }
}

// ===========================
// AT&T / Helix calls
// ===========================

async function hxGetBearerToken(env) {
  // POST https://auth.helixsolo.app/oauth/token  (password grant) :contentReference[oaicite:1]{index=1}
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
  // PATCH https://api.helixsolo.app/api/mobility-subscriber/ctn :contentReference[oaicite:2]{index=2}
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
    throw new Error(`MDN change failed (SUBID ${mobilitySubscriptionId}): ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function hxSubscriberDetails(env, token, mobilitySubscriptionId) {
  // POST https://api.helixsolo.app/api/mobility-subscriber/details :contentReference[oaicite:3]{index=3}
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
    throw new Error(`Details failed (SUBID ${mobilitySubscriptionId}): ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function normalizeUS(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // fallback: store raw
  return phone;
}

// ===========================
// Supabase helpers (PostgREST)
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
  // set valid_to=now where current row
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
  // Our cron runs daily at 05:00 UTC.
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    5, 0, 0
  ));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString(); // always ends in Z (UTC)
}

async function postResellerWebhook(env, payload) {
  if (!env.RESELLER_WEBHOOK_URL) return;

  const res = await fetch(env.RESELLER_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // optional: log failures (helps debugging)
  if (!res.ok) {
    const txt = await res.text();
    console.log("Reseller webhook failed:", res.status, txt);
  }
}
async function findResellerIdBySimId(env, simId) {
  if (!simId) return null;
  const q = `reseller_sims?select=reseller_id&sim_id=eq.${encodeURIComponent(
    String(simId)
  )}&active=eq.true&limit=1`;
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
  const q = `reseller_webhooks?select=url&reseller_id=eq.${encodeURIComponent(
    String(resellerId)
  )}&enabled=eq.true&limit=1`;
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


