// _fix_d3_imei_close.js
// When clicking "Open Change IMEI Dialog", close the detail modal first so the
// IMEI modal isn't hidden behind it (both are z-50).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Fix 1: Add _sdOpenImei() wrapper alongside the other wrappers
const OLD_WRAPPERS = "        function _sdOta() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, 'ota_refresh'); }";
const NEW_WRAPPERS =
  "        function _sdOta() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, 'ota_refresh'); }\n" +
  "        function _sdOpenImei() { if (!_sdCurrentSim) return; var c=_sdCurrentSim; closeSimDetail(); showChangeImeiModal(c.id, c.iccid, c.gateway_id, c.port); }";

if (!content.includes(OLD_WRAPPERS)) { console.error('Fix 1 FAILED: wrapper anchor not found'); process.exit(1); }
content = content.replace(OLD_WRAPPERS, NEW_WRAPPERS);
console.log('Fix 1 (wrapper function) applied.');

// Fix 2: Change onclick in renderSimDetailImei to use the wrapper
const OLD_BTN = "'<button onclick=\"showChangeImeiModal(_sdCurrentSim.id, _sdCurrentSim.iccid, _sdCurrentSim.gateway_id, _sdCurrentSim.port)\" class=\"px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition\">Open Change IMEI Dialog</button>'";
const NEW_BTN = "'<button onclick=\"_sdOpenImei()\" class=\"px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition\">Open Change IMEI Dialog</button>'";

if (!content.includes(OLD_BTN)) { console.error('Fix 2 FAILED: IMEI button not found'); process.exit(1); }
content = content.replace(OLD_BTN, NEW_BTN);
console.log('Fix 2 (button onclick) applied.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
