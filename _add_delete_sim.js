'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const BT = '\\`';
const DS = '\\${';

// ── Change 1: Add backend route ──────────────────────────────────────────────
const routeAnchor = '    // Serve HTML dashboard for all non-API paths (SPA routing)';
if (!content.includes(routeAnchor)) throw new Error('Route anchor not found');

const newRoute =
  '    if (url.pathname === \'/api/delete-sim\' && request.method === \'POST\') {\n' +
  '      return handleDeleteSim(request, env, corsHeaders);\n' +
  '    }\n\n' +
  routeAnchor;

content = content.replace(routeAnchor, newRoute);
console.log('✓ Route added');

// ── Change 2: Add backend handleDeleteSim function ───────────────────────────
const handlerAnchor = '// Helper: insert a row into system_errors';
if (!content.includes(handlerAnchor)) throw new Error('Handler anchor not found');

const handlerFn =
  'async function handleDeleteSim(request, env, corsHeaders) {\n' +
  '  try {\n' +
  '    const body = await request.json();\n' +
  '    const simId = parseInt(body.sim_id);\n' +
  '    if (!simId) {\n' +
  '      return new Response(JSON.stringify({ error: \'sim_id required\' }), { status: 400, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '    }\n' +
  '    const base = env.SUPABASE_URL + \'/rest/v1\';\n' +
  '    const h = {\n' +
  '      apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '      Authorization: \'Bearer \' + env.SUPABASE_SERVICE_ROLE_KEY,\n' +
  '      \'Content-Type\': \'application/json\',\n' +
  '    };\n' +
  '    // Nullify sim_id in system_errors (nullable FK — preserve the error log)\n' +
  '    await fetch(base + \'/system_errors?sim_id=eq.\' + simId, {\n' +
  '      method: \'PATCH\',\n' +
  '      headers: { ...h, Prefer: \'return=minimal\' },\n' +
  '      body: JSON.stringify({ sim_id: null }),\n' +
  '    });\n' +
  '    // Delete all child records in dependency order\n' +
  '    for (const table of [\'sim_numbers\', \'inbound_sms\', \'reseller_sims\', \'sim_status_history\']) {\n' +
  '      await fetch(base + \'/\' + table + \'?sim_id=eq.\' + simId, { method: \'DELETE\', headers: h });\n' +
  '    }\n' +
  '    // Delete the SIM itself\n' +
  '    const del = await fetch(base + \'/sims?id=eq.\' + simId, { method: \'DELETE\', headers: h });\n' +
  '    if (!del.ok) {\n' +
  '      const errText = await del.text();\n' +
  '      return new Response(JSON.stringify({ error: \'Failed to delete SIM: \' + errText }), { status: 500, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '    }\n' +
  '    return new Response(JSON.stringify({ ok: true, deleted: simId }), {\n' +
  '      headers: { ...corsHeaders, \'Content-Type\': \'application/json\' }\n' +
  '    });\n' +
  '  } catch (error) {\n' +
  '    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: { ...corsHeaders, \'Content-Type\': \'application/json\' } });\n' +
  '  }\n' +
  '}\n\n';

content = content.replace(handlerAnchor, handlerFn + handlerAnchor);
console.log('✓ Backend handler added');

// ── Change 3: Add frontend deleteSim function ────────────────────────────────
const frontendFnAnchor = '        async function assignReseller(simId) {';
if (!content.includes(frontendFnAnchor)) throw new Error('Frontend function anchor not found');

const deleteSimFn =
  '        async function deleteSim(simId, iccid) {\n' +
  '            if (!(await showConfirm(\'Delete SIM\', \'Permanently delete SIM #\' + simId + \' (ICCID: \' + iccid + \')? This deletes all SMS history and cannot be undone.\'))) return;\n' +
  '            try {\n' +
  '                const resp = await fetch(API_BASE + \'/delete-sim\', {\n' +
  '                    method: \'POST\',\n' +
  '                    headers: { \'Content-Type\': \'application/json\' },\n' +
  '                    body: JSON.stringify({ sim_id: simId })\n' +
  '                });\n' +
  '                const result = await resp.json();\n' +
  '                if (result.ok) {\n' +
  '                    showToast(\'SIM #\' + simId + \' deleted\', \'success\');\n' +
  '                    loadSims(true);\n' +
  '                } else {\n' +
  '                    showToast(\'Failed: \' + (result.error || JSON.stringify(result)), \'error\');\n' +
  '                }\n' +
  '            } catch (err) {\n' +
  '                showToast(\'Error deleting SIM: \' + err, \'error\');\n' +
  '            }\n' +
  '        }\n\n' +
  frontendFnAnchor;

content = content.replace(frontendFnAnchor, deleteSimFn);
console.log('✓ Frontend deleteSim function added');

// ── Change 4: Add Delete button in SIM row ───────────────────────────────────
// Find the Status button (already wrapped in \${...})
const statusBtn =
  '                        ' + DS + BT +
  '<button onclick="showSetStatusModal(' + DS + 'sim.id}, \'' + DS + 'sim.status}\')" ' +
  'class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' +
  BT + '}';

if (!content.includes(statusBtn)) throw new Error('Status button anchor not found — check escaping');

const deleteBtn =
  '\n                        ' + DS + BT +
  '<button onclick="deleteSim(' + DS + 'sim.id}, \'' + DS + 'sim.iccid}\')" ' +
  'class="px-2 py-1 text-xs bg-red-700 hover:bg-red-600 text-white rounded transition ml-1" ' +
  'title="Delete this SIM permanently">Del</button>' +
  BT + '}';

content = content.replace(statusBtn, statusBtn + deleteBtn);
console.log('✓ Delete button added to SIM row');

// ── Write back with CRLF ─────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done. Run: node --input-type=module --check < src/dashboard/index.js');
