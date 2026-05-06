// Apply the 3 missing backend+HTML changes (route, functions, modal)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─── 1. Add /api/helix-query-bulk route ──────────────────────────────────────
const OLD_ROUTE = "    if (url.pathname === '/api/helix-query') {\n"
  + "      return handleHelixQuery(request, env, corsHeaders);\n"
  + "    }";

const NEW_ROUTE = "    if (url.pathname === '/api/helix-query') {\n"
  + "      return handleHelixQuery(request, env, corsHeaders);\n"
  + "    }\n"
  + "\n"
  + "    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {\n"
  + "      return handleHelixQueryBulk(request, env, corsHeaders);\n"
  + "    }";

if (content.includes("helix-query-bulk")) {
  console.log('✓ Route already present, skipping');
} else if (!content.includes(OLD_ROUTE)) {
  console.error('PATCH FAILED: route anchor not found'); process.exit(1);
} else {
  content = content.replace(OLD_ROUTE, NEW_ROUTE);
  console.log('✓ Route added');
}

// ─── 2. Replace handleHelixQuery + add new functions ─────────────────────────
const funcStart = content.indexOf('async function handleHelixQuery(');
const funcEnd = content.indexOf('\nasync function handleSendTestSms(');
if (funcStart === -1 || funcEnd === -1) {
  console.error('PATCH FAILED: handleHelixQuery boundaries not found');
  process.exit(1);
}

const existing = content.slice(funcStart, funcEnd);
if (existing.includes('syncCancelledSim')) {
  console.log('✓ Backend functions already patched, skipping');
} else {
  const NEW_FUNCS = "async function handleHelixQuery(request, env, corsHeaders) {\n"
    + "  if (request.method !== 'POST') {\n"
    + "    return new Response('Method not allowed', { status: 405 });\n"
    + "  }\n"
    + "\n"
    + "  try {\n"
    + "    const body = await request.json();\n"
    + "    const subId = body.mobility_subscription_id;\n"
    + "\n"
    + "    if (!subId) {\n"
    + "      return new Response(JSON.stringify({ error: 'mobility_subscription_id is required' }), {\n"
    + "        status: 400,\n"
    + "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "\n"
    + "    const tokenRes = await fetch(env.HX_TOKEN_URL, {\n"
    + "      method: 'POST',\n"
    + "      headers: { 'Content-Type': 'application/json' },\n"
    + "      body: JSON.stringify({\n"
    + "        grant_type: 'password',\n"
    + "        client_id: env.HX_CLIENT_ID,\n"
    + "        audience: env.HX_AUDIENCE,\n"
    + "        username: env.HX_GRANT_USERNAME,\n"
    + "        password: env.HX_GRANT_PASSWORD,\n"
    + "      }),\n"
    + "    });\n"
    + "\n"
    + "    const tokenData = await tokenRes.json();\n"
    + "    if (!tokenRes.ok || !tokenData.access_token) {\n"
    + "      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {\n"
    + "        status: 502,\n"
    + "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "\n"
    + "    const token = tokenData.access_token;\n"
    + "    const detailsUrl = env.HX_API_BASE + '/api/mobility-subscriber/details';\n"
    + "    const detailsRes = await fetch(detailsUrl, {\n"
    + "      method: 'POST',\n"
    + "      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },\n"
    + "      body: JSON.stringify({ mobilitySubscriptionId: parseInt(subId) }),\n"
    + "    });\n"
    + "\n"
    + "    const detailsText = await detailsRes.text();\n"
    + "    let detailsData;\n"
    + "    try {\n"
    + "      detailsData = JSON.parse(detailsText);\n"
    + "    } catch {\n"
    + "      return new Response(JSON.stringify({ error: 'Invalid JSON from Helix', raw: detailsText.slice(0, 500) }), {\n"
    + "        status: 502,\n"
    + "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "\n"
    + "    if (!detailsRes.ok) {\n"
    + "      return new Response(JSON.stringify({ error: 'Helix API error', status: detailsRes.status, details: detailsData }), {\n"
    + "        status: 502,\n"
    + "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "\n"
    + "    const data = Array.isArray(detailsData) ? detailsData[0] : detailsData;\n"
    + "    let db_update = null;\n"
    + "    if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {\n"
    + "      db_update = await syncCancelledSim(env, String(subId), data);\n"
    + "    }\n"
    + "\n"
    + "    return new Response(JSON.stringify({ ok: true, mobility_subscription_id: subId, helix_response: detailsData, db_update }, null, 2), {\n"
    + "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "    });\n"
    + "\n"
    + "  } catch (error) {\n"
    + "    return new Response(JSON.stringify({ error: String(error) }), {\n"
    + "      status: 500,\n"
    + "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "    });\n"
    + "  }\n"
    + "}\n"
    + "\n"
    + "async function syncCancelledSim(env, subId, helixData) {\n"
    + "  try {\n"
    + "    const sims = await sbGet(env, 'sims?mobility_subscription_id=eq.' + encodeURIComponent(subId) + '&select=id,iccid,status&limit=1');\n"
    + "    const sim = Array.isArray(sims) ? sims[0] : null;\n"
    + "    if (!sim) return { found: false };\n"
    + "\n"
    + "    const result = { found: true, iccid: sim.iccid, sim_id: sim.id };\n"
    + "\n"
    + "    if (sim.status !== 'canceled') {\n"
    + "      await sbPatch(env, 'sims?id=eq.' + sim.id, { status: 'canceled' });\n"
    + "      result.status_updated = true;\n"
    + "      result.previous_status = sim.status;\n"
    + "    } else {\n"
    + "      result.status_already_canceled = true;\n"
    + "    }\n"
    + "\n"
    + "    const hist = await sbGet(env, 'sim_status_history?sim_id=eq.' + sim.id + '&new_status=eq.canceled&limit=1');\n"
    + "    if (!Array.isArray(hist) || hist.length === 0) {\n"
    + "      const canceledAt = helixData.canceledAt || helixData.cancelledAt;\n"
    + "      if (canceledAt) {\n"
    + "        await sbPost(env, 'sim_status_history', {\n"
    + "          sim_id: sim.id,\n"
    + "          old_status: sim.status,\n"
    + "          new_status: 'canceled',\n"
    + "          changed_at: new Date(canceledAt).toISOString(),\n"
    + "        });\n"
    + "        result.history_inserted = true;\n"
    + "        result.canceled_at = new Date(canceledAt).toISOString();\n"
    + "      } else {\n"
    + "        result.no_cancel_date = true;\n"
    + "      }\n"
    + "    } else {\n"
    + "      result.history_exists = true;\n"
    + "      result.canceled_at = hist[0].changed_at;\n"
    + "    }\n"
    + "\n"
    + "    return result;\n"
    + "  } catch (e) {\n"
    + "    return { error: String(e) };\n"
    + "  }\n"
    + "}\n"
    + "\n"
    + "async function handleHelixQueryBulk(request, env, corsHeaders) {\n"
    + "  if (request.method !== 'POST') {\n"
    + "    return new Response('Method not allowed', { status: 405 });\n"
    + "  }\n"
    + "  try {\n"
    + "    const body = await request.json().catch(() => ({}));\n"
    + "    const limit = Math.min(parseInt(body.limit) || 100, 200);\n"
    + "    const offset = parseInt(body.offset) || 0;\n"
    + "\n"
    + "    const simsData = await sbGet(env, 'sims?mobility_subscription_id=not.is.null&status=not.eq.canceled&select=id,iccid,status,mobility_subscription_id&limit=5000');\n"
    + "    const allSims = Array.isArray(simsData) ? simsData : [];\n"
    + "    const batch = allSims.slice(offset, offset + limit);\n"
    + "\n"
    + "    if (batch.length === 0) {\n"
    + "      return new Response(JSON.stringify({ ok: true, total_eligible: allSims.length, processed: 0, message: 'No SIMs in this batch' }), {\n"
    + "        headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "\n"
    + "    const tokenRes = await fetch(env.HX_TOKEN_URL, {\n"
    + "      method: 'POST',\n"
    + "      headers: { 'Content-Type': 'application/json' },\n"
    + "      body: JSON.stringify({\n"
    + "        grant_type: 'password',\n"
    + "        client_id: env.HX_CLIENT_ID,\n"
    + "        audience: env.HX_AUDIENCE,\n"
    + "        username: env.HX_GRANT_USERNAME,\n"
    + "        password: env.HX_GRANT_PASSWORD,\n"
    + "      }),\n"
    + "    });\n"
    + "    const tokenData = await tokenRes.json();\n"
    + "    if (!tokenRes.ok || !tokenData.access_token) {\n"
    + "      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {\n"
    + "        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "      });\n"
    + "    }\n"
    + "    const token = tokenData.access_token;\n"
    + "\n"
    + "    const results = {\n"
    + "      ok: true,\n"
    + "      total_eligible: allSims.length,\n"
    + "      processed: batch.length,\n"
    + "      offset,\n"
    + "      has_more: offset + batch.length < allSims.length,\n"
    + "      next_offset: offset + batch.length,\n"
    + "      cancelled_found: 0,\n"
    + "      db_updated: 0,\n"
    + "      already_synced: 0,\n"
    + "      errors: 0,\n"
    + "      changed: [],\n"
    + "    };\n"
    + "\n"
    + "    for (const sim of batch) {\n"
    + "      try {\n"
    + "        const detailsRes = await fetch(env.HX_API_BASE + '/api/mobility-subscriber/details', {\n"
    + "          method: 'POST',\n"
    + "          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },\n"
    + "          body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),\n"
    + "        });\n"
    + "\n"
    + "        if (!detailsRes.ok) {\n"
    + "          results.errors++;\n"
    + "          results.changed.push({ iccid: sim.iccid, error: 'Helix ' + detailsRes.status });\n"
    + "          continue;\n"
    + "        }\n"
    + "\n"
    + "        const d = await detailsRes.json();\n"
    + "        const data = Array.isArray(d) ? d[0] : d;\n"
    + "\n"
    + "        if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {\n"
    + "          results.cancelled_found++;\n"
    + "          const upd = await syncCancelledSim(env, String(sim.mobility_subscription_id), data);\n"
    + "          if (upd.status_updated) results.db_updated++;\n"
    + "          else if (upd.status_already_canceled) results.already_synced++;\n"
    + "          results.changed.push({ iccid: sim.iccid, sub_id: sim.mobility_subscription_id, helix_status: data.status, ...upd });\n"
    + "        }\n"
    + "      } catch (e) {\n"
    + "        results.errors++;\n"
    + "        results.changed.push({ iccid: sim.iccid, error: String(e) });\n"
    + "      }\n"
    + "    }\n"
    + "\n"
    + "    return new Response(JSON.stringify(results), {\n"
    + "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "    });\n"
    + "\n"
    + "  } catch (error) {\n"
    + "    return new Response(JSON.stringify({ error: String(error) }), {\n"
    + "      status: 500,\n"
    + "      headers: { ...corsHeaders, 'Content-Type': 'application/json' }\n"
    + "    });\n"
    + "  }\n"
    + "}\n";

  content = content.slice(0, funcStart) + NEW_FUNCS + content.slice(funcEnd);
  console.log('✓ Backend functions replaced');
}

// ─── 3. Update modal HTML ─────────────────────────────────────────────────────
if (content.includes('helix-db-update-banner')) {
  console.log('✓ Modal HTML already patched, skipping');
} else {
  const OLD_MODAL = "    <!-- Helix Query Modal -->\n"
    + '    <div id="helix-query-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n'
    + '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">\n'
    + '            <div class="px-5 py-4 border-b border-dark-600">\n'
    + '                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>\n'
    + '            </div>\n'
    + '            <div class="p-5">\n'
    + '                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>\n'
    + '                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>\n'
    + '                <div id="helix-query-result" class="mt-4 hidden">\n'
    + '                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>\n'
    + '                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>\n'
    + '                </div>\n'
    + '            </div>\n'
    + '            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">\n'
    + '                <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>\n'
    + '                <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>\n'
    + '            </div>\n'
    + '        </div>\n'
    + '    </div>';

  if (!content.includes(OLD_MODAL)) {
    console.error('PATCH FAILED: modal HTML not found');
    process.exit(1);
  }

  const NEW_MODAL = "    <!-- Helix Query Modal -->\n"
    + '    <div id="helix-query-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n'
    + '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">\n'
    + '            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">\n'
    + '                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>\n'
    + '                <button onclick="hideHelixQueryModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n'
    + '            </div>\n'
    + '            <div class="p-5">\n'
    + '                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>\n'
    + '                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>\n'
    + '                <div id="helix-query-result" class="mt-4 hidden">\n'
    + '                    <div id="helix-db-update-banner" class="hidden mb-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">\n'
    + '                        <p class="text-xs font-semibold text-yellow-400 mb-1">&#x26A0; DB Auto-Synced \u2014 Line marked Cancelled</p>\n'
    + '                        <pre id="helix-db-update-output" class="text-xs font-mono text-yellow-300 whitespace-pre-wrap"></pre>\n'
    + '                    </div>\n'
    + '                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>\n'
    + '                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>\n'
    + '                </div>\n'
    + '                <div id="helix-bulk-result" class="mt-4 hidden">\n'
    + '                    <div id="helix-bulk-summary" class="grid grid-cols-4 gap-2 mb-3"></div>\n'
    + '                    <div id="helix-bulk-changed" class="hidden">\n'
    + '                        <h4 class="text-sm font-medium text-gray-400 mb-2">Cancelled / Errors:</h4>\n'
    + '                        <pre id="helix-bulk-changed-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-gray-300 border border-dark-600"></pre>\n'
    + '                    </div>\n'
    + '                    <div id="helix-bulk-more" class="hidden mt-3 flex justify-end">\n'
    + '                        <button id="helix-bulk-next-btn" onclick="queryHelixBulkNext()" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Run Next Batch</button>\n'
    + '                    </div>\n'
    + '                </div>\n'
    + '            </div>\n'
    + '            <div class="px-5 py-4 border-t border-dark-600 flex justify-between items-center">\n'
    + '                <button onclick="queryHelixBulk()" id="helix-bulk-btn" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 border border-dark-500 text-gray-300 rounded-lg transition">Bulk Query All SIMs</button>\n'
    + '                <div class="flex gap-3">\n'
    + '                    <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>\n'
    + '                    <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>\n'
    + '                </div>\n'
    + '            </div>\n'
    + '        </div>\n'
    + '    </div>';

  content = content.replace(OLD_MODAL, NEW_MODAL);
  console.log('✓ Modal HTML updated');
}

// ─── Write ────────────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written');
