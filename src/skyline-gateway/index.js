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

  const gateway = await loadGateway(env, gateway_id);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

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

  const result = await skylineFetch(gateway, "/goip_post_sms.html", "POST", payload);

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

  const gateway = await loadGateway(env, gateway_id);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

  const payload = { type: "command", op: "switch", ports: port };
  const result = await skylineFetch(gateway, "/goip_send_cmd.html", "POST", payload);

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

  const gateway = await loadGateway(env, gateway_id);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

  const payload = { type: "command", op: "get", ports: port, prop: "imei" };
  const result = await skylineFetch(gateway, "/goip_send_cmd.html", "POST", payload);

  await logSkylineApiCall(env, {
    action: "get_imei",
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

  return json({ ok: true, skyline_response: result.data });
}

async function handleSetImei(request, env) {
  const body = await request.json();
  const { gateway_id, port, imei } = body;

  if (!gateway_id || !port || !imei) {
    return json({ ok: false, error: "gateway_id, port, and imei are required" }, 400);
  }

  const gateway = await loadGateway(env, gateway_id);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

  const payload = { type: "command", op: "set", ports: port, prop: "imei", value: imei };
  const result = await skylineFetch(gateway, "/goip_send_cmd.html", "POST", payload);

  await logSkylineApiCall(env, {
    action: "set_imei",
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

  return json({ ok: true, message: `IMEI set on ${gateway.code} port ${port}`, skyline_response: result.data });
}

async function handlePortStatus(url, env) {
  const gatewayId = url.searchParams.get("gateway_id");
  if (!gatewayId) {
    return json({ ok: false, error: "gateway_id query param is required" }, 400);
  }

  const gateway = await loadGateway(env, gatewayId);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

  // Use GET with query params for status
  const params = new URLSearchParams({
    version: "1.1",
    username: gateway.username,
    password: gateway.password,
    ports: "all",
    type: "3",
  });

  const statusUrl = `http://${gateway.host}:${gateway.api_port || 80}/goip_get_sms_stat.html?${params}`;

  let result;
  try {
    const res = await fetch(statusUrl);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    result = { url: statusUrl, status: res.status, ok: res.ok && (data.code === 200 || !data.code), data, error: null };
  } catch (err) {
    result = { url: statusUrl, status: 0, ok: false, data: null, error: String(err) };
  }

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

async function handlePortCommand(request, env, op) {
  const body = await request.json();
  const { gateway_id, port } = body;

  if (!gateway_id || !port) {
    return json({ ok: false, error: "gateway_id and port are required" }, 400);
  }

  const gateway = await loadGateway(env, gateway_id);
  if (!gateway) return json({ ok: false, error: "Gateway not found" }, 404);
  if (!gateway.host || !gateway.username || !gateway.password) {
    return json({ ok: false, error: `Gateway "${gateway.code}" missing credentials` }, 400);
  }

  const payload = { type: "command", op, ports: port };
  const result = await skylineFetch(gateway, "/goip_send_cmd.html", "POST", payload);

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

async function loadGateway(env, gatewayId) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/gateways?select=id,code,name,host,api_port,username,password,total_ports&id=eq.${encodeURIComponent(gatewayId)}&limit=1`,
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

async function skylineFetch(gateway, endpoint, method, payload) {
  const apiPort = gateway.api_port || 80;
  const url = `http://${gateway.host}:${apiPort}${endpoint}`;
  const authHeader = "Basic " + btoa(`${gateway.username}:${gateway.password}`);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const ok = res.ok && (data.code === 200 || data.code === undefined);
    return { url, status: res.status, ok, data, error: ok ? null : (data.reason || `HTTP ${res.status}`) };
  } catch (err) {
    return { url, status: 0, ok: false, data: null, error: String(err) };
  }
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
