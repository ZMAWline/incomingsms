// _fix_billing_ledger_frontend.js
// Splices new HTML sections, modal, JS functions, and tab/sim-detail wiring
// for Plan Rates + Billing Ledger UI.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const TAB_HTML = fs.readFileSync(path.join(__dirname, '_patch_bl_tab_html.txt'), 'utf8').replace(/\r\n/g, '\n');
const MODAL_HTML = fs.readFileSync(path.join(__dirname, '_patch_bl_modal.txt'), 'utf8').replace(/\r\n/g, '\n');
const RAW_JS = fs.readFileSync(path.join(__dirname, '_patch_bl_js.txt'), 'utf8').replace(/\r\n/g, '\n');

// Frontend JS sits inside the outer getHTML() template literal — backticks and
// ${} must be escaped so the outer template doesn't eat them.
const escapedJs = RAW_JS.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// ── 1) Insert HTML sections at the END of tab-billing div ───────────────────
// Anchor on the closing of the audit-history div + the tab-billing closing tag.
const TAB_HTML_OLD =
'                            <tbody id="audit-history-table" class="text-sm">\n' +
'                                <tr><td colspan="9" class="px-4 py-4 text-center text-gray-500">No audits yet</td></tr>\n' +
'                            </tbody>\n' +
'                        </table>\n' +
'                    </div>\n' +
'                </div>\n' +
'            </div>\n' +
'\n' +
'            <!-- SMS Usage Tab -->';
const TAB_HTML_NEW =
'                            <tbody id="audit-history-table" class="text-sm">\n' +
'                                <tr><td colspan="9" class="px-4 py-4 text-center text-gray-500">No audits yet</td></tr>\n' +
'                            </tbody>\n' +
'                        </table>\n' +
'                    </div>\n' +
'                </div>\n' +
'\n' +
TAB_HTML + '\n' +
'            </div>\n' +
'\n' +
'            <!-- SMS Usage Tab -->';

// ── 2) Insert plan-rate modal before the sim-detail-modal ───────────────────
const MODAL_OLD =
'    <div id="sim-detail-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">';
const MODAL_NEW =
MODAL_HTML +
'    <div id="sim-detail-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">';

// ── 3) Add Billing tab button + content div to sim-detail-modal ─────────────
const SD_TABS_OLD =
'                <button id="sdtab-btn-logs" onclick="switchSimDetailTab(\'logs\')" class="py-3 px-4 text-sm text-gray-400 transition">API Logs</button>\n' +
'            </div>';
const SD_TABS_NEW =
'                <button id="sdtab-btn-logs" onclick="switchSimDetailTab(\'logs\')" class="py-3 px-4 text-sm text-gray-400 transition">API Logs</button>\n' +
'                <button id="sdtab-btn-billing" onclick="switchSimDetailTab(\'billing\')" class="py-3 px-4 text-sm text-gray-400 transition">Billing</button>\n' +
'            </div>';

const SD_CONTENT_OLD =
'                <div id="sdtab-logs" class="hidden">\n' +
'                    <div class="flex justify-between items-center mb-3">\n' +
'                        <p class="text-sm text-gray-400">Carrier API Logs</p>\n' +
'                        <button onclick="if(_sdCurrentSim)loadSimDetailLogs(_sdCurrentSim.id,_sdCurrentSim.iccid)" class="px-2 py-1 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded transition">&#8635; Refresh</button>\n' +
'                    </div>\n' +
'                    <div id="sd-logs-container"></div>\n' +
'                </div>\n' +
'            </div>';
const SD_CONTENT_NEW =
'                <div id="sdtab-logs" class="hidden">\n' +
'                    <div class="flex justify-between items-center mb-3">\n' +
'                        <p class="text-sm text-gray-400">Carrier API Logs</p>\n' +
'                        <button onclick="if(_sdCurrentSim)loadSimDetailLogs(_sdCurrentSim.id,_sdCurrentSim.iccid)" class="px-2 py-1 text-xs bg-dark-600 hover:bg-dark-500 text-gray-300 rounded transition">&#8635; Refresh</button>\n' +
'                    </div>\n' +
'                    <div id="sd-logs-container"></div>\n' +
'                </div>\n' +
'                <div id="sdtab-billing" class="hidden"></div>\n' +
'            </div>';

// ── 4) Update switchSimDetailTab to include billing ────────────────────────
const SWITCH_OLD =
'        function switchSimDetailTab(tab) {\n' +
'            [\'details\', \'status\', \'imei\', \'logs\'].forEach(function(t) {';
const SWITCH_NEW =
'        function switchSimDetailTab(tab) {\n' +
'            [\'details\', \'status\', \'imei\', \'logs\', \'billing\'].forEach(function(t) {';

const SWITCH_TAIL_OLD =
'            if (tab === \'logs\' && _sdCurrentSim) loadSimDetailLogs(_sdCurrentSim.id, _sdCurrentSim.iccid);\n' +
'        }';
const SWITCH_TAIL_NEW =
'            if (tab === \'logs\' && _sdCurrentSim) loadSimDetailLogs(_sdCurrentSim.id, _sdCurrentSim.iccid);\n' +
'            if (tab === \'billing\' && _sdCurrentSim) loadSimDetailBilling(_sdCurrentSim.id);\n' +
'        }';

// ── 5) Update billing tab loader to also call new loaders ───────────────────
const TABLOAD_OLD =
'            if (tabName === \'billing\') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); }';
const TABLOAD_NEW =
'            if (tabName === \'billing\') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); loadPlanRates(); loadBillingLedgerSummary(); }';

// ── 6) Update audit vendor select to add wing_iot label, deprecate wing ─────
const AUDIT_SELECT_OLD =
'                            <select id="audit-vendor" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">\n' +
'                                <option value="wing">Wing</option>\n' +
'                            </select>';
const AUDIT_SELECT_NEW =
'                            <select id="audit-vendor" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">\n' +
'                                <option value="wing_iot">Wing IoT</option>\n' +
'                                <option value="atomic">ATOMIC</option>\n' +
'                                <option value="helix">Helix</option>\n' +
'                                <option value="teltik">Teltik</option>\n' +
'                            </select>';

// ── 7) Insert new JS before the closing </script> tag ───────────────────────
// Anchor on the unique "End D3" comment that immediately precedes </script>.
const SCRIPT_END_OLD = '        // ── End D3 ───────────────────────────────────────────────────────────\n    </script>\n';
const SCRIPT_END_NEW = '        // ── End D3 ───────────────────────────────────────────────────────────\n\n' + escapedJs + '\n    </script>\n';

// ── Apply ────────────────────────────────────────────────────────────────────
function strReplace(label, oldStr, newStr) {
    if (!content.includes(oldStr)) {
        console.error('PATCH FAILED: anchor not found for ' + label);
        process.exit(1);
    }
    if (content.split(oldStr).length > 2) {
        console.error('PATCH FAILED: anchor not unique for ' + label);
        process.exit(1);
    }
    content = content.replace(oldStr, () => newStr);
    console.log('  ✓ ' + label);
}

console.log('Applying frontend patches:');
strReplace('tab-billing HTML', TAB_HTML_OLD, TAB_HTML_NEW);
strReplace('plan-rate modal', MODAL_OLD, MODAL_NEW);
strReplace('sim-detail tab buttons', SD_TABS_OLD, SD_TABS_NEW);
strReplace('sim-detail content divs', SD_CONTENT_OLD, SD_CONTENT_NEW);
strReplace('switchSimDetailTab tabs array', SWITCH_OLD, SWITCH_NEW);
strReplace('switchSimDetailTab tail (load on billing tab)', SWITCH_TAIL_OLD, SWITCH_TAIL_NEW);
strReplace('billing tab loaders', TABLOAD_OLD, TABLOAD_NEW);
strReplace('audit vendor select', AUDIT_SELECT_OLD, AUDIT_SELECT_NEW);
strReplace('append JS before </script>', SCRIPT_END_OLD, SCRIPT_END_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Frontend patch applied.');