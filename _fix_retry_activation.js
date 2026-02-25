'use strict';
// Patch script: retry activation feature
// Usage: node _fix_retry_activation.js
const fs = require('fs');

// ─────────────────────────────────────────────────────────────
// Part 1: mdn-rotator — add hxActivate, scanGatewaysForIccid,
//         getUnoccupiedCandidates, retryActivation + router case
// ─────────────────────────────────────────────────────────────
{
  const filePath = 'src/mdn-rotator/index.js';
  let src = fs.readFileSync(filePath, 'utf8');
  const hasCRLF = src.includes('\r\n');
  if (hasCRLF) src = src.replace(/\r\n/g, '\n');

  // 1a. Add retry_activation to validActions
  const va_old = 'const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix"];';
  const va_new = 'const validActions = ["ota_refresh", "cancel", "resume", "rotate", "fix", "retry_activation"];';
  if (!src.includes(va_old)) throw new Error('validActions marker not found');
  src = src.replace(va_old, va_new);
  console.log('  [1a] validActions updated');

  // 1b. Insert retry_activation handler before the !subId check
  const marker1b = '        // For ota_refresh, cancel, resume \u2014 need Helix token + subscriber details';
  const idx1b = src.indexOf(marker1b);
  if (idx1b === -1) throw new Error('marker1b not found');
  const handler1b =
    '        // For retry_activation \u2014 handles its own SIM loading\n' +
    '        if (action === "retry_activation") {\n' +
    '          const result = await retryActivation(env, sim_id, body.gateway_id ?? null, body.port ?? null);\n' +
    '          return new Response(JSON.stringify(result, null, 2), {\n' +
    '            status: result.ok === false && !result.slot_not_found ? 500 : 200,\n' +
    '            headers: { "Content-Type": "application/json" }\n' +
    '          });\n' +
    '        }\n\n';
  src = src.slice(0, idx1b) + handler1b + src.slice(idx1b);
  console.log('  [1b] retry_activation router case inserted');

  // 1c. Insert new helper functions before supabase helpers
  const marker1c = '// ===========================\n// Supabase helpers\n// ===========================';
  const idx1c = src.indexOf(marker1c);
  if (idx1c === -1) throw new Error('marker1c not found');

  const newFunctions =
    '// ===========================\n' +
    '// Retry Activation for error-status SIMs\n' +
    '// ===========================\n\n' +
    'async function hxActivate(env, token, iccid, imei) {\n' +
    '  const url = env.HX_API_BASE + \'/api/mobility-activation/activate\';\n' +
    '  const method = "POST";\n' +
    '  const runId = \'retry_activate_\' + iccid + \'_\' + Date.now();\n' +
    '  const requestBody = {\n' +
    '    clientId: Number(env.HX_ACTIVATION_CLIENT_ID),\n' +
    '    plan: { id: Number(env.HX_PLAN_ID) },\n' +
    '    BAN: String(env.HX_BAN),\n' +
    '    FAN: String(env.HX_FAN),\n' +
    '    activationType: "new_activation",\n' +
    '    subscriber: { firstName: "SUB", lastName: "NINE" },\n' +
    '    address: {\n' +
    '      address1: env.HX_ADDRESS1,\n' +
    '      city: env.HX_CITY,\n' +
    '      state: env.HX_STATE,\n' +
    '      zipCode: env.HX_ZIP,\n' +
    '    },\n' +
    '    service: { iccid, imei },\n' +
    '  };\n' +
    '  const res = await fetch(url, {\n' +
    '    method,\n' +
    '    headers: { "Content-Type": "application/json", Authorization: \'Bearer \' + token },\n' +
    '    body: JSON.stringify(requestBody),\n' +
    '  });\n' +
    '  const responseText = await res.text();\n' +
    '  let json = {};\n' +
    '  try { json = JSON.parse(responseText); } catch {}\n' +
    '  await logHelixApiCall(env, {\n' +
    '    run_id: runId, step: "retry_activation", iccid, imei,\n' +
    '    request_url: url, request_method: method, request_body: requestBody,\n' +
    '    response_status: res.status, response_ok: res.ok,\n' +
    '    response_body_text: responseText, response_body_json: json,\n' +
    '    error: res.ok ? null : \'Activate failed: \' + res.status,\n' +
    '  });\n' +
    '  if (!res.ok) throw new Error(\'Activate failed \' + res.status + \': \' + responseText.slice(0, 300));\n' +
    '  if (json && json.mobilitySubscriptionId) return json;\n' +
    '  const match = responseText.match(/"mobilitySubscriptionId"\\s*:\\s*"?(\\d+)"?/);\n' +
    '  if (match) return { mobilitySubscriptionId: match[1], _raw: responseText };\n' +
    '  throw new Error(\'Activate returned \' + res.status + \' but no mobilitySubscriptionId. Raw: \' + responseText.slice(0, 200));\n' +
    '}\n\n' +
    'async function scanGatewaysForIccid(env, iccid) {\n' +
    '  if (!env.SKYLINE_GATEWAY) throw new Error("SKYLINE_GATEWAY service binding not configured");\n' +
    '  if (!env.SKYLINE_SECRET) throw new Error("SKYLINE_SECRET not configured");\n' +
    '  const gateways = await supabaseSelect(env, \'gateways?select=id,code&order=id.asc\');\n' +
    '  if (!Array.isArray(gateways) || gateways.length === 0) return null;\n' +
    '  for (const gw of gateways) {\n' +
    '    try {\n' +
    '      const skUrl = \'https://skyline-gateway/port-info?gateway_id=\' + encodeURIComponent(String(gw.id)) +\n' +
    '        \'&secret=\' + encodeURIComponent(env.SKYLINE_SECRET) + \'&all_slots=1\';\n' +
    '      const res = await env.SKYLINE_GATEWAY.fetch(skUrl);\n' +
    '      const txt = await res.text();\n' +
    '      let data = {};\n' +
    '      try { data = JSON.parse(txt); } catch {}\n' +
    '      if (!data.ok || !Array.isArray(data.ports)) continue;\n' +
    '      const found = data.ports.find(p => p.iccid === iccid);\n' +
    '      if (found) return { gateway_id: gw.id, gateway_code: gw.code, port: found.port, current_imei: found.imei || null };\n' +
    '    } catch (err) {\n' +
    '      console.warn(\'[scanGateways] Gateway \' + gw.id + \' error: \' + err);\n' +
    '    }\n' +
    '  }\n' +
    '  return null;\n' +
    '}\n\n' +
    'async function getUnoccupiedCandidates(env) {\n' +
    '  if (!env.SKYLINE_GATEWAY) throw new Error("SKYLINE_GATEWAY service binding not configured");\n' +
    '  if (!env.SKYLINE_SECRET) throw new Error("SKYLINE_SECRET not configured");\n' +
    '  const activeSims = await supabaseSelect(env, \'sims?select=iccid&status=in.(active,provisioning)&limit=5000\');\n' +
    '  const occupied = new Set(Array.isArray(activeSims) ? activeSims.map(s => s.iccid).filter(Boolean) : []);\n' +
    '  const gateways = await supabaseSelect(env, \'gateways?select=id,code&order=id.asc\');\n' +
    '  if (!Array.isArray(gateways) || gateways.length === 0) return [];\n' +
    '  const candidates = [];\n' +
    '  for (const gw of gateways) {\n' +
    '    try {\n' +
    '      const skUrl = \'https://skyline-gateway/port-info?gateway_id=\' + encodeURIComponent(String(gw.id)) +\n' +
    '        \'&secret=\' + encodeURIComponent(env.SKYLINE_SECRET) + \'&all_slots=1\';\n' +
    '      const res = await env.SKYLINE_GATEWAY.fetch(skUrl);\n' +
    '      const txt = await res.text();\n' +
    '      let data = {};\n' +
    '      try { data = JSON.parse(txt); } catch {}\n' +
    '      if (!data.ok || !Array.isArray(data.ports)) continue;\n' +
    '      for (const p of data.ports) {\n' +
    '        if (p.iccid && !occupied.has(p.iccid)) {\n' +
    '          candidates.push({ gateway_id: gw.id, gateway_code: gw.code, port: p.port, iccid: p.iccid, current_imei: p.imei || null });\n' +
    '        }\n' +
    '      }\n' +
    '    } catch (err) {\n' +
    '      console.warn(\'[getUnoccupied] Gateway \' + gw.id + \' error: \' + err);\n' +
    '    }\n' +
    '  }\n' +
    '  return candidates;\n' +
    '}\n\n' +
    'async function retryActivation(env, simId, manualGatewayId = null, manualPort = null) {\n' +
    '  const sims = await supabaseSelect(\n' +
    '    env,\n' +
    '    \'sims?select=id,iccid,status,current_imei_pool_id&id=eq.\' + encodeURIComponent(String(simId)) + \'&limit=1\'\n' +
    '  );\n' +
    '  if (!Array.isArray(sims) || sims.length === 0) throw new Error(\'SIM not found: \' + simId);\n' +
    '  const sim = sims[0];\n' +
    '  if (sim.status !== \'error\') throw new Error(\'SIM \' + sim.iccid + \' is not in error state (status: \' + sim.status + \')\');\n' +
    '  console.log(\'[RetryActivation] Starting for SIM \' + simId + \' (\' + sim.iccid + \')\');\n\n' +
    '  let gatewayId, port;\n' +
    '  if (manualGatewayId && manualPort) {\n' +
    '    gatewayId = manualGatewayId;\n' +
    '    port = manualPort;\n' +
    '    console.log(\'[RetryActivation] Using manual slot: gateway=\' + gatewayId + \' port=\' + port);\n' +
    '  } else {\n' +
    '    const found = await scanGatewaysForIccid(env, sim.iccid);\n' +
    '    if (!found) {\n' +
    '      console.log(\'[RetryActivation] SIM \' + sim.iccid + \' not found on any gateway, returning candidates\');\n' +
    '      const candidates = await getUnoccupiedCandidates(env);\n' +
    '      return { ok: false, slot_not_found: true, candidates };\n' +
    '    }\n' +
    '    gatewayId = found.gateway_id;\n' +
    '    port = found.port;\n' +
    '    console.log(\'[RetryActivation] Found SIM \' + sim.iccid + \' at gateway=\' + gatewayId + \' port=\' + port);\n' +
    '  }\n\n' +
    '  await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)), { gateway_id: gatewayId, port });\n\n' +
    '  if (sim.current_imei_pool_id) await retireImeiPoolEntry(env, sim.current_imei_pool_id, simId);\n\n' +
    '  const poolEntry = await allocateImeiFromPool(env, simId);\n' +
    '  console.log(\'[RetryActivation] SIM \' + sim.iccid + \': allocated IMEI \' + poolEntry.imei + \' (pool entry \' + poolEntry.id + \')\');\n\n' +
    '  // Step 6a: Set IMEI on gateway\n' +
    '  try {\n' +
    '    await callSkylineSetImei(env, gatewayId, port, poolEntry.imei);\n' +
    '    console.log(\'[RetryActivation] SIM \' + sim.iccid + \': IMEI set on gateway\');\n' +
    '  } catch (err) {\n' +
    '    console.error(\'[RetryActivation] SIM \' + sim.iccid + \': gateway set-IMEI failed: \' + err);\n' +
    '    await releaseImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});\n' +
    '    await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)),\n' +
    '      { last_activation_error: \'Gateway error: \' + err.message });\n' +
    '    throw err;\n' +
    '  }\n\n' +
    '  // Step 6b: Helix activation\n' +
    '  let activateResult;\n' +
    '  try {\n' +
    '    const token = await getCachedToken(env);\n' +
    '    activateResult = await hxActivate(env, token, sim.iccid, poolEntry.imei);\n' +
    '    console.log(\'[RetryActivation] SIM \' + sim.iccid + \': activation submitted, subId=\' + activateResult.mobilitySubscriptionId);\n' +
    '  } catch (err) {\n' +
    '    console.error(\'[RetryActivation] SIM \' + sim.iccid + \': Helix activation failed: \' + err);\n' +
    '    await retireImeiPoolEntry(env, poolEntry.id, simId).catch(() => {});\n' +
    '    await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)),\n' +
    '      { last_activation_error: String(err), imei: poolEntry.imei, current_imei_pool_id: poolEntry.id });\n' +
    '    throw err;\n' +
    '  }\n\n' +
    '  // Step 6c: Set SIM to provisioning\n' +
    '  await supabasePatch(env, \'sims?id=eq.\' + encodeURIComponent(String(simId)), {\n' +
    '    status: \'provisioning\',\n' +
    '    last_activation_error: null,\n' +
    '    imei: poolEntry.imei,\n' +
    '    current_imei_pool_id: poolEntry.id,\n' +
    '  });\n' +
    '  console.log(\'[RetryActivation] SIM \' + sim.iccid + \': set to provisioning\');\n\n' +
    '  return {\n' +
    '    ok: true,\n' +
    '    imei: poolEntry.imei,\n' +
    '    gateway_id: gatewayId,\n' +
    '    port,\n' +
    '    message: \'Activation submitted \u2014 finalizer will complete within 5 min\',\n' +
    '  };\n' +
    '}\n\n';

  src = src.slice(0, idx1c) + newFunctions + src.slice(idx1c);
  console.log('  [1c] new helper functions inserted');

  if (hasCRLF) src = src.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, src, 'utf8');
  console.log('[1/2] mdn-rotator patched OK');
}

// ─────────────────────────────────────────────────────────────
// Part 2: dashboard — backend forwarding + frontend UI
// ─────────────────────────────────────────────────────────────
{
  const filePath = 'src/dashboard/index.js';
  let src = fs.readFileSync(filePath, 'utf8');
  // Normalize CRLF → LF for reliable string matching
  src = src.replace(/\r\n/g, '\n');

  // 2a. Backend: forward gateway_id and port to mdn-rotator
  const fwd_old = 'body: JSON.stringify({ sim_id, action })';
  const fwd_new = 'body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null })';
  if (!src.includes(fwd_old)) throw new Error('fwd_old not found in dashboard');
  src = src.replace(fwd_old, fwd_new);
  console.log('  [2a] backend forwarding updated');

  // 2b. Add Retry button for error-status SIM rows
  // Find the OTA button by its unique class set, then find end of that line
  const otaMarker = '">OTA</button>';
  const otaIdx = src.indexOf(otaMarker);
  if (otaIdx === -1) throw new Error('OTA button marker not found');
  const otaLineEnd = src.indexOf('\n', otaIdx);
  if (otaLineEnd === -1) throw new Error('OTA line end not found');
  // Insert Retry button line after OTA button line
  // Raw file chars: \${sim.status === 'error' ? \`<button onclick="retryActivation(\${sim.id})" ...>Retry</button>\` : ''}
  const retryBtnLine = '\n' +
    '                        \\${sim.status === \'error\' ? \\`<button onclick="retryActivation(\\${sim.id})" class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1">Retry</button>\\` : \'\'}';
  src = src.slice(0, otaLineEnd) + retryBtnLine + src.slice(otaLineEnd);
  console.log('  [2b] Retry button added to SIM rows');

  // 2c. Insert Slot Picker Modal HTML (before Rotate Specific SIMs modal)
  const rotateModalMarker = '    <!-- Rotate Specific SIMs Modal -->';
  const rotateModalIdx = src.indexOf(rotateModalMarker);
  if (rotateModalIdx === -1) throw new Error('rotate modal marker not found');
  const slotPickerModal =
    '    <!-- Slot Picker Modal -->\n' +
    '    <div id="slot-picker-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n' +
    '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[80vh] flex flex-col">\n' +
    '            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">\n' +
    '                <h3 class="text-lg font-semibold text-white">Select Gateway Slot</h3>\n' +
    '                <button onclick="hideSlotPickerModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n' +
    '            </div>\n' +
    '            <div class="p-5 overflow-y-auto flex-1">\n' +
    '                <p class="text-sm text-gray-400 mb-4">The SIM card was not found on any gateway. Select a slot to try, or enter slot details manually.</p>\n' +
    '                <div id="slot-picker-candidates" class="mb-4"></div>\n' +
    '                <div class="border-t border-dark-600 pt-4">\n' +
    '                    <h4 class="text-sm font-medium text-gray-300 mb-3">Manual Entry</h4>\n' +
    '                    <div class="flex gap-3 items-end">\n' +
    '                        <div>\n' +
    '                            <label class="block text-xs text-gray-500 mb-1">Gateway ID</label>\n' +
    '                            <input id="slot-picker-manual-gw" type="text" class="px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent w-28" placeholder="1"/>\n' +
    '                        </div>\n' +
    '                        <div>\n' +
    '                            <label class="block text-xs text-gray-500 mb-1">Port</label>\n' +
    '                            <input id="slot-picker-manual-port" type="text" class="px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent w-24" placeholder="01.01"/>\n' +
    '                        </div>\n' +
    '                        <button onclick="useManualSlot()" class="px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Use Slot</button>\n' +
    '                    </div>\n' +
    '                </div>\n' +
    '            </div>\n' +
    '            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">\n' +
    '                <button onclick="hideSlotPickerModal()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Cancel</button>\n' +
    '            </div>\n' +
    '        </div>\n' +
    '    </div>\n';
  src = src.slice(0, rotateModalIdx) + slotPickerModal + src.slice(rotateModalIdx);
  console.log('  [2c] slot picker modal HTML inserted');

  // 2d. Insert JS functions after simAction, before loadSimActionLogs
  const simActionEndMarker = '            loadSimActionLogs();\n        }\n\n        async function loadSimActionLogs() {';
  const simActionEndIdx = src.indexOf(simActionEndMarker);
  if (simActionEndIdx === -1) throw new Error('simAction end marker not found');
  // Insert point: right after the closing brace of simAction (after '        }\n\n')
  const insertPoint = simActionEndIdx + '            loadSimActionLogs();\n        }\n\n'.length;

  // These functions are placed inside the <script> block (inside getHTML() template literal).
  // Since they contain NO backticks and NO ${, no additional escaping is needed.
  const newJsFunctions =
    '        async function retryActivation(simId, gatewayId, port) {\n' +
    '            const sim = tableState.sims?.data?.find(s => String(s.id) === String(simId));\n' +
    '            currentSimActionId = simId;\n' +
    '            currentSimActionIccid = sim?.iccid || null;\n\n' +
    '            document.getElementById(\'sim-action-title\').textContent = \'Retry Activation - SIM #\' + simId;\n' +
    '            document.getElementById(\'sim-action-output\').textContent = \'Scanning gateways for SIM...\';\n' +
    '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
    '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n\n' +
    '            try {\n' +
    '                const reqBody = { sim_id: simId, action: \'retry_activation\' };\n' +
    '                if (gatewayId) reqBody.gateway_id = gatewayId;\n' +
    '                if (port) reqBody.port = port;\n\n' +
    '                const response = await fetch(API_BASE + \'/sim-action\', {\n' +
    '                    method: \'POST\',\n' +
    '                    headers: { \'Content-Type\': \'application/json\' },\n' +
    '                    body: JSON.stringify(reqBody)\n' +
    '                });\n' +
    '                const result = await response.json();\n\n' +
    '                if (result.slot_not_found) {\n' +
    '                    hideSimActionModal();\n' +
    '                    showSlotPickerModal(simId, result.candidates || []);\n' +
    '                    return;\n' +
    '                }\n\n' +
    '                document.getElementById(\'sim-action-output\').textContent = JSON.stringify(result, null, 2);\n' +
    '                if (result.ok) {\n' +
    '                    showToast(\'Retry activation submitted \u2014 SIM moving to provisioning\', \'success\');\n' +
    '                    loadSims(true);\n' +
    '                    loadErrors();\n' +
    '                } else {\n' +
    '                    showToast(\'Retry failed: \' + (result.error || \'Unknown error\'), \'error\');\n' +
    '                }\n' +
    '            } catch (error) {\n' +
    '                document.getElementById(\'sim-action-output\').textContent = String(error);\n' +
    '                showToast(\'Error running retry activation\', \'error\');\n' +
    '                console.error(error);\n' +
    '            }\n\n' +
    '            loadSimActionLogs();\n' +
    '        }\n\n' +
    '        let _slotPickerSimId = null;\n\n' +
    '        function showSlotPickerModal(simId, candidates) {\n' +
    '            _slotPickerSimId = simId;\n' +
    '            const container = document.getElementById(\'slot-picker-candidates\');\n' +
    '            container.innerHTML = \'\';\n' +
    '            if (!candidates || candidates.length === 0) {\n' +
    '                container.innerHTML = \'<p class="text-sm text-gray-500">No unoccupied slots found on any gateway.</p>\';\n' +
    '            } else {\n' +
    '                const table = document.createElement(\'table\');\n' +
    '                table.className = \'w-full text-sm text-gray-300\';\n' +
    '                table.innerHTML = \'<thead><tr class="text-xs text-gray-500 border-b border-dark-600">\' +\n' +
    '                    \'<th class="py-2 text-left">Gateway</th><th class="py-2 text-left">Port</th>\' +\n' +
    '                    \'<th class="py-2 text-left">ICCID in Slot</th><th class="py-2 text-left">IMEI</th>\' +\n' +
    '                    \'<th class="py-2"></th></tr></thead><tbody id="slot-picker-tbody"></tbody>\';\n' +
    '                container.appendChild(table);\n' +
    '                const tbody = document.getElementById(\'slot-picker-tbody\');\n' +
    '                candidates.forEach(function(c) {\n' +
    '                    const tr = document.createElement(\'tr\');\n' +
    '                    tr.className = \'border-b border-dark-700\';\n' +
    '                    tr.innerHTML = \'<td class="py-2 pr-4">\' + (c.gateway_code || c.gateway_id) + \'</td>\' +\n' +
    '                        \'<td class="py-2 pr-4 font-mono">\' + (c.port || \'-\') + \'</td>\' +\n' +
    '                        \'<td class="py-2 pr-4 font-mono text-xs">\' + (c.iccid || \'-\') + \'</td>\' +\n' +
    '                        \'<td class="py-2 pr-4 font-mono text-xs">\' + (c.current_imei || \'-\') + \'</td>\' +\n' +
    '                        \'<td class="py-2"></td>\';\n' +
    '                    const btn = document.createElement(\'button\');\n' +
    '                    btn.className = \'px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition\';\n' +
    '                    btn.textContent = \'Use Slot\';\n' +
    '                    btn.addEventListener(\'click\', (function(gid, p) {\n' +
    '                        return function() { retryActivation(simId, gid, p); };\n' +
    '                    })(c.gateway_id, c.port));\n' +
    '                    tr.lastElementChild.appendChild(btn);\n' +
    '                    tbody.appendChild(tr);\n' +
    '                });\n' +
    '            }\n' +
    '            document.getElementById(\'slot-picker-modal\').classList.remove(\'hidden\');\n' +
    '        }\n\n' +
    '        function hideSlotPickerModal() {\n' +
    '            document.getElementById(\'slot-picker-modal\').classList.add(\'hidden\');\n' +
    '            _slotPickerSimId = null;\n' +
    '        }\n\n' +
    '        function useManualSlot() {\n' +
    '            const gwId = document.getElementById(\'slot-picker-manual-gw\').value.trim();\n' +
    '            const port = document.getElementById(\'slot-picker-manual-port\').value.trim();\n' +
    '            if (!gwId || !port) { showToast(\'Enter gateway ID and port\', \'error\'); return; }\n' +
    '            const simId = _slotPickerSimId;\n' +
    '            hideSlotPickerModal();\n' +
    '            retryActivation(simId, gwId, port);\n' +
    '        }\n\n';

  src = src.slice(0, insertPoint) + newJsFunctions + src.slice(insertPoint);
  console.log('  [2d] JS functions inserted');

  // Convert back to CRLF (dashboard uses CRLF)
  src = src.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, src, 'utf8');
  console.log('[2/2] dashboard patched OK');
}

console.log('\nAll patches applied.');
console.log('Syntax check: node --input-type=module --check < src/dashboard/index.js');
console.log('Syntax check: node --input-type=module --check < src/mdn-rotator/index.js');
