// Patch D4: Replace silent button hiding with disabled + tooltip for vendor-incompatible actions.
// OTA and Retry buttons now show as disabled gray buttons with explanatory title tooltips
// for Teltik, Wing IoT, and disabled-Helix SIMs, instead of vanishing.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const before = content;

// Escaping helpers for the template literal context
const BT = '\\' + '`';   // produces \` in the file (escaped backtick)
const DS = '\\' + '${';  // produces \${ in the file (escaped template expr)

// ============================================================
// OTA button: replace hide-when-unsupported with disabled+tooltip
// ============================================================

const OLD_OTA = DS + "(!['teltik', 'wing_iot'].includes(sim.vendor) && sim.status === 'active') ? " + BT +
  '<button onclick="simAction(' + DS + "sim.id}, 'ota_refresh')\" class=\"px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition mr-1\">OTA</button>" + BT + " : ''}";

// New: show disabled button with tooltip for unsupported vendors; hide if not active
const NEW_OTA = DS + "sim.status === 'active' ? (" +
  "['teltik', 'wing_iot'].includes(sim.vendor) ? " + BT +
  '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="OTA not available for ' + DS + "sim.vendor === 'teltik' ? 'Teltik' : 'Wing IoT'}\">" +
  "OTA</button>" + BT +
  " : (sim.vendor === 'helix' && !window.HELIX_ENABLED) ? " + BT +
  '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Helix is disabled">' +
  "OTA</button>" + BT +
  " : " + BT +
  '<button onclick="simAction(' + DS + "sim.id}, 'ota_refresh')\" class=\"px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition mr-1\">OTA</button>" + BT +
  ") : ''}";

if (!content.includes(OLD_OTA)) { console.error('PATCH FAILED: OTA button not found'); process.exit(1); }
content = content.replace(OLD_OTA, NEW_OTA);

// ============================================================
// Retry button: replace hide-when-unsupported with disabled+tooltip
// ============================================================

const OLD_RETRY = DS + "(!['teltik', 'wing_iot'].includes(sim.vendor) && sim.status === 'error') ? " + BT +
  '<button onclick="retryActivation(' + DS + "sim.id})\" class=\"px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1\">Retry</button>" + BT + " : ''}";

const NEW_RETRY = DS + "sim.status === 'error' ? (" +
  "['teltik', 'wing_iot'].includes(sim.vendor) ? " + BT +
  '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Retry not available for ' + DS + "sim.vendor === 'teltik' ? 'Teltik' : 'Wing IoT'}\">" +
  "Retry</button>" + BT +
  " : (sim.vendor === 'helix' && !window.HELIX_ENABLED) ? " + BT +
  '<button disabled class="px-2 py-1 text-xs bg-gray-700 text-gray-500 rounded mr-1 cursor-not-allowed" title="Helix is disabled">' +
  "Retry</button>" + BT +
  " : " + BT +
  '<button onclick="retryActivation(' + DS + "sim.id})\" class=\"px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded transition mr-1\">Retry</button>" + BT +
  ") : ''}";

if (!content.includes(OLD_RETRY)) { console.error('PATCH FAILED: Retry button not found'); process.exit(1); }
content = content.replace(OLD_RETRY, NEW_RETRY);

if (content === before) { console.error('ERROR: no replacements made'); process.exit(1); }
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch D4 applied: OTA and Retry buttons show disabled with vendor tooltip');
