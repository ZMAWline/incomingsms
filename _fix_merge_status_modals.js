// Patch D1: Merge set-status-modal and bulk-set-status-modal into one.
// - Keep set-status-modal HTML (slightly modified for dual-mode)
// - Remove bulk-set-status-modal HTML entirely
// - Unify JS: _setStatusSimIds array replaces _setStatusSimId scalar
// - showSetStatusModal(simId, status) → single mode
// - showBulkSetStatusModal() → bulk mode (reads checkboxes)
// - runSetStatus() → handles both (loops _setStatusSimIds)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const before = content;

// ============================================================
// HTML: Modify set-status-modal to support dual mode
// ============================================================

// Add a count line and update the title placeholder
const OLD_MODAL = '    <div id="set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n' +
  '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">\n' +
  '            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">\n' +
  '                <h3 id="set-status-title" class="text-lg font-semibold text-white">Set Status</h3>\n' +
  '                <button onclick="document.getElementById(\'set-status-modal\').classList.add(\'hidden\')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n' +
  '            </div>\n' +
  '            <div class="p-5">\n' +
  '                <select id="set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">';

const NEW_MODAL = '    <div id="set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n' +
  '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">\n' +
  '            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">\n' +
  '                <h3 id="set-status-title" class="text-lg font-semibold text-white">Set Status</h3>\n' +
  '                <button onclick="document.getElementById(\'set-status-modal\').classList.add(\'hidden\')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n' +
  '            </div>\n' +
  '            <div class="p-5">\n' +
  '                <p id="set-status-count" class="text-sm text-gray-400 mb-3 hidden"></p>\n' +
  '                <select id="set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">';

if (!content.includes(OLD_MODAL)) { console.error('PATCH FAILED: set-status-modal HTML not found'); process.exit(1); }
content = content.replace(OLD_MODAL, NEW_MODAL);

// ============================================================
// HTML: Remove bulk-set-status-modal entirely
// ============================================================

const OLD_BULK_MODAL = '\n    <!-- Bulk Set Status Modal -->\n' +
  '    <div id="bulk-set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">\n' +
  '        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">\n' +
  '            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">\n' +
  '                <h3 class="text-lg font-semibold text-white">Bulk Set Status</h3>\n' +
  '                <button onclick="document.getElementById(\'bulk-set-status-modal\').classList.add(\'hidden\')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>\n' +
  '            </div>\n' +
  '            <div class="p-5">\n' +
  '                <p class="text-sm text-gray-400 mb-3"><span id="bulk-status-count" class="text-white font-medium">0</span> SIM(s) selected</p>\n' +
  '                <select id="bulk-set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">\n' +
  '                    <option value="provisioning">provisioning</option>\n' +
  '                    <option value="active">active</option>\n' +
  '                    <option value="suspended">suspended</option>\n' +
  '                    <option value="canceled">canceled</option>\n' +
  '                    <option value="error">error</option>\n' +
  '                    <option value="pending">pending</option>\n' +
  '                    <option value="helix_timeout">helix_timeout</option>\n' +
  '                    <option value="data_mismatch">data_mismatch</option>\n' +
  '                </select>\n' +
  '                <div class="flex gap-2 justify-end">\n' +
  '                    <button onclick="document.getElementById(\'bulk-set-status-modal\').classList.add(\'hidden\')" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg transition">Cancel</button>\n' +
  '                    <button id="bulk-status-apply-btn" onclick="runBulkSetStatus()" class="px-4 py-2 text-sm bg-accent hover:bg-accent/80 text-white rounded-lg transition">Apply</button>\n' +
  '                </div>\n' +
  '            </div>\n' +
  '        </div>\n' +
  '    </div>';

if (!content.includes(OLD_BULK_MODAL)) { console.error('PATCH FAILED: bulk-set-status-modal HTML not found'); process.exit(1); }
content = content.replace(OLD_BULK_MODAL, '');

// ============================================================
// JS: Replace all 4 functions with unified versions
// ============================================================

// Replace showSetStatusModal + runSetStatus + showBulkSetStatusModal + runBulkSetStatus
// with unified versions that use _setStatusSimIds array

const OLD_JS = '        function showSetStatusModal(simId, currentStatus) {\n' +
  '            _setStatusSimId = simId;\n' +
  "            document.getElementById('set-status-title').textContent = 'Set Status - SIM #' + simId;\n" +
  "            document.getElementById('set-status-select').value = currentStatus;\n" +
  "            document.getElementById('set-status-modal').classList.remove('hidden');\n" +
  '        }\n' +
  '\n' +
  '        async function runSetStatus() {\n' +
  "            const status = document.getElementById('set-status-select').value;\n" +
  "            document.getElementById('set-status-modal').classList.add('hidden');\n" +
  '            try {\n' +
  "                const res = await fetch(API_BASE + '/set-sim-status', {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  '                    body: JSON.stringify({ sim_id: _setStatusSimId, status })\n' +
  '                });\n' +
  '                const result = await res.json();\n' +
  '                if (result.ok) {\n' +
  "                    showToast('SIM #' + _setStatusSimId + ' status set to ' + status, 'success');\n" +
  '                    loadSims(true);\n' +
  '                } else {\n' +
  "                    showToast('Error: ' + (result.error || 'Failed'), 'error');\n" +
  '                }\n' +
  '            } catch (e) {\n' +
  "                showToast('Error setting status', 'error');\n" +
  '                console.error(e);\n' +
  '            }\n' +
  '        }\n' +
  '\n' +
  '        function showBulkSetStatusModal() {\n' +
  "            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  '            if (selectedIds.length === 0) {\n' +
  "                showToast('Select at least one SIM first', 'error');\n" +
  '                return;\n' +
  '            }\n' +
  "            document.getElementById('bulk-status-count').textContent = selectedIds.length;\n" +
  "            document.getElementById('bulk-set-status-select').value = 'active';\n" +
  "            document.getElementById('bulk-set-status-modal').classList.remove('hidden');\n" +
  '        }\n' +
  '\n' +
  '        async function runBulkSetStatus() {\n' +
  "            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  '            if (selectedIds.length === 0) return;\n' +
  "            const status = document.getElementById('bulk-set-status-select').value;\n" +
  "            document.getElementById('bulk-set-status-modal').classList.add('hidden');\n" +
  '\n' +
  "            const btn = document.getElementById('bulk-status-apply-btn');\n" +
  '            btn.disabled = true;\n' +
  "            btn.textContent = 'Applying...';\n" +
  '\n' +
  '            let success = 0, failed = 0;\n' +
  '            for (const simId of selectedIds) {\n' +
  '                try {\n' +
  "                    const res = await fetch(API_BASE + '/set-sim-status', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  '                        body: JSON.stringify({ sim_id: simId, status })\n' +
  '                    });\n' +
  '                    const result = await res.json();\n' +
  '                    if (result.ok) success++;\n' +
  '                    else failed++;\n' +
  '                } catch (e) {\n' +
  '                    failed++;\n' +
  '                }\n' +
  '            }\n' +
  '\n' +
  '            btn.disabled = false;\n' +
  "            btn.textContent = 'Apply';\n" +
  '\n' +
  '            if (failed === 0) {\n' +
  "                showToast(success + ' SIM(s) status set to ' + status, 'success');\n" +
  '            } else {\n' +
  "                showToast(success + ' success, ' + failed + ' failed', failed > 0 ? 'warning' : 'success');\n" +
  '            }\n' +
  '            loadSims(true);\n' +
  '        }';

const NEW_JS = '        // Unified set-status modal — works for single SIM and bulk\n' +
  '        let _setStatusSimIds = [];\n' +
  '\n' +
  '        function showSetStatusModal(simId, currentStatus) {\n' +
  '            _setStatusSimIds = [simId];\n' +
  "            document.getElementById('set-status-title').textContent = 'Set Status — SIM #' + simId;\n" +
  "            document.getElementById('set-status-count').classList.add('hidden');\n" +
  "            document.getElementById('set-status-select').value = currentStatus;\n" +
  "            document.getElementById('set-status-modal').classList.remove('hidden');\n" +
  '        }\n' +
  '\n' +
  '        function showBulkSetStatusModal() {\n' +
  "            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  '            if (selectedIds.length === 0) {\n' +
  "                showToast('Select at least one SIM first', 'error');\n" +
  '                return;\n' +
  '            }\n' +
  '            _setStatusSimIds = selectedIds;\n' +
  "            document.getElementById('set-status-title').textContent = 'Set Status — ' + selectedIds.length + ' SIMs';\n" +
  "            const countEl = document.getElementById('set-status-count');\n" +
  "            countEl.textContent = selectedIds.length + ' SIM(s) selected';\n" +
  "            countEl.classList.remove('hidden');\n" +
  "            document.getElementById('set-status-select').value = 'active';\n" +
  "            document.getElementById('set-status-modal').classList.remove('hidden');\n" +
  '        }\n' +
  '\n' +
  '        async function runSetStatus() {\n' +
  "            const status = document.getElementById('set-status-select').value;\n" +
  "            document.getElementById('set-status-modal').classList.add('hidden');\n" +
  '            let success = 0, failed = 0;\n' +
  '            for (const simId of _setStatusSimIds) {\n' +
  '                try {\n' +
  "                    const res = await fetch(API_BASE + '/set-sim-status', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  '                        body: JSON.stringify({ sim_id: simId, status })\n' +
  '                    });\n' +
  '                    const result = await res.json();\n' +
  '                    if (result.ok) success++;\n' +
  '                    else failed++;\n' +
  '                } catch (e) {\n' +
  '                    failed++;\n' +
  '                }\n' +
  '            }\n' +
  '            if (_setStatusSimIds.length === 1) {\n' +
  '                if (failed === 0) showToast(' + "'SIM #' + _setStatusSimIds[0] + ' status set to ' + status, 'success'" + ');\n' +
  "                else showToast('Error setting status', 'error');\n" +
  '            } else {\n' +
  '                if (failed === 0) showToast(success + ' + "' SIM(s) status set to ' + status, 'success'" + ');\n' +
  "                else showToast(success + ' success, ' + failed + ' failed', 'warning');\n" +
  '            }\n' +
  '            loadSims(true);\n' +
  '        }';

if (!content.includes(OLD_JS)) { console.error('PATCH FAILED: JS functions not found'); process.exit(1); }
content = content.replace(OLD_JS, NEW_JS);

if (content === before) { console.error('ERROR: no replacements made'); process.exit(1); }
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch D1 applied: set-status modals merged into one');
console.log('  - bulk-set-status-modal HTML removed');
console.log('  - set-status-modal gains count line for bulk mode');
console.log('  - _setStatusSimIds array replaces _setStatusSimId + checkbox re-read');
console.log('  - runSetStatus() loops array (works for single + bulk)');
