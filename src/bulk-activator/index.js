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

    // Validate all rows upfront
    const validationErrors = [];
    const simsToProcess = [];
    for (let i = 0; i < toProcess.length; i++) {
      const r = toProcess[i];
      const iccid = String(r[iIccid] || "").trim();
      const imei = String(r[iImei] || "").trim();
      const resellerId = parseInt(String(r[iReseller] || "").trim(), 10);
      if (!iccid || !imei || !Number.isFinite(resellerId)) {
        validationErrors.push({ iccid, ok: false, error: "Invalid ICCID / IMEI / reseller_id" });
      } else {
        simsToProcess.push({ iccid, imei, resellerId });
      }
    }

    // Check for already-activated ICCIDs
    let token = await hxGetBearerToken(env);
    const results = [...validationErrors];
    let skipped = 0;
    let processed = 0;
    let errors = validationErrors.length;

    const toActivate = [];
    const toActivateMeta = []; // parallel array: { iccid, resellerId }
    for (const sim of simsToProcess) {
      const existing = await supabaseSelect(
        env,
        `sims?select=id,mobility_subscription_id&iccid=eq.${encodeURIComponent(sim.iccid)}&limit=1`
      );
      if (existing?.[0]?.mobility_subscription_id) {
        skipped++;
        results.push({ iccid: sim.iccid, ok: true, skipped: true });
      } else {
        toActivate.push(buildActivationObject(env, sim.iccid, sim.imei));
        toActivateMeta.push({ iccid: sim.iccid, resellerId: sim.resellerId });
      }
    }

    if (toActivate.length > 0) {
      const runId = `bulk_csv_${Date.now()}`;
      try {
        const bulkResult = await hxBulkActivateSub(env, token, toActivate, runId);
        const successfulItems = Array.isArray(bulkResult.successful) ? bulkResult.successful : [];
        const failedItems = Array.isArray(bulkResult.failed) ? bulkResult.failed : [];

        // Process successful: try to match by iccid in response, fall back to index
        for (let i = 0; i < successfulItems.length; i++) {
          const item = successfulItems[i];
          const subId = item?.data?.mobilitySubscriptionId || item?.mobilitySubscriptionId;
          const responseIccid = item?.data?.service?.iccid || item?.data?.iccid;
          const meta = responseIccid
            ? toActivateMeta.find(m => m.iccid === responseIccid) || toActivateMeta[i]
            : toActivateMeta[i];

          if (!meta || !subId) {
            errors++;
            results.push({ ok: false, error: `Bulk success item ${i} missing subId or meta`, raw: item });
            continue;
          }
          try {
            const simId = await upsertSim(env, meta.iccid, subId);
            await assignSimToReseller(env, meta.resellerId, simId);
            processed++;
            results.push({ iccid: meta.iccid, ok: true, mobilitySubscriptionId: subId, status: "provisioning" });
          } catch (e) {
            errors++;
            results.push({ iccid: meta.iccid, ok: false, error: String(e) });
            try { await upsertSimError(env, meta.iccid, String(e)); } catch {}
          }
        }

        // Process failed
        for (let i = 0; i < failedItems.length; i++) {
          const item = failedItems[i];
          const responseIccid = item?.data?.service?.iccid || item?.data?.iccid;
          const meta = responseIccid
            ? toActivateMeta.find(m => m.iccid === responseIccid) || toActivateMeta[successfulItems.length + i]
            : toActivateMeta[successfulItems.length + i];
          const errorMsg = item?.error || item?.message || JSON.stringify(item);
          const iccid = meta?.iccid || responseIccid || `unknown_${i}`;
          errors++;
          results.push({ iccid, ok: false, error: errorMsg });
          try { await upsertSimError(env, iccid, errorMsg); } catch {}
        }
      } catch (e) {
        // Bulk call itself failed — record error for all pending
        errors += toActivateMeta.length;
        for (const meta of toActivateMeta) {
          results.push({ iccid: meta.iccid, ok: false, error: `Bulk activation error: ${e}` });
          try { await upsertSimError(env, meta.iccid, `Bulk activation error: ${e}`); } catch {}
        }
      }
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

    // Validate input format upfront
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

    // Pre-filter: skip already-activated ICCIDs
    const toActivate = [];
    const toActivateMeta = []; // parallel array: { iccid, resellerId }
    for (const simData of sims) {
      const iccid = String(simData.iccid || "").trim();
      const imei = String(simData.imei || "").trim();
      const resellerId = parseInt(String(simData.reseller_id || "").trim(), 10);

      const existing = await supabaseSelect(
        env,
        `sims?select=id,mobility_subscription_id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
      );

      if (existing?.[0]?.mobility_subscription_id) {
        skipped++;
        results.push({ iccid, ok: true, skipped: true });
        continue;
      }

      toActivate.push(buildActivationObject(env, iccid, imei));
      toActivateMeta.push({ iccid, resellerId });
    }

    if (toActivate.length > 0) {
      const runId = `bulk_json_${Date.now()}`;
      try {
        const bulkResult = await hxBulkActivateSub(env, token, toActivate, runId);
        const successfulItems = Array.isArray(bulkResult.successful) ? bulkResult.successful : [];
        const failedItems = Array.isArray(bulkResult.failed) ? bulkResult.failed : [];

        // Process successful items
        for (let i = 0; i < successfulItems.length; i++) {
          const item = successfulItems[i];
          const subId = item?.data?.mobilitySubscriptionId || item?.mobilitySubscriptionId;
          const responseIccid = item?.data?.service?.iccid || item?.data?.iccid;
          const meta = responseIccid
            ? toActivateMeta.find(m => m.iccid === responseIccid) || toActivateMeta[i]
            : toActivateMeta[i];

          if (!meta || !subId) {
            errors++;
            results.push({ ok: false, error: `Bulk success item ${i} missing subId or meta`, raw: item });
            continue;
          }
          try {
            const simId = await upsertSim(env, meta.iccid, subId);
            await assignSimToReseller(env, meta.resellerId, simId);
            processed++;
            results.push({ iccid: meta.iccid, ok: true, mobilitySubscriptionId: subId, status: "provisioning" });
          } catch (e) {
            errors++;
            results.push({ iccid: meta.iccid, ok: false, error: String(e) });
            try { await upsertSimError(env, meta.iccid, String(e)); } catch {}
          }
        }

        // Process failed items
        for (let i = 0; i < failedItems.length; i++) {
          const item = failedItems[i];
          const responseIccid = item?.data?.service?.iccid || item?.data?.iccid;
          const meta = responseIccid
            ? toActivateMeta.find(m => m.iccid === responseIccid) || toActivateMeta[successfulItems.length + i]
            : toActivateMeta[successfulItems.length + i];
          const errorMsg = item?.error || item?.message || JSON.stringify(item);
          const iccid = meta?.iccid || responseIccid || `unknown_${i}`;
          errors++;
          results.push({ iccid, ok: false, error: errorMsg });
          try { await upsertSimError(env, iccid, errorMsg); } catch {}
        }
      } catch (e) {
        errors += toActivateMeta.length;
        for (const meta of toActivateMeta) {
          results.push({ iccid: meta.iccid, ok: false, error: `Bulk activation error: ${e}` });
          try { await upsertSimError(env, meta.iccid, `Bulk activation error: ${e}`); } catch {}
        }
      }
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

function buildActivationObject(env, iccid, imei) {
  return {
    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),
    plan: { id: Number(env.HX_PLAN_ID) },
    BAN: String(env.HX_BAN),
    FAN: String(env.HX_FAN),
    activationType: "new_activation",
    partnerTransactionId: iccid,
    subscriber: { firstName: "SUB", lastName: "NINE" },
    address: {
      address1: env.HX_ADDRESS1,
      city: env.HX_CITY,
      state: env.HX_STATE,
      zipCode: env.HX_ZIP,
    },
    service: { iccid, imei },
  };
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

  const { json: j, text } = await safeReadJsonOrText(res);

  if (!res.ok || !j?.access_token) {
    throw new Error(`Token failed ${res.status}: ${JSON.stringify(j ?? { raw: text })}`);
  }
  return j.access_token;
}

async function hxBulkActivateSub(env, token, activationObjects, runId) {
  const url = `${env.HX_API_BASE}/api/mobility-sub-ops/subscription`;
  const method = "POST";

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(activationObjects),
  });

  const responseText = await res.text();
  let responseJson = {};
  try { responseJson = JSON.parse(responseText); } catch {}

  // Log to helix_api_logs (fire-and-forget)
  logHelixApiCall(env, {
    run_id: runId,
    step: "bulk_activation",
    request_url: url,
    request_method: method,
    request_body: activationObjects,
    response_status: res.status,
    response_ok: res.ok,
    response_body_text: responseText,
    response_body_json: responseJson,
    error: res.ok ? null : `Bulk activation failed: ${res.status}`,
  }).catch(e => console.error(`[Helix Log] Failed: ${e}`));

  if (!res.ok) {
    throw new Error(`Bulk activation failed ${res.status}: ${responseText.slice(0, 300)}`);
  }

  return responseJson;
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

async function upsertSimError(env, iccid, errorMessage) {
  const existing = await supabaseSelect(
    env,
    `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`
  );

  if (existing?.[0]?.id) {
    await supabasePatch(env, `sims?id=eq.${existing[0].id}`, {
      status: "error",
      last_activation_error: `Activation failed: ${errorMessage}`,
      last_rotation_at: new Date().toISOString(),
    });
  } else {
    await supabaseInsert(env, "sims", [{
      iccid,
      status: "error",
      last_activation_error: `Activation failed: ${errorMessage}`,
      last_rotation_at: new Date().toISOString(),
    }]);
  }
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

/* ================= HELIX API LOGGING ================= */

async function logHelixApiCall(env, logData) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return;

  const logPayload = {
    run_id: logData.run_id,
    step: logData.step,
    iccid: logData.iccid || null,
    imei: logData.imei || null,
    request_url: logData.request_url,
    request_method: logData.request_method,
    request_body: logData.request_body || null,
    response_status: logData.response_status,
    response_ok: logData.response_ok,
    response_body_text: (logData.response_body_text || "").slice(0, 5000),
    response_body_json: logData.response_body_json || null,
    error: logData.error || null,
    created_at: new Date().toISOString(),
  };

  console.log(`[Helix API] ${logData.request_method} ${logData.request_url} -> ${logData.response_status} ${logData.response_ok ? 'OK' : 'FAIL'}`);

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/helix_api_logs`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(logPayload),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[Helix Log] Supabase failed: ${res.status} ${errText}`);
  }
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
