// _fix_teltik_query.js — add Teltik option to dashboard Carrier Query
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

function apply(label, OLD, NEW) {
  if (!content.includes(OLD)) {
    console.error('PATCH FAILED [' + label + ']: old string not found.');
    process.exit(1);
  }
  content = content.replace(OLD, NEW);
  console.log('OK: ' + label);
}

// ── 1. Add /api/teltik-query route ───────────────────────────────────────────
apply('route',
  `    if (url.pathname === '/api/atomic-query' && request.method === 'POST') {
      return handleAtomicQuery(request, env, corsHeaders);
    }

    // Serve HTML dashboard for all non-API paths (SPA routing)`,
  `    if (url.pathname === '/api/atomic-query' && request.method === 'POST') {
      return handleAtomicQuery(request, env, corsHeaders);
    }

    if (url.pathname === '/api/teltik-query' && request.method === 'POST') {
      return handleTeltikQuery(request, env, corsHeaders);
    }

    // Serve HTML dashboard for all non-API paths (SPA routing)`
);

// ── 2. Add handleTeltikQuery backend function ─────────────────────────────────
apply('backend-function',
  `async function syncCancelledSim(env, subId, helixData) {`,
  `async function handleTeltikQuery(request, env, corsHeaders) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }
  try {
    const { iccid } = await request.json();
    if (!iccid) {
      return new Response(JSON.stringify({ error: 'iccid required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const apiKey = env.TELTIK_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ ok: false, error: 'TELTIK_API_KEY not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    const teltikUrl = 'https://api.smsgateway.xyz/v1/get-phone-number/?apikey=' + encodeURIComponent(apiKey) + '&iccid=' + encodeURIComponent(iccid);
    const fetchUrl = env.RELAY_URL ? env.RELAY_URL + '/' + teltikUrl : teltikUrl;
    const fetchHeaders = {};
    if (env.RELAY_KEY) fetchHeaders['x-relay-key'] = env.RELAY_KEY;
    const res = await fetch(fetchUrl, { method: 'GET', headers: fetchHeaders });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    await logCarrierApiCall(env, {
      run_id: 'teltik_query_' + iccid + '_' + Date.now(),
      step: 'query',
      iccid,
      imei: null,
      vendor: 'teltik',
      request_url: 'https://api.smsgateway.xyz/v1/get-phone-number/?iccid=' + encodeURIComponent(iccid),
      request_method: 'GET',
      request_body: null,
      response_status: res.status,
      response_ok: res.ok,
      response_body_text: text,
      response_body_json: json,
      error: res.ok ? null : 'Teltik query failed: ' + res.status,
    });

    let db_update = null;
    if (res.ok && json) {
      const rawMdn = json.msisdn || json.mdn || json.phone_number || '';
      if (rawMdn) {
        db_update = await syncActiveSim(env, iccid, { mdn: rawMdn, activatedAt: null });
      }
    }

    return new Response(JSON.stringify({
      ok: res.ok,
      status: res.status,
      iccid,
      response: json || text,
      db_update,
    }, null, 2), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

async function syncCancelledSim(env, subId, helixData) {`
);

// ── 3. Add Teltik option to vendor <select> ───────────────────────────────────
apply('vendor-select-option',
  `                        <option value="wing_iot">Wing IoT (ICCID)</option>
                    </select>`,
  `                        <option value="wing_iot">Wing IoT (ICCID)</option>
                        <option value="teltik">Teltik (T-Mobile)</option>
                    </select>`
);

// ── 4. updateCarrierQueryUI — add teltik branch ───────────────────────────────
apply('updateCarrierQueryUI',
  `            } else if (vendor === 'atomic') {
                label.textContent = 'Enter ICCID or MDN (10-digit):';
                input.placeholder = 'ICCID (89010...) or MDN (9295551234)';
                bulkBtn.style.display = 'none';`,
  `            } else if (vendor === 'teltik') {
                label.textContent = 'Enter ICCID:';
                input.placeholder = 'e.g. 8901240497128314860';
                bulkBtn.style.display = 'none';
            } else if (vendor === 'atomic') {
                label.textContent = 'Enter ICCID or MDN (10-digit):';
                input.placeholder = 'ICCID (89010...) or MDN (9295551234)';
                bulkBtn.style.display = 'none';`
);

// ── 5. Empty-input toast — add teltik to ICCID case ──────────────────────────
apply('toast-validation',
  `showToast(vendor === 'wing_iot' ? 'Please enter an ICCID' : 'Please enter a Subscription ID', 'error');`,
  `showToast((vendor === 'wing_iot' || vendor === 'teltik') ? 'Please enter an ICCID' : 'Please enter a Subscription ID', 'error');`
);

// ── 6. queryHelix — add teltik branch before helix section ───────────────────
// Note: \\\\n in this template literal → \\n in the file → \n in browser JS (valid escape).
// \\u26A0 in template → \u26A0 in file → ⚠ in evaluated string.
apply('queryHelix-teltik-branch',
  `            // Helix query (original)
            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }`,
  `            // Teltik query
            if (vendor === 'teltik') {
                try {
                    const response = await fetch(API_BASE + '/teltik-query', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ iccid: inputVal })
                    });
                    const result = await response.json();
                    const outputEl = document.getElementById('helix-query-output');
                    const resultDiv = document.getElementById('helix-query-result');
                    document.getElementById('helix-db-update-banner').classList.add('hidden');
                    if (!result.ok) {
                        outputEl.innerHTML = '<span class="text-red-400">Error: ' + (result.error || 'Unknown') + '</span>';
                    } else {
                        const d = result.response;
                        let fmtd = '<span class="text-green-400 font-bold">Teltik MDN Found</span>\\\\n\\\\n';
                        fmtd += '<span class="text-blue-400">iccid:</span> ' + (d.iccid || result.iccid) + '\\\\n';
                        fmtd += '<span class="text-blue-400">msisdn:</span> ' + (d.msisdn || d.mdn || 'N/A') + '\\\\n';
                        fmtd += '\\\\n<span class="text-gray-500">--- Full Response ---</span>\\\\n';
                        fmtd += JSON.stringify(d, null, 2);
                        outputEl.innerHTML = fmtd;
                    }
                    const du = result.db_update;
                    if (du && du.found && du.mdn_updated) {
                        document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Auto-Synced';
                        document.getElementById('helix-db-update-output').textContent = 'MDN: ' + (du.mdn_old || '(none)') + ' \u2192 ' + du.mdn_new;
                        document.getElementById('helix-db-update-banner').classList.remove('hidden');
                    }
                    resultDiv.classList.remove('hidden');
                } catch (err) {
                    showToast('Error querying Teltik', 'error');
                    console.error(err);
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Query';
                }
                return;
            }

            // Helix query (original)
            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }`
);

// ── 7. querySimCarrier — add teltik case ─────────────────────────────────────
apply('querySimCarrier',
  `            } else if (vendor === 'atomic') {
                vendorSelect.value = 'atomic';
                input.value = iccid || '';
            } else {
                vendorSelect.value = 'helix';`,
  `            } else if (vendor === 'teltik') {
                vendorSelect.value = 'teltik';
                input.value = iccid || '';
            } else if (vendor === 'atomic') {
                vendorSelect.value = 'atomic';
                input.value = iccid || '';
            } else {
                vendorSelect.value = 'helix';`
);

// ── 8. bulkQuery — add teltik case ───────────────────────────────────────────
apply('bulkQuery-teltik',
  `                    } else if (vendor === 'atomic') {
                        const res = await fetch(API_BASE + '/atomic-query', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ identifier: sim.iccid || '' })
                        });`,
  `                    } else if (vendor === 'teltik') {
                        const res = await fetch(API_BASE + '/teltik-query', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ iccid: sim.iccid || '' })
                        });
                        const r = await res.json();
                        if (r.ok) {
                            okCount++;
                            const tMdn = r.response && (r.response.msisdn || r.response.mdn) ? (r.response.msisdn || r.response.mdn) : 'OK';
                            const tNote = r.db_update && r.db_update.mdn_updated ? ' [MDN\u2192' + r.db_update.mdn_new + ']' : '';
                            lines.push(label + ' [teltik]: ' + tMdn + tNote);
                        } else {
                            failCount++;
                            lines.push(label + ' [teltik]: ERROR \u2014 ' + (r.error || 'unknown'));
                        }
                    } else if (vendor === 'atomic') {
                        const res = await fetch(API_BASE + '/atomic-query', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ identifier: sim.iccid || '' })
                        });`
);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('\nAll patches applied.');
