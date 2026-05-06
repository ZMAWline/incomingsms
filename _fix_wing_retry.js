// _fix_wing_retry.js — enable Retry Activation for Wing IoT SIMs
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Fix 1: canRetry in SIM detail panel — remove wing_iot from exclusion
const OLD1 = "var canRetry = sim.status === 'error' && ['teltik','wing_iot'].indexOf(sim.vendor) === -1 && !(sim.vendor === 'helix' && !window.HELIX_ENABLED);";
const NEW1 = "var canRetry = sim.status === 'error' && sim.vendor !== 'teltik' && !(sim.vendor === 'helix' && !window.HELIX_ENABLED);";
if (!content.includes(OLD1)) { console.error('PATCH FAILED: canRetry old string not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('Fix 1 applied: canRetry now includes wing_iot');

// Fix 2: SIM table row — wing_iot gets a working Retry button (only teltik stays disabled)
const BT = '\\' + '`';
const DS = '\\' + '${';

const OLD2 = DS + "sim.status === 'error' ? (['teltik', 'wing_iot'].includes(sim.vendor) ? " + BT + '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Retry not available for ' + DS + "sim.vendor === 'teltik' ? 'Teltik' : 'Wing IoT'" + '}">Retry</button>' + BT + " : (sim.vendor === 'helix' && !window.HELIX_ENABLED) ? " + BT + '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Helix is disabled">Retry</button>' + BT + ' : ' + BT + '<button onclick="retryActivation(' + DS + 'sim.id})" class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1">Retry</button>' + BT + ") : ''}";

const NEW2 = DS + "sim.status === 'error' ? (sim.vendor === 'teltik' ? " + BT + '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Retry not available for Teltik">Retry</button>' + BT + " : (sim.vendor === 'helix' && !window.HELIX_ENABLED) ? " + BT + '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Helix is disabled">Retry</button>' + BT + ' : ' + BT + '<button onclick="retryActivation(' + DS + 'sim.id})" class="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1">Retry</button>' + BT + ") : ''}";

if (!content.includes(OLD2)) { console.error('PATCH FAILED: SIM table retry old string not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Fix 2 applied: SIM table Retry button enabled for wing_iot');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch written successfully.');
