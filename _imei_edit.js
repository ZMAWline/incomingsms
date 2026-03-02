const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Track changes
let changes = 0;
function replace(label, search, replacement) {
  if (typeof search === 'string') {
    if (!content.includes(search)) {
      console.log(`SKIP (not found): ${label}`);
      return false;
    }
    content = content.replace(search, replacement);
  } else {
    if (!search.test(content)) {
      console.log(`SKIP (regex not found): ${label}`);
      return false;
    }
    content = content.replace(search, replacement);
  }
  changes++;
  console.log(`OK: ${label}`);
  return true;
}

// 1. Update handleImeiPoolGet to include gateway_id, port
replace(
  'Add gateway_id,port to imei_pool query',
  /imei_pool\?select=id,imei,status,sim_id,assigned_at,previous_sim_id,notes,created_at,sims!imei_pool_sim_id_fkey\(iccid,port\)&order=id\.desc/,
  'imei_pool?select=id,imei,status,sim_id,gateway_id,port,assigned_at,previous_sim_id,notes,created_at,sims!imei_pool_sim_id_fkey(iccid,port)&order=id.desc'
);

// 2. Add 'blocked' to stats
replace(
  'Add blocked stat',
  /retired: pool\.filter\(e => e\.status === 'retired'\)\.length,/,
  `retired: pool.filter(e => e.status === 'retired').length,
      blocked: pool.filter(e => e.status === 'blocked').length,`
);

// 3. Replace handleImportGatewayImeis entirely with a sync function
// Find the function and replace it up to its closing catch
const importFuncRegex = /async function handleImportGatewayImeis\(request, env, corsHeaders\) \{[\s\S]*?^\s*\} catch \(error\) \{\s*\n\s*return new Response\(JSON\.stringify\(\{ error: String\(error\) \}\), \{\s*\n\s*status: 500,/m;

const newImportFunc = `async function handleImportGatewayImeis(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const gatewayId = body.gateway_id;

    if (!gatewayId) {
      return new Response(JSON.stringify({ error: 'gateway_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SKYLINE_GATEWAY) {
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY service binding not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!env.SKYLINE_SECRET) {
      return new Response(JSON.stringify({ error: 'SKYLINE_SECRET not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Fetch all port data with all_slots=1
    const infoParams = new URLSearchParams({
      gateway_id: gatewayId,
      secret: env.SKYLINE_SECRET,
      all_slots: '1',
    });
    const infoRes = await env.SKYLINE_GATEWAY.fetch(
      \`https://skyline-gateway/port-info?\${infoParams}\`,
      { method: 'GET' }
    );
    const infoText = await infoRes.text();
    let infoData;
    try { infoData = JSON.parse(infoText); } catch {
      return new Response(JSON.stringify({ error: \`Non-JSON from skyline-gateway: \${infoText.slice(0, 200)}\` }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!infoData.ok) {
      return new Response(JSON.stringify({ error: infoData.error || 'Gateway returned error', detail: infoData }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const ports = infoData.ports || [];

    // Extract unique valid IMEIs from gateway
    const gatewayImeis = new Map(); // imei -> { port, slot, iccid, sim_id }
    for (const p of ports) {
      const imei = (p.imei || '').trim();
      if (!imei || !/^\\d{15}$/.test(imei)) continue;
      if (!gatewayImeis.has(imei)) {
        gatewayImeis.set(imei, { port: p.port, slot: p.slot, iccid: p.iccid, sim_id: p.sim_id });
      }
    }

    // Get existing pool entries for this gateway
    const existingRes = await supabaseGet(env, \`imei_pool?select=id,imei,status,gateway_id,port&gateway_id=eq.\${gatewayId}\`);
    const existing = await existingRes.json();
    const existingByImei = new Map();
    for (const e of (existing || [])) existingByImei.set(e.imei, e);

    // Also get pool entries matching any of these IMEIs (might exist without gateway_id)
    const allPoolRes = await supabaseGet(env, 'imei_pool?select=id,imei,status,gateway_id,port');
    const allPool = await allPoolRes.json();
    const poolByImei = new Map();
    for (const e of (allPool || [])) poolByImei.set(e.imei, e);

    let added = 0, updated = 0, released = 0;

    // Upsert: for each gateway IMEI, ensure it's in pool as in_use with correct gateway/port
    for (const [imei, info] of gatewayImeis) {
      const poolEntry = poolByImei.get(imei);
      if (poolEntry) {
        // Update existing entry: set status=in_use, gateway_id, port
        if (poolEntry.status !== 'in_use' || poolEntry.gateway_id !== gatewayId || poolEntry.port !== info.port) {
          const patchBody = { status: 'in_use', gateway_id: gatewayId, port: info.port, updated_at: new Date().toISOString() };
          if (poolEntry.status === 'blocked') {
            // Don't override blocked status
            delete patchBody.status;
          }
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.\${poolEntry.id}\`, {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify(patchBody),
          });
          updated++;
        }
      } else {
        // New IMEI — insert as in_use
        await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool\`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify({
            imei, status: 'in_use', gateway_id: gatewayId, port: info.port,
            notes: \`Imported from gateway \${gatewayId} port \${info.port}\`,
          }),
        });
        added++;
      }
    }

    // Release: IMEIs that were in_use on this gateway but no longer on it
    for (const [imei, entry] of existingByImei) {
      if (!gatewayImeis.has(imei) && entry.status === 'in_use') {
        await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.\${entry.id}\`, {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ status: 'available', gateway_id: null, port: null, sim_id: null, updated_at: new Date().toISOString() }),
        });
        released++;
      }
    }

    // Backfill sims.imei for active slots
    let backfilled = 0;
    for (const [imei, info] of gatewayImeis) {
      if (info.sim_id) {
        try {
          const patchRes = await fetch(
            \`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${encodeURIComponent(String(info.sim_id))}&imei=is.null\`,
            {
              method: 'PATCH',
              headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({ imei }),
            }
          );
          if (patchRes.ok) backfilled++;
        } catch {}
      }
    }

    // Link pool entries to sims
    let linked = 0;
    for (const [imei, info] of gatewayImeis) {
      if (info.sim_id) {
        try {
          const linkRes = await fetch(
            \`\${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.\${encodeURIComponent(imei)}\`,
            {
              method: 'PATCH',
              headers: {
                apikey: env.SUPABASE_SERVICE_ROLE_KEY,
                Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify({ sim_id: info.sim_id }),
            }
          );
          if (linkRes.ok) linked++;
        } catch {}
      }
    }

    return new Response(JSON.stringify({
      ok: true, gateway_id: gatewayId,
      total_ports: ports.length, gateway_imeis: gatewayImeis.size,
      added, updated, released,
      backfilled_sims: backfilled, linked_to_sims: linked,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,`;

replace('Replace handleImportGatewayImeis', importFuncRegex, newImportFunc);

// 4. Update handleImeiPoolPost to support 'block' and 'unblock' actions
replace(
  'Add block/unblock actions',
  /return new Response\(JSON\.stringify\(\{ error: 'Unknown action\. Use "add" or "retire"' \}\)/,
  `if (action === 'block') {
      const id = body.id;
      if (!id) {
        return new Response(JSON.stringify({ error: 'id is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const patchRes = await fetch(
        \`\${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.\${id}\`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ status: 'blocked', updated_at: new Date().toISOString() }),
        }
      );
      const patchText = await patchRes.text();
      let patched = [];
      try { patched = JSON.parse(patchText); } catch {}
      return new Response(JSON.stringify({ ok: true, blocked: patched[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (action === 'unblock') {
      const id = body.id;
      if (!id) {
        return new Response(JSON.stringify({ error: 'id is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const patchRes = await fetch(
        \`\${env.SUPABASE_URL}/rest/v1/imei_pool?id=eq.\${id}&status=eq.blocked\`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ status: 'available', updated_at: new Date().toISOString() }),
        }
      );
      const patchText = await patchRes.text();
      let patched = [];
      try { patched = JSON.parse(patchText); } catch {}
      if (patched.length === 0) {
        return new Response(JSON.stringify({ error: 'IMEI not found or not blocked' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true, unblocked: patched[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action. Use "add", "retire", "block", or "unblock"' })`
);

// 5. Update the IMEI pool HTML stats row — add Blocked stat card
replace(
  'Add blocked stat card',
  /<div class="bg-dark-800 rounded-xl p-4 border border-dark-600">\s*\n\s*<span class="text-sm text-gray-400">Retired<\/span>\s*\n\s*<p class="text-2xl font-bold text-gray-500" id="imei-retired">-<\/p>\s*\n\s*<\/div>/,
  `<div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400">Retired</span>
                        <p class="text-2xl font-bold text-gray-500" id="imei-retired">-</p>
                    </div>
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400">Blocked</span>
                        <p class="text-2xl font-bold text-red-400" id="imei-blocked">-</p>
                    </div>`
);

// 6. Update stats grid from grid-cols-4 to grid-cols-5
replace(
  'Update stats grid cols',
  /grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">\s*\n\s*<div class="bg-dark-800 rounded-xl p-4 border border-dark-600">\s*\n\s*<span class="text-sm text-gray-400">Total<\/span>/,
  `grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                    <div class="bg-dark-800 rounded-xl p-4 border border-dark-600">
                        <span class="text-sm text-gray-400">Total</span>`
);

// 7. Add 'blocked' to status filter dropdown
replace(
  'Add blocked to status filter',
  '<option value="retired">Retired</option>',
  `<option value="retired">Retired</option>
                            <option value="blocked">Blocked</option>`
);

// 8. Update table headers to include Gateway and Port columns
replace(
  'Update IMEI table headers',
  /onclick="sortTable\('imei','status'\)">Status[\s\S]*?<th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable\('imei','sim_id'\)">/,
  `onclick="sortTable('imei','status')">Status <span class="sort-arrow" data-table="imei" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','gateway_id')">Gateway <span class="sort-arrow" data-table="imei" data-col="gateway_id"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','port')">Port <span class="sort-arrow" data-table="imei" data-col="port"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('imei','sim_id')">`
);

// 9. Update colspan from 6 to 8
replace('Update loading colspan', 'colspan="6" class="px-4 py-4 text-center text-gray-500">Loading...', 'colspan="8" class="px-4 py-4 text-center text-gray-500">Loading...');
replace('Update empty colspan', 'colspan="6" class="px-4 py-4 text-center text-gray-500">No IMEIs match filters', 'colspan="8" class="px-4 py-4 text-center text-gray-500">No IMEIs match filters');

// 10. Update renderImeiPool JS to show gateway, port, blocked stats, and action buttons
replace(
  'Add blocked stat to render',
  /document\.getElementById\('imei-retired'\)\.textContent = stats\.retired \|\| 0;/,
  `document.getElementById('imei-retired').textContent = stats.retired || 0;
            document.getElementById('imei-blocked').textContent = stats.blocked || 0;`
);

// 11. Update the row rendering to include gateway/port columns and block/unblock buttons
replace(
  'Update row rendering',
  /const statusClass = \{[\s\S]*?'retired': 'bg-gray-500\/20 text-gray-400',[\s\S]*?\}\[entry\.status\] \|\| 'bg-gray-500\/20 text-gray-400';/,
  `const statusClass = {
                    'available': 'bg-accent/20 text-accent',
                    'in_use': 'bg-blue-500/20 text-blue-400',
                    'retired': 'bg-gray-500/20 text-gray-400',
                    'blocked': 'bg-red-500/20 text-red-400',
                }[entry.status] || 'bg-gray-500/20 text-gray-400';`
);

// 12. Update the table row template with new columns
replace(
  'Update row template with gateway/port',
  /return \\\`\s*\n\s*<tr class="border-b border-dark-600[\s\S]*?<td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \\\$\{statusClass\}">\\\$\{entry\.status\}<\/span><\/td>\s*\n\s*<td class="px-4 py-3 text-gray-400 text-xs">\\\$\{entry\.status === 'in_use' \? simInfo : '-'\}<\/td>\s*\n\s*<td class="px-4 py-3 text-gray-500 text-xs">\\\$\{entry\.status === 'in_use' \? assignedAt : '-'\}<\/td>\s*\n\s*<td class="px-4 py-3">\s*\n\s*\\\$\{canRetire[\s\S]*?<\/td>\s*\n\s*<\/tr>/,
  `return \\\`
                <tr class="border-b border-dark-600 hover:bg-dark-700/50 transition">
                    <td class="px-4 py-3 text-gray-400">\\\${entry.id}</td>
                    <td class="px-4 py-3 font-mono text-sm text-gray-200">\\\${entry.imei}</td>
                    <td class="px-4 py-3"><span class="px-2 py-1 text-xs font-medium rounded-full \\\${statusClass}">\\\${entry.status}</span></td>
                    <td class="px-4 py-3 text-gray-400 text-xs">\\\${entry.gateway_id ? 'GW ' + entry.gateway_id : '-'}</td>
                    <td class="px-4 py-3 text-gray-400 text-xs">\\\${entry.port != null ? entry.port : '-'}</td>
                    <td class="px-4 py-3 text-gray-400 text-xs">\\\${entry.status === 'in_use' ? simInfo : '-'}</td>
                    <td class="px-4 py-3 text-gray-500 text-xs">\\\${entry.status === 'in_use' ? assignedAt : '-'}</td>
                    <td class="px-4 py-3">
                        \\\${entry.status === 'available' ? '<button onclick="retireImei(' + entry.id + ')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition mr-1">Retire</button>' : ''}
                        \\\${entry.status !== 'blocked' ? '<button onclick="blockImei(' + entry.id + ')" class="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded transition">Block</button>' : '<button onclick="unblockImei(' + entry.id + ')" class="px-2 py-1 text-xs bg-green-600 hover:bg-green-700 text-white rounded transition">Unblock</button>'}
                    </td>
                </tr>\\\``
);

// 13. Add block/unblock JS functions after retireImei
replace(
  'Add block/unblock functions',
  /if \(document\.getElementById\('tab-imei-pool'\) && !document\.getElementById\('tab-imei-pool'\)\.classList\.contains\('hidden'\)\) \{\s*\n\s*loadImeiPool\(\);\s*\n\s*\}/,
  `if (document.getElementById('tab-imei-pool') && !document.getElementById('tab-imei-pool').classList.contains('hidden')) {
                    loadImeiPool();
                }
            }

            async function blockImei(id) {
                if (!confirm('Mark this IMEI as blocked by ATT?')) return;
                try {
                    const response = await fetch(\\\`\\\${API_BASE}/imei-pool\\\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ action: 'block', id })
                    });
                    const data = await response.json();
                    if (data.ok) {
                        loadImeiPool();
                    } else {
                        alert(data.error || 'Failed to block IMEI');
                    }
                } catch (e) { alert('Error: ' + e.message); }
            }

            async function unblockImei(id) {
                if (!confirm('Unblock this IMEI?')) return;
                try {
                    const response = await fetch(\\\`\\\${API_BASE}/imei-pool\\\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ action: 'unblock', id })
                    });
                    const data = await response.json();
                    if (data.ok) {
                        loadImeiPool();
                    } else {
                        alert(data.error || 'Failed to unblock IMEI');
                    }
                } catch (e) { alert('Error: ' + e.message); }`
);

// 14. Add "Sync from Gateways" button next to "+ Add IMEIs"
replace(
  'Add sync button',
  `<button onclick="showAddImeiModal()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add IMEIs</button>`,
  `<button onclick="syncGatewayImeis()" class="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">Sync from Gateways</button>
                        <button onclick="showAddImeiModal()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add IMEIs</button>`
);

// 15. Add syncGatewayImeis function near loadImeiPool
replace(
  'Add syncGatewayImeis function',
  'async function loadImeiPool() {',
  `async function syncGatewayImeis() {
            if (!confirm('Sync IMEIs from both gateways? This will update statuses to match current gateway state.')) return;
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Syncing...';
            try {
                let totalAdded = 0, totalUpdated = 0, totalReleased = 0;
                for (const gwId of [1, 2]) {
                    btn.textContent = \\\`Syncing GW \\\${gwId}...\\\`;
                    const res = await fetch(\\\`\\\${API_BASE}/import-gateway-imeis\\\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...authHeaders() },
                        body: JSON.stringify({ gateway_id: gwId })
                    });
                    const data = await res.json();
                    if (data.ok) {
                        totalAdded += data.added || 0;
                        totalUpdated += data.updated || 0;
                        totalReleased += data.released || 0;
                    } else {
                        alert(\\\`Gateway \\\${gwId} sync error: \\\${data.error}\\\`);
                    }
                }
                alert(\\\`Sync complete. Added: \\\${totalAdded}, Updated: \\\${totalUpdated}, Released: \\\${totalReleased}\\\`);
                loadImeiPool();
            } catch (e) { alert('Sync error: ' + e.message); }
            btn.disabled = false;
            btn.textContent = 'Sync from Gateways';
        }

        async function loadImeiPool() {`
);

// 16. Also need to update allocateImeiFromPool in mdn-rotator to skip blocked IMEIs
// That's in a different file, will handle separately

fs.writeFileSync(filePath, content);
console.log(`\nDone. ${changes} changes applied.`);
