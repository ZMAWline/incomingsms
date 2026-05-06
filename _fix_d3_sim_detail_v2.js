// _fix_d3_sim_detail_v2.js
// Fix single-quote escaping bugs introduced by v1:
//   1. Add wrapper functions _sdOta/_sdRetry/_sdViewLogs
//   2. Replace broken onclick strings in renderSimDetailDetails actions
//   3. Replace broken retryHtml in loadSimDetailLogs (use data-step attr)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Add wrapper functions before _sdField
// ─────────────────────────────────────────────────────────────────────────────
const OLD_SDFIELD = '        function _sdField(label, value) {';
const NEW_SDFIELD =
  '        function _sdOta() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, \'ota_refresh\'); }\n' +
  '        function _sdRetry() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, \'retry_activation\'); }\n' +
  '        function _sdViewLogs() { switchSimDetailTab(\'logs\'); }\n' +
  '\n' +
  '        function _sdField(label, value) {';

if (!content.includes(OLD_SDFIELD)) { console.error('FIX 1 FAILED: _sdField not found'); process.exit(1); }
content = content.replace(OLD_SDFIELD, NEW_SDFIELD);
console.log('Fix 1 (wrapper functions) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: Replace broken action onclick strings in renderSimDetailDetails
// ─────────────────────────────────────────────────────────────────────────────
// These were written with single quotes inside single-quoted strings by v1.
// Using double-quoted search strings here so we can embed single quotes safely.
const OLD_ACTIONS =
  "                (canOta ? '<button onclick=\"simAction(_sdCurrentSim.id, 'ota_refresh')\" class=\"px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition\">OTA Refresh</button>' : '') +\n" +
  "                (canRetry ? '<button onclick=\"simAction(_sdCurrentSim.id, 'retry_activation')\" class=\"px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition\">Retry Activation</button>' : '') +\n" +
  "                '<button onclick=\"switchSimDetailTab('logs')\" class=\"px-3 py-1.5 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded-lg transition\">View Logs</button>' +";

const NEW_ACTIONS =
  "                (canOta ? '<button onclick=\"_sdOta()\" class=\"px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition\">OTA Refresh</button>' : '') +\n" +
  "                (canRetry ? '<button onclick=\"_sdRetry()\" class=\"px-3 py-1.5 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition\">Retry Activation</button>' : '') +\n" +
  "                '<button onclick=\"_sdViewLogs()\" class=\"px-3 py-1.5 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded-lg transition\">View Logs</button>' +";

if (!content.includes(OLD_ACTIONS)) { console.error('FIX 2 FAILED: actions old string not found'); process.exit(1); }
content = content.replace(OLD_ACTIONS, NEW_ACTIONS);
console.log('Fix 2 (action onclick strings) applied.');

// ─────────────────────────────────────────────────────────────────────────────
// FIX 3: Replace broken retryHtml in loadSimDetailLogs (use data-step)
// ─────────────────────────────────────────────────────────────────────────────
const OLD_RETRY =
  "                    var retryHtml = (!log.response_ok || log.error) ? '<div class=\"mt-2\"><button onclick=\"retryLogStep('' + log.step + '')\" class=\"px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition\">&#8635; Retry</button></div>' : '';";

const NEW_RETRY =
  "                    var retryHtml = (!log.response_ok || log.error) ? '<div class=\"mt-2\"><button data-step=\"' + (log.step || '') + '\" onclick=\"retryLogStep(this.dataset.step)\" class=\"px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition\">&#8635; Retry</button></div>' : '';";

if (!content.includes(OLD_RETRY)) { console.error('FIX 3 FAILED: retryHtml old string not found'); process.exit(1); }
content = content.replace(OLD_RETRY, NEW_RETRY);
console.log('Fix 3 (retryHtml data-step) applied.');

// Write back
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All fixes applied.');
