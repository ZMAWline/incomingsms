// _fix_d3_sim_detail.js
// D3: Add per-SIM unified detail modal with tabs (Details | Status | IMEI | Logs)
// Changes:
//   1. Insert sim-detail-modal HTML before Custom Confirm Modal
//   2. Insert JS functions before </script>
//   3. Change SIM ID button onclick: showSimLogs -> openSimDetail
//   4. Change IMEI button onclick:   showChangeImeiModal -> openSimDetail
//   5. Change Status button onclick:  showSetStatusModal -> openSimDetail

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────
// CHANGE 1: SIM ID button onclick
// ─────────────────────────────────────────────
const OLD_SIMID = '<button onclick="showSimLogs(\\${sim.id})" class="text-indigo-400 hover:text-indigo-200 hover:underline font-mono transition" title="View API logs">\\${sim.id}</button>';
const NEW_SIMID = '<button onclick="openSimDetail(\\${sim.id}, \'details\')" class="text-indigo-400 hover:text-indigo-200 hover:underline font-mono transition" title="View SIM detail">\\${sim.id}</button>';

if (!content.includes(OLD_SIMID)) {
  console.error('PATCH FAILED: SIM ID button old string not found');
  process.exit(1);
}
content = content.replace(OLD_SIMID, NEW_SIMID);
console.log('Change 1 (SIM ID button) applied.');

// ─────────────────────────────────────────────
// CHANGE 2: IMEI button onclick
// ─────────────────────────────────────────────
const OLD_IMEI = '\\${(sim.mobility_subscription_id && sim.gateway_id && sim.port) ? \\`<button onclick="showChangeImeiModal(\\${sim.id}, \'\\${sim.iccid}\', \\${sim.gateway_id}, \'\\${sim.port}\')" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1" title="Change IMEI">IMEI</button>\\` : \'\'}';
const NEW_IMEI = '\\${(sim.mobility_subscription_id && sim.gateway_id && sim.port) ? \\`<button onclick="openSimDetail(\\${sim.id}, \'imei\')" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1" title="Change IMEI">IMEI</button>\\` : \'\'}';

if (!content.includes(OLD_IMEI)) {
  console.error('PATCH FAILED: IMEI button old string not found');
  process.exit(1);
}
content = content.replace(OLD_IMEI, NEW_IMEI);
console.log('Change 2 (IMEI button) applied.');

// ─────────────────────────────────────────────
// CHANGE 3: Status button onclick
// ─────────────────────────────────────────────
const OLD_STATUS = '\\${\\`<button onclick="showSetStatusModal(\\${sim.id}, \'\\${sim.status}\')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>\\`}';
const NEW_STATUS = '\\${\\`<button onclick="openSimDetail(\\${sim.id}, \'status\')" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>\\`}';

if (!content.includes(OLD_STATUS)) {
  console.error('PATCH FAILED: Status button old string not found');
  process.exit(1);
}
content = content.replace(OLD_STATUS, NEW_STATUS);
console.log('Change 3 (Status button) applied.');

// ─────────────────────────────────────────────
// CHANGE 4: Insert sim-detail-modal HTML
// ─────────────────────────────────────────────
const HTML_ANCHOR = '\n    <!-- Custom Confirm Modal -->';

const NEW_MODAL_HTML = `
    <!-- SIM Detail Modal (D3) -->
    <div id="sim-detail-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <div>
                    <h3 id="sd-title" class="text-lg font-semibold text-white">SIM Detail</h3>
                    <p id="sd-subtitle" class="text-xs text-gray-500 mt-0.5 font-mono"></p>
                </div>
                <button onclick="closeSimDetail()" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="border-b border-dark-600 flex px-2">
                <button id="sdtab-btn-details" onclick="switchSimDetailTab('details')" class="py-3 px-4 text-sm text-white border-b-2 border-accent transition">Details</button>
                <button id="sdtab-btn-status" onclick="switchSimDetailTab('status')" class="py-3 px-4 text-sm text-gray-400 transition">Status</button>
                <button id="sdtab-btn-imei" onclick="switchSimDetailTab('imei')" class="py-3 px-4 text-sm text-gray-400 transition">IMEI</button>
                <button id="sdtab-btn-logs" onclick="switchSimDetailTab('logs')" class="py-3 px-4 text-sm text-gray-400 transition">API Logs</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <div id="sdtab-details"></div>
                <div id="sdtab-status" class="hidden"></div>
                <div id="sdtab-imei" class="hidden"></div>
                <div id="sdtab-logs" class="hidden">
                    <div class="flex justify-between items-center mb-3">
                        <p class="text-sm text-gray-400">Carrier API Logs</p>
                        <button onclick="if(_sdCurrentSim)loadSimDetailLogs(_sdCurrentSim.id,_sdCurrentSim.iccid)" class="px-2 py-1 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded transition">&#8635; Refresh</button>
                    </div>
                    <div id="sd-logs-container"></div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="closeSimDetail()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>
` + '\n    <!-- Custom Confirm Modal -->';

if (!content.includes(HTML_ANCHOR)) {
  console.error('PATCH FAILED: Custom Confirm Modal anchor not found');
  process.exit(1);
}
content = content.replace(HTML_ANCHOR, NEW_MODAL_HTML);
console.log('Change 4 (modal HTML) applied.');

// ─────────────────────────────────────────────
// CHANGE 5: Insert JS functions before </script>
// ─────────────────────────────────────────────
const JS_ANCHOR = "            if (bulkBtn) bulkBtn.style.display = 'none';\n        }\n    </script>";

const NEW_JS = `            if (bulkBtn) bulkBtn.style.display = 'none';
        }

        // ── D3: Per-SIM Unified Detail Modal ──────────────────────────────────
        let _sdCurrentSim = null;

        function openSimDetail(simId, tab) {
            tab = tab || 'details';
            const sim = tableState.sims && tableState.sims.data && tableState.sims.data.find(function(s) { return String(s.id) === String(simId); });
            if (!sim) { showToast('SIM #' + simId + ' not in current view — refresh the SIMs list first', 'error'); return; }
            _sdCurrentSim = sim;
            document.getElementById('sd-title').textContent = 'SIM #' + sim.id;
            document.getElementById('sd-subtitle').textContent = sim.iccid || '';
            renderSimDetailDetails(sim);
            renderSimDetailStatus(sim);
            renderSimDetailImei(sim);
            document.getElementById('sd-logs-container').innerHTML = '';
            document.getElementById('sim-detail-modal').classList.remove('hidden');
            switchSimDetailTab(tab);
            if (tab === 'logs') loadSimDetailLogs(sim.id, sim.iccid);
        }

        function closeSimDetail() {
            document.getElementById('sim-detail-modal').classList.add('hidden');
            _sdCurrentSim = null;
        }

        function switchSimDetailTab(tab) {
            ['details', 'status', 'imei', 'logs'].forEach(function(t) {
                var content = document.getElementById('sdtab-' + t);
                var btn = document.getElementById('sdtab-btn-' + t);
                if (!content || !btn) return;
                content.classList.toggle('hidden', t !== tab);
                if (t === tab) {
                    btn.classList.add('border-b-2', 'border-accent', 'text-white');
                    btn.classList.remove('text-gray-400');
                } else {
                    btn.classList.remove('border-b-2', 'border-accent', 'text-white');
                    btn.classList.add('text-gray-400');
                }
            });
            if (tab === 'logs' && _sdCurrentSim) loadSimDetailLogs(_sdCurrentSim.id, _sdCurrentSim.iccid);
        }

        function _sdField(label, value) {
            return '<div><p class="text-xs text-gray-500 mb-0.5">' + label + '</p><p class="text-sm text-gray-200">' + (value || '<span class="text-gray-600">-</span>') + '</p></div>';
        }

        function renderSimDetailDetails(sim) {
            var statusClass = ({
                active: 'bg-accent/20 text-accent',
                provisioning: 'bg-yellow-500/20 text-yellow-400',
                suspended: 'bg-orange-500/20 text-orange-400',
                canceled: 'bg-red-500/20 text-red-400',
                error: 'bg-red-500/20 text-red-400',
            })[sim.status] || 'bg-gray-500/20 text-gray-400';
            var vendorColor = ({teltik:'text-purple-300', atomic:'text-blue-300', wing_iot:'text-green-300', helix:'text-gray-400'})[sim.vendor] || 'text-gray-400';
            var statusBadge = '<span class="px-2 py-0.5 text-xs font-medium rounded-full ' + statusClass + '">' + (sim.status || '-') + '</span>';
            var vendorBadge = '<span class="text-sm font-medium ' + vendorColor + '">' + (sim.vendor || '-') + '</span>';
            var canSendOnline = sim.phone_number && sim.reseller_id && sim.status === 'active';
            var canOta = sim.status === 'active' && ['teltik','wing_iot'].indexOf(sim.vendor) === -1 && !(sim.vendor === 'helix' && !window.HELIX_ENABLED);
            var canRetry = sim.status === 'error' && ['teltik','wing_iot'].indexOf(sim.vendor) === -1 && !(sim.vendor === 'helix' && !window.HELIX_ENABLED);
            var gatewayPort = (sim.gateway_name || sim.gateway_code || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + sim.port : '');
            var errHtml = (sim.status === 'error' && sim.last_activation_error)
                ? '<div class="mt-3 p-2 bg-red-900/20 border border-red-800/40 rounded text-xs text-red-400 font-mono break-all">' + sim.last_activation_error.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
                : '';
            var actions = '<div class="border-t border-dark-600 pt-4 flex flex-wrap gap-2">' +
                (canSendOnline ? '<button onclick="sendSimOnline(_sdCurrentSim.id, _sdCurrentSim.phone_number)" class="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition">Online Webhook</button>' : '') +
                (canOta ? '<button onclick="simAction(_sdCurrentSim.id, \'ota_refresh\')" class="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition">OTA Refresh</button>' : '') +
                (canRetry ? '<button onclick="simAction(_sdCurrentSim.id, \'retry_activation\')" class="px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Retry Activation</button>' : '') +
                '<button onclick="switchSimDetailTab(\'logs\')" class="px-3 py-1.5 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded-lg transition">View Logs</button>' +
                '</div>';
            document.getElementById('sdtab-details').innerHTML =
                '<div class="grid grid-cols-2 gap-x-6 gap-y-3 mb-4">' +
                _sdField('ICCID', '<span class="font-mono">' + (sim.iccid || '-') + '</span>') +
                _sdField('Phone Number', sim.phone_number || '') +
                _sdField('Status', statusBadge) +
                _sdField('Vendor', vendorBadge) +
                _sdField('Carrier', sim.carrier || '') +
                _sdField('Reseller', sim.reseller_name || '') +
                _sdField('Gateway / Port', '<span class="font-mono">' + (gatewayPort || '') + '</span>') +
                _sdField('Subscription ID', '<span class="font-mono text-xs">' + (sim.mobility_subscription_id || '') + '</span>') +
                _sdField('Rotation Interval', sim.rotation_interval_hours ? sim.rotation_interval_hours + 'h' : '') +
                _sdField('SMS (24h)', String(sim.sms_count || 0)) +
                _sdField('Last Rotated', sim.last_mdn_rotated_at ? new Date(sim.last_mdn_rotated_at).toLocaleString() : '') +
                _sdField('Activated', sim.activated_at ? new Date(sim.activated_at).toLocaleString() : '') +
                _sdField('Last Notified', sim.last_notified_at ? new Date(sim.last_notified_at).toLocaleString() : '') +
                _sdField('Last SMS', sim.last_sms_received ? new Date(sim.last_sms_received).toLocaleString() : '') +
                '</div>' +
                errHtml + actions;
        }

        function renderSimDetailStatus(sim) {
            var statuses = ['provisioning','active','suspended','canceled','error','pending','helix_timeout','data_mismatch'];
            var opts = statuses.map(function(s) {
                return '<option value="' + s + '"' + (sim.status === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('');
            var resellerSection = sim.reseller_id
                ? '<div class="mt-5 pt-4 border-t border-dark-600">' +
                  '<p class="text-xs text-gray-500 mb-1">Reseller</p>' +
                  '<p class="text-sm font-medium text-white mb-3">' + (sim.reseller_name || String(sim.reseller_id)) + '</p>' +
                  '<button onclick="unassignReseller(_sdCurrentSim.id)" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Unassign from Reseller</button>' +
                  '</div>'
                : '<div class="mt-5 pt-4 border-t border-dark-600">' +
                  '<p class="text-xs text-gray-500 mb-2">No reseller assigned</p>' +
                  '<button onclick="closeSimDetail();assignReseller(_sdCurrentSim.id)" class="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-800 text-white rounded-lg transition">Assign to Reseller</button>' +
                  '</div>';
            document.getElementById('sdtab-status').innerHTML =
                '<p class="text-sm font-medium text-gray-300 mb-2">Set Status</p>' +
                '<div class="flex gap-2 items-center">' +
                '<select id="sd-status-select" class="flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent">' + opts + '</select>' +
                '<button onclick="applySimDetailStatus()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Apply</button>' +
                '</div>' + resellerSection;
        }

        function renderSimDetailImei(sim) {
            var hasImei = sim.mobility_subscription_id && sim.gateway_id && sim.port;
            document.getElementById('sdtab-imei').innerHTML =
                '<div class="grid grid-cols-2 gap-4 mb-5">' +
                _sdField('ICCID', '<span class="font-mono text-xs">' + (sim.iccid || '-') + '</span>') +
                _sdField('Gateway / Port', '<span class="font-mono">' + ((sim.gateway_name || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + sim.port : '') || '-') + '</span>') +
                _sdField('Subscription ID', '<span class="font-mono text-xs">' + (sim.mobility_subscription_id || '-') + '</span>') +
                '</div>' +
                (hasImei
                    ? '<button onclick="showChangeImeiModal(_sdCurrentSim.id, _sdCurrentSim.iccid, _sdCurrentSim.gateway_id, _sdCurrentSim.port)" class="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Open Change IMEI Dialog</button>'
                    : '<p class="text-sm text-gray-500">IMEI change not available — SIM needs subscription ID, gateway, and port assigned.</p>');
        }

        async function applySimDetailStatus() {
            if (!_sdCurrentSim) return;
            var status = document.getElementById('sd-status-select').value;
            try {
                var res = await fetch(API_BASE + '/set-sim-status', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sim_id: _sdCurrentSim.id, status: status })
                });
                var result = await res.json();
                if (result.ok) {
                    showToast('SIM #' + _sdCurrentSim.id + ' status set to ' + status, 'success');
                    closeSimDetail();
                    loadSims(true);
                } else {
                    showToast('Failed: ' + (result.error || JSON.stringify(result)), 'error');
                }
            } catch (err) {
                showToast('Error: ' + err, 'error');
            }
        }

        async function loadSimDetailLogs(simId, iccid) {
            currentSimActionId = simId;
            currentSimActionIccid = iccid || null;
            var container = document.getElementById('sd-logs-container');
            container.innerHTML = '<p class="text-gray-500 text-sm">Loading API logs...</p>';
            try {
                var params = iccid ? 'iccid=' + encodeURIComponent(iccid) : 'sim_id=' + simId;
                var resp = await fetch(API_BASE + '/error-logs?' + params);
                var logs = await resp.json();
                if (!Array.isArray(logs) || logs.length === 0) {
                    container.innerHTML = '<p class="text-gray-500 text-sm">No API logs found for this SIM.</p>';
                    return;
                }
                var vendorColors = { atomic: 'text-orange-400', wing_iot: 'text-green-400', helix: 'text-purple-400', teltik: 'text-pink-400' };
                container.innerHTML = logs.map(function(log) {
                    var statusColor = (log.response_status >= 200 && log.response_status < 300) ? 'text-accent' : 'text-red-400';
                    var reqBody = '-';
                    if (log.request_body) { try { reqBody = JSON.stringify(log.request_body, null, 2); } catch(e) { reqBody = String(log.request_body); } }
                    var resBody = '-';
                    if (log.response_body_json) { try { resBody = JSON.stringify(log.response_body_json, null, 2); } catch(e) { resBody = String(log.response_body_json); } }
                    else if (log.response_body_text) { resBody = log.response_body_text; }
                    var time = log.created_at ? new Date(log.created_at).toLocaleString() : '-';
                    var vendorBadge2 = log.vendor ? '<span class="text-xs font-semibold ' + (vendorColors[log.vendor] || 'text-gray-400') + '">' + log.vendor.toUpperCase() + '</span>' : '';
                    var errHtml2 = log.error ? '<p class="text-xs text-red-400 mt-1">Error: ' + String(log.error).replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>' : '';
                    var retryHtml = (!log.response_ok || log.error) ? '<div class="mt-2"><button onclick="retryLogStep(\'' + log.step + '\')" class="px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition">&#8635; Retry</button></div>' : '';
                    return '<div class="bg-dark-900 rounded-lg border border-dark-600 p-3 mb-2">' +
                        '<div class="flex items-center justify-between mb-2">' +
                        '<div class="flex items-center gap-3">' +
                        '<span class="text-xs font-semibold text-blue-400">' + (log.step || '-') + '</span>' + vendorBadge2 +
                        '<span class="text-xs ' + statusColor + ' font-mono">HTTP ' + (log.response_status || '?') + '</span>' +
                        '<span class="text-xs text-gray-500 font-mono">' + (log.request_method || 'GET') + '</span>' +
                        '</div><span class="text-xs text-gray-500">' + time + '</span></div>' +
                        '<div class="text-xs text-gray-400 font-mono mb-2 truncate" title="' + (log.request_url || '').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '">' + (log.request_url || '-') + '</div>' +
                        '<details class="mb-1"><summary class="text-xs text-blue-400 cursor-pointer hover:text-blue-300">Request Body</summary>' +
                        '<pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">' + reqBody.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre></details>' +
                        '<details open><summary class="text-xs text-orange-400 cursor-pointer hover:text-orange-300">Response Body</summary>' +
                        '<pre class="mt-1 text-xs font-mono text-gray-300 bg-dark-700 p-2 rounded overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap">' + resBody.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre></details>' +
                        errHtml2 + retryHtml + '</div>';
                }).join('');
            } catch (err) {
                container.innerHTML = '<p class="text-red-400 text-sm">Failed to load logs: ' + err + '</p>';
            }
        }
        // ── End D3 ───────────────────────────────────────────────────────────
    </script>`;

if (!content.includes(JS_ANCHOR)) {
  console.error('PATCH FAILED: JS anchor not found');
  process.exit(1);
}
content = content.replace(JS_ANCHOR, NEW_JS);
console.log('Change 5 (JS functions) applied.');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied. File written.');
