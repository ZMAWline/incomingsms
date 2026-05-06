// a. Add Query to bulk actions
// b. Add Retry Activation to bulk actions
// c. Remove Query from per-row actions
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

const changes = [];

// 1. Add Query and Retry Activation buttons to bulk action bar (after Set Status)
const bulkBarOld = '<button onclick="showBulkSetStatusModal()" class="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition">Set Status</button>\n                </div>';

const bulkBarNew = '<button onclick="showBulkSetStatusModal()" class="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition">Set Status</button>\n                    <button onclick="bulkQuery()" class="px-3 py-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition">Query</button>\n                    <button onclick="bulkRetryActivation()" class="px-3 py-1.5 text-xs bg-pink-600 hover:bg-pink-700 text-white rounded transition">Retry Activation</button>\n                </div>';

if (content.includes(bulkBarOld)) {
  content = content.replace(bulkBarOld, bulkBarNew);
  changes.push('1. Added Query and Retry Activation buttons to bulk action bar');
} else {
  console.log('Bulk bar pattern not found');
}

// 2. Remove Query button from per-row actions
const queryBtnOld = '\n                        \\${\\`<button onclick="querySimCarrier(\\${sim.id}, \'\\${sim.vendor}\', \'\\${sim.mobility_subscription_id || \'\'}\', \'\\${sim.iccid}\')" class="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition ml-1">Query</button>\\`}';

if (content.includes(queryBtnOld)) {
  content = content.replace(queryBtnOld, '');
  changes.push('2. Removed Query button from per-row actions');
} else {
  console.log('Per-row Query button not found');
}

// 3. Update querySimCarrier to handle single SIM (keep function)
// 4. Add bulkQuery function (after querySimCarrier)
const querySimCarrierEnd = "document.getElementById('helix-query-modal').classList.remove('hidden');\n        }\n\n        function showSimLogs";

const bulkQueryFn = "document.getElementById('helix-query-modal').classList.remove('hidden');\n        }\n\n        function bulkQuery() {\n            const selected = [...document.querySelectorAll('.sim-cb:checked')];\n            if (selected.length === 0) { showToast('Select at least one SIM', 'error'); return; }\n            if (selected.length > 1) { showToast('Query works on one SIM at a time. Select only one.', 'error'); return; }\n            const simId = parseInt(selected[0].value);\n            const sim = tableState.sims?.data?.find(s => s.id === simId);\n            if (!sim) { showToast('SIM not found', 'error'); return; }\n            querySimCarrier(simId, sim.vendor || 'helix', sim.mobility_subscription_id || '', sim.iccid || '');\n        }\n\n        async function bulkRetryActivation() {\n            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n            if (simIds.length === 0) { showToast('Select at least one SIM', 'error'); return; }\n            if (!(await showConfirm('Retry Activation', 'Retry activation for ' + simIds.length + ' SIM(s)?'))) return;\n            showToast('Retrying activation for ' + simIds.length + ' SIM(s)...', 'info');\n            let success = 0, failed = 0;\n            for (const simId of simIds) {\n                try {\n                    const res = await fetch(API_BASE + '/sim-action', {\n                        method: 'POST',\n                        headers: { 'Content-Type': 'application/json' },\n                        body: JSON.stringify({ sim_id: simId, action: 'retry_activation' })\n                    });\n                    const result = await res.json();\n                    if (result.ok) success++;\n                    else failed++;\n                } catch (e) {\n                    failed++;\n                }\n            }\n            showToast(success + ' success, ' + failed + ' failed', failed > 0 ? 'warning' : 'success');\n            loadSims(true);\n        }\n\n        function showSimLogs";

if (content.includes(querySimCarrierEnd)) {
  content = content.replace(querySimCarrierEnd, bulkQueryFn);
  changes.push('3. Added bulkQuery and bulkRetryActivation functions');
} else {
  console.log('querySimCarrier end not found');
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');

console.log('Patch applied:');
changes.forEach(c => console.log('  ' + c));
