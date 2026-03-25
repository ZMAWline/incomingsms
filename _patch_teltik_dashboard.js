// Patch: Teltik vendor integration — dashboard changes
// Adds: /api/import-teltik route, vendor columns in sims query,
// vendor filter dropdown, vendor th, Import Teltik button,
// renderSims vendor filter, T-Mobile badge, vendor td, OTA/Retry guards,
// importTeltik() function

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Helper vars — represent characters as they appear in dashboard source file
// (inside the outer getHTML() template literal, backticks and ${ are escaped)
const BT = '\\`';    // \` — escaped backtick in source
const DS = '\\${';   // \${ — escaped template expression in source

// ── 1. Backend route: add /api/import-teltik ─────────────────────────────
const ROUTE_OLD = `    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {
      return handleTriggerBlimeiSweep(env, corsHeaders);
    }

    if (url.pathname === '/api/sync-gateway-slots' && request.method === 'POST') {`;

const ROUTE_NEW = `    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {
      return handleTriggerBlimeiSweep(env, corsHeaders);
    }

    if (url.pathname === '/api/import-teltik' && request.method === 'POST') {
      const res = await env.TELTIK_WORKER.fetch(
        new Request('https://teltik-worker/import?secret=' + env.ADMIN_RUN_SECRET, { method: 'POST' })
      );
      return new Response(await res.text(), { status: res.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/api/sync-gateway-slots' && request.method === 'POST') {`;

if (!content.includes(ROUTE_OLD)) { console.error('ERROR: ROUTE_OLD not found'); process.exit(1); }
content = content.replace(ROUTE_OLD, ROUTE_NEW);
console.log('✓ /api/import-teltik backend route added');

// ── 2. handleSims query: add vendor/carrier/rotation_interval_hours ───────
const SIMS_QUERY_OLD = `sims?select=id,iccid,port,status,mobility_subscription_id,gateway_id`;
const SIMS_QUERY_NEW = `sims?select=id,iccid,port,status,vendor,carrier,rotation_interval_hours,mobility_subscription_id,gateway_id`;

if (!content.includes(SIMS_QUERY_OLD)) { console.error('ERROR: SIMS_QUERY_OLD not found'); process.exit(1); }
content = content.replace(SIMS_QUERY_OLD, SIMS_QUERY_NEW);
console.log('✓ handleSims query updated with vendor/carrier/rotation_interval_hours');

// ── 3. HTML: Import Teltik button in bulk actions area ────────────────────
const IMPORT_BTN_OLD = `                    <button onclick="bulkModifyImei()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded transition">Modify IMEI</button>
                </div>`;

const IMPORT_BTN_NEW = `                    <button onclick="bulkModifyImei()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded transition">Modify IMEI</button>
                    <button onclick="importTeltik()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Import Teltik</button>
                </div>`;

if (!content.includes(IMPORT_BTN_OLD)) { console.error('ERROR: IMPORT_BTN_OLD not found'); process.exit(1); }
content = content.replace(IMPORT_BTN_OLD, IMPORT_BTN_NEW);
console.log('✓ Import Teltik button added');

// ── 4. HTML: vendor filter dropdown (after gateway filter) ────────────────
const VENDOR_HTML_OLD = `                                <select id="filter-gateway" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Gateways</option>
                                </select>
                                <select id="filter-special" onchange="renderSims()"`;

const VENDOR_HTML_NEW = `                                <select id="filter-gateway" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Gateways</option>
                                </select>
                                <select id="filter-vendor" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Vendors</option>
                                    <option value="helix">Helix</option>
                                    <option value="teltik">Teltik</option>
                                </select>
                                <select id="filter-special" onchange="renderSims()"`;

if (!content.includes(VENDOR_HTML_OLD)) { console.error('ERROR: VENDOR_HTML_OLD not found'); process.exit(1); }
content = content.replace(VENDOR_HTML_OLD, VENDOR_HTML_NEW);
console.log('✓ vendor filter dropdown added');

// ── 5. HTML: Vendor th after Status th ────────────────────────────────────
const STATUS_TH_OLD = `onclick="sortTable('sims','status')">Status <span class="sort-arrow" data-table="sims" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','mobility_subscription_id')">Sub ID`;

const STATUS_TH_NEW = `onclick="sortTable('sims','status')">Status <span class="sort-arrow" data-table="sims" data-col="status"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','vendor')">Vendor <span class="sort-arrow" data-table="sims" data-col="vendor"></span></th>
                                    <th class="px-4 py-3 font-medium cursor-pointer hover:text-gray-300 select-none" onclick="sortTable('sims','mobility_subscription_id')">Sub ID`;

if (!content.includes(STATUS_TH_OLD)) { console.error('ERROR: STATUS_TH_OLD not found'); process.exit(1); }
content = content.replace(STATUS_TH_OLD, STATUS_TH_NEW);
console.log('✓ Vendor th added');

// ── 6. renderSims: add vendor filter logic ────────────────────────────────
const VENDOR_JS_OLD = `  const gatewayFilterVal = document.getElementById('filter-gateway')?.value;
  if (gatewayFilterVal) data = data.filter(s => s.gateway_code === gatewayFilterVal);
  const activatedFrom = document.getElementById('filter-activated-from')?.value;`;

const VENDOR_JS_NEW = `  const gatewayFilterVal = document.getElementById('filter-gateway')?.value;
  if (gatewayFilterVal) data = data.filter(s => s.gateway_code === gatewayFilterVal);
  const vendorFilterVal = document.getElementById('filter-vendor')?.value;
  if (vendorFilterVal) data = data.filter(s => s.vendor === vendorFilterVal);
  const activatedFrom = document.getElementById('filter-activated-from')?.value;`;

if (!content.includes(VENDOR_JS_OLD)) { console.error('ERROR: VENDOR_JS_OLD not found'); process.exit(1); }
content = content.replace(VENDOR_JS_OLD, VENDOR_JS_NEW);
console.log('✓ renderSims vendor filter logic added');

// ── 7. renderSims: gatewayDisplay — add T-Mobile badge for Teltik ─────────
// Match the closing backtick + fallback expression at end of gatewayDisplay line
const GW_OLD = `${BT} : (sim.port || '-');`;
const GW_NEW = `${BT} : (sim.vendor === 'teltik' ? '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-pink-500/20 text-pink-300">T-Mobile</span>' : (sim.port || '-'));`;

if (!content.includes(GW_OLD)) { console.error('ERROR: GW_OLD not found'); process.exit(1); }
content = content.replace(GW_OLD, GW_NEW);
console.log('✓ gatewayDisplay T-Mobile badge added');

// ── 8. renderSims: add vendorBadge variable after statusClass ─────────────
const VENDOR_BADGE_OLD = `                }[sim.status] || 'bg-gray-500/20 text-gray-400';
                return ${BT}`;

const VENDOR_BADGE_NEW = `                }[sim.status] || 'bg-gray-500/20 text-gray-400';
                const vendorBadge = sim.vendor === 'teltik' ? '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-500/20 text-purple-300">Teltik</span>' : '<span class="px-1.5 py-0.5 text-xs font-medium rounded bg-gray-500/20 text-gray-400">Helix</span>';
                return ${BT}`;

if (!content.includes(VENDOR_BADGE_OLD)) { console.error('ERROR: VENDOR_BADGE_OLD not found'); process.exit(1); }
content = content.replace(VENDOR_BADGE_OLD, VENDOR_BADGE_NEW);
console.log('✓ vendorBadge variable added');

// ── 9. renderSims row: add vendor td after status td ─────────────────────
const VENDOR_TD_OLD = `                        <span class="px-2 py-1 text-xs font-medium rounded-full ${DS}statusClass}">${DS}sim.status}</span>
                    </td>
                    <td class="px-4 py-3 font-mono text-xs">`;

const VENDOR_TD_NEW = `                        <span class="px-2 py-1 text-xs font-medium rounded-full ${DS}statusClass}">${DS}sim.status}</span>
                    </td>
                    <td class="px-4 py-3">${DS}vendorBadge}</td>
                    <td class="px-4 py-3 font-mono text-xs">`;

if (!content.includes(VENDOR_TD_OLD)) { console.error('ERROR: VENDOR_TD_OLD not found'); process.exit(1); }
content = content.replace(VENDOR_TD_OLD, VENDOR_TD_NEW);
console.log('✓ vendor column td added');

// ── 10. renderSims: add vendor guard to OTA button ────────────────────────
const OTA_OLD = `${DS}sim.status === 'active' ? ${BT}<button onclick="simAction(`;
const OTA_NEW = `${DS}(sim.vendor !== 'teltik' && sim.status === 'active') ? ${BT}<button onclick="simAction(`;

if (!content.includes(OTA_OLD)) { console.error('ERROR: OTA_OLD not found'); process.exit(1); }
content = content.replace(OTA_OLD, OTA_NEW);
console.log('✓ OTA button vendor guard added');

// ── 11. renderSims: add vendor guard to Retry button ─────────────────────
const RETRY_OLD = `${DS}sim.status === 'error' ? ${BT}<button onclick="retryActivation(`;
const RETRY_NEW = `${DS}(sim.vendor !== 'teltik' && sim.status === 'error') ? ${BT}<button onclick="retryActivation(`;

if (!content.includes(RETRY_OLD)) { console.error('ERROR: RETRY_OLD not found'); process.exit(1); }
content = content.replace(RETRY_OLD, RETRY_NEW);
console.log('✓ Retry button vendor guard added');

// ── 12. Add importTeltik() function after sendSimOnline ───────────────────
const IMPORT_FN_OLD = `                showToast('Error sending online webhook', 'error');
                console.error(error);
            }
        }

        async function loadMessages() {`;

const IMPORT_FN_NEW = `                showToast('Error sending online webhook', 'error');
                console.error(error);
            }
        }

        async function importTeltik() {
            if (!(await showConfirm('Import Teltik', 'Fetch all Teltik lines and upsert into DB?'))) return;
            showToast('Importing Teltik lines...', 'info');
            const res = await fetch(${BT}${DS}API_BASE}/import-teltik${BT}, { method: 'POST' });
            const data = await res.json();
            if (res.ok) {
                showToast('Imported: ' + data.imported + ' new, ' + data.updated + ' updated', 'success');
                loadSims();
            } else {
                showToast('Error: ' + data.error, 'error');
            }
        }

        async function loadMessages() {`;

if (!content.includes(IMPORT_FN_OLD)) { console.error('ERROR: IMPORT_FN_OLD not found'); process.exit(1); }
content = content.replace(IMPORT_FN_OLD, IMPORT_FN_NEW);
console.log('✓ importTeltik() function added');

// Convert back to CRLF and write
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written (CRLF)');
console.log('\nAll patches applied successfully.');
