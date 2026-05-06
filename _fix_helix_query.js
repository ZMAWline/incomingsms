// _fix_helix_query.js
// 1. handleHelixQuery — auto-sync cancelled status to DB
// 2. Add syncCancelledSim helper
// 3. Add handleHelixQueryBulk
// 4. Add /api/helix-query-bulk route
// 5. Modal: show db_update banner + Bulk Query button + bulk result area
// 6. JS: update queryHelix() to show db_update, add queryHelixBulk()

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─── 1. Add /api/helix-query-bulk route ─────────────────────────────────────

const OLD_ROUTE = `    if (url.pathname === '/api/helix-query') {
      return handleHelixQuery(request, env, corsHeaders);
    }`;

const NEW_ROUTE = `    if (url.pathname === '/api/helix-query') {
      return handleHelixQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {
      return handleHelixQueryBulk(request, env, corsHeaders);
    }`;

if (!content.includes(OLD_ROUTE)) {
  console.error('PATCH FAILED: route anchor not found');
  process.exit(1);
}
content = content.replace(OLD_ROUTE, NEW_ROUTE);
console.log('✓ Route added');

// ─── 2. Replace handleHelixQuery (whole function) ───────────────────────────

const funcStart = content.indexOf('async function handleHelixQuery(');
const funcEnd = content.indexOf('\nasync function handleSendTestSms(');
if (funcStart === -1 || funcEnd === -1) {
  console.error('PATCH FAILED: handleHelixQuery boundaries not found');
  process.exit(1);
}

const NEW_HELIX_QUERY_FUNCS = `async function handleHelixQuery(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const subId = body.mobility_subscription_id;

    if (!subId) {
      return new Response(JSON.stringify({ error: 'mobility_subscription_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tokenRes = await fetch(env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const token = tokenData.access_token;
    const detailsUrl = \`\${env.HX_API_BASE}/api/mobility-subscriber/details\`;
    const detailsRes = await fetch(detailsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
      body: JSON.stringify({ mobilitySubscriptionId: parseInt(subId) }),
    });

    const detailsText = await detailsRes.text();
    let detailsData;
    try {
      detailsData = JSON.parse(detailsText);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON response from Helix', raw: detailsText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!detailsRes.ok) {
      return new Response(JSON.stringify({ error: 'Helix API error', status: detailsRes.status, details: detailsData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Auto-cancel: if Helix says CANCELLED, sync to DB
    const data = Array.isArray(detailsData) ? detailsData[0] : detailsData;
    let db_update = null;
    if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
      db_update = await syncCancelledSim(env, String(subId), data);
    }

    return new Response(JSON.stringify({ ok: true, mobility_subscription_id: subId, helix_response: detailsData, db_update }, null, 2), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function syncCancelledSim(env, subId, helixData) {
  try {
    const sims = await sbGet(env, \`sims?mobility_subscription_id=eq.\${encodeURIComponent(subId)}&select=id,iccid,status&limit=1\`);
    const sim = Array.isArray(sims) ? sims[0] : null;
    if (!sim) return { found: false };

    const result = { found: true, iccid: sim.iccid, sim_id: sim.id };

    if (sim.status !== 'canceled') {
      await sbPatch(env, \`sims?id=eq.\${sim.id}\`, { status: 'canceled' });
      result.status_updated = true;
      result.previous_status = sim.status;
    } else {
      result.status_already_canceled = true;
    }

    // Check for existing canceled history entry
    const hist = await sbGet(env, \`sim_status_history?sim_id=eq.\${sim.id}&new_status=eq.canceled&limit=1\`);
    if (!Array.isArray(hist) || hist.length === 0) {
      const canceledAt = helixData.canceledAt || helixData.cancelledAt;
      if (canceledAt) {
        await sbPost(env, 'sim_status_history', {
          sim_id: sim.id,
          old_status: sim.status,
          new_status: 'canceled',
          changed_at: new Date(canceledAt).toISOString(),
        });
        result.history_inserted = true;
        result.canceled_at = new Date(canceledAt).toISOString();
      } else {
        result.no_cancel_date = true;
      }
    } else {
      result.history_exists = true;
      result.canceled_at = hist[0].changed_at;
    }

    return result;
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleHelixQueryBulk(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  try {
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(parseInt(body.limit) || 100, 200);
    const offset = parseInt(body.offset) || 0;

    // All non-canceled SIMs with a subscription ID
    const simsData = await sbGet(env, \`sims?mobility_subscription_id=not.is.null&status=not.eq.canceled&select=id,iccid,status,mobility_subscription_id&limit=5000\`);
    const allSims = Array.isArray(simsData) ? simsData : [];
    const batch = allSims.slice(offset, offset + limit);

    if (batch.length === 0) {
      return new Response(JSON.stringify({ ok: true, total_eligible: allSims.length, processed: 0, message: 'No SIMs in this batch' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Get Helix token
    const tokenRes = await fetch(env.HX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: env.HX_CLIENT_ID,
        audience: env.HX_AUDIENCE,
        username: env.HX_GRANT_USERNAME,
        password: env.HX_GRANT_PASSWORD,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return new Response(JSON.stringify({ error: 'Failed to get Helix token', details: tokenData }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const token = tokenData.access_token;

    const results = {
      ok: true,
      total_eligible: allSims.length,
      processed: batch.length,
      offset,
      has_more: offset + batch.length < allSims.length,
      next_offset: offset + batch.length,
      cancelled_found: 0,
      db_updated: 0,
      already_synced: 0,
      errors: 0,
      changed: [],
    };

    for (const sim of batch) {
      try {
        const detailsRes = await fetch(\`\${env.HX_API_BASE}/api/mobility-subscriber/details\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: \`Bearer \${token}\` },
          body: JSON.stringify({ mobilitySubscriptionId: parseInt(sim.mobility_subscription_id) }),
        });

        if (!detailsRes.ok) {
          results.errors++;
          results.changed.push({ iccid: sim.iccid, error: \`Helix \${detailsRes.status}\` });
          continue;
        }

        const d = await detailsRes.json();
        const data = Array.isArray(d) ? d[0] : d;

        if (data && (data.status === 'CANCELLED' || data.status === 'CANCELED')) {
          results.cancelled_found++;
          const upd = await syncCancelledSim(env, String(sim.mobility_subscription_id), data);
          if (upd.status_updated) results.db_updated++;
          else if (upd.status_already_canceled) results.already_synced++;
          results.changed.push({ iccid: sim.iccid, sub_id: sim.mobility_subscription_id, helix_status: data.status, ...upd });
        }
      } catch (e) {
        results.errors++;
        results.changed.push({ iccid: sim.iccid, error: String(e) });
      }
    }

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

`;

content = content.slice(0, funcStart) + NEW_HELIX_QUERY_FUNCS + content.slice(funcEnd);
console.log('✓ handleHelixQuery + syncCancelledSim + handleHelixQueryBulk replaced/added');

// ─── 3. Update modal HTML ────────────────────────────────────────────────────

const OLD_MODAL = `    <!-- Helix Query Modal -->
    <div id="helix-query-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">
            <div class="px-5 py-4 border-b border-dark-600">
                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>
                <div id="helix-query-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>
                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-3">
                <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>
            </div>
        </div>
    </div>`;

const NEW_MODAL = `    <!-- Helix Query Modal -->
    <div id="helix-query-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl">
            <div class="px-5 py-4 border-b border-dark-600 flex items-center justify-between">
                <h3 class="text-lg font-semibold text-white">Query Helix Subscriber</h3>
                <button onclick="hideHelixQueryModal()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3">Enter a Mobility Subscription ID:</p>
                <input type="text" id="helix-subid-input" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="e.g. 40033"/>
                <div id="helix-query-result" class="mt-4 hidden">
                    <div id="helix-db-update-banner" class="hidden mb-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                        <p class="text-xs font-semibold text-yellow-400 mb-1">&#x26A0; DB Auto-Synced — Line marked Cancelled</p>
                        <pre id="helix-db-update-output" class="text-xs font-mono text-yellow-300 whitespace-pre-wrap"></pre>
                    </div>
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Result:</h4>
                    <pre id="helix-query-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-80 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                </div>
                <div id="helix-bulk-result" class="mt-4 hidden">
                    <div id="helix-bulk-summary" class="grid grid-cols-4 gap-2 mb-3"></div>
                    <div id="helix-bulk-changed" class="hidden">
                        <h4 class="text-sm font-medium text-gray-400 mb-2">Lines Cancelled / Errors:</h4>
                        <pre id="helix-bulk-changed-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto text-gray-300 border border-dark-600"></pre>
                    </div>
                    <div id="helix-bulk-more" class="hidden mt-3 flex justify-end">
                        <button id="helix-bulk-next-btn" onclick="queryHelixBulkNext()" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Run Next Batch</button>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-between items-center">
                <button onclick="queryHelixBulk()" id="helix-bulk-btn" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 border border-dark-500 text-gray-300 rounded-lg transition">Bulk Query All SIMs</button>
                <div class="flex gap-3">
                    <button onclick="hideHelixQueryModal()" class="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Close</button>
                    <button onclick="queryHelix()" id="helix-query-btn" class="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Query</button>
                </div>
            </div>
        </div>
    </div>`;

if (!content.includes(OLD_MODAL)) {
  console.error('PATCH FAILED: modal HTML not found');
  process.exit(1);
}
content = content.replace(OLD_MODAL, NEW_MODAL);
console.log('✓ Modal HTML updated');

// ─── 4. Replace JS functions ─────────────────────────────────────────────────

const OLD_JS = `        function showHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-subid-input').focus();
        }

        function queryHelixSubId(subId) {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = subId;
            queryHelix();
        }

        function hideHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-query-result').classList.add('hidden');
        }

        async function queryHelix() {
            const subId = document.getElementById('helix-subid-input').value.trim();
            if (!subId) {
                showToast('Please enter a Subscription ID', 'error');
                return;
            }

            const btn = document.getElementById('helix-query-btn');
            btn.disabled = true;
            btn.textContent = 'Querying...';

            try {
                const response = await fetch(\`\${API_BASE}/helix-query\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mobility_subscription_id: subId })
                });

                const result = await response.json();
                const outputEl = document.getElementById('helix-query-output');
                const resultDiv = document.getElementById('helix-query-result');

                if (response.ok && result.ok) {
                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;
                    let formatted = '';
                    if (data) {
                        formatted = \`<span class="text-blue-400 font-bold">status:</span> <span class="\${data.status === 'ACTIVE' ? 'text-accent' : 'text-red-400'} font-bold">\${data.status || 'N/A'}</span>\\n\`;
                        if (data.statusReason) {
                            formatted += \`<span class="text-blue-400 font-bold">statusReason:</span> <span class="text-orange-400 font-bold">\${data.statusReason}</span>\\n\`;
                        }
                        formatted += \`\\n<span class="text-gray-500">--- Full Response ---</span>\\n\`;
                        formatted += JSON.stringify(data, null, 2);
                    } else {
                        formatted = JSON.stringify(result.helix_response, null, 2);
                    }
                    outputEl.innerHTML = formatted;
                    resultDiv.classList.remove('hidden');
                } else {
                    outputEl.innerHTML = \`<span class="text-red-400">Error:</span> \${JSON.stringify(result, null, 2)}\`;
                    resultDiv.classList.remove('hidden');
                }
            } catch (error) {
                showToast('Error querying Helix', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Query';
            }
        }`;

const NEW_JS = `        function showHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-subid-input').focus();
        }

        function queryHelixSubId(subId) {
            document.getElementById('helix-query-modal').classList.remove('hidden');
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
            document.getElementById('helix-subid-input').value = subId;
            queryHelix();
        }

        function hideHelixQueryModal() {
            document.getElementById('helix-query-modal').classList.add('hidden');
            document.getElementById('helix-subid-input').value = '';
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.add('hidden');
        }

        async function queryHelix() {
            const subId = document.getElementById('helix-subid-input').value.trim();
            if (!subId) {
                showToast('Please enter a Subscription ID', 'error');
                return;
            }

            const btn = document.getElementById('helix-query-btn');
            btn.disabled = true;
            btn.textContent = 'Querying...';
            document.getElementById('helix-bulk-result').classList.add('hidden');

            try {
                const response = await fetch(\`\${API_BASE}/helix-query\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mobility_subscription_id: subId })
                });

                const result = await response.json();
                const outputEl = document.getElementById('helix-query-output');
                const resultDiv = document.getElementById('helix-query-result');
                const dbBanner = document.getElementById('helix-db-update-banner');
                const dbOutput = document.getElementById('helix-db-update-output');

                dbBanner.classList.add('hidden');

                if (response.ok && result.ok) {
                    const data = Array.isArray(result.helix_response) ? result.helix_response[0] : result.helix_response;
                    let formatted = '';
                    if (data) {
                        const isCancelled = data.status === 'CANCELLED' || data.status === 'CANCELED';
                        formatted = \`<span class="text-blue-400 font-bold">status:</span> <span class="\${data.status === 'ACTIVE' ? 'text-accent' : isCancelled ? 'text-red-400' : 'text-orange-400'} font-bold">\${data.status || 'N/A'}</span>\\n\`;
                        if (data.statusReason) {
                            formatted += \`<span class="text-blue-400 font-bold">statusReason:</span> <span class="text-orange-400 font-bold">\${data.statusReason}</span>\\n\`;
                        }
                        if (data.canceledAt || data.cancelledAt) {
                            formatted += \`<span class="text-blue-400 font-bold">canceledAt:</span> <span class="text-red-300">\${data.canceledAt || data.cancelledAt}</span>\\n\`;
                        }
                        formatted += \`\\n<span class="text-gray-500">--- Full Response ---</span>\\n\`;
                        formatted += JSON.stringify(data, null, 2);
                    } else {
                        formatted = JSON.stringify(result.helix_response, null, 2);
                    }
                    outputEl.innerHTML = formatted;

                    // Show DB update banner if auto-cancel fired
                    if (result.db_update) {
                        const u = result.db_update;
                        let dbLines = [];
                        if (!u.found) dbLines.push('SIM not found in DB for this sub ID');
                        else {
                            dbLines.push(\`ICCID: \${u.iccid}\`);
                            if (u.status_updated) dbLines.push(\`Status: \${u.previous_status} → canceled\`);
                            else if (u.status_already_canceled) dbLines.push('Status: already canceled in DB');
                            if (u.history_inserted) dbLines.push(\`Cancel date recorded: \${u.canceled_at}\`);
                            else if (u.history_exists) dbLines.push(\`Cancel date already in history: \${u.canceled_at}\`);
                            else if (u.no_cancel_date) dbLines.push('No canceledAt in Helix response — history not inserted');
                            if (u.error) dbLines.push(\`Error: \${u.error}\`);
                        }
                        dbOutput.textContent = dbLines.join('\\n');
                        dbBanner.classList.remove('hidden');
                    }

                    resultDiv.classList.remove('hidden');
                } else {
                    outputEl.innerHTML = \`<span class="text-red-400">Error:</span> \${JSON.stringify(result, null, 2)}\`;
                    resultDiv.classList.remove('hidden');
                }
            } catch (error) {
                showToast('Error querying Helix', 'error');
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Query';
            }
        }

        let _bulkNextOffset = 0;

        async function queryHelixBulk(offset) {
            const btn = document.getElementById('helix-bulk-btn');
            const nextBtn = document.getElementById('helix-bulk-next-btn');
            btn.disabled = true;
            btn.textContent = 'Running...';
            if (nextBtn) nextBtn.disabled = true;
            document.getElementById('helix-query-result').classList.add('hidden');
            document.getElementById('helix-bulk-result').classList.remove('hidden');
            document.getElementById('helix-bulk-summary').innerHTML = \`<div class="col-span-4 text-sm text-gray-400 py-2">Querying Helix... this may take up to 30 seconds.</div>\`;
            document.getElementById('helix-bulk-changed').classList.add('hidden');
            document.getElementById('helix-bulk-more').classList.add('hidden');

            try {
                const response = await fetch(\`\${API_BASE}/helix-query-bulk\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ limit: 100, offset: offset || 0 })
                });
                const result = await response.json();

                if (!response.ok || result.error) {
                    document.getElementById('helix-bulk-summary').innerHTML =
                        \`<div class="col-span-4 text-sm text-red-400">Error: \${result.error || 'Unknown error'}</div>\`;
                    return;
                }

                _bulkNextOffset = result.next_offset || 0;

                const stats = [
                    { label: 'Queried', value: result.processed, color: 'text-white' },
                    { label: 'Cancelled Found', value: result.cancelled_found, color: result.cancelled_found > 0 ? 'text-red-400' : 'text-gray-400' },
                    { label: 'DB Updated', value: result.db_updated, color: result.db_updated > 0 ? 'text-yellow-400' : 'text-gray-400' },
                    { label: 'Errors', value: result.errors, color: result.errors > 0 ? 'text-orange-400' : 'text-gray-400' },
                ];
                document.getElementById('helix-bulk-summary').innerHTML = stats.map(s =>
                    \`<div class="bg-dark-900 rounded-lg p-3 text-center border border-dark-600">
                        <div class="text-xl font-bold \${s.color}">\${s.value}</div>
                        <div class="text-xs text-gray-500 mt-1">\${s.label}</div>
                    </div>\`
                ).join('');

                if (result.changed && result.changed.length > 0) {
                    document.getElementById('helix-bulk-changed-output').textContent = JSON.stringify(result.changed, null, 2);
                    document.getElementById('helix-bulk-changed').classList.remove('hidden');
                }

                if (result.has_more) {
                    const moreEl = document.getElementById('helix-bulk-more');
                    moreEl.classList.remove('hidden');
                    moreEl.querySelector('button').textContent =
                        \`Run Next Batch (\${result.next_offset}–\${Math.min(result.next_offset + 100, result.total_eligible)} of \${result.total_eligible})\`;
                }

                if (result.cancelled_found > 0) {
                    showToast(\`\${result.cancelled_found} cancelled line\${result.cancelled_found > 1 ? 's' : ''} found — \${result.db_updated} DB updated\`, 'warning');
                } else {
                    showToast(\`Bulk query done — \${result.processed} SIMs checked, none cancelled\`, 'success');
                }

            } catch (error) {
                document.getElementById('helix-bulk-summary').innerHTML =
                    \`<div class="col-span-4 text-sm text-red-400">Error: \${error.message}</div>\`;
                console.error(error);
            } finally {
                btn.disabled = false;
                btn.textContent = 'Bulk Query All SIMs';
                if (nextBtn) nextBtn.disabled = false;
            }
        }

        function queryHelixBulkNext() {
            queryHelixBulk(_bulkNextOffset);
        }`;

if (!content.includes(OLD_JS)) {
  console.error('PATCH FAILED: JS functions not found');
  process.exit(1);
}
content = content.replace(OLD_JS, NEW_JS);
console.log('✓ JS functions updated');

// ─── Write back ──────────────────────────────────────────────────────────────

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written');
console.log('Now run: node --input-type=module --check < src/dashboard/index.js');
