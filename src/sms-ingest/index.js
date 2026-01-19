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

    // Helpers
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
        inserts.push({
          sim_id: simId,
          to_number: to,
          from_number: from,
          body,
          received_at: receivedAt,
          port,
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

    const rawText = await request.text();

    const from = senderQ || extractLineValue("Sender", rawText) || "";
    const body = extractSmsBody(rawText); // ✅ this should become only "בסדר"

    // ✅ Best mapping for rotating numbers: ICCID -> sim_id -> current phone number
    const simId = iccid ? await findSimIdByIccid(env, iccid) : null;
    const toNumber = simId ? await findCurrentNumberBySimId(env, simId) : "";

    // If to_number is still empty, we still store the SMS (you can backfill later)
    const receivedAt = new Date().toISOString();

    const ins = await supabaseInsert(env, "inbound_sms", [
      {
        sim_id: simId,
        to_number: toNumber,
        from_number: from,
        body,
        received_at: receivedAt,
        port,
        raw: {
          content_type: ct,
          url: request.url,
          query: Object.fromEntries(url.searchParams.entries()),
          rawText,
        },
      },
    ]);

    if (!ins.ok) return new Response(await ins.text(), { status: 500 });

    // Notify reseller (temporary webhook)
await postResellerWebhook(env, {
  event_type: "sms.received",
  created_at: new Date().toISOString(),
  data: {
    number: toNumber,        // +1854...
    from: from,              // sender
    message: body,           // parsed SMS text
    received_at: receivedAt,
    iccid: iccid,
    port: port
  }
});
    return new Response("OK", { status: 200 });
    
  },
  
};

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

// Find sim_id by ICCID
async function findSimIdByIccid(env, iccid) {
  const q = `sims?select=id&iccid=eq.${encodeURIComponent(iccid)}&limit=1`;
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

async function postResellerWebhook(env, payload) {
  if (!env.RESELLER_WEBHOOK_URL) return;

  await fetch(env.RESELLER_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

