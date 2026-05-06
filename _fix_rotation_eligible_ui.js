// _fix_rotation_eligible_ui.js
// 6 edits:
// 1. /api/sims SELECT adds rotation_eligible column
// 2. /api/sims formatted response adds rotation_eligible
// 3. New route POST /api/set-rotation-eligible
// 4. Backend handler handleSetRotationEligible near handleUnassignReseller
// 5. Bulk action buttons (Pause / Resume auto-rotate) in the SIM action bar
// 6. Per-row pill button in the SIM actions cell
// 7. Frontend helpers setRotationEligible, bulkSetRotationEligible

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const BT = '\\' + '`';    // \`
const DS = '\\' + '${';   // \${

// 1. Add rotation_eligible to sims SELECT ------------------------------------
const SELECT_OLD =
  "let query = `sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000`;";
const SELECT_NEW =
  "let query = `sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,rotation_eligible,mobility_subscription_id,gateway_id,last_mdn_rotated_at,activated_at,last_activation_error,last_notified_at,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=5000`;";
if (!content.includes(SELECT_OLD)) {
  if (content.includes('rotation_eligible,mobility_subscription_id')) {
    console.warn('Step 1 skipped — rotation_eligible already in SELECT.');
  } else {
    console.error('PATCH FAILED (1): SIM SELECT not found.'); process.exit(1);
  }
} else {
  content = content.replace(SELECT_OLD, SELECT_NEW);
}

// 2. Add rotation_eligible to formatted response -----------------------------
const FMT_OLD =
  "        vendor: sim.vendor || 'unknown',\n" +
  "        carrier: sim.carrier || null,\n" +
  "        rotation_interval_hours: sim.rotation_interval_hours || 24,\n" +
  "      };";
const FMT_NEW =
  "        vendor: sim.vendor || 'unknown',\n" +
  "        carrier: sim.carrier || null,\n" +
  "        rotation_interval_hours: sim.rotation_interval_hours || 24,\n" +
  "        rotation_eligible: sim.rotation_eligible !== false,\n" +
  "      };";
if (!content.includes(FMT_OLD)) {
  if (content.includes('rotation_eligible: sim.rotation_eligible')) {
    console.warn('Step 2 skipped — rotation_eligible already in response.');
  } else {
    console.error('PATCH FAILED (2): formatted response anchor not found.'); process.exit(1);
  }
} else {
  content = content.replace(FMT_OLD, FMT_NEW);
}

// 3. Add /api/set-rotation-eligible route ------------------------------------
const ROUTE_OLD =
  "    if (url.pathname === '/api/unassign-reseller' && request.method === 'POST') {\n" +
  "      return handleUnassignReseller(request, env, corsHeaders);\n" +
  "    }";
const ROUTE_NEW = ROUTE_OLD + "\n\n" +
  "    if (url.pathname === '/api/set-rotation-eligible' && request.method === 'POST') {\n" +
  "      return handleSetRotationEligible(request, env, corsHeaders);\n" +
  "    }";
if (content.includes("'/api/set-rotation-eligible'")) {
  console.warn('Step 3 skipped — route already present.');
} else if (!content.includes(ROUTE_OLD)) {
  console.error('PATCH FAILED (3): unassign-reseller route anchor not found.'); process.exit(1);
} else {
  content = content.replace(ROUTE_OLD, ROUTE_NEW);
}

// 4. Add handleSetRotationEligible backend handler ---------------------------
const HANDLER_ANCHOR = 'async function handleUnassignReseller(request, env, corsHeaders) {';
if (content.includes('async function handleSetRotationEligible')) {
  console.warn('Step 4 skipped — handler already defined.');
} else if (!content.includes(HANDLER_ANCHOR)) {
  console.error('PATCH FAILED (4): handler anchor not found.'); process.exit(1);
} else {
  const handler = [
    'async function handleSetRotationEligible(request, env, corsHeaders) {',
    '  try {',
    '    const body = await request.json();',
    '    const simIds = Array.isArray(body.sim_ids) ? body.sim_ids.map(Number).filter(Boolean) : [];',
    '    const eligible = body.eligible === true;',
    '    if (simIds.length === 0) {',
    '      return new Response(JSON.stringify({ error: \'sim_ids array required\' }), {',
    '        status: 400, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '      });',
    '    }',
    '    // Single PATCH against sims?id=in.(...) — atomic, one round-trip.',
    '    const url = `${env.SUPABASE_URL}/rest/v1/sims?id=in.(${simIds.join(\',\')})`;',
    '    const res = await fetch(url, {',
    '      method: \'PATCH\',',
    '      headers: {',
    '        apikey: env.SUPABASE_SERVICE_ROLE_KEY,',
    '        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,',
    '        \'Content-Type\': \'application/json\',',
    '        Prefer: \'return=representation\',',
    '      },',
    '      body: JSON.stringify({ rotation_eligible: eligible }),',
    '    });',
    '    const text = await res.text();',
    '    let data; try { data = JSON.parse(text); } catch { data = null; }',
    '    if (!res.ok) {',
    '      return new Response(JSON.stringify({ error: \'Supabase PATCH \' + res.status + \': \' + text.slice(0, 200) }), {',
    '        status: 502, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '      });',
    '    }',
    '    const updated = Array.isArray(data) ? data.length : 0;',
    '    return new Response(JSON.stringify({ ok: true, updated, eligible }), {',
    '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '    });',
    '  } catch (e) {',
    '    return new Response(JSON.stringify({ error: String(e) }), {',
    '      status: 500, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }',
    '    });',
    '  }',
    '}',
    '',
    '',
  ].join('\n');
  content = content.replace(HANDLER_ANCHOR, handler + HANDLER_ANCHOR);
}

// 5. Bulk buttons — add after "Resume" in the sim-action-bar -----------------
const BULK_OLD = "                    <button onclick=\"bulkSimAction('resume')\" class=\"px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition\">Resume</button>";
const BULK_NEW = BULK_OLD +
  "\n                    <button onclick=\"bulkSetRotationEligible(false)\" class=\"px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 text-white rounded transition\">Pause Auto-Rotate</button>" +
  "\n                    <button onclick=\"bulkSetRotationEligible(true)\" class=\"px-3 py-1.5 text-xs bg-lime-600 hover:bg-lime-700 text-white rounded transition\">Resume Auto-Rotate</button>";
if (content.includes('bulkSetRotationEligible')) {
  console.warn('Step 5 skipped — bulk buttons already present.');
} else if (!content.includes(BULK_OLD)) {
  console.error('PATCH FAILED (5): Resume bulk button anchor not found.'); process.exit(1);
} else {
  content = content.replace(BULK_OLD, BULK_NEW);
}

// 6. Per-row pill button in SIM actions cell ---------------------------------
// Append just before the closing </td> of the actions cell (after the Del button).
const ROW_OLD =
  '                        ' + DS + BT + '<button onclick="deleteSim(' + DS + 'sim.id}, \'' + DS + 'sim.iccid}\')" class="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition ml-1" title="Delete this SIM permanently">Del</button>' + BT + '}';
const ROW_NEW = ROW_OLD +
  '\n                        ' + DS + BT + '<button onclick="setRotationEligible(' + DS + 'sim.id}, ' + DS + '!(sim.rotation_eligible === false)})" class="px-2 py-1 text-xs rounded transition ml-1 ' + DS + '(sim.rotation_eligible === false) ? \'bg-slate-600 hover:bg-slate-500 text-gray-200\' : \'bg-green-700 hover:bg-green-600 text-white\'}" title="Toggle automatic rotation for this SIM">' + DS + '(sim.rotation_eligible === false) ? \'Auto: Off\' : \'Auto: On\'}</button>' + BT + '}';
if (content.includes('setRotationEligible(')) {
  console.warn('Step 6 skipped — per-row pill already present.');
} else if (!content.includes(ROW_OLD)) {
  console.error('PATCH FAILED (6): row actions Del-button anchor not found.'); process.exit(1);
} else {
  content = content.replace(ROW_OLD, ROW_NEW);
}

// 7. Frontend helpers — setRotationEligible + bulkSetRotationEligible --------
// Insert after hideSimActionModal() to be near other action helpers.
const FN_ANCHOR =
  '        function hideSimActionModal() {\n' +
  '            document.getElementById(\'sim-action-modal\').classList.add(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-output\').classList.remove(\'hidden\');\n' +
  '        }';
if (content.includes('function setRotationEligible(')) {
  console.warn('Step 7 skipped — frontend helpers already defined.');
} else if (!content.includes(FN_ANCHOR)) {
  console.error('PATCH FAILED (7): hideSimActionModal anchor not found.'); process.exit(1);
} else {
  const NL = '\\' + '\\' + 'n'; // survives the outer template as literal \n in browser
  const fn = FN_ANCHOR + '\n\n' +
    '        async function setRotationEligible(simId, eligible) {\n' +
    '            try {\n' +
    '                const res = await fetch(API_BASE + \'/set-rotation-eligible\', {\n' +
    '                    method: \'POST\',\n' +
    '                    headers: { \'Content-Type\': \'application/json\' },\n' +
    '                    body: JSON.stringify({ sim_ids: [simId], eligible: eligible })\n' +
    '                });\n' +
    '                const data = await res.json();\n' +
    '                if (!res.ok || !data.ok) {\n' +
    '                    showToast(\'Failed: \' + (data.error || res.status), \'error\');\n' +
    '                    return;\n' +
    '                }\n' +
    '                showToast(\'SIM #\' + simId + \' auto-rotate \' + (eligible ? \'ON\' : \'OFF\'), \'success\');\n' +
    '                loadSims(true);\n' +
    '            } catch (e) {\n' +
    '                showToast(\'Error: \' + (e && e.message ? e.message : e), \'error\');\n' +
    '            }\n' +
    '        }\n' +
    '\n' +
    '        async function bulkSetRotationEligible(eligible) {\n' +
    '            const simIds = [...document.querySelectorAll(\'.sim-cb:checked\')].map(cb => parseInt(cb.value));\n' +
    '            if (simIds.length === 0) { showToast(\'Select at least one SIM\', \'error\'); return; }\n' +
    '            const verb = eligible ? \'Resume\' : \'Pause\';\n' +
    '            if (!(await showConfirm(verb + \' Auto-Rotate\', verb + \' auto-rotation for \' + simIds.length + \' SIM(s)?\'))) return;\n' +
    '\n' +
    '            const output = document.getElementById(\'sim-action-output\');\n' +
    '            document.getElementById(\'sim-action-title\').textContent = verb + \' Auto-Rotate — \' + simIds.length + \' SIMs\';\n' +
    '            output.textContent = \'Working...\';\n' +
    '            output.classList.remove(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
    '\n' +
    '            try {\n' +
    '                const res = await fetch(API_BASE + \'/set-rotation-eligible\', {\n' +
    '                    method: \'POST\',\n' +
    '                    headers: { \'Content-Type\': \'application/json\' },\n' +
    '                    body: JSON.stringify({ sim_ids: simIds, eligible: eligible })\n' +
    '                });\n' +
    '                const data = await res.json();\n' +
    '                if (!res.ok || !data.ok) {\n' +
    '                    output.textContent = \'Failed: \' + (data.error || (\'HTTP \' + res.status));\n' +
    '                    return;\n' +
    '                }\n' +
    '                const lines = simIds.map(function(id) { return \'SIM #\' + id + \': auto-rotate \' + (eligible ? \'ON\' : \'OFF\'); });\n' +
    '                output.textContent = \'Updated \' + data.updated + \' of \' + simIds.length + \' SIM(s).\' + \'' + NL + NL + '\' + lines.join(\'' + NL + '\');\n' +
    '                loadSims(true);\n' +
    '            } catch (e) {\n' +
    '                output.textContent = \'Error: \' + (e && e.message ? e.message : e);\n' +
    '            }\n' +
    '        }';

  content = content.replace(FN_ANCHOR, fn);
}

// Write back with CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: rotation_eligible UI + backend route.');
