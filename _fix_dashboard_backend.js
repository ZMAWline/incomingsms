'use strict';
// Patch script: dashboard backend – new IMEI eligibility routes + eligibility gate
// Run: node _fix_dashboard_backend.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// ===================================================================
// 1. Add new routes in the router (after fix-slot, before /api/errors)
// ===================================================================

const ROUTE_MARKER = "    if (url.pathname === '/api/errors') {\n      return handleErrors(env, corsHeaders, url);\n    }";

const NEW_ROUTES = "    if (url.pathname === '/api/check-imei' && request.method === 'GET') {\n      return handleCheckImei(request, env, corsHeaders, url);\n    }\n\n    if (url.pathname === '/api/check-imeis' && request.method === 'POST') {\n      return handleCheckImeis(request, env, corsHeaders);\n    }\n\n    if (url.pathname === '/api/imei-pool/fix-incompatible' && request.method === 'POST') {\n      return handleFixIncompatibleImei(request, env, corsHeaders);\n    }\n\n    if (url.pathname === '/api/errors') {\n      return handleErrors(env, corsHeaders, url);\n    }";

if (!src.includes(ROUTE_MARKER)) {
  console.error('ERROR: /api/errors route marker not found');
  process.exit(1);
}
src = src.replace(ROUTE_MARKER, NEW_ROUTES);
console.log('✓ Added new API routes');

// ===================================================================
// 2. Extend handleSimAction to pass new_imei and auto_imei
// ===================================================================

const SIM_ACTION_BODY_OLD = "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null })";
const SIM_ACTION_BODY_NEW = "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false })";

if (!src.includes(SIM_ACTION_BODY_OLD)) {
  console.error('ERROR: handleSimAction body JSON.stringify not found');
  process.exit(1);
}
src = src.replace(SIM_ACTION_BODY_OLD, SIM_ACTION_BODY_NEW);
console.log('✓ Extended handleSimAction to pass new_imei and auto_imei');

// ===================================================================
// 3. Add eligibility gate to handleImeiPoolPost add action
//    After the retired check block, before the actual upsert
// ===================================================================

const IMEI_UPSERT_MARKER = "      let added = 0;\n      if (toAdd.length > 0) {\n        const addInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {";

const IMEI_ELIGIBILITY_GATE = '      // Eligibility gate: check each IMEI before adding\n      const rejectedIneligible = [];\n      const eligible = [];\n      if (env.MDN_ROTATOR && env.ADMIN_RUN_SECRET) {\n        for (const candidate of toAdd) {\n          try {\n            const checkUrl = ' + "'https://mdn-rotator/check-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET) + '&imei=' + encodeURIComponent(candidate.imei)" + ';\n            const checkRes = await env.MDN_ROTATOR.fetch(checkUrl, { method: ' + "'GET'" + ' });\n            const checkData = checkRes.ok ? await checkRes.json().catch(() => ({})) : {};\n            if (checkData.eligible === true) {\n              eligible.push(candidate);\n            } else {\n              rejectedIneligible.push({ imei: candidate.imei, reason: checkData.result ? JSON.stringify(checkData.result).slice(0, 200) : ' + "'Not eligible for carrier/plan'" + ' });\n            }\n          } catch (eligErr) {\n            // On check error, allow the IMEI (do not block on Helix errors)\n            console.error(' + "'[IMEI Add] Eligibility check error for ' + candidate.imei + ': ' + eligErr" + ');\n            eligible.push(candidate);\n          }\n        }\n      } else {\n        // No MDN_ROTATOR binding — skip eligibility check\n        eligible.push(...toAdd);\n      }\n\n      let added = 0;\n      if (eligible.length > 0) {\n        const addInsertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei`, {';

if (!src.includes(IMEI_UPSERT_MARKER)) {
  console.error('ERROR: IMEI upsert marker not found in handleImeiPoolPost');
  process.exit(1);
}
src = src.replace(IMEI_UPSERT_MARKER, IMEI_ELIGIBILITY_GATE);
console.log('✓ Added eligibility gate before IMEI upsert');

// ===================================================================
// 4. Fix the closing of the if (toAdd.length > 0) block to use eligible
//    The old code: if (toAdd.length > 0) { ... body: JSON.stringify(toAdd) ... }
//    Already replaced the open; now fix the body to use `eligible`
// ===================================================================

// The JSON.stringify(toAdd) in the addInsertRes body
const TOADD_JSON_OLD = '          body: JSON.stringify(toAdd),\n        });\n        const addInsertText = await addInsertRes.text();\n        let addInserted = [];\n        try { addInserted = JSON.parse(addInsertText); } catch { }\n        added = Array.isArray(addInserted) ? addInserted.length : 0;\n      }';
const TOADD_JSON_NEW = '          body: JSON.stringify(eligible),\n        });\n        const addInsertText = await addInsertRes.text();\n        let addInserted = [];\n        try { addInserted = JSON.parse(addInsertText); } catch { }\n        added = Array.isArray(addInserted) ? addInserted.length : 0;\n      }';

if (!src.includes(TOADD_JSON_OLD)) {
  console.error('ERROR: JSON.stringify(toAdd) in addInsertRes not found');
  process.exit(1);
}
src = src.replace(TOADD_JSON_OLD, TOADD_JSON_NEW);
console.log('✓ Updated addInsertRes body to use eligible array');

// ===================================================================
// 5. Add rejectedIneligible to the return value
// ===================================================================

const RETURN_OLD = "      return new Response(JSON.stringify({\n        ok: true,\n        added,\n        duplicates: dupCount,\n        invalid: invalid.length,\n        rejected_retired: rejectedRetired,\n      }), {";
const RETURN_NEW = "      return new Response(JSON.stringify({\n        ok: true,\n        added,\n        duplicates: dupCount,\n        invalid: invalid.length,\n        rejected_retired: rejectedRetired,\n        rejected_ineligible: rejectedIneligible || [],\n      }), {";

if (!src.includes(RETURN_OLD)) {
  console.error('ERROR: handleImeiPoolPost return value not found');
  process.exit(1);
}
src = src.replace(RETURN_OLD, RETURN_NEW);
console.log('✓ Added rejected_ineligible to handleImeiPoolPost return');

// ===================================================================
// 6. Add new handler functions before handleQboRoute
// ===================================================================

const QBO_ROUTE_MARKER = 'async function handleQboRoute(request, env, corsHeaders, url) {';

const NEW_HANDLERS = `async function handleCheckImei(request, env, corsHeaders, url) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const imei = url.searchParams.get('imei') || '';
    if (!/^\\d{15}$/.test(imei)) {
      return new Response(JSON.stringify({ error: 'imei must be 15 digits' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const checkUrl = 'https://mdn-rotator/check-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET) + '&imei=' + encodeURIComponent(imei);
    const workerRes = await env.MDN_ROTATOR.fetch(checkUrl, { method: 'GET' });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleCheckImeis(request, env, corsHeaders) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await request.json().catch(() => ({}));
    const checkUrl = 'https://mdn-rotator/check-imeis?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET);
    const workerRes = await env.MDN_ROTATOR.fetch(checkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleFixIncompatibleImei(request, env, corsHeaders) {
  try {
    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const body = await request.json().catch(() => ({}));
    const fixUrl = 'https://mdn-rotator/fix-incompatible-imei?secret=' + encodeURIComponent(env.ADMIN_RUN_SECRET);
    const workerRes = await env.MDN_ROTATOR.fetch(fixUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseText = await workerRes.text();
    return new Response(responseText, { status: workerRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

`;

if (!src.includes(QBO_ROUTE_MARKER)) {
  console.error('ERROR: handleQboRoute marker not found');
  process.exit(1);
}
src = src.replace(QBO_ROUTE_MARKER, NEW_HANDLERS + QBO_ROUTE_MARKER);
console.log('✓ Added handleCheckImei, handleCheckImeis, handleFixIncompatibleImei');

// ===================================================================
// Write with CRLF
// ===================================================================
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/dashboard/index.js with CRLF line endings');
console.log('Run: node --input-type=module --check < src/dashboard/index.js');
