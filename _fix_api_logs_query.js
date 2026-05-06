// 1. Add Query button to SIM row actions
// 2. Rename Helix Logs to API Logs everywhere
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

const changes = [];

// 1. Add Query button after Status button in SIM row
const BT = '\\' + '`';  // produces \` in file
const DS = '\\' + '${'; // produces \${ in file

const statusBtnOld = DS + '{' + BT + '<button onclick="showSetStatusModal(' + DS + 'sim.id}, ' + "'" + DS + "sim.status}')" + '" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' + BT + '}';

const statusBtnNew = DS + '{' + BT + '<button onclick="showSetStatusModal(' + DS + 'sim.id}, ' + "'" + DS + "sim.status}')" + '" class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition ml-1">Status</button>' + BT + '}\n' +
'                        ' + DS + '{' + BT + '<button onclick="querySimCarrier(' + DS + "sim.id}, '" + DS + "sim.vendor}', '" + DS + "sim.mobility_subscription_id || ''}', '" + DS + "sim.iccid}')" + '" class="px-2 py-1 text-xs bg-cyan-600 hover:bg-cyan-500 text-white rounded transition ml-1">Query</button>' + BT + '}';

if (content.includes(statusBtnOld)) {
  content = content.replace(statusBtnOld, statusBtnNew);
  changes.push('1. Added Query button to SIM row actions');
} else {
  console.log('Could not find Status button pattern');
}

// 2. Rename "Helix Logs" to "API Logs" everywhere
const renames = [
  ['Recent Helix API Logs', 'Recent API Logs'],
  ["'Helix Logs — SIM #'", "'API Logs — SIM #'"],
  ["'Loading Helix logs...'", "'Loading API logs...'"],
  ['Failed to load Helix API logs', 'Failed to load API logs'],
  ['Retry a failed Helix API log step', 'Retry a failed API log step'],
  ['title="View Helix logs"', 'title="View API logs"']
];

for (const [old, newStr] of renames) {
  if (content.includes(old)) {
    content = content.replace(old, newStr);
    changes.push('Renamed: ' + old.slice(0, 30));
  }
}

// 3. Add querySimCarrier function (before showSimLogs)
const showSimLogsOld = 'function showSimLogs(simId) {';
const querySimCarrierFn = `function querySimCarrier(simId, vendor, subId, iccid) {
            const vendorSelect = document.getElementById('carrier-query-vendor');
            const input = document.getElementById('helix-subid-input');
            if (vendor === 'wing_iot') {
                vendorSelect.value = 'wing_iot';
                input.value = iccid || '';
            } else {
                vendorSelect.value = 'helix';
                input.value = subId || '';
            }
            updateCarrierQueryUI();
            document.getElementById('helix-query-modal').classList.remove('hidden');
        }

        function showSimLogs(simId) {`;

if (content.includes(showSimLogsOld)) {
  content = content.replace(showSimLogsOld, querySimCarrierFn);
  changes.push('3. Added querySimCarrier function');
}

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');

console.log('Patch applied:');
changes.forEach(c => console.log('  ' + c));
