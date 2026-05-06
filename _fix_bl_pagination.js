// _fix_bl_pagination.js
// (1) Replaces handleBillingLedgerList with month-aware + paginated version,
// (2) adds handleBillingLedgerMonths + route,
// (3) replaces date input with month <select> in the Billing Ledger UI,
// (4) adds pagination controls,
// (5) replaces loadBillingLedger / filterLedgerStatus + adds loadLedgerMonths,
// (6) wires loadLedgerMonths into the billing tab loader.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const NEW_HANDLERS = fs.readFileSync(path.join(__dirname, '_patch_bl_pagination_handler.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const RAW_NEW_JS = fs.readFileSync(path.join(__dirname, '_patch_bl_pagination_js.txt'), 'utf8').replace(/\r\n/g, '\n');
const escapedJs = RAW_NEW_JS.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// ── 1) Replace handleBillingLedgerList by positional brace counting ─────────
function replaceFunctionByName(src, fnDeclSubstring, replacement) {
    const declStart = src.indexOf(fnDeclSubstring);
    if (declStart === -1) return null;
    // Find the body opening brace AFTER the closing paren of the parameter list
    const closeParen = src.indexOf(')', declStart);
    if (closeParen === -1) return null;
    let i = src.indexOf('{', closeParen);
    if (i === -1) return null;
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        i++;
    }
    if (i >= src.length) return null;
    return src.slice(0, declStart) + replacement + src.slice(i + 1);
}

const newList = NEW_HANDLERS;
const replaced = replaceFunctionByName(content, 'async function handleBillingLedgerList(', newList);
if (!replaced) { console.error('PATCH FAILED: handleBillingLedgerList anchor not found'); process.exit(1); }
content = replaced;
console.log('  ✓ handleBillingLedgerList + handleBillingLedgerMonths inserted');

// ── 2) Add the months route just after the list route ──────────────────────
const ROUTES_OLD =
'    if (url.pathname === \'/api/billing-ledger\' && request.method === \'GET\') {\n' +
'      return handleBillingLedgerList(env, corsHeaders, url);\n' +
'    }\n';
const ROUTES_NEW =
'    if (url.pathname === \'/api/billing-ledger\' && request.method === \'GET\') {\n' +
'      return handleBillingLedgerList(env, corsHeaders, url);\n' +
'    }\n' +
'    if (url.pathname === \'/api/billing-ledger/months\' && request.method === \'GET\') {\n' +
'      return handleBillingLedgerMonths(env, corsHeaders);\n' +
'    }\n';

if (!content.includes(ROUTES_OLD)) { console.error('PATCH FAILED: routes anchor not found'); process.exit(1); }
content = content.replace(ROUTES_OLD, () => ROUTES_NEW);
console.log('  ✓ months route added');

// ── 3) Replace date input with month <select> ───────────────────────────────
const DATE_INPUT_OLD =
'                        <div class="flex flex-col gap-1">\n' +
'                            <label class="text-xs text-gray-500 uppercase">Period Start</label>\n' +
'                            <input type="date" id="ledger-period-start" onchange="loadBillingLedger()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">\n' +
'                        </div>';
const MONTH_SELECT_NEW =
'                        <div class="flex flex-col gap-1">\n' +
'                            <label class="text-xs text-gray-500 uppercase">Month</label>\n' +
'                            <select id="ledger-month" onchange="loadBillingLedger(1)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300">\n' +
'                                <option value="">All months</option>\n' +
'                            </select>\n' +
'                        </div>';
if (!content.includes(DATE_INPUT_OLD)) { console.error('PATCH FAILED: date input anchor not found'); process.exit(1); }
content = content.replace(DATE_INPUT_OLD, () => MONTH_SELECT_NEW);
console.log('  ✓ date input → month select');

// ── 3b) Vendor + Status onchange should reset to page 1 ─────────────────────
const VENDOR_OC_OLD = '<select id="ledger-vendor" onchange="loadBillingLedger()" ';
const VENDOR_OC_NEW = '<select id="ledger-vendor" onchange="loadBillingLedger(1)" ';
const STATUS_OC_OLD = '<select id="ledger-status" onchange="loadBillingLedger()" ';
const STATUS_OC_NEW = '<select id="ledger-status" onchange="loadBillingLedger(1)" ';
if (content.includes(VENDOR_OC_OLD)) { content = content.replace(VENDOR_OC_OLD, () => VENDOR_OC_NEW); console.log('  ✓ vendor onchange page-resets'); }
if (content.includes(STATUS_OC_OLD)) { content = content.replace(STATUS_OC_OLD, () => STATUS_OC_NEW); console.log('  ✓ status onchange page-resets'); }

// ── 4) Add pagination controls below the table ─────────────────────────────
const PAGINATION_OLD =
'                    <p class="text-xs text-gray-500 mt-2" id="ledger-row-count"></p>\n' +
'                </div>';
const PAGINATION_NEW =
'                    <div class="flex items-center justify-between mt-3">\n' +
'                        <p class="text-xs text-gray-500" id="ledger-pageinfo">Page 1 of 1 · 0 total rows</p>\n' +
'                        <div class="flex gap-2">\n' +
'                            <button id="ledger-prev" onclick="ledgerPrev()" class="px-3 py-1 text-xs bg-dark-600 hover:bg-dark-500 disabled:bg-dark-700 disabled:text-gray-600 text-gray-200 rounded transition" disabled>&laquo; Prev</button>\n' +
'                            <button id="ledger-next" onclick="ledgerNext()" class="px-3 py-1 text-xs bg-dark-600 hover:bg-dark-500 disabled:bg-dark-700 disabled:text-gray-600 text-gray-200 rounded transition" disabled>Next &raquo;</button>\n' +
'                        </div>\n' +
'                    </div>\n' +
'                    <p class="text-xs text-gray-500 mt-2 hidden" id="ledger-row-count"></p>\n' +
'                </div>';
if (!content.includes(PAGINATION_OLD)) { console.error('PATCH FAILED: pagination anchor not found'); process.exit(1); }
content = content.replace(PAGINATION_OLD, () => PAGINATION_NEW);
console.log('  ✓ pagination controls added');

// ── 5) Replace loadBillingLedger + filterLedgerStatus + add loadLedgerMonths ──
function findFunctionRange(src, fnDeclSubstring) {
    const start = src.indexOf(fnDeclSubstring);
    if (start === -1) return null;
    const closeParen = src.indexOf(')', start);
    if (closeParen === -1) return null;
    let i = src.indexOf('{', closeParen);
    if (i === -1) return null;
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        i++;
    }
    if (i >= src.length) return null;
    return { start, end: i + 1 };
}

// Remove existing loadBillingLedger and filterLedgerStatus (the new file defines both + loadLedgerMonths + ledgerPrev/Next)
const lblRange = findFunctionRange(content, 'async function loadBillingLedger(');
if (!lblRange) { console.error('PATCH FAILED: loadBillingLedger not found'); process.exit(1); }
content = content.slice(0, lblRange.start) + content.slice(lblRange.end);
console.log('  ✓ removed old loadBillingLedger');

const flsRange = findFunctionRange(content, 'function filterLedgerStatus(');
if (!flsRange) { console.error('PATCH FAILED: filterLedgerStatus not found'); process.exit(1); }
content = content.slice(0, flsRange.start) + content.slice(flsRange.end);
console.log('  ✓ removed old filterLedgerStatus');

// Insert all new JS at the position where loadBillingLedger used to be
// Find the now-empty area where the function was — insert after the position by finding the prior function end.
// Easier: insert right after loadBillingLedgerSummary (which precedes both old functions).
const SUMMARY_END_ANCHOR = 'console.error(\'loadBillingLedgerSummary:\', e); }\n        }';
if (!content.includes(SUMMARY_END_ANCHOR)) { console.error('PATCH FAILED: summary end anchor not found'); process.exit(1); }
content = content.replace(SUMMARY_END_ANCHOR, () => SUMMARY_END_ANCHOR + '\n\n' + escapedJs);
console.log('  ✓ inserted new loadBillingLedger / loadLedgerMonths / pagination helpers');

// ── 6) Wire loadLedgerMonths into the billing tab loader ────────────────────
const TABLOAD_OLD =
'            if (tabName === \'billing\') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); loadPlanRates(); loadBillingLedgerSummary(); }';
const TABLOAD_NEW =
'            if (tabName === \'billing\') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); loadPlanRates(); loadBillingLedgerSummary(); loadLedgerMonths(); }';
if (!content.includes(TABLOAD_OLD)) { console.error('PATCH FAILED: tab loader anchor not found'); process.exit(1); }
content = content.replace(TABLOAD_OLD, () => TABLOAD_NEW);
console.log('  ✓ tab loader wired to loadLedgerMonths');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied.');