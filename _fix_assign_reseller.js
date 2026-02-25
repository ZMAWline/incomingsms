const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. Add route ----
const ROUTE_OLD =
  "    if (url.pathname === '/api/unassign-reseller' && request.method === 'POST') {\n" +
  "      return handleUnassignReseller(request, env, corsHeaders);\n" +
  "    }";
const ROUTE_NEW = ROUTE_OLD +
  "\n\n    if (url.pathname === '/api/assign-reseller' && request.method === 'POST') {\n" +
  "      return handleAssignReseller(request, env, corsHeaders);\n" +
  "    }";
if (!content.includes(ROUTE_OLD)) throw new Error('ROUTE_OLD not found');
content = content.replace(ROUTE_OLD, ROUTE_NEW);
console.log('Route added');

// ---- 2. Add handler before the unassign handler ----
const HANDLER_MARKER = '// Unassign SIMs from reseller\n';
if (!content.includes(HANDLER_MARKER)) throw new Error('HANDLER_MARKER not found');

const SUPABASE_FILTER_URL = '`' + '${env.SUPABASE_URL}/rest/v1/reseller_sims?sim_id=eq.${sim_id}&active=eq.true' + '`';
const SUPABASE_INSERT_URL = '`' + '${env.SUPABASE_URL}/rest/v1/reseller_sims' + '`';
const BEARER = '`' + 'Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}' + '`';

const ASSIGN_HANDLER =
  '// Assign SIM to reseller\n' +
  'async function handleAssignReseller(request, env, corsHeaders) {\n' +
  '  try {\n' +
  '    const body = await request.json();\n' +
  '    const { sim_id, reseller_id } = body;\n' +
  "    if (!sim_id || !reseller_id) {\n" +
  "      return new Response(JSON.stringify({ error: 'sim_id and reseller_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  "    }\n" +
  "    // Deactivate any existing active assignment\n" +
  '    await fetch(' + SUPABASE_FILTER_URL + ', {\n' +
  "      method: 'PATCH',\n" +
  '      headers: {\n' +
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  '        Authorization: ' + BEARER + ',\n' +
  "        'Content-Type': 'application/json',\n" +
  "        Prefer: 'return=minimal',\n" +
  '      },\n' +
  "      body: JSON.stringify({ active: false }),\n" +
  '    });\n' +
  "    // Insert new assignment\n" +
  '    const res = await fetch(' + SUPABASE_INSERT_URL + ', {\n' +
  "      method: 'POST',\n" +
  '      headers: {\n' +
  "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
  '        Authorization: ' + BEARER + ',\n' +
  "        'Content-Type': 'application/json',\n" +
  "        Prefer: 'return=minimal',\n" +
  '      },\n' +
  '      body: JSON.stringify({ sim_id, reseller_id, active: true }),\n' +
  '    });\n' +
  '    if (!res.ok) {\n' +
  '      const err = await res.text();\n' +
  "      return new Response(JSON.stringify({ error: err }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  '    }\n' +
  "    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  '  } catch (error) {\n' +
  "    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
  '  }\n' +
  '}\n\n';

content = content.replace(HANDLER_MARKER, ASSIGN_HANDLER + HANDLER_MARKER);
console.log('Handler added');

// ---- 3. Change button ternary in SIM row ----
const BTN_OLD =
  "\\${sim.reseller_id ? \\`<button onclick=\"unassignReseller(\\${sim.id})\" " +
  "class=\"px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition\" " +
  "title=\"Unassign from reseller\">Unassign</button>\\` : ''}";
const BTN_NEW =
  "\\${sim.reseller_id ? \\`<button onclick=\"unassignReseller(\\${sim.id})\" " +
  "class=\"px-2 py-1 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition\" " +
  "title=\"Unassign from reseller\">Unassign</button>\\` : " +
  "\\`<button onclick=\"assignReseller(\\${sim.id})\" " +
  "class=\"px-2 py-1 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition\" " +
  "title=\"Assign to reseller\">Assign</button>\\`}";
if (!content.includes(BTN_OLD)) throw new Error('BTN_OLD not found: ' + JSON.stringify(BTN_OLD.substring(0, 80)));
content = content.replace(BTN_OLD, BTN_NEW);
console.log('Button updated');

// ---- 4. Add assignReseller function before bulkUnassignReseller ----
const FN_MARKER = '        async function bulkUnassignReseller() {';
if (!content.includes(FN_MARKER)) throw new Error('FN_MARKER not found');

const ASSIGN_FN =
  '        async function assignReseller(simId) {\n' +
  "            const sel = document.getElementById('filter-reseller');\n" +
  '            const opts = [...sel.options].filter(o => o.value);\n' +
  '            if (opts.length === 0) {\n' +
  "                showToast('No resellers available', 'error');\n" +
  '                return;\n' +
  '            }\n' +
  "            const existing = document.getElementById('assign-reseller-modal');\n" +
  '            if (existing) existing.remove();\n' +
  '\n' +
  "            const modal = document.createElement('div');\n" +
  "            modal.id = 'assign-reseller-modal';\n" +
  "            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';\n" +
  "            const box = document.createElement('div');\n" +
  "            box.className = 'bg-gray-800 rounded-xl shadow-xl w-80 p-6';\n" +
  "            const titleEl = document.createElement('h3');\n" +
  "            titleEl.className = 'text-lg font-semibold text-white mb-4';\n" +
  "            titleEl.textContent = 'Assign to Reseller';\n" +
  "            const select = document.createElement('select');\n" +
  "            select.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-300 mb-4';\n" +
  '            opts.forEach(function(o) {\n' +
  "                const opt = document.createElement('option');\n" +
  '                opt.value = o.value;\n' +
  '                opt.textContent = o.text;\n' +
  '                select.appendChild(opt);\n' +
  '            });\n' +
  "            const btnRow = document.createElement('div');\n" +
  "            btnRow.className = 'flex gap-2 justify-end mt-4';\n" +
  "            const cancelBtn = document.createElement('button');\n" +
  "            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';\n" +
  "            cancelBtn.textContent = 'Cancel';\n" +
  '            cancelBtn.onclick = function() { modal.remove(); };\n' +
  "            const assignBtn = document.createElement('button');\n" +
  "            assignBtn.className = 'px-3 py-1.5 text-sm bg-green-700 hover:bg-green-800 text-white rounded transition';\n" +
  "            assignBtn.textContent = 'Assign';\n" +
  '            assignBtn.onclick = async function() {\n' +
  '                const resellerId = parseInt(select.value);\n' +
  '                modal.remove();\n' +
  '                try {\n' +
  "                    const resp = await fetch(API_BASE + '/assign-reseller', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  '                        body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })\n' +
  '                    });\n' +
  '                    const result = await resp.json();\n' +
  '                    if (result.ok) {\n' +
  "                        showToast('SIM assigned to reseller', 'success');\n" +
  '                        loadSims(true);\n' +
  '                    } else {\n' +
  "                        showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');\n" +
  '                    }\n' +
  '                } catch (err) {\n' +
  "                    showToast('Error assigning: ' + err, 'error');\n" +
  '                }\n' +
  '            };\n' +
  '            btnRow.appendChild(cancelBtn);\n' +
  '            btnRow.appendChild(assignBtn);\n' +
  '            box.appendChild(titleEl);\n' +
  '            box.appendChild(select);\n' +
  '            box.appendChild(btnRow);\n' +
  '            modal.appendChild(box);\n' +
  '            document.body.appendChild(modal);\n' +
  '        }\n\n';

content = content.replace(FN_MARKER, ASSIGN_FN + FN_MARKER);
console.log('assignReseller function added');

// ---- Write back with CRLF ----
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
