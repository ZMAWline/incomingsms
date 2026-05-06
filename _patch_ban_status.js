'use strict';
const fs = require('fs');
const path = require('path');

function patchFile(relPath, patchFn) {
  const filePath = path.join(__dirname, relPath);
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/\r\n/g, '\n');
  content = patchFn(content);
  content = content.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Patched:', relPath);
}

// ── 1. subscriber-sync.js: store att_ban when syncing Helix details ──────────
patchFile('src/shared/subscriber-sync.js', content => {
  const anchor = '  // 5. IMEI check — log only, do not auto-fix';
  const insert =
    '  // 4b. att_ban — store/update from Helix if present\n' +
    '  const helixBan = d?.attBan || d?.ban || null;\n' +
    '  if (helixBan) {\n' +
    '    await _patch(env, `sims?id=eq.${encodeURIComponent(String(simRow.id))}`, { att_ban: helixBan });\n' +
    '    console.log(`[SyncDetails] sim_id=${simRow.id}: stored att_ban=${helixBan}`);\n' +
    '  }\n\n';
  const idx = content.indexOf(anchor);
  if (idx === -1) throw new Error('subscriber-sync: att_ban anchor not found');
  return content.slice(0, idx) + insert + content.slice(idx);
});

// ── 2. mdn-rotator: update sim fetch to include att_ban + sim_numbers ────────
patchFile('src/mdn-rotator/index.js', content => {
  // 2a. Sim fetch query
  const oldFetch = '`sims?select=id,iccid,mobility_subscription_id,gateway_id,port,status,imei,activated_at&id=eq.${encodeURIComponent(String(sim_id))}&limit=1`';
  const newFetch = '`sims?select=id,iccid,mobility_subscription_id,gateway_id,port,status,imei,activated_at,att_ban,sim_numbers(e164)&id=eq.${encodeURIComponent(String(sim_id))}&limit=1&sim_numbers.valid_to=is.null`';
  if (!content.includes(oldFetch)) throw new Error('mdn-rotator: sim fetch not found');
  content = content.replace(oldFetch, newFetch);

  // 2b. Replace subscriber_details block for ota_refresh/cancel/resume
  const oldBlock =
    '        // For ota_refresh, cancel, resume — need Helix token + subscriber details\n' +
    '        if (!subId) {\n' +
    '          return new Response(JSON.stringify({ ok: false, error: `SIM ${iccid} has no mobility_subscription_id` }), {\n' +
    '            status: 400,\n' +
    '            headers: { "Content-Type": "application/json" }\n' +
    '          });\n' +
    '        }\n' +
    '\n' +
    '        const token = await getCachedToken(env);\n' +
    '        const runId = `simaction_${iccid}_${Date.now()}`;\n' +
    '\n' +
    '        // Get subscriber details for mdn + attBan\n' +
    '        const details = await hxSubscriberDetails(env, token, subId, runId, iccid);\n' +
    '        const d = Array.isArray(details) ? details[0] : null;\n' +
    '        const subscriberNumber = d?.phoneNumber;\n' +
    '        const attBan = d?.attBan || d?.ban || null;\n' +
    '\n' +
    '        // Sync DB with Helix details (activated_at backfill, ICCID/IMEI mismatch logging)\n' +
    '        syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));\n' +
    '\n' +
    '        if (!subscriberNumber) {\n' +
    '          return new Response(JSON.stringify({ ok: false, error: `No phoneNumber from Helix for SIM ${iccid}` }), {\n' +
    '            status: 500,\n' +
    '            headers: { "Content-Type": "application/json" }\n' +
    '          });\n' +
    '        }\n' +
    '\n' +
    '        const mdn = String(subscriberNumber).replace(/\\D/g, "").replace(/^1/, "");';

  const newBlock =
    '        // For ota_refresh, cancel, resume — need Helix token + mdn/ban\n' +
    '        if (!subId) {\n' +
    '          return new Response(JSON.stringify({ ok: false, error: `SIM ${iccid} has no mobility_subscription_id` }), {\n' +
    '            status: 400,\n' +
    '            headers: { "Content-Type": "application/json" }\n' +
    '          });\n' +
    '        }\n' +
    '\n' +
    '        const token = await getCachedToken(env);\n' +
    '        const runId = `simaction_${iccid}_${Date.now()}`;\n' +
    '\n' +
    '        // Use cached BAN + MDN from DB if available; fall back to subscriber_details\n' +
    '        const dbMdn = sim.sim_numbers?.[0]?.e164;\n' +
    '        let mdn, attBan, d = null;\n' +
    '        if (dbMdn && (action !== "ota_refresh" || sim.att_ban)) {\n' +
    '          mdn = String(dbMdn).replace(/\\D/g, "").replace(/^1/, "");\n' +
    '          attBan = sim.att_ban || null;\n' +
    '          console.log(`[SimAction] SIM ${iccid}: using cached BAN=${attBan} MDN=${mdn}`);\n' +
    '        } else {\n' +
    '          // Fall back to subscriber_details\n' +
    '          const details = await hxSubscriberDetails(env, token, subId, runId, iccid);\n' +
    '          d = Array.isArray(details) ? details[0] : null;\n' +
    '          const rawPhone = d?.phoneNumber;\n' +
    '          attBan = d?.attBan || d?.ban || null;\n' +
    '          // Sync DB with Helix details (stores att_ban, activated_at backfill, etc.)\n' +
    '          syncSimFromHelixDetails(env, sim, d).catch(e => console.warn(`[SyncDetails] sim_id=${sim.id}: ${e}`));\n' +
    '          if (!rawPhone) {\n' +
    '            return new Response(JSON.stringify({ ok: false, error: `No phoneNumber from Helix for SIM ${iccid}` }), {\n' +
    '              status: 500,\n' +
    '              headers: { "Content-Type": "application/json" }\n' +
    '            });\n' +
    '          }\n' +
    '          mdn = String(rawPhone).replace(/\\D/g, "").replace(/^1/, "");\n' +
    '        }';

  if (!content.includes(oldBlock)) throw new Error('mdn-rotator: subscriber_details block not found');
  content = content.replace(oldBlock, newBlock);

  return content;
});

// ── 3. dashboard: backend route + handler + frontend modal + button + JS ─────
patchFile('src/dashboard/index.js', content => {
  const BT = '\\`';   // represents \` in the file (escaped backtick inside outer template)
  const DS = '\\${';  // represents \${ in the file (escaped template expression)

  // 3a. Add route
  const routeAnchor = "if (url.pathname === '/api/reset-to-provisioning' && request.method === 'POST') {\n      return handleResetToProvisioning(request, env, corsHeaders);\n    }";
  const routeInsert = "if (url.pathname === '/api/set-sim-status' && request.method === 'POST') {\n      return handleSetSimStatus(request, env, corsHeaders);\n    }\n\n    ";
  const idx3a = content.indexOf(routeAnchor);
  if (idx3a === -1) throw new Error('dashboard: route anchor not found');
  content = content.slice(0, idx3a) + routeInsert + content.slice(idx3a);

  // 3b. Add handleSetSimStatus function before handleResetToProvisioning
  const fnAnchor = 'async function handleResetToProvisioning(request, env, corsHeaders) {';
  const fnInsert =
    'async function handleSetSimStatus(request, env, corsHeaders) {\n' +
    "  const body = await request.json();\n" +
    "  const { sim_id, status } = body;\n" +
    "  const validStatuses = ['provisioning', 'active', 'suspended', 'canceled', 'error', 'pending', 'helix_timeout', 'data_mismatch'];\n" +
    "  if (!sim_id || !status) {\n" +
    "    return new Response(JSON.stringify({ error: 'sim_id and status required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
    "  }\n" +
    "  if (!validStatuses.includes(status)) {\n" +
    "    return new Response(JSON.stringify({ error: 'Invalid status. Valid: ' + validStatuses.join(', ') }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
    "  }\n" +
    "  const res = await fetch(\n" +
    "    env.SUPABASE_URL + '/rest/v1/sims?id=eq.' + encodeURIComponent(String(sim_id)),\n" +
    "    {\n" +
    "      method: 'PATCH',\n" +
    "      headers: {\n" +
    "        apikey: env.SUPABASE_SERVICE_ROLE_KEY,\n" +
    "        Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,\n" +
    "        'Content-Type': 'application/json',\n" +
    "        Prefer: 'return=minimal',\n" +
    "      },\n" +
    "      body: JSON.stringify({ status }),\n" +
    "    }\n" +
    "  );\n" +
    "  if (!res.ok) {\n" +
    "    const text = await res.text();\n" +
    "    return new Response(JSON.stringify({ error: 'DB error: ' + text }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
    "  }\n" +
    "  return new Response(JSON.stringify({ ok: true, sim_id, status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });\n" +
    "}\n\n";
  const idx3b = content.indexOf(fnAnchor);
  if (idx3b === -1) throw new Error('dashboard: fn anchor not found');
  content = content.slice(0, idx3b) + fnInsert + content.slice(idx3b);

  // 3c. Add Status button after IMEI button in SIM row actions
  const imeiBtnEnd = 'title="Change IMEI">IMEI</button>' + BT + " : ''}" + '\n                    </td>';
  const statusBtn =
    '                        ' + BT +
    '<button onclick="showSetStatusModal(' + DS + 'sim.id}, \'' + DS + "sim.status}')" +
    '" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' + BT;
  const imeiBtnEndNew = 'title="Change IMEI">IMEI</button>' + BT + " : ''}" + '\n' + statusBtn + '\n                    </td>';
  const idx3c = content.indexOf(imeiBtnEnd);
  if (idx3c === -1) throw new Error('dashboard: IMEI button end anchor not found');
  content = content.slice(0, idx3c) + imeiBtnEndNew + content.slice(idx3c + imeiBtnEnd.length);

  // 3d. Add Set Status modal before the SIM Action Modal comment
  const modalAnchor = '<!-- SIM Action Modal -->';
  const newModal =
    '<!-- Set Status Modal -->\n' +
    '    <div id="set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n' +
    '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">\n' +
    '            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">\n' +
    '                <h3 id="set-status-title" class="text-lg font-semibold text-white">Set Status</h3>\n' +
    "                <button onclick=\"document.getElementById('set-status-modal').classList.add('hidden')\" class=\"text-gray-400 hover:text-white text-xl leading-none\">&times;</button>\n" +
    '            </div>\n' +
    '            <div class="p-5">\n' +
    '                <select id="set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">\n' +
    '                    <option value="provisioning">provisioning</option>\n' +
    '                    <option value="active">active</option>\n' +
    '                    <option value="suspended">suspended</option>\n' +
    '                    <option value="canceled">canceled</option>\n' +
    '                    <option value="error">error</option>\n' +
    '                    <option value="pending">pending</option>\n' +
    '                    <option value="helix_timeout">helix_timeout</option>\n' +
    '                    <option value="data_mismatch">data_mismatch</option>\n' +
    '                </select>\n' +
    '                <div class="flex gap-2 justify-end">\n' +
    "                    <button onclick=\"document.getElementById('set-status-modal').classList.add('hidden')\" class=\"px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg transition\">Cancel</button>\n" +
    '                    <button onclick="runSetStatus()" class="px-4 py-2 text-sm bg-accent hover:bg-accent/80 text-white rounded-lg transition">Apply</button>\n' +
    '                </div>\n' +
    '            </div>\n' +
    '        </div>\n' +
    '    </div>\n\n' +
    '    ';
  const idx3d = content.indexOf(modalAnchor);
  if (idx3d === -1) throw new Error('dashboard: modal anchor not found');
  content = content.slice(0, idx3d) + newModal + content.slice(idx3d);

  // 3e. Add JS functions before simAction
  const jsAnchor = 'async function simAction(simId, action, skipConfirm = false) {';
  const newFns =
    'let _setStatusSimId = null;\n' +
    '        function showSetStatusModal(simId, currentStatus) {\n' +
    "            _setStatusSimId = simId;\n" +
    "            document.getElementById('set-status-title').textContent = 'Set Status - SIM #' + simId;\n" +
    "            document.getElementById('set-status-select').value = currentStatus;\n" +
    "            document.getElementById('set-status-modal').classList.remove('hidden');\n" +
    '        }\n\n' +
    '        async function runSetStatus() {\n' +
    "            const status = document.getElementById('set-status-select').value;\n" +
    "            document.getElementById('set-status-modal').classList.add('hidden');\n" +
    '            try {\n' +
    "                const res = await fetch(API_BASE + '/set-sim-status', {\n" +
    "                    method: 'POST',\n" +
    "                    headers: { 'Content-Type': 'application/json' },\n" +
    '                    body: JSON.stringify({ sim_id: _setStatusSimId, status })\n' +
    '                });\n' +
    '                const result = await res.json();\n' +
    '                if (result.ok) {\n' +
    "                    showToast('SIM #' + _setStatusSimId + ' status set to ' + status, 'success');\n" +
    '                    loadSims(true);\n' +
    '                } else {\n' +
    "                    showToast('Error: ' + (result.error || 'Failed'), 'error');\n" +
    '                }\n' +
    '            } catch (e) {\n' +
    "                showToast('Error setting status', 'error');\n" +
    '                console.error(e);\n' +
    '            }\n' +
    '        }\n\n        ';
  const idx3e = content.indexOf(jsAnchor);
  if (idx3e === -1) throw new Error('dashboard: simAction anchor not found');
  content = content.slice(0, idx3e) + newFns + content.slice(idx3e);

  return content;
});

console.log('All patches applied successfully.');
