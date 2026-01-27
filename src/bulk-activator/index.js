export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // NEW: JSON activation endpoint
    if (url.pathname === "/activate") {
      return handleActivateJson(request, env);
    }

    // Health check
    if (url.pathname !== "/run") {
      return new Response(
        "bulk-activator (activation-only) ok. Use /run?secret=... or POST /activate",
        { status: 200 }
      );
    }

    // Security
    const secret = url.searchParams.get("secret") || "";
    if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Optional limit
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 1, 1) : null;

    // Fetch CSV
    const csvRes = await fetch(env.SHEET_CSV_URL);
    if (!csvRes.ok) {
      return new Response(`Failed to fetch CSV: ${csvRes.status}`, { status: 500 });
    }
    const csvText = await csvRes.text();

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      return json({ ok: true, processed: 0, note: "CSV empty" });
    }

    const header = rows[0].map((h) => (h || "").trim().toLowerCase());
    const dataRowsRaw = rows.slice(1).map(r => normalizeRow(r, header.length));

    const idx = (name) => header.indexOf(name);
    const iIccid = idx("iccid");
    const iImei = idx("imei");
    const iReseller = idx("reseller_id");
    const iStatus = idx("status");

    if ([iIccid, iImei, iReseller, iStatus].some((i) => i < 0)) {
      return new Response("CSV missing required headers", { status: 400 });
    }

    // Filter pending rows
    const pending = dataRowsRaw.filter(
      (r) => (r[iStatus] || "").trim().toLowerCase() === "pending"
    );
    const toProcess = limit ? pending.slice(0, limit) : pending;

    if (toProcess.length === 0) {
      return json({ ok: true, processed: 0, note: "No pending rows" });
    }

    // Get Helix token once (auto-refresh on 401 inside hxActivate)
    let token = await hxGetBearerToken(env);

    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const results = [];

    // PROCESS STRICTLY ONE AT A TIME
    for (const r of toProcess) {
      const iccid = String(r[iIccid] || "").trim();
      const imei = String(r[iImei] || "").trim();
      const resellerId = parseInt(String(r[iReseller] || "").trim(), 10);

      if (!iccid || !imei || !Number.isFinite(resellerId)) {
        errors++;
        results.push({ iccid, ok: false, error: "Invalid ICCID / IMEI / reseller_id" });
        continue;
      }

      try {
        // De-dupe: if already activated, skip
        const existing = await supabaseSelect(
          env,
          `sims?select=id,mobility_subscription_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
        );

        if (existing?.[0]?.mobility_subscription_id) {
          skipped++;
          results.push({ iccid, ok: true, skipped: true });
          continue;
        }

        // ACTIVATE SIM (ONLY THIS API CALL)
        const activation = await hxActivateWithRetry(env, () => token, async (t) => {
          token = t;
        }, { iccid, imei });

        const subId = activation?.mobilitySubscriptionId;

        if (!subId) {
          throw new Error("Activation succeeded but no mobilitySubscriptionId returned");
        }

        // Upsert SIM → provisioning
        const simId = await upsertSim(env, iccid, subId);

        // Assign reseller
        await assignSimToReseller(env, resellerId, simId);

        processed++;
        results.push({
          iccid,
          ok: true,
          mobilitySubscriptionId: subId,
          status: "provisioning",
        });
      } catch (e) {
        errors++;
        results.push({ iccid, ok: false, error: String(e) });
      }

      // HARD CARRIER SAFETY GAP BETWEEN SIMS
      await sleep(10000);
    }

    return json({
      ok: true,
      processed,
      skipped,
      errors,
      attempted: toProcess.length,
      results,
    });
  },
};

/* ================= JSON ACTIVATION ENDPOINT ================= */

async function handleActivateJson(request, env) {
  // Security check
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";
  if (!env.BULK_RUN_SECRET || secret !== env.BULK_RUN_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "POST") {
    return json({ ok: false, error: "Method must be POST" });
  }

  try {
    const body = await request.json();
    const sims = body.sims || [];

    if (!Array.isArray(sims) || sims.length === 0) {
      return json({ ok: false, error: "sims array is required" });
    }

    // Validate input format
    for (let i = 0; i < sims.length; i++) {
      const sim = sims[i];
      if (!sim.iccid || !sim.imei || !Number.isFinite(sim.reseller_id)) {
        return json({
          ok: false,
          error: `Invalid SIM at index ${i}: must have iccid, imei, and reseller_id`
        });
      }
    }

    // Get Helix token once
    let token = await hxGetBearerToken(env);

    let processed = 0;
    let skipped = 0;
    let errors = 0;
    const results = [];

    // Process each SIM (one at a time for carrier safety)
    for (const simData of sims) {
      const iccid = String(simData.iccid || "").trim();
      const imei = String(simData.imei || "").trim();
      const resellerId = parseInt(String(simData.reseller_id || "").trim(), 10);

      try {
        // Check if already activated
        const existing = await supabaseSelect(
          env,
          `sims?select=id,mobility_subscription_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
        );

        if (existing?.[0]?.mobility_subscription_id) {
          skipped++;
          results.push({ iccid, ok: true, skipped: true });
          continue;
        }

        // Activate with Helix
        const activation = await hxActivateWithRetry(env, () => token, async (t) => {
          token = t;
        }, { iccid, imei });

        const subId = activation?.mobilitySubscriptionId;

        if (!subId) {
          throw new Error("Activation succeeded but no mobilitySubscriptionId returned");
        }

        // Upsert SIM → provisioning
        const simId = await upsertSim(env, iccid, subId);

        // Assign reseller
        await assignSimToReseller(env, resellerId, simId);

        processed++;
        results.push({
          iccid,
          ok: true,
          mobilitySubscriptionId: subId,
          status: "provisioning",
        });
      } catch (e) {
        errors++;
        results.push({ iccid, ok: false, error: String(e) });
      }

      // HARD CARRIER SAFETY GAP BETWEEN SIMS
      await sleep(10000);
    }

    return json({
      ok: true,
      processed,
      skipped,
      errors,
      attempted: sims.length,
      results,
    });

  } catch (error) {
    return json({ ok: false, error: String(error) });
  }
}

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

/* ================= CSV ================= */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(cur);
        cur = "";
      } else if (c === "\n") {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      } else if (c !== "\r") {
        cur += c;
      }
    }
  }
  row.push(cur);
  rows.push(row);

  // Keep non-empty rows
  return rows.filter((r) => r.some((v) => String(v).trim() !== ""));
}

function normalizeRow(row, len) {
  const r = row.slice(0, len);
  while (r.length < len) r.push("");
  return r;
}

/* ================= HELIX ================= */

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

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok || !json?.access_token) {
    throw new Error(`Token failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`);
  }
  return json.access_token;
}

async function hxActivate(env, token, { iccid, imei }) {
  const body = {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: "new_activation",
    subscriber: { firstName: "SUB", lastName: "NINE" },
    address: {
      address1: env.HX_ADDRESS1,
      city: env.HX_CITY,
      state: env.HX_STATE,
      zipCode: env.HX_ZIP,
    },
    service: { iccid, imei },
  };

  const res = await fetch(`${env.HX_API_BASE}/api/mobility-activation/activate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok) {
    throw new Error(`Activate failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`);
  }

  // Normal path
  if (json && json.mobilitySubscriptionId) return json;

  // Fallback path: truncated/invalid JSON but contains the ID
  const subId = extractMobilitySubscriptionId(text);
  if (subId) return { mobilitySubscriptionId: subId, _raw: text };

  throw new Error(
    `Activate returned ${res.status} but response body was not usable (no mobilitySubscriptionId). Raw: ${text.slice(
      0,
      200
    )}`
  );
}

// Retry once on 401 by refreshing token
async function hxActivateWithRetry(env, getToken, setToken, { iccid, imei }) {
  const token = getToken();
  try {
    return await hxActivate(env, token, { iccid, imei });
  } catch (e) {
    const msg = String(e);
    // If Helix returns 401, refresh token and retry once
    if (msg.includes("Activate failed 401") || msg.includes(" 401:")) {
      const newToken = await hxGetBearerToken(env);
      await setToken(newToken);
      return await hxActivate(env, newToken, { iccid, imei });
    }
    throw e;
  }
}

/* ================= SUPABASE (SAFE) ================= */

async function supabaseSelect(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase select failed ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!text.trim()) return [];

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Supabase select JSON parse failed: ${String(e)}. Raw: ${text.slice(0, 300)}`
    );
  }
}

async function supabaseInsert(env, table, rows) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(rows),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase insert failed ${res.status}: ${text.slice(0, 300)}`);
  }

  if (!text.trim()) return [];

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Supabase insert JSON parse failed: ${String(e)}. Raw: ${text.slice(0, 300)}`
    );
  }
}

async function supabasePatch(env, path, body) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase patch failed ${res.status}: ${text.slice(0, 300)}`);
  }

  // PATCH often returns 204 with empty body; that's OK
  return true;
}

async function upsertSim(env, iccid, subId) {
  const existing = await supabaseSelect(
    env,
    `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
  );

  if (existing?.[0]?.id) {
    await supabasePatch(env, `sims?id=eq.${existing[0].id}`, {
      mobility_subscription_id: subId,
      status: "provisioning",
    });
    return existing[0].id;
  }

  const inserted = await supabaseInsert(env, "sims", [
    {
      iccid,
      mobility_subscription_id: subId,
      status: "provisioning",
    },
  ]);

  if (!inserted?.[0]?.id) {
    throw new Error("Supabase insert returned no rows. Add Prefer:return=representation.");
  }
  return inserted[0].id;
}

async function assignSimToReseller(env, resellerId, simId) {
  const existing = await supabaseSelect(
    env,
    `reseller_sims?select=reseller_id,sim_id&reseller_id=eq.${resellerId}&sim_id=eq.${simId}&limit=1`
  );
  if (existing.length) return;

  await supabaseInsert(env, "reseller_sims", [
    {
      reseller_id: resellerId,
      sim_id: simId,
      active: true,
    },
  ]);
}

/* ================= RESPONSE PARSING ================= */

async function safeReadJsonOrText(res) {
  const text = await res.text();
  if (!text) return { json: null, text: "" };

  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function extractMobilitySubscriptionId(rawText) {
  const m =
    rawText.match(/"mobilitySubscriptionId"\s*:\s*"(\d+)"/) ||
    rawText.match(/"mobilitySubscriptionId"\s*:\s*(\d+)/);
  return m ? m[1] : null;
}

