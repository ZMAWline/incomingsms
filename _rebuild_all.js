#!/usr/bin/env node
// Comprehensive dashboard rebuild: errors page, sim actions, IMEI sync/block, pagination
// Uses line-based manipulation to avoid CRLF and backtick escaping issues

const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8');
// Normalize to LF for processing
content = content.replace(/\r\n/g, '\n');
let lines = content.split('\n');

let changeCount = 0;
function replaceLine(lineNum, newContent) {
  // lineNum is 1-based
  lines[lineNum - 1] = newContent;
  changeCount++;
}
function insertAfterLine(lineNum, newLines) {
  // Insert array of lines after lineNum (1-based)
  lines.splice(lineNum, 0, ...newLines);
  changeCount++;
  return newLines.length; // return offset
}
function insertBeforeLine(lineNum, newLines) {
  lines.splice(lineNum - 1, 0, ...newLines);
  changeCount++;
  return newLines.length;
}
function findLine(needle, startFrom = 0) {
  for (let i = startFrom; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1; // return 1-based
  }
  return -1;
}
function deleteLines(from, to) {
  // 1-based inclusive
  lines.splice(from - 1, to - from + 1);
  changeCount++;
}

// Track cumulative offset from insertions
let offset = 0;

// ============================================================
// 1. Add new API routes (after /api/import-gateway-imeis route)
// ============================================================
let routeInsertLine = findLine("url.pathname === '/api/import-gateway-imeis'");
if (routeInsertLine === -1) throw new Error('Cannot find import-gateway-imeis route');
// Find the closing } of this if block (next line with just "}")
let routeBlockEnd = routeInsertLine;
while (routeBlockEnd < lines.length && !lines[routeBlockEnd - 1].match(/^\s{4}\}$/)) routeBlockEnd++;
offset += insertAfterLine(routeBlockEnd, [
  '',
  "    if (url.pathname === '/api/errors') {",
  '      return handleErrors(env, corsHeaders, url);',
  '    }',
  '',
  "    if (url.pathname === '/api/error-logs') {",
  '      return handleErrorLogs(env, corsHeaders, url);',
  '    }',
  '',
  "    if (url.pathname === '/api/sim-action' && request.method === 'POST') {",
  '      return handleSimAction(request, env, corsHeaders);',
  '    }',
]);
console.log(`[1] Added 3 new API routes after line ${routeBlockEnd}`);

// ============================================================
// 2. Modify handleSims query to include last_mdn_rotated_at, last_activation_error
// ============================================================
let simsQueryLine = findLine("sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id");
if (simsQueryLine === -1) throw new Error('Cannot find sims query');
lines[simsQueryLine - 1] = lines[simsQueryLine - 1].replace(
  'sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=100',
  'sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_mdn_rotated_at,last_activation_error,gateways(code,name),sim_numbers(e164,verification_status),reseller_sims(reseller_id,resellers(name))&sim_numbers.valid_to=is.null&reseller_sims.active=eq.true&order=id.desc&limit=500'
);
changeCount++;
console.log(`[2] Modified handleSims query to include last_mdn_rotated_at, last_activation_error`);

// Also add these fields to the formatted output (find the return object in the map)
let simFormatLine = findLine("gateway_name: sim.gateways?.name || null");
if (simFormatLine === -1) throw new Error('Cannot find gateway_name in sims formatter');
// Fix: add comma to gateway_name line since we're inserting after it
lines[simFormatLine - 1] = lines[simFormatLine - 1].replace(
  "gateway_name: sim.gateways?.name || null",
  "gateway_name: sim.gateways?.name || null,"
);
offset += insertAfterLine(simFormatLine, [
  '        last_mdn_rotated_at: sim.last_mdn_rotated_at || null,',
  '        last_activation_error: sim.last_activation_error || null,',
]);
console.log(`[2b] Added last_mdn_rotated_at and last_activation_error to sims formatter`);

// ============================================================
// 3. Modify handleImeiPoolGet: add gateway_id, port, blocked stat, limit=5000
// ============================================================
let imeiPoolQueryLine = findLine("imei_pool?select=id,imei,status,sim_id,assigned_at,previous_sim_id,notes,created_at,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc");
if (imeiPoolQueryLine === -1) throw new Error('Cannot find imei_pool query');
lines[imeiPoolQueryLine - 1] = lines[imeiPoolQueryLine - 1].replace(
  "imei_pool?select=id,imei,status,sim_id,assigned_at,previous_sim_id,notes,created_at,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc",
  "imei_pool?select=id,imei,status,sim_id,assigned_at,previous_sim_id,notes,created_at,gateway_id,port,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc&limit=5000"
);
changeCount++;
console.log(`[3] Modified handleImeiPoolGet query`);

// Add blocked stat
let retiredStatLine = findLine("retired: pool.filter(e => e.status === 'retired').length,");
if (retiredStatLine === -1) throw new Error('Cannot find retired stat line');
offset += insertAfterLine(retiredStatLine, [
  "      blocked: pool.filter(e => e.status === 'blocked').length,",
]);
console.log(`[3b] Added blocked stat`);

// ============================================================
// 4. Modify handleImeiPoolPost: add block/unblock actions
// ============================================================
let unknownActionLine = findLine('Unknown action. Use "add" or "retire"');
if (unknownActionLine === -1) throw new Error('Cannot find unknown action line');
// Insert block and unblock handlers before the unknown action response
offset += insertBeforeLine(unknownActionLine, [
  "    if (action === 'block') {",
  '      const id = body.id;',
  "      if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '      const patchRes = await fetch(',
  "        `${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${id}&status=in.(available,in_use)`,",
  '        {',
  "          method: 'PATCH',",
  '          headers: {',
  '            apikey: env.SUPABASE_SERVICE_ROLE_KEY,',
  '            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,',
  "            'Content-Type': 'application/json',",
  "            Prefer: 'return=representation',",
  '          },',
  "          body: JSON.stringify({ status: 'blocked' }),",
  '        }',
  '      );',
  '      const patched = await patchRes.json().catch(() => []);',
  "      if (!patched.length) return new Response(JSON.stringify({ error: 'IMEI not found or not blockable' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "      return new Response(JSON.stringify({ ok: true, blocked: patched[0] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '    }',
  '',
  "    if (action === 'unblock') {",
  '      const id = body.id;',
  "      if (!id) return new Response(JSON.stringify({ error: 'id is required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '      const patchRes = await fetch(',
  "        `${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.${id}&status=eq.blocked`,",
  '        {',
  "          method: 'PATCH',",
  '          headers: {',
  '            apikey: env.SUPABASE_SERVICE_ROLE_KEY,',
  '            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,',
  "            'Content-Type': 'application/json',",
  "            Prefer: 'return=representation',",
  '          },',
  "          body: JSON.stringify({ status: 'available' }),",
  '        }',
  '      );',
  '      const patched = await patchRes.json().catch(() => []);',
  "      if (!patched.length) return new Response(JSON.stringify({ error: 'IMEI not found or not blocked' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "      return new Response(JSON.stringify({ ok: true, unblocked: patched[0] }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '    }',
  '',
]);
// Update the error message too
let updatedUnknownLine = findLine('Unknown action. Use "add" or "retire"');
if (updatedUnknownLine !== -1) {
  lines[updatedUnknownLine - 1] = lines[updatedUnknownLine - 1].replace(
    'Unknown action. Use "add" or "retire"',
    'Unknown action. Use "add", "retire", "block", or "unblock"'
  );
}
console.log(`[4] Added block/unblock actions to handleImeiPoolPost`);

// ============================================================
// 5. Modify handleImportGatewayImeis: upsert with on_conflict, merge-duplicates, gateway_id/port tracking
// ============================================================
// Change the toInsert object to include gateway_id and port
let toInsertPushLine = findLine("notes: `Imported from gateway ${gatewayId} port ${p.port}");
if (toInsertPushLine === -1) throw new Error('Cannot find toInsert push');
// Replace the toInsert.push block: find opening { and closing }
let pushStartLine = toInsertPushLine;
while (pushStartLine > 0 && !lines[pushStartLine - 1].includes('toInsert.push(')) pushStartLine--;
let pushEndLine = toInsertPushLine;
while (pushEndLine < lines.length && !lines[pushEndLine - 1].trim().startsWith('});')) pushEndLine++;

// Replace those lines
let newPushLines = [
  '        toInsert.push({',
  '          imei,',
  "          status: 'in_use',",
  '          gateway_id: parseInt(gatewayId),',
  '          port: p.port || null,',
  "          notes: `Imported from gateway ${gatewayId} port ${p.port}${p.iccid ? ' iccid=' + p.iccid : ''}`,",
  '        });',
];
lines.splice(pushStartLine - 1, pushEndLine - pushStartLine + 1, ...newPushLines);
changeCount++;
console.log(`[5a] Modified toInsert to include gateway_id and port`);

// Change ignore-duplicates to merge-duplicates and add on_conflict
let importInsertLine = findLine("Prefer: 'resolution=ignore-duplicates,return=representation',", findLine("handleImportGatewayImeis") - 1);
if (importInsertLine === -1) throw new Error('Cannot find import Prefer header');
lines[importInsertLine - 1] = lines[importInsertLine - 1].replace(
  "Prefer: 'resolution=ignore-duplicates,return=representation',",
  "Prefer: 'resolution=merge-duplicates,return=representation',"
);
changeCount++;
console.log(`[5b] Changed ignore-duplicates to merge-duplicates in import handler`);

// Add on_conflict=imei to the import URL
let importUrlLine = findLine("${env.SUPABASE_URL}/rest/v1/imei_pool`", findLine("handleImportGatewayImeis") - 1);
if (importUrlLine === -1) throw new Error('Cannot find import URL');
lines[importUrlLine - 1] = lines[importUrlLine - 1].replace(
  "/rest/v1/imei_pool`",
  "/rest/v1/imei_pool?on_conflict=imei`"
);
changeCount++;
console.log(`[5c] Added on_conflict=imei to import URL`);

// Change "added" reporting to "updated" since merge-duplicates returns all
let addedVarLine = findLine("const added = Array.isArray(inserted) ? inserted.length : 0;");
if (addedVarLine === -1) throw new Error('Cannot find added var line');
lines[addedVarLine - 1] = '    const upserted = Array.isArray(inserted) ? inserted.length : 0;';
changeCount++;
let dupVarLine = findLine("const duplicates = toInsert.length - added;");
if (dupVarLine !== -1) {
  lines[dupVarLine - 1] = '    const updated = upserted;';
  changeCount++;
}

// Update the response JSON
let importRespLine = findLine("added, duplicates, backfilled_sims");
if (importRespLine !== -1) {
  lines[importRespLine - 1] = lines[importRespLine - 1]
    .replace('added, duplicates,', 'added: 0, updated: upserted,');
  changeCount++;
}
console.log(`[5d] Updated import response vars`);

// ============================================================
// 6. Add new handler functions (handleErrors, handleErrorLogs, handleSimAction) before getHTML
// ============================================================
let getHTMLLine = findLine("function getHTML() {");
if (getHTMLLine === -1) throw new Error('Cannot find getHTML function');
offset += insertBeforeLine(getHTMLLine, [
  'async function handleErrors(env, corsHeaders, url) {',
  '  try {',
  "    const query = `sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id,last_activation_error,last_mdn_rotated_at,gateways(code),sim_numbers(e164)&last_activation_error=not.is.null&sim_numbers.valid_to=is.null&order=id.desc&limit=500`;",
  '    const response = await supabaseGet(env, query);',
  '    const sims = await response.json();',
  '    return new Response(JSON.stringify(sims), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleErrorLogs(env, corsHeaders, url) {',
  '  try {',
  "    const simId = url.searchParams.get('sim_id');",
  "    if (!simId) return new Response(JSON.stringify({ error: 'sim_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '    const query = `helix_api_logs?select=id,action,request_body,response_body,status_code,created_at&sim_id=eq.${simId}&order=created_at.desc&limit=20`;',
  '    const response = await supabaseGet(env, query);',
  '    const logs = await response.json();',
  '    return new Response(JSON.stringify(logs), {',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
  'async function handleSimAction(request, env, corsHeaders) {',
  '  try {',
  '    const body = await request.json();',
  '    const { sim_id, action } = body;',
  "    if (!sim_id || !action) return new Response(JSON.stringify({ error: 'sim_id and action required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '',
  "    if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  "    if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });",
  '',
  '    const workerUrl = `https://mdn-rotator/sim-action?secret=${encodeURIComponent(env.ADMIN_RUN_SECRET)}`;',
  '    const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, {',
  "      method: 'POST',",
  "      headers: { 'Content-Type': 'application/json' },",
  '      body: JSON.stringify({ sim_id, action })',
  '    });',
  '',
  '    const responseText = await workerResponse.text();',
  '    let result;',
  '    try { result = JSON.parse(responseText); } catch {',
  '      result = { ok: false, error: `Non-JSON response: ${responseText.slice(0, 200)}` };',
  '    }',
  '',
  '    return new Response(JSON.stringify(result, null, 2), {',
  '      status: workerResponse.status,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  } catch (error) {',
  '    return new Response(JSON.stringify({ error: String(error) }), {',
  '      status: 500,',
  "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }",
  '    });',
  '  }',
  '}',
  '',
]);
console.log(`[6] Added handleErrors, handleErrorLogs, handleSimAction handlers`);

// ============================================================
// 7. HTML: Add Errors sidebar button (after IMEI Pool button)
// ============================================================
let imeiPoolBtnLine = findLine("title=\"IMEI Pool\">");
if (imeiPoolBtnLine === -1) throw new Error('Cannot find IMEI Pool sidebar button');
// Find the closing </button> for this button
let imeiPoolBtnEnd = imeiPoolBtnLine;
while (imeiPoolBtnEnd < lines.length && !lines[imeiPoolBtnEnd - 1].includes('</button>')) imeiPoolBtnEnd++;
offset += insertAfterLine(imeiPoolBtnEnd, [
  '                <button onclick="switchTab(\'errors\')" class="sidebar-btn w-10 h-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-dark-600 transition relative" title="Errors">',
  '                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>',
  '                    <span id="error-badge" class="hidden absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center">0</span>',
  '                </button>',
]);
console.log(`[7] Added Errors sidebar button`);

// ============================================================
// 8. HTML: Add Errors tab section (before </main>)
// ============================================================
let mainCloseLine = findLine('</main>');
if (mainCloseLine === -1) throw new Error('Cannot find </main>');
offset += insertBeforeLine(mainCloseLine, [
  '',
  '            <!-- Errors Tab -->',
  '            <div id="tab-errors" class="tab-content hidden">',
  '                <div class="flex items-center justify-between mb-6">',
  '                    <h2 class="text-xl font-bold text-white">Activation Errors</h2>',
  '                    <div class="flex items-center gap-3">',
  '                        <input id="errors-search" type="text" placeholder="Search..." oninput="renderErrors()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent w-40">',
  '                        <button onclick="loadErrors()" class="text-xs text-accent hover:text-green-400 transition">Refresh</button>',
  '                    </div>',
  '                </div>',
  '                <!-- Error Summary -->',
  '                <div id="error-summary" class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"></div>',
  '                <!-- Bulk Action Bar -->',
  '                <div id="error-action-bar" class="hidden mb-4 p-3 bg-dark-800 rounded-lg border border-dark-600 flex items-center gap-3">',
  '                    <span id="error-selected-count" class="text-sm text-gray-300">0 selected</span>',
  '                    <button onclick="bulkErrorAction(\'ota\')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition">OTA Refresh</button>',
  '                    <button onclick="bulkErrorAction(\'cancel\')" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Cancel</button>',
  '                    <button onclick="bulkErrorAction(\'resume\')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>',
  '                    <button onclick="bulkErrorAction(\'fix\')" class="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">Fix SIM</button>',
  '                </div>',
  '                <div class="bg-dark-800 rounded-xl border border-dark-600">',
  '                    <div class="overflow-x-auto">',
  '                        <table class="w-full">',
  '                            <thead>',
  '                                <tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">',
  '                                    <th class="px-4 py-3 font-medium"><input type="checkbox" onchange="toggleAllErrors(this)" class="accent-green-500"></th>',
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'errors\',\'id\')">ID <span class="sort-arrow" data-table="errors" data-col="id"></span></th>',
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'errors\',\'iccid\')">ICCID <span class="sort-arrow" data-table="errors" data-col="iccid"></span></th>',
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'errors\',\'status\')">Status <span class="sort-arrow" data-table="errors" data-col="status"></span></th>',
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'errors\',\'last_activation_error\')">Error <span class="sort-arrow" data-table="errors" data-col="last_activation_error"></span></th>',
  '                                    <th class="px-4 py-3 font-medium">Actions</th>',
  '                                </tr>',
  '                            </thead>',
  '                            <tbody id="errors-table" class="text-sm">',
  '                                <tr><td colspan="6" class="px-4 py-4 text-center text-gray-500">Loading...</td></tr>',
  '                            </tbody>',
  '                        </table>',
  '                    </div>',
  '                    <div id="errors-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>',
  '                </div>',
  '                <!-- Error Detail Drawer -->',
  '                <div id="error-detail" class="hidden mt-4 bg-dark-800 rounded-xl border border-dark-600 p-5">',
  '                    <div class="flex items-center justify-between mb-3">',
  '                        <h3 class="text-lg font-semibold text-white" id="error-detail-title">Error Details</h3>',
  '                        <button onclick="hideErrorDetail()" class="text-gray-400 hover:text-white">&times;</button>',
  '                    </div>',
  '                    <pre id="error-detail-content" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>',
  '                </div>',
  '            </div>',
  '',
]);
console.log(`[8] Added Errors tab HTML`);

// ============================================================
// 9. HTML: IMEI Pool tab modifications
// ============================================================
// Add "Sync from Gateways" button next to "+ Add IMEIs"
let addImeisBtnLine = findLine('onclick="showAddImeiModal()"');
if (addImeisBtnLine === -1) throw new Error('Cannot find Add IMEIs button');
offset += insertBeforeLine(addImeisBtnLine, [
  '                        <button onclick="syncAllGatewayImeis()" id="sync-gateways-btn" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Sync from Gateways</button>',
]);
console.log(`[9a] Added Sync from Gateways button`);

// Add "Blocked" filter option
let retiredFilterLine = findLine('<option value="retired">Retired</option>');
if (retiredFilterLine === -1) throw new Error('Cannot find retired filter option');
offset += insertAfterLine(retiredFilterLine, [
  '                            <option value="blocked">Blocked</option>',
]);
console.log(`[9b] Added blocked filter option`);

// Change stats row from 4-col to 5-col and add Blocked card
let statsRow4ColLine = findLine('grid-cols-2 md:grid-cols-4 gap-4 mb-6', findLine('IMEI Pool') - 1);
if (statsRow4ColLine !== -1) {
  lines[statsRow4ColLine - 1] = lines[statsRow4ColLine - 1].replace('grid-cols-2 md:grid-cols-4', 'grid-cols-2 md:grid-cols-5');
  changeCount++;
}
// Add Blocked card after Retired card
let retiredCardLine = findLine('id="imei-retired"');
if (retiredCardLine === -1) throw new Error('Cannot find imei-retired element');
// Find the closing </div></div> for this card
let retiredCardEnd = retiredCardLine;
for (let closings = 0; closings < 2 && retiredCardEnd < lines.length; retiredCardEnd++) {
  if (lines[retiredCardEnd - 1].trim() === '</div>') closings++;
}
retiredCardEnd--; // back to last </div>
offset += insertAfterLine(retiredCardEnd, [
  '                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">',
  '                        <span class="text-sm text-gray-400">Blocked</span>',
  '                        <p class="text-2xl font-bold text-red-400" id="imei-blocked">-</p>',
  '                    </div>',
]);
console.log(`[9c] Added Blocked stat card`);

// Add Gateway and Port columns to IMEI Pool table header
let imeiAssignedAtHeader = findLine("onclick=\"sortTable('imei','assigned_at')\"");
if (imeiAssignedAtHeader === -1) throw new Error('Cannot find IMEI assigned_at header');
offset += insertBeforeLine(imeiAssignedAtHeader, [
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'imei\',\'gateway_id\')">Gateway <span class="sort-arrow" data-table="imei" data-col="gateway_id"></span></th>',
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'imei\',\'port\')">Port <span class="sort-arrow" data-table="imei" data-col="port"></span></th>',
]);
console.log(`[9d] Added Gateway and Port column headers to IMEI Pool`);

// Add pagination container to IMEI Pool table
let imeiPoolTableEnd = findLine('id="imei-pool-table"');
if (imeiPoolTableEnd === -1) throw new Error('Cannot find imei-pool-table');
// Find the closing </div> of the overflow-x-auto wrapper (2 </div>s after tbody)
let poolTableEndLine = imeiPoolTableEnd;
while (poolTableEndLine < lines.length) {
  if (lines[poolTableEndLine - 1].includes('</table>')) break;
  poolTableEndLine++;
}
// After </table>, find the </div> (overflow wrapper)
poolTableEndLine++;
while (poolTableEndLine < lines.length && !lines[poolTableEndLine - 1].trim().startsWith('</div>')) poolTableEndLine++;
offset += insertBeforeLine(poolTableEndLine, [
  '                    <div id="imei-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>',
]);
console.log(`[9e] Added IMEI pagination container`);

// ============================================================
// 10. HTML: SIMs tab modifications - add checkbox column header and pagination
// ============================================================
// Add checkbox column before ID header
let simsIdHeader = findLine("onclick=\"sortTable('sims','id')\"");
if (simsIdHeader === -1) throw new Error('Cannot find sims ID header');
offset += insertBeforeLine(simsIdHeader, [
  '                                    <th class="px-4 py-3 font-medium"><input type="checkbox" onchange="toggleAllSims(this)" class="accent-green-500"></th>',
]);
console.log(`[10a] Added SIMs checkbox column header`);

// Add Last Rotated column header before Actions
let simsActionsHeader = findLine("font-medium\">Actions</th>", findLine("tab-sims") - 1);
if (simsActionsHeader === -1) throw new Error('Cannot find sims Actions header');
offset += insertBeforeLine(simsActionsHeader, [
  '                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable(\'sims\',\'last_mdn_rotated_at\')">Last Rotated <span class="sort-arrow" data-table="sims" data-col="last_mdn_rotated_at"></span></th>',
]);
console.log(`[10b] Added Last Rotated column header`);

// Update colspan from 10 to 12 in sims loading row
let simsLoadingLine = findLine('colspan="10"', findLine('tab-sims') - 1);
if (simsLoadingLine !== -1) {
  lines[simsLoadingLine - 1] = lines[simsLoadingLine - 1].replace('colspan="10"', 'colspan="12"');
  changeCount++;
}
console.log(`[10c] Updated sims loading colspan`);

// Add bulk action bar before the sims table card
let simsTableCard = findLine('class="bg-dark-800 rounded-xl border border-dark-600"', findLine('tab-sims') - 1);
if (simsTableCard !== -1) {
  offset += insertBeforeLine(simsTableCard, [
    '                <div id="sim-action-bar" class="hidden mb-4 p-3 bg-dark-800 rounded-lg border border-dark-600 flex items-center gap-3">',
    '                    <span id="sim-selected-count" class="text-sm text-gray-300">0 selected</span>',
    '                    <button onclick="bulkSimAction(\'ota\')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition">OTA Refresh</button>',
    '                    <button onclick="bulkSimAction(\'rotate\')" class="px-3 py-1.5 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition">Rotate MDN</button>',
    '                    <button onclick="bulkSimAction(\'fix\')" class="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">Fix SIM</button>',
    '                    <button onclick="bulkSimAction(\'cancel\')" class="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Cancel</button>',
    '                    <button onclick="bulkSimAction(\'resume\')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>',
    '                </div>',
  ]);
  console.log(`[10d] Added SIM bulk action bar`);
}

// Add sims pagination container
let simsTableEndLine = findLine('id="sims-table"');
if (simsTableEndLine === -1) throw new Error('Cannot find sims-table');
let simsTblEnd = simsTableEndLine;
while (simsTblEnd < lines.length && !lines[simsTblEnd - 1].includes('</table>')) simsTblEnd++;
simsTblEnd++;
while (simsTblEnd < lines.length && !lines[simsTblEnd - 1].trim().startsWith('</div>')) simsTblEnd++;
offset += insertBeforeLine(simsTblEnd, [
  '                    <div id="sims-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>',
]);
console.log(`[10e] Added SIMs pagination container`);

// Add messages pagination container
let messagesTableEndLine = findLine('id="messages-table"');
if (messagesTableEndLine === -1) throw new Error('Cannot find messages-table');
let msgTblEnd = messagesTableEndLine;
while (msgTblEnd < lines.length && !lines[msgTblEnd - 1].includes('</table>')) msgTblEnd++;
msgTblEnd++;
while (msgTblEnd < lines.length && !lines[msgTblEnd - 1].trim().startsWith('</div>')) msgTblEnd++;
offset += insertBeforeLine(msgTblEnd, [
  '                    <div id="messages-pagination" class="px-4 py-3 border-t border-dark-600 flex items-center justify-between"></div>',
]);
console.log(`[10f] Added Messages pagination container`);

// ============================================================
// 11. JS: TAB_ROUTES - add 'errors': '/errors'
// ============================================================
let tabRoutesImeiLine = findLine("'imei-pool': '/imei-pool',");
if (tabRoutesImeiLine === -1) throw new Error('Cannot find imei-pool in TAB_ROUTES');
offset += insertAfterLine(tabRoutesImeiLine, [
  "            'errors': '/errors',",
]);
console.log(`[11] Added errors to TAB_ROUTES`);

// ============================================================
// 12. JS: switchTab - add errors handler
// ============================================================
let switchTabGatewayLine = findLine("if (tabName === 'gateway') loadPortStatus();");
if (switchTabGatewayLine === -1) throw new Error('Cannot find gateway handler in switchTab');
offset += insertAfterLine(switchTabGatewayLine, [
  "            if (tabName === 'errors') loadErrors();",
]);
console.log(`[12] Added errors handler to switchTab`);

// ============================================================
// 13. JS: tableState - add page/pageSize for all tables, add errors
// ============================================================
let tableStateLine = findLine("sims: { data: [], sortKey: 'id', sortDir: 'asc' },");
if (tableStateLine === -1) throw new Error('Cannot find sims tableState');
lines[tableStateLine - 1] = "            sims: { data: [], sortKey: 'id', sortDir: 'asc', page: 1, pageSize: 50 },";
changeCount++;
let msgStateLine = findLine("messages: { data: [], sortKey: 'received_at', sortDir: 'desc' },");
if (msgStateLine === -1) throw new Error('Cannot find messages tableState');
lines[msgStateLine - 1] = "            messages: { data: [], sortKey: 'received_at', sortDir: 'desc', page: 1, pageSize: 50 },";
changeCount++;
let imeiStateLine = findLine("imei: { data: [], sortKey: 'id', sortDir: 'desc' },");
if (imeiStateLine === -1) throw new Error('Cannot find imei tableState');
lines[imeiStateLine - 1] = "            imei: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },";
changeCount++;
offset += insertAfterLine(imeiStateLine, [
  "            errors: { data: [], sortKey: 'id', sortDir: 'desc', page: 1, pageSize: 50 },",
]);
console.log(`[13] Updated tableState with pagination and errors entry`);

// ============================================================
// 14. JS: Add sortTable handler for errors
// ============================================================
let sortRenderImeiLine = findLine("else if (table === 'imei') renderImeiPool();");
if (sortRenderImeiLine === -1) throw new Error('Cannot find imei sort render');
offset += insertAfterLine(sortRenderImeiLine, [
  "            else if (table === 'errors') renderErrors();",
]);
console.log(`[14] Added errors to sortTable`);

// Also reset page on sort for all tables
let reRenderComment = findLine("// Re-render", findLine("function sortTable") - 1);
if (reRenderComment !== -1) {
  offset += insertBeforeLine(reRenderComment, [
    "            state.page = 1;",
  ]);
  console.log(`[14b] Added page reset on sort`);
}

// ============================================================
// 15. JS: Add pagination functions and all new JS (before loadGatewayDropdown)
// ============================================================
let loadGwDropdownLine = findLine("loadGatewayDropdown();");
if (loadGwDropdownLine === -1) throw new Error('Cannot find loadGatewayDropdown call');
offset += insertBeforeLine(loadGwDropdownLine, [
  '',
  '        // ===== Pagination =====',
  '        function paginate(data, table) {',
  '            const state = tableState[table];',
  '            const start = (state.page - 1) * state.pageSize;',
  '            return data.slice(start, start + state.pageSize);',
  '        }',
  '',
  '        function changePageSize(table, size) {',
  '            tableState[table].pageSize = parseInt(size);',
  '            tableState[table].page = 1;',
  '            const renderMap = { sims: renderSims, messages: renderMessages, imei: renderImeiPool, errors: renderErrors };',
  '            if (renderMap[table]) renderMap[table]();',
  '        }',
  '',
  '        function goToPage(table, page) {',
  '            tableState[table].page = page;',
  '            const renderMap = { sims: renderSims, messages: renderMessages, imei: renderImeiPool, errors: renderErrors };',
  '            if (renderMap[table]) renderMap[table]();',
  '        }',
  '',
  '        function renderPaginationControls(containerId, table, totalItems) {',
  '            const container = document.getElementById(containerId);',
  '            if (!container) return;',
  '            const state = tableState[table];',
  '            const totalPages = Math.ceil(totalItems / state.pageSize) || 1;',
  '            if (state.page > totalPages) state.page = totalPages;',
  '',
  '            const pageSizeOptions = [25, 50, 100, 250].map(s =>',
  '                `<option value="${s}" ${s === state.pageSize ? \'selected\' : \'\'}>${s}</option>`',
  "            ).join('');",
  '',
  '            let pageButtons = \'\';',
  '            const maxBtns = 7;',
  '            let startPage = Math.max(1, state.page - Math.floor(maxBtns / 2));',
  '            let endPage = Math.min(totalPages, startPage + maxBtns - 1);',
  '            if (endPage - startPage < maxBtns - 1) startPage = Math.max(1, endPage - maxBtns + 1);',
  '',
  '            if (startPage > 1) pageButtons += `<button onclick="goToPage(\'${table}\', 1)" class="px-2 py-1 text-xs rounded bg-dark-700 text-gray-300 hover:bg-dark-600">1</button>`;',
  '            if (startPage > 2) pageButtons += \'<span class="text-gray-500 text-xs">...</span>\';',
  '            for (let i = startPage; i <= endPage; i++) {',
  '                const active = i === state.page ? \'bg-accent text-white\' : \'bg-dark-700 text-gray-300 hover:bg-dark-600\';',
  '                pageButtons += `<button onclick="goToPage(\'${table}\', ${i})" class="px-2 py-1 text-xs rounded ${active}">${i}</button>`;',
  '            }',
  '            if (endPage < totalPages - 1) pageButtons += \'<span class="text-gray-500 text-xs">...</span>\';',
  '            if (endPage < totalPages) pageButtons += `<button onclick="goToPage(\'${table}\', ${totalPages})" class="px-2 py-1 text-xs rounded bg-dark-700 text-gray-300 hover:bg-dark-600">${totalPages}</button>`;',
  '',
  '            container.innerHTML = `',
  '                <div class="flex items-center gap-2">',
  '                    <span class="text-xs text-gray-500">Show</span>',
  '                    <select onchange="changePageSize(\'${table}\', this.value)" class="text-xs bg-dark-700 border border-dark-500 rounded px-2 py-1 text-gray-300">${pageSizeOptions}</select>',
  '                    <span class="text-xs text-gray-500">of ${totalItems}</span>',
  '                </div>',
  '                <div class="flex items-center gap-1">${pageButtons}</div>',
  '            `;',
  '        }',
  '',
  '        // ===== Errors Tab =====',
  '        async function loadErrors() {',
  '            try {',
  '                const response = await fetch(`${API_BASE}/errors`);',
  '                const data = await response.json();',
  '                tableState.errors.data = Array.isArray(data) ? data : [];',
  '                renderErrors();',
  '                // Update badge',
  '                const badge = document.getElementById(\'error-badge\');',
  '                if (badge) {',
  '                    const count = tableState.errors.data.length;',
  '                    badge.textContent = count;',
  '                    badge.classList.toggle(\'hidden\', count === 0);',
  '                }',
  '            } catch (error) {',
  "                showToast('Error loading errors', 'error');",
  '                console.error(error);',
  '            }',
  '        }',
  '',
  '        function classifyError(errorText) {',
  '            if (!errorText) return \'unknown\';',
  '            const lower = errorText.toLowerCase();',
  "            if (lower.includes('must be active')) return 'must_be_active';",
  "            if (lower.includes('cancel')) return 'cancel_failed';",
  "            if (lower.includes('resume')) return 'resume_failed';",
  "            if (lower.includes('ota') || lower.includes('refresh')) return 'ota_failed';",
  "            if (lower.includes('imei')) return 'imei_failed';",
  "            if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';",
  "            return 'other';",
  '        }',
  '',
  '        function renderErrors() {',
  '            const state = tableState.errors;',
  '            const search = (document.getElementById(\'errors-search\')?.value || \'\').trim();',
  '            let data = state.data;',
  '            if (search) data = data.filter(s => matchesSearch(s, search));',
  '            data = genericSort(data, state.sortKey, state.sortDir);',
  '',
  '            // Summary cards',
  '            const categories = {};',
  '            state.data.forEach(s => {',
  '                const cat = classifyError(s.last_activation_error);',
  '                categories[cat] = (categories[cat] || 0) + 1;',
  '            });',
  '            const summaryEl = document.getElementById(\'error-summary\');',
  '            summaryEl.innerHTML = Object.entries(categories).map(([cat, count]) => `',
  '                <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">',
  '                    <span class="text-sm text-gray-400">${cat.replace(/_/g, \' \')}</span>',
  '                    <p class="text-2xl font-bold text-red-400">${count}</p>',
  '                </div>',
  "            `).join('');",
  '',
  '            // Paginate',
  '            const totalFiltered = data.length;',
  "            const pageData = paginate(data, 'errors');",
  "            renderPaginationControls('errors-pagination', 'errors', totalFiltered);",
  '',
  '            const tbody = document.getElementById(\'errors-table\');',
  '            if (pageData.length === 0) {',
  '                tbody.innerHTML = \'<tr><td colspan="6" class="px-4 py-4 text-center text-gray-500">No errors found</td></tr>\';',
  '                return;',
  '            }',
  '            tbody.innerHTML = pageData.map(sim => {',
  "                const phone = sim.sim_numbers?.[0]?.e164 || '';",
  "                const gw = sim.gateways?.code || '';",
  '                const errorShort = (sim.last_activation_error || \'\').slice(0, 80);',
  '                const statusClass = {',
  "                    'active': 'bg-accent/20 text-accent',",
  "                    'canceled': 'bg-red-500/20 text-red-400',",
  "                    'suspended': 'bg-orange-500/20 text-orange-400',",
  "                }[sim.status] || 'bg-gray-500/20 text-gray-400';",
  '                return `',
  '                <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">',
  '                    <td class="px-4 py-3"><input type="checkbox" class="error-cb accent-green-500" value="${sim.id}" onchange="updateErrorActionBar()"></td>',
  '                    <td class="px-4 py-3 text-gray-300">${sim.id}</td>',
  '                    <td class="px-4 py-3 font-mono text-xs text-gray-400">${sim.iccid} <span class="text-gray-600">${gw}</span></td>',
  '                    <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full ${statusClass}">${sim.status}</span></td>',
  '                    <td class="px-4 py-3 text-red-400 text-xs cursor-pointer hover:text-red-300" onclick="showFullError(${sim.id})" title="${(sim.last_activation_error || \'\').replace(/"/g, \'&quot;\')}">${errorShort}${(sim.last_activation_error || \'\').length > 80 ? \'...\' : \'\'}</td>',
  '                    <td class="px-4 py-3">',
  "                        <button onclick=\"simAction(${sim.id}, 'ota')\" class=\"px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition mr-1\">OTA</button>",
  "                        <button onclick=\"simAction(${sim.id}, 'fix')\" class=\"px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition\">Fix</button>",
  '                    </td>',
  '                </tr>`;',
  "            }).join('');",
  '        }',
  '',
  '        function toggleAllErrors(checkbox) {',
  "            document.querySelectorAll('.error-cb').forEach(cb => cb.checked = checkbox.checked);",
  '            updateErrorActionBar();',
  '        }',
  '',
  '        function updateErrorActionBar() {',
  "            const checked = document.querySelectorAll('.error-cb:checked');",
  "            const bar = document.getElementById('error-action-bar');",
  "            document.getElementById('error-selected-count').textContent = checked.length + ' selected';",
  "            bar.classList.toggle('hidden', checked.length === 0);",
  '        }',
  '',
  '        function hideErrorDetail() {',
  "            document.getElementById('error-detail').classList.add('hidden');",
  '        }',
  '',
  '        async function showFullError(simId) {',
  '            const sim = tableState.errors.data.find(s => s.id === simId);',
  '            if (!sim) return;',
  "            document.getElementById('error-detail-title').textContent = `Error Detail - SIM #${simId}`;",
  "            document.getElementById('error-detail-content').textContent = sim.last_activation_error || 'No error text';",
  "            document.getElementById('error-detail').classList.remove('hidden');",
  '            // Try to load logs',
  '            try {',
  '                const resp = await fetch(`${API_BASE}/error-logs?sim_id=${simId}`);',
  '                const logs = await resp.json();',
  '                if (Array.isArray(logs) && logs.length > 0) {',
  "                    document.getElementById('error-detail-content').textContent += '\\n\\n--- API Logs ---\\n' + JSON.stringify(logs, null, 2);",
  '                }',
  '            } catch {}',
  '        }',
  '',
  '        // ===== SIM Actions =====',
  '        async function simAction(simId, action) {',
  '            if (!confirm(`Run ${action} on SIM #${simId}?`)) return;',
  '            showToast(`Running ${action} on SIM #${simId}...`, \'info\');',
  '            try {',
  '                const response = await fetch(`${API_BASE}/sim-action`, {',
  "                    method: 'POST',",
  "                    headers: { 'Content-Type': 'application/json' },",
  '                    body: JSON.stringify({ sim_id: simId, action })',
  '                });',
  '                const result = await response.json();',
  '                if (result.ok) {',
  '                    showToast(`${action} completed on SIM #${simId}`, \'success\');',
  '                    loadErrors();',
  '                } else {',
  '                    showToast(`Error: ${result.error || JSON.stringify(result)}`, \'error\');',
  '                }',
  '            } catch (error) {',
  '                showToast(`Error running ${action}`, \'error\');',
  '                console.error(error);',
  '            }',
  '        }',
  '',
  '        function toggleAllSims(checkbox) {',
  "            document.querySelectorAll('.sim-cb').forEach(cb => cb.checked = checkbox.checked);",
  '            updateSimActionBar();',
  '        }',
  '',
  '        function updateSimActionBar() {',
  "            const checked = document.querySelectorAll('.sim-cb:checked');",
  "            const bar = document.getElementById('sim-action-bar');",
  "            document.getElementById('sim-selected-count').textContent = checked.length + ' selected';",
  "            bar.classList.toggle('hidden', checked.length === 0);",
  '        }',
  '',
  '        async function bulkSimAction(action) {',
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));",
  '            if (simIds.length === 0) return;',
  '            if (!confirm(`Run ${action} on ${simIds.length} SIM(s)?`)) return;',
  '            showToast(`Running ${action} on ${simIds.length} SIM(s)...`, \'info\');',
  '            let ok = 0, fail = 0;',
  '            const concurrency = 5;',
  '            const queue = [...simIds];',
  '            async function worker() {',
  '                while (queue.length > 0) {',
  '                    const id = queue.shift();',
  '                    try {',
  '                        const r = await fetch(`${API_BASE}/sim-action`, {',
  "                            method: 'POST',",
  "                            headers: { 'Content-Type': 'application/json' },",
  '                            body: JSON.stringify({ sim_id: id, action })',
  '                        });',
  '                        const res = await r.json();',
  '                        if (res.ok) ok++; else fail++;',
  '                    } catch { fail++; }',
  '                }',
  '            }',
  '            await Promise.all(Array.from({ length: Math.min(concurrency, simIds.length) }, () => worker()));',
  '            showToast(`${action}: ${ok} ok, ${fail} failed`, fail > 0 ? \'error\' : \'success\');',
  '            loadSims();',
  '        }',
  '',
  '        async function bulkErrorAction(action) {',
  "            const simIds = [...document.querySelectorAll('.error-cb:checked')].map(cb => parseInt(cb.value));",
  '            if (simIds.length === 0) return;',
  '            if (!confirm(`Run ${action} on ${simIds.length} SIM(s)?`)) return;',
  '            showToast(`Running ${action} on ${simIds.length} SIM(s)...`, \'info\');',
  '            let ok = 0, fail = 0;',
  '            const concurrency = 5;',
  '            const queue = [...simIds];',
  '            async function worker() {',
  '                while (queue.length > 0) {',
  '                    const id = queue.shift();',
  '                    try {',
  '                        const r = await fetch(`${API_BASE}/sim-action`, {',
  "                            method: 'POST',",
  "                            headers: { 'Content-Type': 'application/json' },",
  '                            body: JSON.stringify({ sim_id: id, action })',
  '                        });',
  '                        const res = await r.json();',
  '                        if (res.ok) ok++; else fail++;',
  '                    } catch { fail++; }',
  '                }',
  '            }',
  '            await Promise.all(Array.from({ length: Math.min(concurrency, simIds.length) }, () => worker()));',
  '            showToast(`${action}: ${ok} ok, ${fail} failed`, fail > 0 ? \'error\' : \'success\');',
  '            loadErrors();',
  '        }',
  '',
  '        // ===== IMEI Sync/Block =====',
  '        async function syncAllGatewayImeis() {',
  "            const btn = document.getElementById('sync-gateways-btn');",
  "            btn.textContent = 'Syncing...';",
  '            btn.disabled = true;',
  '            try {',
  '                const gwResp = await fetch(`${API_BASE}/gateways`);',
  '                const gateways = await gwResp.json();',
  '                let totalAdded = 0, totalUpdated = 0;',
  '                for (const gw of gateways) {',
  '                    try {',
  '                        const res = await fetch(`${API_BASE}/import-gateway-imeis`, {',
  "                            method: 'POST',",
  "                            headers: { 'Content-Type': 'application/json' },",
  '                            body: JSON.stringify({ gateway_id: gw.id })',
  '                        });',
  '                        const data = await res.json();',
  '                        if (data.ok) {',
  '                            totalAdded += data.added || 0;',
  '                            totalUpdated += data.updated || 0;',
  '                        }',
  '                    } catch {}',
  '                }',
  '                showToast(`Sync complete: ${totalAdded} added, ${totalUpdated} updated`, \'success\');',
  '                loadImeiPool();',
  '            } catch (error) {',
  "                showToast('Sync error: ' + error, 'error');",
  '            } finally {',
  "                btn.textContent = 'Sync from Gateways';",
  '                btn.disabled = false;',
  '            }',
  '        }',
  '',
  '        async function blockImei(id) {',
  "            if (!confirm('Block this IMEI?')) return;",
  '            try {',
  '                const r = await fetch(`${API_BASE}/imei-pool`, {',
  "                    method: 'POST',",
  "                    headers: { 'Content-Type': 'application/json' },",
  "                    body: JSON.stringify({ action: 'block', id })",
  '                });',
  '                const res = await r.json();',
  "                showToast(res.ok ? 'IMEI blocked' : `Error: ${res.error}`, res.ok ? 'success' : 'error');",
  '                loadImeiPool();',
  '            } catch (error) {',
  "                showToast('Error blocking IMEI', 'error');",
  '            }',
  '        }',
  '',
  '        async function unblockImei(id) {',
  "            if (!confirm('Unblock this IMEI?')) return;",
  '            try {',
  '                const r = await fetch(`${API_BASE}/imei-pool`, {',
  "                    method: 'POST',",
  "                    headers: { 'Content-Type': 'application/json' },",
  "                    body: JSON.stringify({ action: 'unblock', id })",
  '                });',
  '                const res = await r.json();',
  "                showToast(res.ok ? 'IMEI unblocked' : `Error: ${res.error}`, res.ok ? 'success' : 'error');",
  '                loadImeiPool();',
  '            } catch (error) {',
  "                showToast('Error unblocking IMEI', 'error');",
  '            }',
  '        }',
  '',
]);
console.log(`[15] Added pagination, errors, sim actions, sync/block JS functions`);

// ============================================================
// 16. JS: Modify renderSims to include checkbox, last_mdn_rotated_at, OTA button, pagination
// ============================================================
// Find renderSims function and replace the tbody building
let renderSimsLine = findLine("function renderSims()");
if (renderSimsLine === -1) throw new Error('Cannot find renderSims');

// Find the "if (data.length === 0)" part
let simsEmptyLine = findLine("No SIMs found", renderSimsLine - 1);
if (simsEmptyLine === -1) throw new Error('Cannot find No SIMs found');
// Replace colspan
lines[simsEmptyLine - 1] = lines[simsEmptyLine - 1].replace(/colspan="\d+"/, 'colspan="12"');
changeCount++;

// Add pagination calls after the countEl line
let countElLine = findLine("countEl.textContent =", renderSimsLine - 1);
if (countElLine !== -1) {
  offset += insertAfterLine(countElLine, [
    '',
    "            const totalFiltered = data.length;",
    "            data = paginate(data, 'sims');",
    "            renderPaginationControls('sims-pagination', 'sims', totalFiltered);",
  ]);
  console.log(`[16a] Added pagination to renderSims`);
}

// Now we need to modify the row template to add checkbox, last_mdn_rotated_at, and OTA
// Find the `tbody.innerHTML = data.map(sim =>` line in renderSims
let simMapLine = findLine("tbody.innerHTML = data.map(sim", renderSimsLine - 1);
if (simMapLine === -1) throw new Error('Cannot find sims map');

// Find the <tr class line (start of row)
let simRowStart = findLine('<tr class="border-b border-dark-600', simMapLine - 1);
if (simRowStart === -1) throw new Error('Cannot find sim row start');
// Insert checkbox td after the <tr> line
offset += insertAfterLine(simRowStart, [
  '                    <td class="px-4 py-3"><input type="checkbox" class="sim-cb accent-green-500" value="\\${sim.id}" onchange="updateSimActionBar()"></td>',
]);
console.log(`[16b] Added checkbox to SIM rows`);

// Find the "Online" button td and add Last Rotated column before it
let onlineBtnLine = findLine("sendSimOnline(", simMapLine - 1);
if (onlineBtnLine === -1) throw new Error('Cannot find Online button');
// Go back to find the <td> that contains it
let onlineTdLine = onlineBtnLine;
while (onlineTdLine > simMapLine && !lines[onlineTdLine - 1].includes('<td class="px-4 py-3">')) onlineTdLine--;

offset += insertBeforeLine(onlineTdLine, [
  "                    <td class=\"px-4 py-3 text-gray-500 text-xs\">\\${sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).toLocaleString() : '-'}</td>",
]);
console.log(`[16c] Added Last Rotated column to SIM rows`);

// Replace the Online button with Online + OTA buttons
let onlineEndTd = onlineBtnLine;
while (onlineEndTd < lines.length && !lines[onlineEndTd - 1].includes('</td>')) onlineEndTd++;
// Expand the actions: Online + OTA
// Actually, let's find the full td block and replace
let actionsTdStart = onlineTdLine;
// The td block goes from onlineTdLine to the </td> line
// We need to find the start and end more carefully after our insertion
// Re-find after insertion
let actionsStart = findLine("sendSimOnline(", simMapLine - 1);
if (actionsStart !== -1) {
  let actStart = actionsStart;
  while (actStart > simMapLine && !lines[actStart - 1].includes('<td class="px-4 py-3">')) actStart--;
  let actEnd = actionsStart;
  while (actEnd < lines.length && !lines[actEnd - 1].includes('</td>')) actEnd++;

  // Replace the entire actions td
  let newActionLines = [
    "                    <td class=\"px-4 py-3 whitespace-nowrap\">",
    "                        \\${canSendOnline ? \\`<button onclick=\"sendSimOnline(\\${sim.id}, '\\${sim.phone_number}')\" class=\"px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition mr-1\">Online</button>\\` : ''}",
    "                        \\${sim.status === 'active' ? \\`<button onclick=\"simAction(\\${sim.id}, 'ota')\" class=\"px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition\">OTA</button>\\` : ''}",
    "                    </td>",
  ];
  lines.splice(actStart - 1, actEnd - actStart + 1, ...newActionLines);
  changeCount++;
  console.log(`[16d] Replaced SIM actions td with Online + OTA`);
}

// ============================================================
// 17. JS: Modify renderMessages to add pagination
// ============================================================
let renderMsgsLine = findLine("function renderMessages()");
if (renderMsgsLine === -1) throw new Error('Cannot find renderMessages');

// Find the tbody = line
let msgTbodyLine = findLine("const tbody = document.getElementById('messages-table')", renderMsgsLine - 1);
if (msgTbodyLine !== -1) {
  offset += insertBeforeLine(msgTbodyLine, [
    "            const totalFiltered = data.length;",
    "            data = paginate(data, 'messages');",
    "            renderPaginationControls('messages-pagination', 'messages', totalFiltered);",
    '',
  ]);
  console.log(`[17] Added pagination to renderMessages`);
}

// ============================================================
// 18. JS: Modify renderImeiPool to add gateway/port columns, block/unblock, blocked stat, pagination
// ============================================================
let renderImeiLine = findLine("function renderImeiPool()");
if (renderImeiLine === -1) throw new Error('Cannot find renderImeiPool');

// Add blocked stat update
let imeiRetiredDisplay = findLine("getElementById('imei-retired')", renderImeiLine - 1);
if (imeiRetiredDisplay !== -1) {
  offset += insertAfterLine(imeiRetiredDisplay, [
    "            document.getElementById('imei-blocked').textContent = stats.blocked || 0;",
  ]);
  console.log(`[18a] Added blocked stat display`);
}

// Add pagination before the tbody building
let imeiTbodyLine = findLine("const tbody = document.getElementById('imei-pool-table')", renderImeiLine - 1);
if (imeiTbodyLine !== -1) {
  offset += insertBeforeLine(imeiTbodyLine, [
    "            const totalFiltered = data.length;",
    "            data = paginate(data, 'imei');",
    "            renderPaginationControls('imei-pagination', 'imei', totalFiltered);",
    '',
  ]);
  console.log(`[18b] Added pagination to renderImeiPool`);
}

// Update the empty state colspan
let imeiEmptyLine = findLine("No IMEIs match filters", renderImeiLine - 1);
if (imeiEmptyLine !== -1) {
  lines[imeiEmptyLine - 1] = lines[imeiEmptyLine - 1].replace(/colspan="\d+"/, 'colspan="8"');
  changeCount++;
}

// Now modify the row template to add gateway/port columns and block/unblock buttons
// Find the row template in renderImeiPool
let imeiRowMapLine = findLine("tbody.innerHTML = data.map(entry", renderImeiLine - 1);
if (imeiRowMapLine === -1) throw new Error('Cannot find IMEI row map');

// Find the "Assigned SIM" td
let assignedSimTd = findLine("simInfo", imeiRowMapLine - 1);
if (assignedSimTd !== -1) {
  // Insert gateway/port columns before the assigned sim td
  // Find the actual <td> containing simInfo
  let simInfoTdLine = assignedSimTd;
  while (simInfoTdLine > imeiRowMapLine && !lines[simInfoTdLine - 1].includes('<td class="px-4 py-3')) simInfoTdLine--;

  offset += insertBeforeLine(simInfoTdLine, [
    '                    <td class="px-4 py-3 text-gray-400 text-xs">\\${entry.gateway_id || \'-\'}</td>',
    '                    <td class="px-4 py-3 text-gray-400 text-xs">\\${entry.port || \'-\'}</td>',
  ]);
  console.log(`[18c] Added gateway/port columns to IMEI rows`);
}

// Modify the Retire button to also show Block/Unblock
let retireBtnLine = findLine("retireImei(", renderImeiLine - 1);
if (retireBtnLine === -1) throw new Error('Cannot find retire button');
// Find the td containing it
let retireTdStart = retireBtnLine;
while (retireTdStart > imeiRowMapLine && !lines[retireTdStart - 1].includes('<td class="px-4 py-3">')) retireTdStart--;
let retireTdEnd = retireBtnLine;
while (retireTdEnd < lines.length && !lines[retireTdEnd - 1].includes('</td>')) retireTdEnd++;

// Replace entire td
let newRetireTd = [
  "                    <td class=\"px-4 py-3 whitespace-nowrap\">",
  "                        \\${canRetire ? \\`<button onclick=\"retireImei(\\${entry.id})\" class=\"px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition mr-1\">Retire</button>\\` : ''}",
  "                        \\${entry.status === 'blocked' ? \\`<button onclick=\"unblockImei(\\${entry.id})\" class=\"px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition\">Unblock</button>\\` : ''}",
  "                        \\${entry.status !== 'blocked' && entry.status !== 'retired' ? \\`<button onclick=\"blockImei(\\${entry.id})\" class=\"px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition\">Block</button>\\` : ''}",
  "                    </td>",
];
lines.splice(retireTdStart - 1, retireTdEnd - retireTdStart + 1, ...newRetireTd);
changeCount++;
console.log(`[18d] Updated IMEI actions with block/unblock`);

// Add blocked to statusClass map in renderImeiPool
let imeiStatusClassLine = findLine("'retired': 'bg-gray-500/20 text-gray-400',", renderImeiLine - 1);
if (imeiStatusClassLine !== -1) {
  offset += insertAfterLine(imeiStatusClassLine, [
    "                    'blocked': 'bg-red-500/20 text-red-400',",
  ]);
  console.log(`[18e] Added blocked status class`);
}

// ============================================================
// 19. JS: Load errors on app init and update error badge
// ============================================================
let loadDataCallLine = findLine("loadData();", findLine("loadResellers()") - 1);
if (loadDataCallLine !== -1) {
  offset += insertAfterLine(loadDataCallLine, [
    "        loadErrors();",
  ]);
  console.log(`[19] Added loadErrors() call on init`);
}

// ============================================================
// Final: Restore CRLF and write
// ============================================================
content = lines.join('\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log(`\n=== Done! Applied ${changeCount} changes. ===`);
