// _fix_sync_gateway_slots.js
// Adds Sync Slots button + backend route + JS function to the gateway tab
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ============================================================
// PATCH 1: Add /api/sync-gateway-slots route in the router
// ============================================================
const OLD1 =
`    if (url.pathname === '/api/imei-gateway-sync' && request.method === 'POST') {
      return handleImeiGatewaySync(request, env, corsHeaders);
    }`;

const NEW1 =
`    if (url.pathname === '/api/sync-gateway-slots' && request.method === 'POST') {
      return handleSyncGatewaySlots(request, env, corsHeaders);
    }

    if (url.pathname === '/api/imei-gateway-sync' && request.method === 'POST') {
      return handleImeiGatewaySync(request, env, corsHeaders);
    }`;

if (!content.includes(OLD1)) {
  console.error('PATCH 1 FAILED: router insertion point not found');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);
console.log('Patch 1 applied: route registered');

// ============================================================
// PATCH 2: Add handleSyncGatewaySlots backend function
// ============================================================
const OLD2 =
`async function handleSimAction(request, env, corsHeaders) {`;

const NEW2 =
`async function handleSyncGatewaySlots(request, env, corsHeaders) {
  if (!env.MDN_ROTATOR) return new Response(JSON.stringify({ error: 'MDN_ROTATOR not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!env.ADMIN_RUN_SECRET) return new Response(JSON.stringify({ error: 'ADMIN_RUN_SECRET not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const gateway_id = body.gateway_id ? parseInt(body.gateway_id) : null;
  if (!gateway_id) return new Response(JSON.stringify({ error: 'gateway_id required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  const workerUrl = \`https://mdn-rotator/sync-gateway-slots?gateway_id=\${gateway_id}&secret=\${encodeURIComponent(env.ADMIN_RUN_SECRET)}\`;
  const workerResponse = await env.MDN_ROTATOR.fetch(workerUrl, { method: 'POST' });
  const responseText = await workerResponse.text();
  let result;
  try { result = JSON.parse(responseText); } catch {
    result = { ok: false, error: \`Non-JSON response: \${responseText.slice(0, 200)}\` };
  }
  return new Response(JSON.stringify(result, null, 2), {
    status: workerResponse.ok ? 200 : 500,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

async function handleSimAction(request, env, corsHeaders) {`;

if (!content.includes(OLD2)) {
  console.error('PATCH 2 FAILED: handleSimAction not found');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Patch 2 applied: backend handler added');

// ============================================================
// PATCH 3: Add Sync Slots button after Import IMEIs button
// ============================================================
const OLD3 =
`                        <button onclick="importGatewayImeis()" id="gw-import-imei-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center group-hover:bg-cyan-500/30 transition">
                                <svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Import IMEIs</span>
                        </button>
                    </div>
                </div>`;

const NEW3 =
`                        <button onclick="importGatewayImeis()" id="gw-import-imei-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-cyan-500/20 flex items-center justify-center group-hover:bg-cyan-500/30 transition">
                                <svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Import IMEIs</span>
                        </button>
                        <button onclick="syncGatewaySlots()" id="gw-sync-slots-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/30 transition">
                                <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582 4 8 4s8 1.79 8 4"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Sync Slots</span>
                        </button>
                    </div>
                </div>`;

if (!content.includes(OLD3)) {
  console.error('PATCH 3 FAILED: Import IMEIs button block not found');
  process.exit(1);
}
content = content.replace(OLD3, NEW3);
console.log('Patch 3 applied: Sync Slots button added to HTML');

// ============================================================
// PATCH 4: Add syncGatewaySlots() JS function
// Using string concatenation for template literal content inside getHTML()
// ============================================================
const OLD4 = `        async function importGatewayImeis() {`;

// Build the template-literal strings using concatenation to avoid escaping issues
const TICK = '\\`';
const DS = '\\${';

const NEW4 = (
  `        async function syncGatewaySlots() {\n` +
  `            const gatewayId = document.getElementById('gw-select').value;\n` +
  `            if (!gatewayId) {\n` +
  `                showToast('Select a gateway first', 'error');\n` +
  `                return;\n` +
  `            }\n` +
  `            const btn = document.getElementById('gw-sync-slots-btn');\n` +
  `            const origLabel = btn.querySelector('span').textContent;\n` +
  `            btn.querySelector('span').textContent = 'Syncing...';\n` +
  `            btn.disabled = true;\n` +
  `            try {\n` +
  `                const res = await fetch(` + TICK + DS + `API_BASE}/sync-gateway-slots` + TICK + `, {\n` +
  `                    method: 'POST',\n` +
  `                    headers: { 'Content-Type': 'application/json' },\n` +
  `                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),\n` +
  `                });\n` +
  `                const data = await res.json();\n` +
  `                if (!res.ok || !data.ok) {\n` +
  `                    showToast(data.error || 'Sync failed', 'error');\n` +
  `                    return;\n` +
  `                }\n` +
  `                showToast(` + TICK + `Synced ` + DS + `data.synced} slots (` + DS + `data.not_found} SIMs not in DB)` + TICK + `, 'success');\n` +
  `                loadPortStatus();\n` +
  `            } catch (err) {\n` +
  `                showToast('Sync error: ' + err, 'error');\n` +
  `            } finally {\n` +
  `                btn.querySelector('span').textContent = origLabel;\n` +
  `                btn.disabled = false;\n` +
  `            }\n` +
  `        }\n` +
  `\n` +
  `        async function importGatewayImeis() {`
);

if (!content.includes(OLD4)) {
  console.error('PATCH 4 FAILED: importGatewayImeis function not found');
  process.exit(1);
}
content = content.replace(OLD4, NEW4);
console.log('Patch 4 applied: syncGatewaySlots JS function added');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
