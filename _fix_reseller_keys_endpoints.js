// _fix_reseller_keys_endpoints.js
// Add /api/reseller-keys admin endpoints (list, create, revoke) to dashboard.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Add router entries after the qbo-invoices route -----------------------

const ROUTER_OLD = [
  "    if (url.pathname === '/api/qbo-invoices') {",
  "      return handleQboInvoicesGet(env, corsHeaders);",
  "    }",
].join('\n');

const ROUTER_NEW = [
  "    if (url.pathname === '/api/qbo-invoices') {",
  "      return handleQboInvoicesGet(env, corsHeaders);",
  "    }",
  "",
  "    if (url.pathname === '/api/reseller-keys' && request.method === 'GET') {",
  "      return handleResellerKeysList(url, env, corsHeaders);",
  "    }",
  "    if (url.pathname === '/api/reseller-keys' && request.method === 'POST') {",
  "      return handleResellerKeysCreate(request, env, corsHeaders);",
  "    }",
  "    if (url.pathname === '/api/reseller-keys/revoke' && request.method === 'POST') {",
  "      return handleResellerKeysRevoke(request, env, corsHeaders);",
  "    }",
].join('\n');

if (!content.includes(ROUTER_OLD)) {
  console.error('PATCH FAILED: router anchor not found.');
  process.exit(1);
}
if (content.includes("'/api/reseller-keys'")) {
  console.log('Reseller-keys router already present, skipping.');
} else {
  content = content.replace(ROUTER_OLD, ROUTER_NEW);
  console.log('Added reseller-keys router entries.');
}

// 2. Insert handler functions before handleQboMappingsGet -----------------

const HANDLER_ANCHOR = "async function handleQboMappingsGet(env, corsHeaders) {";

const HANDLERS = [
  "async function handleResellerKeysList(url, env, corsHeaders) {",
  "  try {",
  "    const resellerId = url.searchParams.get('reseller_id');",
  "    let q = 'reseller_api_keys?select=id,reseller_id,api_key,enabled,created_at,resellers(name)&order=created_at.desc';",
  "    if (resellerId) q += '&reseller_id=eq.' + encodeURIComponent(resellerId);",
  "    const resp = await supabaseGet(env, q);",
  "    if (!resp.ok) {",
  "      return new Response(JSON.stringify({ error: 'lookup failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const rows = await resp.json();",
  "    const out = (Array.isArray(rows) ? rows : []).map(r => ({",
  "      id: r.id,",
  "      reseller_id: r.reseller_id,",
  "      reseller_name: r.resellers?.name || null,",
  "      api_key_masked: maskApiKey(r.api_key),",
  "      enabled: r.enabled,",
  "      created_at: r.created_at,",
  "    }));",
  "    return new Response(JSON.stringify(out), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  } catch (e) {",
  "    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  }",
  "}",
  "",
  "function maskApiKey(k) {",
  "  if (!k || k.length < 8) return '****';",
  "  return k.slice(0, 9) + '…' + k.slice(-4);",
  "}",
  "",
  "function generateApiKey() {",
  "  const bytes = new Uint8Array(16);",
  "  crypto.getRandomValues(bytes);",
  "  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');",
  "  return 'rsk_live_' + hex;",
  "}",
  "",
  "async function handleResellerKeysCreate(request, env, corsHeaders) {",
  "  try {",
  "    const body = await request.json();",
  "    const resellerId = body.reseller_id;",
  "    if (!resellerId) {",
  "      return new Response(JSON.stringify({ error: 'reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const checkResp = await supabaseGet(env, 'resellers?select=id&id=eq.' + encodeURIComponent(resellerId) + '&limit=1');",
  "    const checkRows = await checkResp.json();",
  "    if (!Array.isArray(checkRows) || checkRows.length === 0) {",
  "      return new Response(JSON.stringify({ error: 'reseller not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const apiKey = generateApiKey();",
  "    const insertResp = await fetch(env.SUPABASE_URL + '/rest/v1/reseller_api_keys', {",
  "      method: 'POST',",
  "      headers: {",
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,",
  "        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,",
  "        'Content-Type': 'application/json',",
  "        Prefer: 'return=representation',",
  "      },",
  "      body: JSON.stringify({ reseller_id: resellerId, api_key: apiKey, enabled: true }),",
  "    });",
  "    if (!insertResp.ok) {",
  "      const txt = await insertResp.text();",
  "      return new Response(JSON.stringify({ error: 'insert failed: ' + txt }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const inserted = await insertResp.json();",
  "    const row = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;",
  "    return new Response(JSON.stringify({",
  "      id: row?.id,",
  "      reseller_id: resellerId,",
  "      api_key: apiKey,",
  "      enabled: true,",
  "      created_at: row?.created_at,",
  "      note: 'This key is shown once. Copy it now and deliver to the reseller securely.',",
  "    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  } catch (e) {",
  "    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  }",
  "}",
  "",
  "async function handleResellerKeysRevoke(request, env, corsHeaders) {",
  "  try {",
  "    const body = await request.json();",
  "    const id = body.id;",
  "    if (!id) {",
  "      return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    const resp = await fetch(env.SUPABASE_URL + '/rest/v1/reseller_api_keys?id=eq.' + encodeURIComponent(id), {",
  "      method: 'PATCH',",
  "      headers: {",
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,",
  "        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,",
  "        'Content-Type': 'application/json',",
  "        Prefer: 'return=minimal',",
  "      },",
  "      body: JSON.stringify({ enabled: false }),",
  "    });",
  "    if (!resp.ok) {",
  "      const txt = await resp.text();",
  "      return new Response(JSON.stringify({ error: 'revoke failed: ' + txt }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    }",
  "    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  } catch (e) {",
  "    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "  }",
  "}",
  "",
  "",
].join('\n');

const idx = content.indexOf(HANDLER_ANCHOR);
if (idx === -1) { console.error('PATCH FAILED: handler anchor not found.'); process.exit(1); }
if (content.includes('async function handleResellerKeysList(')) {
  console.log('Reseller-keys handlers already present, skipping.');
} else {
  content = content.slice(0, idx) + HANDLERS + content.slice(idx);
  console.log('Added reseller-keys handler functions.');
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
