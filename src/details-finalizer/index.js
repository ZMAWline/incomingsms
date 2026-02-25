// =========================================================
// DETAILS FINALIZER WORKER
// Finalizes SIM provisioning by getting phone numbers from Helix
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

    await closeCurrentNumber(env, simId);
    await insertNewNumber(env, simId, e164);
    await supabasePatch(
      env,
      `sims?id=eq.${encodeURIComponent(String(simId))}`,
      { status: "active", status_reason: null, activated_at: new Date().toISOString() }
    );

    activated++;
    console.log(`SIM ${sim.iccid}: activated with number ${e164}`);
  }

  return { ok: true, processed, activated };
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

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error("Failed to get Helix token");
  }
  return data.access_token;
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

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Details failed ${res.status}`);
  }
  return data;
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
    valid_from: new Date().toISOString(),
    verification_status: "verified",
  }]);
}
