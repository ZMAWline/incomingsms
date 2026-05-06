// _fix_d3_imei_condition.js
// Remove mobility_subscription_id requirement from IMEI button — it's Helix-only.
// Only gateway_id + port are needed to change IMEI.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Fix 1: row button condition (inside renderSims template literal)
const OLD1 = '\\${(sim.mobility_subscription_id && sim.gateway_id && sim.port) ? \\`<button onclick="openSimDetail(\\${sim.id}, \'imei\')" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1" title="Change IMEI">IMEI</button>\\` : \'\'}';
const NEW1 = '\\${(sim.gateway_id && sim.port) ? \\`<button onclick="openSimDetail(\\${sim.id}, \'imei\')" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1" title="Change IMEI">IMEI</button>\\` : \'\'}';

if (!content.includes(OLD1)) { console.error('Fix 1 FAILED: row button condition not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('Fix 1 (row button) applied.');

// Fix 2: renderSimDetailImei hasImei condition
const OLD2 = '            var hasImei = sim.mobility_subscription_id && sim.gateway_id && sim.port;';
const NEW2 = '            var hasImei = sim.gateway_id && sim.port;';

if (!content.includes(OLD2)) { console.error('Fix 2 FAILED: hasImei not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Fix 2 (hasImei) applied.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
