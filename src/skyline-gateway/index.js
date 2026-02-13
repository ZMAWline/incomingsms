// =========================================================
// SKYLINE GATEWAY WORKER
// Centralizes all SkyLine API calls for multi-gateway support.
// Other workers call this via service bindings.
// =========================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = url.searchParams.get("secret") || "";

    // Health check (no auth required)
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "skyline-gateway" });
    }

    // Auth check for all other routes
    if (!env.SKYLINE_SECRET || secret !== env.SKYLINE_SECRET) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    try {
      if (request.method === "POST" && url.pathname === "/send-sms") {
        return await handleSendSms(request, env);
      }
      if (request.method === "POST" && url.pathname === "/switch-sim") {
        return await handleSwitchSim(request, env);
      }
      if (request.method === "POST" && url.pathname === "/get-imei") {
        return await handleGetImei(request, env);
      }
      if (request.method === "POST" && url.pathname === "/set-imei") {
        return await handleSetImei(request, env);
      }
      if (request.method === "GET" && url.pathname === "/port-status") {
        return await handlePortStatus(url, env);
      }
      if (request.method === "GET" && url.pathname === "/port-info") {
        return await handlePortInfo(url, env);
      }
      if (request.method === "POST" && url.pathname === "/lock") {
        return await handlePortCommand(request, env, "lock");
      }
      if (request.method === "POST" && url.pathname === "/unlock") {
        return await handlePortCommand(request, env, "unlock");
      }
      if (request.method === "POST" && url.pathname === "/reboot") {
        return await handlePortCommand(request, env, "reboot");
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        return await handlePortCommand(request, env, "reset");
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      console.log(`[SkylineGateway] Unhandled error: ${err}`);
      return json({ ok: false, error: String(err) }, 500);
    }
  },
};

/* ================= ROUTE HANDLERS ================= */

async function handleSendSms(request, env) {
  const body = await request.json();
  const { gateway_id, port, to, message, smstype, coding } = body;

  if (!gateway_id || !port || !to || !message) {
    return json({ ok: false, error: "gateway_id, port, to, and message are required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gateway_id);
  if (error) return error;

  const payload = {
    type: "send-sms",
    task_num: 1,
    tasks: [{
      tid: Date.now(),
      port: port,
      to: to,
      sms: message,
      smstype: smstype ?? 0,
      coding: coding ?? 0,
    }],
  };

  const result = await skylineFetch(env, gateway, "/goip_post_sms.html", "POST", payload);

  await logSkylineApiCall(env, {
    action: "send_sms",
    gateway_id,
    port,
    requestUrl: result.url,
    requestBody: payload,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: result.data,
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error", skyline_response: result.data }, 502);
  }

  return json({
    ok: true,
    message: `SMS sent to ${to} via ${gateway.code} port ${port}`,
    skyline_response: result.data,
  });
}

async function handleSwitchSim(request, env) {
  const body = await request.json();
  const { gateway_id, port } = body;

  if (!gateway_id || !port) {
    return json({ ok: false, error: "gateway_id and port are required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gateway_id);
  if (error) return error;

  const payload = { type: "command", op: "switch", ports: port };
  const result = await skylineFetch(env, gateway, "/goip_send_cmd.html", "POST", payload);

  await logSkylineApiCall(env, {
    action: "switch_sim",
    gateway_id,
    port,
    requestUrl: result.url,
    requestBody: payload,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: result.data,
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error", skyline_response: result.data }, 502);
  }

  return json({ ok: true, message: `SIM switch triggered on ${gateway.code} port ${port}`, skyline_response: result.data });
}

async function handleGetImei(request, env) {
  const body = await request.json();
  const { gateway_id, port } = body;

  if (!gateway_id || !port) {
    return json({ ok: false, error: "gateway_id and port are required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gateway_id);
  if (error) return error;

  // IMEI is available from the port status endpoint — just fetch and extract
  const params = new URLSearchParams({
    version: "1.1",
    username: gateway.username,
    password: gateway.password,
    ports: "all",
  });
  const statusUrl = `http://${gateway.host}:${gateway.api_port || 80}/goip_get_status.html?${params}`;
  const result = await bridgeFetch(env, statusUrl, "GET");

  await logSkylineApiCall(env, {
    action: "get_imei",
    gateway_id,
    port,
    requestUrl: statusUrl.replace(gateway.password, "***"),
    requestBody: null,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: null,
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error" }, 502);
  }

  // Find the matching port in status data
  const normalizedPort = normalizePortSlot(port);
  const portEntry = (result.data?.status || []).find(p => p.port === normalizedPort);

  if (!portEntry) {
    return json({ ok: false, error: `Port ${port} (${normalizedPort}) not found in device status` }, 404);
  }

  return json({ ok: true, port: normalizedPort, imei: portEntry.imei || null });
}

async function handleSetImei(request, env) {
  const body = await request.json();
  const { gateway_id, port, imei } = body;

  if (!gateway_id || !port || !imei) {
    return json({ ok: false, error: "gateway_id, port, and imei are required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gateway_id);
  if (error) return error;

  // Calculate sim_imei index: n = (port_number-1)*slots_per_port + (slot_number-1)
  const { portNum, slotNum } = parsePortSlot(port);
  if (!portNum) {
    return json({ ok: false, error: `Cannot parse port "${port}". Use format like "22A" or "22.01"` }, 400);
  }
  const slotsPerPort = gateway.slots_per_port || 1;
  const n = (portNum - 1) * slotsPerPort + (slotNum - 1);

  // Manual 6.4.3: POST to /goip_send_cmd.html?username=xx&password=xx&op=set
  // Body is plain text: sim_imei(n)=value
  const textBody = `sim_imei(${n})=${imei}`;
  const apiPort = gateway.api_port || 80;
  const params = new URLSearchParams({
    username: gateway.username,
    password: gateway.password,
    op: "set",
  });
  const cmdUrl = `http://${gateway.host}:${apiPort}/goip_send_cmd.html?${params}`;

  const result = await bridgeFetch(env, cmdUrl, "POST", {
    "Content-Type": "text/plain",
  }, textBody);

  await logSkylineApiCall(env, {
    action: "set_imei",
    gateway_id,
    port: `${portNum}.${String(slotNum).padStart(2, "0")} (n=${n})`,
    requestUrl: cmdUrl.replace(gateway.password, "***"),
    requestBody: textBody,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: result.data,
    error: result.error,
  });

  // Success response: {"code":0,"reason":"OK","par_set":1}
  const ok = result.ok || result.data?.code === 0;
  if (!ok) {
    return json({ ok: false, error: result.error || result.data?.reason || "Skyline API error", skyline_response: result.data, debug: { n, textBody } }, 502);
  }

  return json({ ok: true, message: `IMEI set on ${gateway.code} port ${portNum} slot ${slotNum} (index ${n})`, skyline_response: result.data, debug: { n, textBody } });
}

async function handlePortStatus(url, env) {
  const gatewayId = url.searchParams.get("gateway_id");
  if (!gatewayId) {
    return json({ ok: false, error: "gateway_id query param is required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gatewayId);
  if (error) return error;

  // Handshake already confirmed connectivity, now fetch full stats via bridge
  const params = new URLSearchParams({
    version: "1.1",
    username: gateway.username,
    password: gateway.password,
    ports: "all",
    type: "3",
  });

  const statusUrl = `http://${gateway.host}:${gateway.api_port || 80}/goip_get_sms_stat.html?${params}`;
  const result = await bridgeFetch(env, statusUrl, "GET");

  await logSkylineApiCall(env, {
    action: "port_status",
    gateway_id: gatewayId,
    port: "all",
    requestUrl: statusUrl.replace(gateway.password, "***"),
    requestBody: null,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: result.data,
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error", skyline_response: result.data }, 502);
  }

  return json({ ok: true, skyline_response: result.data });
}

async function handlePortInfo(url, env) {
  const gatewayId = url.searchParams.get("gateway_id");
  if (!gatewayId) {
    return json({ ok: false, error: "gateway_id query param is required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gatewayId);
  if (error) return error;

  // Fetch device status (includes st, iccid, imei, signal, operator per port)
  const params = new URLSearchParams({
    version: "1.1",
    username: gateway.username,
    password: gateway.password,
    ports: "all",
  });

  // Support all_slots=1 to get IMEIs from every SIM slot (multi-slot gateways)
  if (url.searchParams.get("all_slots") === "1") {
    params.set("all_slots", "1");
  }

  const infoUrl = `http://${gateway.host}:${gateway.api_port || 80}/goip_get_status.html?${params}`;
  const result = await bridgeFetch(env, infoUrl, "GET");

  await logSkylineApiCall(env, {
    action: "port_info",
    gateway_id: gatewayId,
    port: "all",
    requestUrl: infoUrl.replace(gateway.password, "***"),
    requestBody: null,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: null, // skip logging full response (large)
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error", skyline_response: result.data }, 502);
  }

  // Also fetch SIM-to-number mapping from Supabase for this gateway
  const simsRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/sims?select=id,iccid,port,slot,status,sim_numbers(e164,verification_status)&gateway_id=eq.${encodeURIComponent(gatewayId)}&sim_numbers.valid_to=is.null&order=id.asc`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
      },
    }
  );

  let simMap = {};
  if (simsRes.ok) {
    const sims = await simsRes.json();
    for (const sim of sims) {
      if (sim.iccid) {
        simMap[sim.iccid] = {
          sim_id: sim.id,
          port: sim.port,
          status: sim.status,
          number: sim.sim_numbers?.[0]?.e164 || null,
          verified: sim.sim_numbers?.[0]?.verification_status || null,
        };
      }
    }
  }

  // Merge gateway status with SIM info
  const ports = (result.data?.status || []).map(p => {
    const simInfo = simMap[p.iccid] || null;
    return {
      port: p.port,
      st: p.st,
      iccid: p.iccid || null,
      imei: p.imei || null,
      signal: p.sig ?? null,
      operator: p.opr || null,
      inserted: p.inserted,
      active: p.active,
      sim_id: simInfo?.sim_id || null,
      number: simInfo?.number || null,
      sim_status: simInfo?.status || null,
      verified: simInfo?.verified || null,
    };
  });

  return json({ ok: true, gateway: { code: gateway.code, name: gateway.name, mac: result.data?.mac }, ports });
}

async function handlePortCommand(request, env, op) {
  const body = await request.json();
  const { gateway_id, port } = body;

  if (!gateway_id || !port) {
    return json({ ok: false, error: "gateway_id and port are required" }, 400);
  }

  const { gateway, error } = await loadAndHandshake(env, gateway_id);
  if (error) return error;

  const payload = { type: "command", op, ports: port };
  const result = await skylineFetch(env, gateway, "/goip_send_cmd.html", "POST", payload);

  await logSkylineApiCall(env, {
    action: op,
    gateway_id,
    port,
    requestUrl: result.url,
    requestBody: payload,
    responseStatus: result.status,
    responseOk: result.ok,
    responseBody: result.data,
    error: result.error,
  });

  if (!result.ok) {
    return json({ ok: false, error: result.error || "Skyline API error", skyline_response: result.data }, 502);
  }

  return json({ ok: true, message: `${op} executed on ${gateway.code} port ${port}`, skyline_response: result.data });
}

/* ================= CORE FUNCTIONS ================= */

/**
 * Load gateway from DB, validate credentials, and perform handshake.
 * Returns { gateway } on success or { error: Response } on failure.
 */
async function loadAndHandshake(env, gatewayId) {
  const gateway = await loadGateway(env, gatewayId);
  if (!gateway) return { error: json({ ok: false, error: "Gateway not found" }, 404) };
  if (!gateway.host || !gateway.username || !gateway.password) {
    return { error: json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400) };
  }

  const shake = await handshake(env, gateway);
  if (!shake.ok) {
    await logSkylineApiCall(env, {
      action: "handshake",
      gateway_id: gatewayId,
      port: null,
      requestUrl: `http://${gateway.host}:${gateway.api_port || 80}/goip_get_sms_stat.html`,
      requestBody: null,
      responseStatus: 0,
      responseOk: false,
      responseBody: null,
      error: shake.error,
    });
    return { error: json({ ok: false, error: shake.error }, 502) };
  }

  return { gateway };
}

async function loadGateway(env, gatewayId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/gateways?select=id,code,name,host,api_port,username,password,total_ports,slots_per_port&id=eq.${encodeURIComponent(gatewayId)}&limit=1`,
    {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    console.log(`[SkylineGateway] Supabase error loading gateway: ${res.status}`);
    return null;
  }

  const gateways = await res.json();
  return gateways?.[0] || null;
}

/**
 * Route a request through the Supabase Edge Function bridge
 * to break out of Cloudflare's network and reach the gateway IP.
 */
async function bridgeFetch(env, targetUrl, method, headers, payload) {
  const bridgeUrl = `${env.SUPABASE_URL}/functions/v1/skyline-bridge`;

  try {
    const res = await fetch(bridgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-secret": env.SKYLINE_BRIDGE_SECRET,
      },
      body: JSON.stringify({
        url: targetUrl,
        method: method || "GET",
        headers: headers || undefined,
        payload: payload || undefined,
      }),
    });

    const result = await res.json();

    if (!result.ok) {
      return { url: targetUrl, status: 0, ok: false, data: null, error: result.error || "Bridge error" };
    }

    const data = result.data;
    const ok = result.status >= 200 && result.status < 300 && (data.code === 200 || data.code === undefined);
    return { url: targetUrl, status: result.status, ok, data, error: ok ? null : (data.reason || `HTTP ${result.status}`) };
  } catch (err) {
    return { url: targetUrl, status: 0, ok: false, data: null, error: String(err) };
  }
}

/**
 * Handshake: verify gateway is reachable and credentials are valid
 * before performing any operation. Uses a lightweight status query via the bridge.
 */
async function handshake(env, gateway) {
  const apiPort = gateway.api_port || 80;
  const params = new URLSearchParams({
    version: "1.1",
    username: gateway.username,
    password: gateway.password,
    ports: "1",
    type: "3",
  });
  const url = `http://${gateway.host}:${apiPort}/goip_get_sms_stat.html?${params}`;

  const result = await bridgeFetch(env, url, "GET");

  if (!result.ok) {
    const errMsg = result.error || "Handshake failed";
    return { ok: false, error: errMsg.includes("Handshake") ? errMsg : `Handshake failed: ${errMsg}` };
  }

  console.log(`[SkylineGateway] Handshake OK with ${gateway.code} (${gateway.host}:${apiPort})`);
  return { ok: true };
}

async function skylineFetch(env, gateway, endpoint, method, payload) {
  const apiPort = gateway.api_port || 80;
  const authParams = new URLSearchParams({
    username: gateway.username,
    password: gateway.password,
  });
  const url = `http://${gateway.host}:${apiPort}${endpoint}?${authParams}`;

  return await bridgeFetch(env, url, method, {
    "Content-Type": "application/json",
  }, payload);
}

const LETTER_TO_SLOT_NUM = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8 };

/** Normalize port input to dot notation: "22A" → "22.01", "22.01" → "22.01", "22" → "22" */
function normalizePortSlot(port) {
  if (/^\d+\.\d+$/.test(port)) return port;
  const match = port.match(/^(\d+)([A-Ha-h])$/);
  if (match) {
    const slotNum = LETTER_TO_SLOT_NUM[match[2].toUpperCase()] || 1;
    return `${match[1]}.${String(slotNum).padStart(2, "0")}`;
  }
  return port;
}

/** Parse port input into numeric port and slot: "22A" → {portNum:22, slotNum:1}, "22.01" → {portNum:22, slotNum:1} */
function parsePortSlot(port) {
  // Letter notation: "22A"
  const letterMatch = port.match(/^(\d+)([A-Ha-h])$/);
  if (letterMatch) {
    return { portNum: parseInt(letterMatch[1]), slotNum: LETTER_TO_SLOT_NUM[letterMatch[2].toUpperCase()] || 1 };
  }
  // Dot notation: "22.01"
  const dotMatch = port.match(/^(\d+)\.(\d+)$/);
  if (dotMatch) {
    return { portNum: parseInt(dotMatch[1]), slotNum: parseInt(dotMatch[2]) };
  }
  // Just a number: "22" → assume slot 1
  const numMatch = port.match(/^(\d+)$/);
  if (numMatch) {
    return { portNum: parseInt(numMatch[1]), slotNum: 1 };
  }
  return { portNum: null, slotNum: null };
}

/** GET-based command fetch — all params in query string (avoids JSON body parsing quirks) */
async function skylineFetchGet(env, gateway, endpoint, cmdParams) {
  const apiPort = gateway.api_port || 80;
  const params = new URLSearchParams({
    username: gateway.username,
    password: gateway.password,
    ...cmdParams,
  });
  const url = `http://${gateway.host}:${apiPort}${endpoint}?${params}`;
  return await bridgeFetch(env, url, "GET");
}

async function logSkylineApiCall(env, logData) {
  const runId = `sk_${Date.now().toString(36)}`;
  try {
    await fetch(`${env.SUPABASE_URL}/rest/v1/skyline_api_logs`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        run_id: runId,
        action: logData.action,
        gateway_id: logData.gateway_id,
        port: logData.port,
        request_url: logData.requestUrl,
        request_body: logData.requestBody,
        response_status: logData.responseStatus,
        response_ok: logData.responseOk,
        response_body: logData.responseBody,
        error: logData.error,
      }),
    });
  } catch (e) {
    console.log(`[SkylineGateway] Failed to log API call: ${e}`);
  }
}

/* ================= HELPERS ================= */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
