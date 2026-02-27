'use strict';
// Patch script: dashboard frontend – IMEI eligibility UI + Change IMEI
// Run: node _fix_dashboard_frontend.js

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
src = src.replace(/\r\n/g, '\n');

// Helper chars for building strings that contain special chars without confusion
const sq = "'";       // single quote
const bs = "\\";      // one backslash
const bt = "`";       // backtick
const bsbt = bs + bt; // backslash + backtick  (for file's escaped \` )
const bsdol = bs + "$"; // backslash + dollar  (for file's escaped \$)
const bslb = bs + "{"; // backslash + {  (no need, just use {)
// For template interpolation: \${...} appears in file as bsdol + '{' + ... + '}'
// Convenience: bsdol + '{' = the two chars \$  + {

// ===================================================================
// 1. Add "Check IMEIs" button to IMEI pool toolbar
// ===================================================================

const ADD_IMEIS_BTN = '<button onclick="showAddImeiModal()" class="px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">+ Add IMEIs</button>';
const ADD_IMEIS_BTN_NEW = ADD_IMEIS_BTN +
  '\n                        <button onclick="showCheckImeisModal()" class="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Check IMEIs</button>';

if (!src.includes(ADD_IMEIS_BTN)) {
  console.error('ERROR: Add IMEIs button not found');
  process.exit(1);
}
src = src.replace(ADD_IMEIS_BTN, ADD_IMEIS_BTN_NEW);
console.log('✓ Added Check IMEIs button to toolbar');

// ===================================================================
// 2. Add "Check" button to each IMEI pool row — positional approach
//    Find the actions <td> closing tag after the Restore button
// ===================================================================

const IMEI_CELL_ANCHOR = 'title="Restore to available stock">Restore</button>';
const anchorIdx = src.indexOf(IMEI_CELL_ANCHOR);
if (anchorIdx === -1) {
  console.error('ERROR: Restore button anchor not found in renderImeiPool');
  process.exit(1);
}

// Find the closing </td> after the anchor
const tdCloseIdx = src.indexOf('</td>', anchorIdx);
if (tdCloseIdx === -1) {
  console.error('ERROR: closing </td> not found after Restore button');
  process.exit(1);
}

// Build the Check button for the IMEI pool row.
// In the file this needs to be (inside a \`...\` template literal):
//   onclick="checkImeiEligibility('${entry.imei}', '${entry.gateway_id || ''}', '${entry.port || ''}', '${entry.status}')"
// Where \${ means the file has backslash-dollar-brace

const CHECK_BTN_ONCLICK =
  'checkImeiEligibility(' +
  sq + bsdol + '{entry.imei}' + sq + ', ' +
  sq + bsdol + "{entry.gateway_id || ''}" + sq + ', ' +
  sq + bsdol + "{entry.port || ''}" + sq + ', ' +
  sq + bsdol + '{entry.status}' + sq +
  ')';

const CHECK_BTN_HTML =
  '\n                        <button onclick="' + CHECK_BTN_ONCLICK +
  '" class="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition ml-1" title="Check carrier eligibility">Check</button>';

src = src.slice(0, tdCloseIdx) + CHECK_BTN_HTML + '\n                    ' + src.slice(tdCloseIdx);
console.log('✓ Added Check button to IMEI pool rows (positional)');

// ===================================================================
// 3. Add "Change IMEI" button to SIM rows in renderSims() — positional
// ===================================================================

// The Assign/Unassign cell ends with \`}  (backslash-backtick-close-brace)
// which is: bsbt + '}'
const ASSIGN_ANCHOR = 'title="Assign to reseller">Assign</button>' + bsbt + '}';
const assignIdx = src.indexOf(ASSIGN_ANCHOR);
if (assignIdx === -1) {
  console.error('ERROR: Assign reseller anchor not found in renderSims');
  process.exit(1);
}

const afterAssign = assignIdx + ASSIGN_ANCHOR.length;

// Build the Change IMEI button expression.
// In the file this should be (inside a \`...\` outer template):
//   \${(sim.mobility_subscription_id && sim.gateway_id && sim.port) ? \`<button onclick="showChangeImeiModal(\${sim.id}, '\${sim.iccid}', \${sim.gateway_id}, '\${sim.port}')" class="..." title="Change IMEI">IMEI</button>\` : ''}
//
// Where \${ = bsdol+'{' and \` = bsbt

const CHANGE_IMEI_ONCLICK =
  'showChangeImeiModal(' +
  bsdol + '{sim.id}, ' +
  sq + bsdol + '{sim.iccid}' + sq + ', ' +
  bsdol + '{sim.gateway_id}, ' +
  sq + bsdol + '{sim.port}' + sq +
  ')';

const CHANGE_IMEI_CONDITION = 'sim.mobility_subscription_id && sim.gateway_id && sim.port';

const CHANGE_IMEI_EXPR =
  '\n                        ' +
  bsdol + '{(' + CHANGE_IMEI_CONDITION + ') ? ' +
  bsbt + '<button onclick="' + CHANGE_IMEI_ONCLICK +
  '" class="px-2 py-1 text-xs bg-orange-600 hover:bg-orange-700 text-white rounded transition ml-1"' +
  ' title="Change IMEI">IMEI</button>' +
  bsbt + ' : ' + sq + sq + '}';

src = src.slice(0, afterAssign) + CHANGE_IMEI_EXPR + src.slice(afterAssign);
console.log('✓ Added Change IMEI button to SIM rows (positional)');

// ===================================================================
// 4. Add new modal HTML before the <script> tag
// ===================================================================

const SCRIPT_TAG = '\n    <script>\n        const API_BASE = \'/api\';';

const NEW_MODALS = `
    <!-- IMEI Eligibility Modal -->
    <div id="imei-eligibility-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="imei-eligibility-title" class="text-lg font-semibold text-white">IMEI Eligibility Check</h3>
                <button onclick="document.getElementById('imei-eligibility-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <div id="imei-eligibility-content" class="text-sm text-gray-300">Checking...</div>
                <div id="imei-eligibility-fix-btn" class="mt-4 hidden">
                    <button onclick="fixIncompatibleImei()" class="px-4 py-2 text-sm bg-yellow-600 hover:bg-yellow-700 text-white rounded-lg transition">Fix (Replace with Pool IMEI)</button>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('imei-eligibility-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Check IMEIs Bulk Modal -->
    <div id="check-imeis-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 class="text-lg font-semibold text-white">Bulk IMEI Eligibility Check</h3>
                <button onclick="document.getElementById('check-imeis-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <p class="text-sm text-gray-400 mb-3">Paste IMEIs to check eligibility (one per line, max 100):</p>
                <textarea id="check-imeis-input" rows="6" class="w-full px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono mb-3" placeholder="351756051523999"></textarea>
                <button onclick="runBulkImeiCheck()" id="check-imeis-run-btn" class="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition">Run Check</button>
                <div id="check-imeis-result" class="mt-4 hidden">
                    <h4 class="text-sm font-medium text-gray-400 mb-2">Results:</h4>
                    <div class="overflow-x-auto">
                        <table class="w-full text-sm">
                            <thead><tr class="text-left text-xs text-gray-500 border-b border-dark-600">
                                <th class="py-2 pr-4">IMEI</th>
                                <th class="py-2 pr-4">Eligible</th>
                                <th class="py-2 pr-4">Device</th>
                                <th class="py-2">Plans</th>
                            </tr></thead>
                            <tbody id="check-imeis-tbody" class="text-gray-300"></tbody>
                        </table>
                    </div>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('check-imeis-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <!-- Change IMEI Modal -->
    <div id="change-imei-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div class="bg-dark-800 rounded-xl border border-dark-600 w-full max-w-lg max-h-[85vh] flex flex-col">
            <div class="px-5 py-4 border-b border-dark-600 flex justify-between items-center">
                <h3 id="change-imei-title" class="text-lg font-semibold text-white">Change IMEI</h3>
                <button onclick="document.getElementById('change-imei-modal').classList.add('hidden')" class="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
            </div>
            <div class="p-5 overflow-y-auto flex-1">
                <p id="change-imei-sim-info" class="text-sm text-gray-400 mb-4"></p>
                <div class="flex gap-3 mb-4">
                    <button id="change-imei-auto-btn" onclick="confirmChangeImei(true)" class="flex-1 px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Auto (Pick from Pool)</button>
                </div>
                <div class="border-t border-dark-600 pt-4">
                    <label class="block text-xs text-gray-500 mb-1">Manual IMEI (15 digits)</label>
                    <div class="flex gap-2">
                        <input id="change-imei-input" type="text" maxlength="15" class="flex-1 px-3 py-2 bg-dark-700 border border-dark-500 rounded-lg text-gray-200 text-sm focus:outline-none focus:border-accent font-mono" placeholder="351756051523999">
                        <button onclick="checkManualImeiEligibility()" class="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition whitespace-nowrap">Check</button>
                    </div>
                    <div id="change-imei-eligibility-result" class="mt-2 text-xs"></div>
                </div>
                <div class="mt-4">
                    <button id="change-imei-confirm-btn" onclick="confirmChangeImei(false)" class="w-full px-4 py-2 text-sm bg-orange-600 hover:bg-orange-700 text-white rounded-lg transition">Confirm Change IMEI</button>
                </div>
                <div id="change-imei-result-section" class="mt-4 hidden">
                    <pre id="change-imei-output" class="bg-dark-900 p-4 rounded-lg text-xs font-mono overflow-x-auto text-gray-300 border border-dark-600"></pre>
                </div>
            </div>
            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">
                <button onclick="document.getElementById('change-imei-modal').classList.add('hidden')" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>
            </div>
        </div>
    </div>

    <script>
        const API_BASE = '/api';`;

if (!src.includes(SCRIPT_TAG)) {
  console.error('ERROR: <script> tag marker not found');
  process.exit(1);
}
src = src.replace(SCRIPT_TAG, NEW_MODALS);
console.log('✓ Added 3 new modals');

// ===================================================================
// 5. Add new JS functions before showDiscrepancyModal
//    Build with string concatenation (no template literals) to avoid
//    any escaping issues when the patch script itself is parsed.
// ===================================================================

const DISCREPANCY_MARKER = '        function showDiscrepancyModal(discrepancies) {';
if (!src.includes(DISCREPANCY_MARKER)) {
  console.error('ERROR: showDiscrepancyModal marker not found');
  process.exit(1);
}

const NL = '\n';
const I = '            '; // 12-space indent (inside script block)
const I8 = '        ';   // 8-space indent

function line(indent, text) { return indent + text + NL; }

const NEW_JS = [
  line(I8, '// ===== IMEI Eligibility ====='),
  line(I8, 'window._imeiEligibilityContext = null;'),
  NL,
  line(I8, 'async function checkImeiEligibility(imei, gatewayId, port, status) {'),
  line(I, "window._imeiEligibilityContext = { imei, gatewayId, port, status };"),
  line(I, "const modal = document.getElementById('imei-eligibility-modal');"),
  line(I, "document.getElementById('imei-eligibility-title').textContent = 'IMEI Check: ' + imei;"),
  line(I, "document.getElementById('imei-eligibility-content').innerHTML = '<p class=\"text-gray-400\">Checking eligibility...</p>';"),
  line(I, "document.getElementById('imei-eligibility-fix-btn').classList.add('hidden');"),
  line(I, "modal.classList.remove('hidden');"),
  NL,
  line(I, "try {"),
  line(I + '    ', "const res = await fetch(API_BASE + '/check-imei?imei=' + encodeURIComponent(imei));"),
  line(I + '    ', "const data = await res.json();"),
  line(I + '    ', "const el = document.getElementById('imei-eligibility-content');"),
  line(I + '    ', "if (data.eligible) {"),
  line(I + '        ', "const deviceInfo = (data.result && (data.result.brand || data.result.deviceType)) || '';"),
  line(I + '        ', "const plans = Array.isArray(data.result && data.result.plans) ? data.result.plans.map(function(p) { return p.name || p.planName || JSON.stringify(p); }).join(', ') : '';"),
  line(I + '        ', "el.innerHTML = '<div class=\"space-y-3\">' +"),
  line(I + '            ', "'<p><span class=\"inline-block px-2 py-0.5 text-xs rounded-full bg-accent/20 text-accent font-medium\">&#10003; Eligible</span></p>' +"),
  line(I + '            ', "(deviceInfo ? '<p class=\"text-gray-400\">Device: <span class=\"text-gray-200\">' + deviceInfo + '</span></p>' : '') +"),
  line(I + '            ', "(plans ? '<p class=\"text-gray-400\">Plans: <span class=\"text-gray-200\">' + plans + '</span></p>' : '') +"),
  line(I + '            ', "'<details class=\"mt-2\"><summary class=\"text-xs text-gray-500 cursor-pointer\">Raw response</summary><pre class=\"mt-1 text-xs font-mono text-gray-400 overflow-x-auto bg-dark-900 p-2 rounded\">' + JSON.stringify(data.result, null, 2) + '</pre></details>' +"),
  line(I + '            ', "'</div>';"),
  line(I + '    ', "} else {"),
  line(I + '        ', "el.innerHTML = '<div class=\"space-y-3\">' +"),
  line(I + '            ', "'<p><span class=\"inline-block px-2 py-0.5 text-xs rounded-full bg-red-500/20 text-red-400 font-medium\">&#10007; Not Eligible</span></p>' +"),
  line(I + '            ', "(data.error ? '<p class=\"text-red-400 text-xs\">' + data.error + '</p>' : '') +"),
  line(I + '            ', "'<details class=\"mt-2\"><summary class=\"text-xs text-gray-500 cursor-pointer\">Raw response</summary><pre class=\"mt-1 text-xs font-mono text-gray-400 overflow-x-auto bg-dark-900 p-2 rounded\">' + JSON.stringify(data.result || {}, null, 2) + '</pre></details>' +"),
  line(I + '            ', "'</div>';"),
  line(I + '        ', "if (status === 'in_use' && gatewayId && port) {"),
  line(I + '            ', "document.getElementById('imei-eligibility-fix-btn').classList.remove('hidden');"),
  line(I + '        ', "}"),
  line(I + '    ', "}"),
  line(I, "} catch (err) {"),
  line(I + '    ', "document.getElementById('imei-eligibility-content').innerHTML = '<p class=\"text-red-400\">Error: ' + err + '</p>';"),
  line(I, "}"),
  line(I8, "}"),
  NL,
  line(I8, "async function fixIncompatibleImei() {"),
  line(I, "const ctx = window._imeiEligibilityContext;"),
  line(I, "if (!ctx || !ctx.imei || !ctx.gatewayId || !ctx.port) { alert('Missing context for fix'); return; }"),
  line(I, "const fixBtn = document.querySelector('#imei-eligibility-fix-btn button');"),
  line(I, "if (fixBtn) { fixBtn.disabled = true; fixBtn.textContent = 'Fixing...'; }"),
  line(I, "try {"),
  line(I + '    ', "const res = await fetch(API_BASE + '/imei-pool/fix-incompatible', {"),
  line(I + '        ', "method: 'POST',"),
  line(I + '        ', "headers: { 'Content-Type': 'application/json' },"),
  line(I + '        ', "body: JSON.stringify({ imei: ctx.imei, gateway_id: ctx.gatewayId, port: ctx.port }),"),
  line(I + '    ', "});"),
  line(I + '    ', "const data = await res.json();"),
  line(I + '    ', "const el = document.getElementById('imei-eligibility-content');"),
  line(I + '    ', "if (data.ok) {"),
  line(I + '        ', "el.innerHTML += '<div class=\"mt-4 p-3 bg-accent/10 border border-accent/30 rounded-lg\"><p class=\"text-accent font-medium text-sm\">&#10003; Fixed!</p><p class=\"text-gray-300 text-xs mt-1\">New IMEI: <span class=\"font-mono\">' + data.new_imei + '</span></p></div>';"),
  line(I + '        ', "document.getElementById('imei-eligibility-fix-btn').classList.add('hidden');"),
  line(I + '        ', "loadImeiPool();"),
  line(I + '    ', "} else {"),
  line(I + '        ', "el.innerHTML += '<div class=\"mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg\"><p class=\"text-red-400 text-sm\">Fix failed: ' + (data.error || 'Unknown error') + '</p></div>';"),
  line(I + '    ', "}"),
  line(I, "} catch (err) {"),
  line(I + '    ', "alert('Fix error: ' + err);"),
  line(I, "} finally {"),
  line(I + '    ', "if (fixBtn) { fixBtn.disabled = false; fixBtn.textContent = 'Fix (Replace with Pool IMEI)'; }"),
  line(I, "}"),
  line(I8, "}"),
  NL,
  line(I8, "// ===== Bulk IMEI Check Tool ====="),
  line(I8, "function showCheckImeisModal() {"),
  line(I, "document.getElementById('check-imeis-input').value = '';"),
  line(I, "document.getElementById('check-imeis-result').classList.add('hidden');"),
  line(I, "document.getElementById('check-imeis-modal').classList.remove('hidden');"),
  line(I8, "}"),
  NL,
  line(I8, "async function runBulkImeiCheck() {"),
  line(I, "const raw = document.getElementById('check-imeis-input').value.trim();"),
  line(I, "const imeis = raw.split(/\\n/).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });"),
  line(I, "if (imeis.length === 0) { alert('Enter at least one IMEI'); return; }"),
  line(I, "const btn = document.getElementById('check-imeis-run-btn');"),
  line(I, "btn.disabled = true; btn.textContent = 'Checking...';"),
  line(I, "try {"),
  line(I + '    ', "const res = await fetch(API_BASE + '/check-imeis', {"),
  line(I + '        ', "method: 'POST',"),
  line(I + '        ', "headers: { 'Content-Type': 'application/json' },"),
  line(I + '        ', "body: JSON.stringify({ imeis: imeis }),"),
  line(I + '    ', "});"),
  line(I + '    ', "const data = await res.json();"),
  line(I + '    ', "const tbody = document.getElementById('check-imeis-tbody');"),
  line(I + '    ', "if (Array.isArray(data.results)) {"),
  line(I + '        ', "tbody.innerHTML = data.results.map(function(r) {"),
  line(I + '            ', "const eligClass = r.eligible ? 'text-accent' : 'text-red-400';"),
  line(I + '            ', "const eligText = r.eligible ? '&#10003; Yes' : '&#10007; No';"),
  line(I + '            ', "const device = (r.result && (r.result.brand || r.result.deviceType)) || '-';"),
  line(I + '            ', "const plans = Array.isArray(r.result && r.result.plans) ? r.result.plans.length + ' plan(s)' : '-';"),
  line(I + '            ', "return '<tr class=\"border-b border-dark-600\"><td class=\"py-2 pr-4 font-mono text-xs\">' + r.imei + '</td><td class=\"py-2 pr-4 ' + eligClass + ' text-sm\">' + eligText + '</td><td class=\"py-2 pr-4 text-gray-400 text-xs\">' + device + '</td><td class=\"py-2 text-gray-400 text-xs\">' + plans + '</td></tr>';"),
  line(I + '        ', "}).join('');"),
  line(I + '    ', "} else {"),
  line(I + '        ', "tbody.innerHTML = '<tr><td colspan=\"4\" class=\"py-3 text-red-400\">' + (data.error || 'Unknown error') + '</td></tr>';"),
  line(I + '    ', "}"),
  line(I + '    ', "document.getElementById('check-imeis-result').classList.remove('hidden');"),
  line(I, "} catch (err) {"),
  line(I + '    ', "alert('Check error: ' + err);"),
  line(I, "} finally {"),
  line(I + '    ', "btn.disabled = false; btn.textContent = 'Run Check';"),
  line(I, "}"),
  line(I8, "}"),
  NL,
  line(I8, "// ===== Change IMEI ====="),
  line(I8, "window._changeImeiContext = null;"),
  NL,
  line(I8, "function showChangeImeiModal(simId, iccid, gatewayId, port) {"),
  line(I, "window._changeImeiContext = { simId: simId, iccid: iccid, gatewayId: gatewayId, port: port };"),
  line(I, "document.getElementById('change-imei-title').textContent = 'Change IMEI \u2014 SIM ' + simId;"),
  line(I, "document.getElementById('change-imei-sim-info').textContent = 'ICCID: ' + iccid + ' | Gateway: ' + gatewayId + ' | Port: ' + port;"),
  line(I, "document.getElementById('change-imei-input').value = '';"),
  line(I, "document.getElementById('change-imei-eligibility-result').textContent = '';"),
  line(I, "document.getElementById('change-imei-result-section').classList.add('hidden');"),
  line(I, "document.getElementById('change-imei-modal').classList.remove('hidden');"),
  line(I8, "}"),
  NL,
  line(I8, "async function checkManualImeiEligibility() {"),
  line(I, "const imei = document.getElementById('change-imei-input').value.trim();"),
  line(I, "if (!/^\\d{15}$/.test(imei)) {"),
  line(I + '    ', "document.getElementById('change-imei-eligibility-result').innerHTML = '<span class=\"text-yellow-400\">Enter a valid 15-digit IMEI first</span>';"),
  line(I + '    ', "return;"),
  line(I, "}"),
  line(I, "document.getElementById('change-imei-eligibility-result').innerHTML = '<span class=\"text-gray-400\">Checking...</span>';"),
  line(I, "try {"),
  line(I + '    ', "const res = await fetch(API_BASE + '/check-imei?imei=' + encodeURIComponent(imei));"),
  line(I + '    ', "const data = await res.json();"),
  line(I + '    ', "if (data.eligible) {"),
  line(I + '        ', "document.getElementById('change-imei-eligibility-result').innerHTML = '<span class=\"text-accent\">&#10003; Eligible</span>';"),
  line(I + '    ', "} else {"),
  line(I + '        ', "document.getElementById('change-imei-eligibility-result').innerHTML = '<span class=\"text-red-400\">&#10007; Not eligible for this carrier/plan</span>';"),
  line(I + '    ', "}"),
  line(I, "} catch (err) {"),
  line(I + '    ', "document.getElementById('change-imei-eligibility-result').innerHTML = '<span class=\"text-red-400\">Check failed: ' + err + '</span>';"),
  line(I, "}"),
  line(I8, "}"),
  NL,
  line(I8, "async function confirmChangeImei(autoImei) {"),
  line(I, "const ctx = window._changeImeiContext;"),
  line(I, "if (!ctx) { alert('No SIM context'); return; }"),
  line(I, "let newImei = null;"),
  line(I, "if (!autoImei) {"),
  line(I + '    ', "newImei = document.getElementById('change-imei-input').value.trim();"),
  line(I + '    ', "if (!/^\\d{15}$/.test(newImei)) { alert('Enter a valid 15-digit IMEI or use Auto'); return; }"),
  line(I + '    ', "if (!confirm('Change IMEI for SIM ' + ctx.simId + ' to ' + newImei + '?')) return;"),
  line(I, "} else {"),
  line(I + '    ', "if (!confirm('Auto-pick an available IMEI from pool and apply to SIM ' + ctx.simId + '?')) return;"),
  line(I, "}"),
  line(I, "const autoBtn = document.getElementById('change-imei-auto-btn');"),
  line(I, "const confirmBtn = document.getElementById('change-imei-confirm-btn');"),
  line(I, "if (autoImei && autoBtn) { autoBtn.disabled = true; autoBtn.textContent = 'Working...'; }"),
  line(I, "if (!autoImei && confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Working...'; }"),
  line(I, "try {"),
  line(I + '    ', "const body = { sim_id: ctx.simId, action: 'change_imei', auto_imei: autoImei };"),
  line(I + '    ', "if (!autoImei) body.new_imei = newImei;"),
  line(I + '    ', "const res = await fetch(API_BASE + '/sim-action', {"),
  line(I + '        ', "method: 'POST',"),
  line(I + '        ', "headers: { 'Content-Type': 'application/json' },"),
  line(I + '        ', "body: JSON.stringify(body),"),
  line(I + '    ', "});"),
  line(I + '    ', "const data = await res.json();"),
  line(I + '    ', "document.getElementById('change-imei-output').textContent = JSON.stringify(data, null, 2);"),
  line(I + '    ', "document.getElementById('change-imei-result-section').classList.remove('hidden');"),
  line(I + '    ', "if (data.ok) {"),
  line(I + '        ', "document.getElementById('sim-action-title').textContent = 'Change IMEI \u2014 ' + ctx.iccid;"),
  line(I + '        ', "document.getElementById('sim-action-output').textContent = JSON.stringify(data, null, 2);"),
  line(I + '        ', "document.getElementById('sim-action-logs-section').classList.remove('hidden');"),
  line(I + '        ', "window._simActionIccid = ctx.iccid;"),
  line(I + '        ', "document.getElementById('change-imei-modal').classList.add('hidden');"),
  line(I + '        ', "document.getElementById('sim-action-modal').classList.remove('hidden');"),
  line(I + '        ', "loadSimActionLogs();"),
  line(I + '        ', "loadImeiPool();"),
  line(I + '        ', "loadSims(true);"),
  line(I + '    ', "}"),
  line(I, "} catch (err) {"),
  line(I + '    ', "alert('Change IMEI error: ' + err);"),
  line(I, "} finally {"),
  line(I + '    ', "if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = 'Auto (Pick from Pool)'; }"),
  line(I + '    ', "if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Change IMEI'; }"),
  line(I, "}"),
  line(I8, "}"),
  NL,
].join('');

src = src.replace(DISCREPANCY_MARKER, NEW_JS + DISCREPANCY_MARKER);
console.log('✓ Added JS functions (7 new functions)');

// ===================================================================
// Write with CRLF
// ===================================================================
const out = src.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, out, 'utf8');
console.log('✓ Written src/dashboard/index.js with CRLF');
console.log('Run: node --input-type=module --check < src/dashboard/index.js');
