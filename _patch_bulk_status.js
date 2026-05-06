// Add bulk status change option to dashboard
// Changes:
// 1. Add "Set Status" button to bulk action bar
// 2. Add bulk status modal HTML
// 3. Add showBulkSetStatusModal and runBulkSetStatus functions

const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

const changes = [];

// 1. Add "Set Status" button to bulk action bar (after Import Teltik button)
const bulkBarOld = `<button onclick="importTeltik()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Import Teltik</button>
                </div>`;

const bulkBarNew = `<button onclick="importTeltik()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Import Teltik</button>
                    <button onclick="showBulkSetStatusModal()" class="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition">Set Status</button>
                </div>`;

if (content.includes(bulkBarOld)) {
  content = content.replace(bulkBarOld, bulkBarNew);
  changes.push('1. Added "Set Status" button to bulk action bar');
} else if (content.includes(bulkBarOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(bulkBarOld.replace(/\n/g, '\r\n'), bulkBarNew.replace(/\n/g, '\r\n'));
  changes.push('1. Added "Set Status" button to bulk action bar');
} else {
  console.error('ERROR: Could not find bulk action bar');
  process.exit(1);
}

// 2. Add bulk status modal HTML (after set-status-modal)
const setStatusModalEnd = `</div>
    </div>

    <!-- SIM Action Modal -->`;

const bulkStatusModal = `</div>
    </div>

    <!-- Bulk Set Status Modal -->
    <div id="bulk-set-status-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-sm">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 class="text-lg font-semibold text-white">Bulk Set Status</h3>
                <button onclick="document.getElementById('bulk-set-status-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5">
                <p class="text-sm text-gray-400 mb-3"><span id="bulk-status-count" class="text-white font-medium">0</span> SIM(s) selected</p>
                <select id="bulk-set-status-select" class="w-full text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent mb-4">
                    <option value="provisioning">provisioning</option>
                    <option value="active">active</option>
                    <option value="suspended">suspended</option>
                    <option value="canceled">canceled</option>
                    <option value="error">error</option>
                    <option value="pending">pending</option>
                    <option value="helix_timeout">helix_timeout</option>
                    <option value="data_mismatch">data_mismatch</option>
                </select>
                <div class="flex gap-2 justify-end">
                    <button onclick="document.getElementById('bulk-set-status-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-700 hover:bg-dark-600 text-gray-300 rounded-lg transition">Cancel</button>
                    <button id="bulk-status-apply-btn" onclick="runBulkSetStatus()" class="px-4 py-2 text-sm bg-accent hover:bg-accent/80 text-white rounded-lg transition">Apply</button>
                </div>
            </div>
        </div>
    </div>

    <!-- SIM Action Modal -->`;

if (content.includes(setStatusModalEnd)) {
  content = content.replace(setStatusModalEnd, bulkStatusModal);
  changes.push('2. Added bulk set status modal HTML');
} else if (content.includes(setStatusModalEnd.replace(/\n/g, '\r\n'))) {
  content = content.replace(setStatusModalEnd.replace(/\n/g, '\r\n'), bulkStatusModal.replace(/\n/g, '\r\n'));
  changes.push('2. Added bulk set status modal HTML');
} else {
  console.error('ERROR: Could not find set-status-modal end');
  process.exit(1);
}

// 3. Add showBulkSetStatusModal and runBulkSetStatus functions (after runSetStatus function)
const afterRunSetStatus = `showToast('Error setting status', 'error');
                console.error(e);
            }
        }

        async function simAction(simId, action, skipConfirm = false) {`;

const bulkStatusFunctions = `showToast('Error setting status', 'error');
                console.error(e);
            }
        }

        function showBulkSetStatusModal() {
            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (selectedIds.length === 0) {
                showToast('Select at least one SIM first', 'error');
                return;
            }
            document.getElementById('bulk-status-count').textContent = selectedIds.length;
            document.getElementById('bulk-set-status-select').value = 'active';
            document.getElementById('bulk-set-status-modal').classList.remove('hidden');
        }

        async function runBulkSetStatus() {
            const selectedIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));
            if (selectedIds.length === 0) return;
            const status = document.getElementById('bulk-set-status-select').value;
            document.getElementById('bulk-set-status-modal').classList.add('hidden');

            const btn = document.getElementById('bulk-status-apply-btn');
            btn.disabled = true;
            btn.textContent = 'Applying...';

            let success = 0, failed = 0;
            for (const simId of selectedIds) {
                try {
                    const res = await fetch(API_BASE + '/set-sim-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sim_id: simId, status })
                    });
                    const result = await res.json();
                    if (result.ok) success++;
                    else failed++;
                } catch (e) {
                    failed++;
                }
            }

            btn.disabled = false;
            btn.textContent = 'Apply';

            if (failed === 0) {
                showToast(success + ' SIM(s) status set to ' + status, 'success');
            } else {
                showToast(success + ' success, ' + failed + ' failed', failed > 0 ? 'warning' : 'success');
            }
            loadSims(true);
        }

        async function simAction(simId, action, skipConfirm = false) {`;

if (content.includes(afterRunSetStatus)) {
  content = content.replace(afterRunSetStatus, bulkStatusFunctions);
  changes.push('3. Added showBulkSetStatusModal and runBulkSetStatus functions');
} else if (content.includes(afterRunSetStatus.replace(/\n/g, '\r\n'))) {
  content = content.replace(afterRunSetStatus.replace(/\n/g, '\r\n'), bulkStatusFunctions.replace(/\n/g, '\r\n'));
  changes.push('3. Added showBulkSetStatusModal and runBulkSetStatus functions');
} else {
  console.error('ERROR: Could not find runSetStatus function end');
  process.exit(1);
}

// Write the file
fs.writeFileSync(dashPath, content, 'utf8');

console.log('Bulk status change patch applied successfully!');
console.log('Changes:');
changes.forEach(c => console.log('  ' + c));
console.log('\nRun syntax check: node --input-type=module --check < src/dashboard/index.js');
