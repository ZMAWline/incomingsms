const TPLINK_BASE = 'https://wap.tplinkcloud.com/';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    const json = (data, status) => new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

    try {
      if (path === '/outlets' && request.method === 'GET') {
        return json(await getOutlets(env));
      }
      if (path === '/outlet' && request.method === 'POST') {
        const { alias, action } = await request.json();
        if (!alias || !['on', 'off', 'reboot'].includes(action)) {
          return json({ error: 'alias and action (on/off/reboot) required' }, 400);
        }
        return json(await controlOutlet(env, alias, action));
      }
      // Manual trigger of the scheduled reboot. Same auth as other workers (ADMIN_RUN_SECRET)
      // optional — if not configured, the endpoint is open. Useful for one-off ops.
      if (path === '/reboot-gateways' && request.method === 'POST') {
        const secret = url.searchParams.get('secret') || '';
        if (env.ADMIN_RUN_SECRET && secret !== env.ADMIN_RUN_SECRET) {
          return json({ error: 'Unauthorized' }, 401);
        }
        return json(await rebootAllGateways(env));
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebootAllGateways(env).catch(err => {
      console.error('[KasaCron] rebootAllGateways failed:', err);
    }));
  },
};

// Reboot every KASA outlet whose alias matches a known gateway code (gateways.code in DB).
// Sequential — at most one gateway is powered down at any moment (~20s downtime each:
// 10s off + 10s on inside controlOutlet's reboot action). Outlets with non-matching
// aliases are left alone (e.g., a router or hub sharing the same strip).
async function rebootAllGateways(env) {
  const gatewayCodes = await fetchActiveGatewayCodes(env);
  if (gatewayCodes.length === 0) {
    console.log('[KasaCron] No active gateways found in DB — skipping');
    return { ok: true, rebooted: 0, skipped: [], message: 'no active gateways' };
  }
  const codeSet = new Set(gatewayCodes.map(c => c.toLowerCase()));

  const token = await login(env);
  const strip = await findStrip(env, token);
  const resp = await passthrough(env, token, strip.deviceId, strip.appServerUrl, { system: { get_sysinfo: {} } });
  const children = resp.system.get_sysinfo.children || [];

  const targets = children.filter(c => c.alias && codeSet.has(c.alias.toLowerCase()));
  const ignored = children.filter(c => !c.alias || !codeSet.has(c.alias.toLowerCase())).map(c => c.alias);

  console.log(`[KasaCron] Rebooting ${targets.length} of ${children.length} outlets — matched gateways: ${targets.map(t => t.alias).join(', ')} | ignored: ${ignored.join(', ') || 'none'}`);

  const results = [];
  for (const child of targets) {
    try {
      await passthrough(env, token, strip.deviceId, strip.appServerUrl, {
        context: { child_ids: [child.id] },
        system: { set_relay_state: { state: 0 } },
      });
      await new Promise(r => setTimeout(r, 10000));
      await passthrough(env, token, strip.deviceId, strip.appServerUrl, {
        context: { child_ids: [child.id] },
        system: { set_relay_state: { state: 1 } },
      });
      console.log(`[KasaCron] Rebooted ${child.alias}`);
      results.push({ alias: child.alias, ok: true });
    } catch (err) {
      console.error(`[KasaCron] Reboot failed for ${child.alias}: ${err}`);
      results.push({ alias: child.alias, ok: false, error: String(err) });
    }
  }

  return { ok: true, rebooted: results.filter(r => r.ok).length, total: targets.length, ignored, results };
}

async function fetchActiveGatewayCodes(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase credentials not configured on kasa-control');
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/gateways?select=code&active=eq.true`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase gateways fetch failed ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows.map(r => r.code).filter(Boolean) : [];
}

function relayFetch(env, url, init) {
  if (env.RELAY_URL && env.RELAY_KEY) {
    return fetch(env.RELAY_URL + '/' + url, {
      ...init,
      headers: { ...((init && init.headers) || {}), 'x-relay-key': env.RELAY_KEY },
    });
  }
  return fetch(url, init);
}

async function kasaPost(env, token, appServerUrl, body) {
  const endpoint = appServerUrl || TPLINK_BASE;
  const url = token ? endpoint + '?token=' + token : endpoint;
  const res = await relayFetch(env, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error_code !== 0) {
    throw new Error('TP-Link error ' + data.error_code + ': ' + (data.msg || JSON.stringify(data)));
  }
  return data.result;
}

async function login(env) {
  const result = await kasaPost(env, null, null, {
    method: 'login',
    params: {
      appType: 'Kasa',
      cloudUserName: env.KASA_USERNAME,
      cloudPassword: env.KASA_PASSWORD,
      terminalUUID: crypto.randomUUID(),
    },
  });
  return result.token;
}

async function getDeviceList(env, token) {
  const result = await kasaPost(env, token, null, {
    method: 'getDeviceList',
    params: {},
  });
  return result.deviceList || [];
}

async function passthrough(env, token, deviceId, appServerUrl, requestData) {
  const result = await kasaPost(env, token, appServerUrl, {
    method: 'passthrough',
    params: { deviceId: deviceId, requestData: JSON.stringify(requestData) },
  });
  return JSON.parse(result.responseData);
}

async function findStrip(env, token) {
  const devices = await getDeviceList(env, token);
  const strip = devices.find(d => d.alias && d.alias.toLowerCase().includes('9a97'));
  if (!strip) {
    throw new Error('Device "Union Office" not found. Available: ' + devices.map(d => d.alias).join(', '));
  }
  return strip;
}

async function getOutlets(env) {
  const token = await login(env);
  const strip = await findStrip(env, token);
  const resp = await passthrough(env, token, strip.deviceId, strip.appServerUrl, { system: { get_sysinfo: {} } });
  const children = resp.system.get_sysinfo.children || [];
  return children.map((c, i) => ({ alias: c.alias, id: c.id, state: c.state === 1, index: i }));
}

async function controlOutlet(env, alias, action) {
  const token = await login(env);
  const strip = await findStrip(env, token);
  const resp = await passthrough(env, token, strip.deviceId, strip.appServerUrl, { system: { get_sysinfo: {} } });
  const children = resp.system.get_sysinfo.children || [];
  const child = children.find(c => c.alias === alias);
  if (!child) throw new Error('Outlet "' + alias + '" not found');

  if (action === 'reboot') {
    await passthrough(env, token, strip.deviceId, strip.appServerUrl, {
      context: { child_ids: [child.id] },
      system: { set_relay_state: { state: 0 } },
    });
    await new Promise(r => setTimeout(r, 10000));
    await passthrough(env, token, strip.deviceId, strip.appServerUrl, {
      context: { child_ids: [child.id] },
      system: { set_relay_state: { state: 1 } },
    });
    return { ok: true, action: 'rebooted', alias: alias };
  }

  await passthrough(env, token, strip.deviceId, strip.appServerUrl, {
    context: { child_ids: [child.id] },
    system: { set_relay_state: { state: action === 'on' ? 1 : 0 } },
  });
  return { ok: true, action: action, alias: alias };
}

