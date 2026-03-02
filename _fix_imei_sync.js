// Patch script: IMEI pool sync source-of-truth overhaul
// Run: node _fix_imei_sync.js
// Changes:
//   1. Add /api/imei-pool/fix-slot route
//   2. handleImeiPoolPost add action: reject retired IMEIs, use ignore-duplicates
//   3. handleImportGatewayImeis: slot-aware discrepancy detection
//   4. New handleImeiPoolFixSlot backend handler
//   5. Frontend syncAllGatewayImeis: accumulate + show discrepancy modal
//   6. Frontend importGatewayImeis: show discrepancy modal
//   7. New frontend helpers: fixSlot, fixAllSlots, showDiscrepancyModal

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

function apply(label, oldStr, newStr) {
  if (!content.includes(oldStr)) {
    console.error('NOT FOUND: ' + label);
    console.error('Sample: ' + JSON.stringify(oldStr.slice(0, 120)));
    process.exit(1);
  }
  content = content.replace(oldStr, newStr);
  console.log('OK: ' + label);
}

function replaceFunc(label, startMarker, endMarker, newBody) {
  const start = content.indexOf(startMarker);
  if (start === -1) { console.error('START NOT FOUND: ' + label); process.exit(1); }
  const end = content.indexOf(endMarker, start);
  if (end === -1) { console.error('END NOT FOUND: ' + label + ' | end=' + JSON.stringify(endMarker.slice(0, 60))); process.exit(1); }
  content = content.slice(0, start) + newBody + content.slice(end);
  console.log('OK (replaceFunc): ' + label);
}

function insertBefore(label, marker, insertion) {
  const idx = content.indexOf(marker);
  if (idx === -1) { console.error('MARKER NOT FOUND: ' + label); process.exit(1); }
  content = content.slice(0, idx) + insertion + content.slice(idx);
  console.log('OK (insertBefore): ' + label);
}

// ============================================================
// CHANGE 1: Add /api/imei-pool/fix-slot route
// ============================================================
apply('fix-slot route',
  "    if (url.pathname === '/api/import-gateway-imeis' && request.method === 'POST') {\n      return handleImportGatewayImeis(request, env, corsHeaders);\n    }",
  "    if (url.pathname === '/api/import-gateway-imeis' && request.method === 'POST') {\n      return handleImportGatewayImeis(request, env, corsHeaders);\n    }\n\n    if (url.pathname === '/api/imei-pool/fix-slot' && request.method === 'POST') {\n      return handleImeiPoolFixSlot(request, env, corsHeaders);\n    }"
);

// ============================================================
// CHANGE 2: handleImeiPoolPost add action - reject retired IMEIs
// ============================================================
const newAddBody = `      // Check for retired IMEIs — retired IMEIs cannot be reused
      const imeiValues = valid.map(v => v.imei);
      const existingRes = await fetch(
        \`\${env.SUPABASE_URL}/rest/v1/imei_pool?imei=in.(\${imeiValues.join(',')})&select=imei,status\`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
          },
        }
      );
      const existingRows = existingRes.ok ? await existingRes.json() : [];
      const retiredSet = new Set(existingRows.filter(r => r.status === 'retired').map(r => r.imei));
      const inPoolSet = new Set(existingRows.filter(r => r.status !== 'retired').map(r => r.imei));

      const rejectedRetired = valid.filter(v => retiredSet.has(v.imei)).map(v => v.imei);
      const toAdd = valid.filter(v => !retiredSet.has(v.imei) && !inPoolSet.has(v.imei));
      const dupCount = valid.filter(v => inPoolSet.has(v.imei)).length;

      if (rejectedRetired.length > 0 && toAdd.length === 0) {
        return new Response(JSON.stringify({
          error: 'All submitted IMEIs have been retired and cannot be reused: ' + rejectedRetired.join(', '),
          rejected_retired: rejectedRetired,
        }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      let added = 0;
      if (toAdd.length > 0) {
        const addInsertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?on_conflict=imei\`, {
          method: 'POST',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(toAdd),
        });
        const addInsertText = await addInsertRes.text();
        let addInserted = [];
        try { addInserted = JSON.parse(addInsertText); } catch { }
        added = Array.isArray(addInserted) ? addInserted.length : 0;
      }

      return new Response(JSON.stringify({
        ok: true,
        added,
        duplicates: dupCount,
        invalid: invalid.length,
        rejected_retired: rejectedRetired,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }`;

replaceFunc('imei add action reject retired',
  '      // Bulk insert, ignoring duplicates',
  '\n\n    if (action === \'retire\') {',
  newAddBody
);

// ============================================================
// CHANGE 3: handleImportGatewayImeis - slot-aware discrepancy detection
// ============================================================
const newHandleImport = `async function handleImportGatewayImeis(request, env, corsHeaders) {
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

    // Fetch all port data with all_slots=1 to get every IMEI (including inactive slots)
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
    const totalPorts = ports.length;

    // Query DB for all in_use IMEIs for this gateway (DB is the source of truth)
    const dbRes = await fetch(
      \`\${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.\${encodeURIComponent(gatewayId)}&status=eq.in_use&select=imei,port\`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
        },
      }
    );
    const dbRows = dbRes.ok ? await dbRes.json() : [];

    // Build map: normalizedPort -> dbImei
    const dbSlotMap = {};
    for (const row of dbRows) {
      if (row.port) dbSlotMap[normalizeImeiPoolPort(row.port)] = row.imei;
    }

    // Process gateway ports: compare against DB slot map
    const seen = new Set();
    const toInsert = [];
    const discrepancies = [];
    let skippedNoImei = 0;
    let inSync = 0;
    const simImeiMap = [];

    for (const p of ports) {
      const imei = (p.imei || '').trim();
      if (!imei || !/^\\d{15}$/.test(imei)) {
        skippedNoImei++;
        continue;
      }
      const normPort = p.port ? normalizeImeiPoolPort(p.port) : null;

      if (normPort && Object.prototype.hasOwnProperty.call(dbSlotMap, normPort)) {
        const dbImei = dbSlotMap[normPort];
        if (dbImei === imei) {
          // Already in sync — no action needed
          inSync++;
        } else {
          // Discrepancy: DB says dbImei, gateway has imei — DB wins
          discrepancies.push({ port: normPort, db_imei: dbImei, gateway_imei: imei });
        }
        // Either way, skip insertion — DB is authoritative for this slot
      } else {
        // No DB entry for this slot — add as new
        if (!seen.has(imei)) {
          seen.add(imei);
          toInsert.push({
            imei,
            status: 'in_use',
            gateway_id: parseInt(gatewayId),
            port: normPort || p.port || null,
            notes: \`Imported from gateway \${gatewayId} port \${p.port}\${p.iccid ? ' iccid=' + p.iccid : ''}\`,
          });
        }
      }

      // Track sim_id -> IMEI for backfilling
      if (p.iccid && p.sim_id) {
        simImeiMap.push({ sim_id: p.sim_id, imei });
      }
    }

    // Insert new IMEIs (slots not yet in DB)
    let inserted = 0;
    if (toInsert.length > 0) {
      const insertRes = await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool\`, {
        method: 'POST',
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify(toInsert),
      });
      const insertText = await insertRes.text();
      let insertedArr = [];
      try { insertedArr = JSON.parse(insertText); } catch { }
      inserted = Array.isArray(insertedArr) ? insertedArr.length : 0;
    }

    // Backfill sims.imei for active slots that have a matched sim_id
    let backfilled = 0;
    for (const entry of simImeiMap) {
      try {
        const patchRes = await fetch(
          \`\${env.SUPABASE_URL}/rest/v1/sims?id=eq.\${encodeURIComponent(String(entry.sim_id))}&imei=is.null\`,
          {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ imei: entry.imei }),
          }
        );
        if (patchRes.ok) backfilled++;
      } catch { }
    }

    // Link sim_id on imei_pool entries for active SIM slots
    let linked = 0;
    for (const entry of simImeiMap) {
      try {
        const linkRes = await fetch(
          \`\${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.\${encodeURIComponent(entry.imei)}\`,
          {
            method: 'PATCH',
            headers: {
              apikey: env.SUPABASE_SERVICE_ROLE_KEY,
              Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ sim_id: entry.sim_id }),
          }
        );
        if (linkRes.ok) linked++;
      } catch { }
    }

    return new Response(JSON.stringify({
      ok: true,
      total_ports: totalPorts,
      skipped_no_imei: skippedNoImei,
      in_sync: inSync,
      added: inserted,
      discrepancies,
      backfilled_sims: backfilled,
      linked_to_sims: linked,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}`;

replaceFunc('handleImportGatewayImeis',
  'async function handleImportGatewayImeis(',
  '\nasync function handleErrors(',
  newHandleImport + '\n'
);

// ============================================================
// CHANGE 4: New handleImeiPoolFixSlot backend handler
// ============================================================
const newHandleFixSlot = `async function handleImeiPoolFixSlot(request, env, corsHeaders) {
  try {
    const body = await request.json();
    const { gateway_id, port, db_imei, gateway_imei } = body;

    if (!gateway_id || !port || !db_imei || !gateway_imei) {
      return new Response(JSON.stringify({ error: 'gateway_id, port, db_imei, gateway_imei are all required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Verify db_imei exists in pool and is in_use
    const verifyRes = await fetch(
      \`\${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.\${encodeURIComponent(db_imei)}&select=imei,status,gateway_id,port\`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\` } }
    );
    const verifyRows = verifyRes.ok ? await verifyRes.json() : [];
    const dbRow = verifyRows[0];

    if (!dbRow) {
      return new Response(JSON.stringify({ error: \`IMEI \${db_imei} not found in pool\` }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (dbRow.status !== 'in_use') {
      return new Response(JSON.stringify({ error: \`IMEI \${db_imei} is not in_use (status: \${dbRow.status})\` }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Check for conflict: db_imei assigned to a different gateway/port
    const normPort = normalizeImeiPoolPort(port);
    const normDbPort = normalizeImeiPoolPort(dbRow.port);
    if (String(dbRow.gateway_id) !== String(gateway_id) || normDbPort !== normPort) {
      return new Response(JSON.stringify({
        error: \`Conflict: IMEI \${db_imei} is in_use on gateway \${dbRow.gateway_id} port \${dbRow.port}, not \${gateway_id}/\${port}. Resolve this manually.\`,
        conflict: { gateway_id: dbRow.gateway_id, port: dbRow.port },
      }), { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (!env.SKYLINE_GATEWAY || !env.SKYLINE_SECRET) {
      return new Response(JSON.stringify({ error: 'SKYLINE_GATEWAY or SKYLINE_SECRET not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Push db_imei to the gateway slot via skyline-gateway
    const setParams = new URLSearchParams({ secret: env.SKYLINE_SECRET });
    const setRes = await env.SKYLINE_GATEWAY.fetch(
      \`https://skyline-gateway/set-imei?\${setParams}\`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway_id, port, imei: db_imei }),
      }
    );
    const setData = await setRes.json();
    if (!setData.ok) {
      return new Response(JSON.stringify({
        error: 'Gateway rejected IMEI push: ' + (setData.error || JSON.stringify(setData)),
        skyline_response: setData,
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Retire the gateway's current IMEI in pool (if it exists and isn't already retired)
    let retired = false;
    if (gateway_imei && gateway_imei !== db_imei) {
      const retireRes = await fetch(
        \`\${env.SUPABASE_URL}/rest/v1/imei_pool?imei=eq.\${encodeURIComponent(gateway_imei)}&status=neq.retired\`,
        {
          method: 'PATCH',
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: \`Bearer \${env.SUPABASE_SERVICE_ROLE_KEY}\`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ status: 'retired' }),
        }
      );
      retired = retireRes.ok;
    }

    return new Response(JSON.stringify({
      ok: true,
      message: \`IMEI \${db_imei} pushed to gateway \${gateway_id} port \${port}\`,
      gateway_imei_retired: retired,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
`;

insertBefore('handleImeiPoolFixSlot before handleErrors',
  'async function handleErrors(',
  newHandleFixSlot
);

// ============================================================
// CHANGE 5: Frontend syncAllGatewayImeis - accumulate discrepancies
// ============================================================
const newSyncAll = `        async function syncAllGatewayImeis() {
            const btn = document.getElementById('sync-gateways-btn');
            btn.textContent = 'Syncing...';
            btn.disabled = true;
            try {
                const gwResp = await fetch(\\\`\\\${API_BASE}/gateways\\\`);
                const gateways = await gwResp.json();
                let totalAdded = 0, totalInSync = 0;
                const allDiscrepancies = [];
                for (const gw of gateways) {
                    try {
                        const res = await fetch(\\\`\\\${API_BASE}/import-gateway-imeis\\\`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ gateway_id: gw.id })
                        });
                        const data = await res.json();
                        if (data.ok) {
                            totalAdded += data.added || 0;
                            totalInSync += data.in_sync || 0;
                            if (data.discrepancies && data.discrepancies.length > 0) {
                                data.discrepancies.forEach(d => allDiscrepancies.push(Object.assign({}, d, { gateway_id: gw.id, gateway_name: gw.name || gw.code })));
                            }
                        }
                    } catch {}
                }
                showToast(\\\`Sync complete: \\\${totalAdded} added, \\\${totalInSync} in sync\\\`, 'success');
                if (allDiscrepancies.length > 0) showDiscrepancyModal(allDiscrepancies);
                loadImeiPool();
            } catch (error) {
                showToast('Sync error: ' + error, 'error');
            } finally {
                btn.textContent = 'Sync from Gateways';
                btn.disabled = false;
            }
        }`;

replaceFunc('frontend syncAllGatewayImeis',
  '        async function syncAllGatewayImeis() {',
  '\n\n        async function unretireImei(',
  newSyncAll
);

// ============================================================
// CHANGE 6: Frontend importGatewayImeis - show discrepancy modal
// ============================================================
const newImportGw = `        async function importGatewayImeis() {
            const gatewayId = document.getElementById('gw-select').value;
            if (!gatewayId) {
                showToast('Select a gateway first', 'error');
                return;
            }

            const btn = document.getElementById('gw-import-imei-btn');
            const origLabel = btn.querySelector('span').textContent;
            btn.querySelector('span').textContent = 'Importing...';
            btn.disabled = true;

            try {
                const res = await fetch(\\\`\\\${API_BASE}/import-gateway-imeis\\\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),
                });
                const data = await res.json();

                if (!res.ok || !data.ok) {
                    showToast(data.error || 'Import failed', 'error');
                    return;
                }

                const msg = \\\`Added \\\${data.added} IMEIs (\\\${data.in_sync} in sync, \\\${data.skipped_no_imei} slots had no IMEI)\\\`;
                showToast(msg, 'success');

                if (data.discrepancies && data.discrepancies.length > 0) {
                    const gwSelect = document.getElementById('gw-select');
                    const selOpt = gwSelect.options[gwSelect.selectedIndex];
                    const gwName = selOpt ? selOpt.text : ('Gateway ' + gatewayId);
                    const tagged = data.discrepancies.map(d => Object.assign({}, d, { gateway_id: parseInt(gatewayId), gateway_name: gwName }));
                    showDiscrepancyModal(tagged);
                }

                if (document.getElementById('tab-imei-pool') && !document.getElementById('tab-imei-pool').classList.contains('hidden')) {
                    loadImeiPool();
                }
            } catch (err) {
                showToast('Import error: ' + err, 'error');
            } finally {
                btn.querySelector('span').textContent = origLabel;
                btn.disabled = false;
            }
        }`;

replaceFunc('frontend importGatewayImeis',
  '        async function importGatewayImeis() {',
  '\n\n        async function loadImeiPool(',
  newImportGw
);

// ============================================================
// CHANGE 7: New frontend helpers: fixSlot, fixAllSlots, showDiscrepancyModal
// ============================================================
const newFrontendHelpers = `        async function fixSlot(gateway_id, port, db_imei, gateway_imei, btn) {
            btn.textContent = 'Fixing...';
            btn.disabled = true;
            try {
                const res = await fetch(\\\`\\\${API_BASE}/imei-pool/fix-slot\\\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gateway_id, port, db_imei, gateway_imei }),
                });
                const data = await res.json();
                if (data.ok) {
                    btn.textContent = 'Fixed \u2713';
                    btn.disabled = true;
                    btn.style.background = '#15803d';
                } else {
                    btn.textContent = 'Fix';
                    btn.disabled = false;
                    showToast('Fix failed: ' + (data.error || 'Unknown error'), 'error');
                }
            } catch (err) {
                btn.textContent = 'Fix';
                btn.disabled = false;
                showToast('Fix error: ' + err, 'error');
            }
        }

        async function fixAllSlots() {
            const list = window._discrepancies || [];
            for (let i = 0; i < list.length; i++) {
                const btn = document.getElementById('fix-btn-' + i);
                if (btn && !btn.disabled) {
                    await fixSlot(list[i].gateway_id, list[i].port, list[i].db_imei, list[i].gateway_imei, btn);
                }
            }
            loadImeiPool();
        }

        function showDiscrepancyModal(discrepancies) {
            const existing = document.getElementById('discrepancy-modal');
            if (existing) existing.remove();
            window._discrepancies = discrepancies;

            const modal = document.createElement('div');
            modal.id = 'discrepancy-modal';
            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';

            const container = document.createElement('div');
            container.className = 'bg-gray-800 rounded-xl shadow-xl max-w-3xl w-full max-h-[80vh] flex flex-col';

            const headerDiv = document.createElement('div');
            headerDiv.className = 'flex items-center justify-between p-4 border-b border-gray-700';

            const title = document.createElement('h3');
            title.className = 'text-lg font-semibold text-white';
            title.textContent = 'IMEI Discrepancies (' + discrepancies.length + ')';

            const btnGroup = document.createElement('div');
            btnGroup.className = 'flex gap-2';

            const fixAllBtn = document.createElement('button');
            fixAllBtn.className = 'px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition';
            fixAllBtn.textContent = 'Fix All';
            fixAllBtn.onclick = fixAllSlots;

            const closeBtn = document.createElement('button');
            closeBtn.className = 'px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded transition';
            closeBtn.textContent = 'Close';
            closeBtn.onclick = function() {
                const m = document.getElementById('discrepancy-modal');
                if (m) m.remove();
            };

            btnGroup.appendChild(fixAllBtn);
            btnGroup.appendChild(closeBtn);
            headerDiv.appendChild(title);
            headerDiv.appendChild(btnGroup);

            const note = document.createElement('p');
            note.className = 'text-xs text-gray-400 px-4 pt-3';
            note.textContent = 'DB (green) is the source of truth. Fix pushes the DB IMEI to the gateway slot and retires the wrong IMEI.';

            const tableWrap = document.createElement('div');
            tableWrap.className = 'overflow-auto flex-1 p-4';

            const table = document.createElement('table');
            table.className = 'w-full text-sm text-left';
            table.innerHTML =
                '<thead><tr class="text-gray-400 text-xs border-b border-gray-700">' +
                '<th class="py-2 px-3">Gateway</th>' +
                '<th class="py-2 px-3">Port/Slot</th>' +
                '<th class="py-2 px-3">DB IMEI (correct)</th>' +
                '<th class="py-2 px-3">Gateway IMEI (wrong)</th>' +
                '<th class="py-2 px-3"></th>' +
                '</tr></thead><tbody></tbody>';

            const tbody = table.querySelector('tbody');
            discrepancies.forEach(function(d, i) {
                const tr = document.createElement('tr');
                tr.className = 'border-b border-gray-700';
                tr.innerHTML =
                    '<td class="py-2 px-3 text-gray-300">' + (d.gateway_name || 'GW ' + d.gateway_id) + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm">' + d.port + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm text-green-400">' + d.db_imei + '</td>' +
                    '<td class="py-2 px-3 font-mono text-sm text-red-400">' + d.gateway_imei + '</td>' +
                    '<td class="py-2 px-3"></td>';
                const fixBtn = document.createElement('button');
                fixBtn.id = 'fix-btn-' + i;
                fixBtn.className = 'px-3 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition';
                fixBtn.textContent = 'Fix';
                (function(gwId, p, dbI, gwI, b) {
                    b.onclick = function() { fixSlot(gwId, p, dbI, gwI, b); };
                })(d.gateway_id, d.port, d.db_imei, d.gateway_imei, fixBtn);
                tr.querySelector('td:last-child').appendChild(fixBtn);
                tbody.appendChild(tr);
            });

            tableWrap.appendChild(table);
            container.appendChild(headerDiv);
            container.appendChild(note);
            container.appendChild(tableWrap);
            modal.appendChild(container);
            document.body.appendChild(modal);
        }

`;

insertBefore('frontend helpers before unretireImei',
  '        async function unretireImei(',
  newFrontendHelpers
);

// ============================================================
// Write back with CRLF
// ============================================================
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('\nAll changes applied. Run syntax check next.');
