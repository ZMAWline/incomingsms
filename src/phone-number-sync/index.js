export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname !== "/run") {
      return new Response(
        "phone-number-sync ok. Use /run?secret=...",
        { status: 200 }
      );
    }

    // Security
    const secret = url.searchParams.get("secret") || "";
    if (!env.SYNC_SECRET || secret !== env.SYNC_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Optional: limit processing to specific SIMs
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.max(parseInt(limitParam, 10) || 10, 1) : null;

    try {
      // Get Helix bearer token
      const token = await hxGetBearerToken(env);

      // Get all active SIMs with mobility_subscription_id
      const sims = await supabaseSelect(
        env,
        `sims?select=id,iccid,mobility_subscription_id&mobility_subscription_id=not.is.null&status=in.(active,provisioning)&order=id.asc`
      );

      if (!sims || sims.length === 0) {
        return json({ ok: true, processed: 0, note: "No active SIMs found" });
      }

      const toProcess = limit ? sims.slice(0, limit) : sims;

      let processed = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;
      const results = [];

      // Process each SIM
      for (const sim of toProcess) {
        try {
          const { id: simId, iccid, mobility_subscription_id: subId } = sim;

          // Get current phone number from Helix
          const helixData = await hxGetSubscription(env, token, subId);
          const d = Array.isArray(helixData) ? helixData[0] : helixData;
          const helixMdn = d?.phoneNumber || d?.mdn || null;

          if (!helixMdn) {
            skipped++;
            results.push({
              sim_id: simId,
              iccid,
              ok: true,
              skipped: true,
              reason: "No phone number in Helix",
            });
            continue;
          }

          // Normalize to E.164
          const e164 = normalizeToE164(helixMdn);

          // Get current phone number from sim_numbers (valid_to IS NULL)
          const currentNumbers = await supabaseSelect(
            env,
            `sim_numbers?select=e164,valid_from&sim_id=eq.${simId}&valid_to=is.null&limit=1`
          );

          const currentE164 = currentNumbers?.[0]?.e164;

          // If phone numbers match, skip
          if (currentE164 === e164) {
            skipped++;
            results.push({
              sim_id: simId,
              iccid,
              ok: true,
              skipped: true,
              reason: "Phone number already correct",
              current: e164,
            });
            continue;
          }

          // Phone number mismatch - need to update
          const now = new Date().toISOString();

          // If there's an existing current number, expire it
          if (currentE164) {
            await supabasePatch(
              env,
              `sim_numbers?sim_id=eq.${simId}&valid_to=is.null`,
              { valid_to: now }
            );
          }

          // Insert new current number
          await supabaseInsert(env, "sim_numbers", [
            {
              sim_id: simId,
              e164: e164,
              valid_from: now,
              valid_to: null,
            },
          ]);

          updated++;
          results.push({
            sim_id: simId,
            iccid,
            ok: true,
            updated: true,
            old_number: currentE164 || "(none)",
            new_number: e164,
          });

          processed++;
        } catch (e) {
          errors++;
          results.push({
            sim_id: sim.id,
            iccid: sim.iccid,
            ok: false,
            error: String(e),
          });
        }

        // Small delay to avoid rate limiting
        await sleep(1000);
      }

      return json({
        ok: true,
        processed,
        updated,
        skipped,
        errors,
        total_checked: toProcess.length,
        results,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: String(e) }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

/* ================= HELPERS ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeToE164(phoneNumber) {
  const s = String(phoneNumber || "");
  const digits = s.replace(/\D/g, "");

  // If already has +, return as-is
  if (s.startsWith("+")) return s;

  // 10 digits: assume US/Canada
  if (digits.length === 10) return `+1${digits}`;

  // 11 digits starting with 1: assume US/Canada
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Otherwise return with + prefix
  return `+${digits}`;
}

/* ================= HELIX API ================= */

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

async function hxGetSubscription(env, token, subscriptionId) {
  const res = await fetch(
    `${env.HX_API_BASE}/api/mobility-subscriber/details`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mobilitySubscriptionId: subscriptionId }),
    }
  );

  const { json, text } = await safeReadJsonOrText(res);

  if (!res.ok) {
    throw new Error(
      `Get subscription failed ${res.status}: ${JSON.stringify(json ?? { raw: text })}`
    );
  }

  return json;
}

/* ================= SUPABASE ================= */

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

  return true;
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
