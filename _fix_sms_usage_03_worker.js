// _fix_sms_usage_03_worker.js
// Add /api/sms-usage route + handleSmsUsage handler + cycle boundary helpers.
// These changes are in the outer Worker module, OUTSIDE getHTML() — plain JS is fine.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. Add route registration after /api/stats block ----
const ROUTE_OLD =
  "    if (url.pathname === '/api/stats') {\n" +
  "      return handleStats(env, corsHeaders);\n" +
  "    }\n";
const ROUTE_NEW =
  "    if (url.pathname === '/api/stats') {\n" +
  "      return handleStats(env, corsHeaders);\n" +
  "    }\n" +
  "\n" +
  "    if (url.pathname === '/api/sms-usage') {\n" +
  "      return handleSmsUsage(env, corsHeaders, url);\n" +
  "    }\n";

if (!content.includes(ROUTE_OLD)) {
  console.error('PATCH FAILED: /api/stats route block not found.');
  process.exit(1);
}
if (content.includes("'/api/sms-usage'")) {
  console.error('PATCH FAILED: /api/sms-usage route already registered.');
  process.exit(1);
}
content = content.replace(ROUTE_OLD, () => ROUTE_NEW);

// ---- 2. Add helper functions + handleSmsUsage after handleStats ----
const HANDLER_ANCHOR = "async function handleSims(env, corsHeaders, url) {";

const NEW_HANDLER =
`// Billing cycle + EST date helpers for SMS usage analytics.
// Soft-coded anchor day — change here when real Wing billing cycle date is confirmed.
const BILLING_CYCLE_ANCHOR_DAY = 1;

function currentCycleStartEst(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  let y = parseInt(parts.year, 10);
  let m = parseInt(parts.month, 10);
  const d = parseInt(parts.day, 10);
  if (d < BILLING_CYCLE_ANCHOR_DAY) {
    m--;
    if (m < 1) { m = 12; y--; }
  }
  return y + '-' + String(m).padStart(2, '0') + '-' + String(BILLING_CYCLE_ANCHOR_DAY).padStart(2, '0');
}

function todayEst(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

async function handleSmsUsage(env, corsHeaders, url) {
  try {
    const noCache = url && url.searchParams && url.searchParams.has('nocache');
    const cacheKey = new Request('https://cache.local/sms-usage');
    if (!noCache) {
      const hit = await caches.default.match(cacheKey);
      if (hit) return hit;
    }

    const body = {
      p_cycle_start: currentCycleStartEst(),
      p_today: todayEst(),
      p_trend_days: 30,
    };

    const r = await fetch(env.SUPABASE_URL + '/rest/v1/rpc/get_sms_usage_summary', {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: 'rpc_failed', status: r.status, detail: txt }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const data = await r.json();
    const resp = new Response(JSON.stringify(data), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Cache-Control': 'max-age=60',
      },
    });
    if (!noCache) await caches.default.put(cacheKey, resp.clone());
    return resp;
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

`;

if (!content.includes(HANDLER_ANCHOR)) {
  console.error('PATCH FAILED: handleSims anchor not found.');
  process.exit(1);
}
if (content.includes('async function handleSmsUsage')) {
  console.error('PATCH FAILED: handleSmsUsage already present.');
  process.exit(1);
}
content = content.replace(HANDLER_ANCHOR, () => NEW_HANDLER + HANDLER_ANCHOR);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch 3 applied: Worker route + handler + helpers.');
