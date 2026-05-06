// _fix_billing_ledger_backend.js
// Adds billing-ledger generator, reconciler, and read endpoints; auto-triggers
// regen + reconcile from handleBillAuditUpload after the audit insert.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const NEW_HANDLERS = fs.readFileSync(path.join(__dirname, '_patch_billing_ledger_handlers.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();

// ── 1) Add 5 routes after the plan-rates routes ─────────────────────────────
const ROUTES_OLD =
'    if (url.pathname.startsWith(\'/api/plan-rates/\') && request.method === \'DELETE\') {\n' +
'      return handlePlanRatesDelete(env, corsHeaders, url);\n' +
'    }\n';
const ROUTES_NEW =
'    if (url.pathname.startsWith(\'/api/plan-rates/\') && request.method === \'DELETE\') {\n' +
'      return handlePlanRatesDelete(env, corsHeaders, url);\n' +
'    }\n' +
'\n' +
'    if (url.pathname === \'/api/billing-ledger\' && request.method === \'GET\') {\n' +
'      return handleBillingLedgerList(env, corsHeaders, url);\n' +
'    }\n' +
'    if (url.pathname === \'/api/billing-ledger/summary\' && request.method === \'GET\') {\n' +
'      return handleBillingLedgerSummary(env, corsHeaders, url);\n' +
'    }\n' +
'    if (url.pathname === \'/api/billing-ledger/regenerate\' && request.method === \'POST\') {\n' +
'      return handleBillingLedgerRegenerate(request, env, corsHeaders, url);\n' +
'    }\n' +
'    if (url.pathname === \'/api/billing-ledger/reconcile\' && request.method === \'POST\') {\n' +
'      return handleBillingLedgerReconcile(request, env, corsHeaders, url);\n' +
'    }\n';

// ── 2) Insert ledger handlers after the plan_rates handlers (before auditOneLine) ──
// Anchor on the last line of handlePlanRatesDelete + the blank line + the auditOneLine comment
const INSERT_AFTER_OLD =
'async function handlePlanRatesDelete(env, corsHeaders, url) {\n';
// We'll splice NEW_HANDLERS in BEFORE the auditOneLine comment block.
// Use the auditOneLine comment as the anchor.
const PRE_AUDIT_OLD =
'// Apply the five audit checks to one parsed row. Returns { discrepancyType, discrepancyDetail, expectedPrice }.\n' +
'// ratesByVendor: { vendor: { rate, plan_name } } — from loadActiveRates()\n';
const PRE_AUDIT_NEW =
NEW_HANDLERS + '\n\n' +
'// Apply the five audit checks to one parsed row. Returns { discrepancyType, discrepancyDetail, expectedPrice }.\n' +
'// ratesByVendor: { vendor: { rate, plan_name } } — from loadActiveRates()\n';

// ── 3) Auto-trigger ledger regen + reconcile from handleBillAuditUpload ────
// Splice immediately after the bill_audit_uploads PATCH and before the response Response.
const TRIGGER_OLD =
'        await sbPatch(env, `bill_audit_uploads?id=eq.${uploadId}`, {\n' +
'            status: \'complete\',\n' +
'            total_amount: totalAmount,\n' +
'            total_expected: totalExpected,\n' +
'            overcharge_amount: overchargeAmount,\n' +
'            discrepancy_count: discrepancyCount,\n' +
'            billing_period_start: dates[0] ? dates[0].split(\'T\')[0] : null,\n' +
'            billing_period_end: endDates.length ? endDates[endDates.length - 1].split(\'T\')[0] : null,\n' +
'        });\n' +
'\n' +
'        return new Response(JSON.stringify({\n' +
'            upload_id: uploadId,\n';
const TRIGGER_NEW =
'        await sbPatch(env, `bill_audit_uploads?id=eq.${uploadId}`, {\n' +
'            status: \'complete\',\n' +
'            total_amount: totalAmount,\n' +
'            total_expected: totalExpected,\n' +
'            overcharge_amount: overchargeAmount,\n' +
'            discrepancy_count: discrepancyCount,\n' +
'            billing_period_start: dates[0] ? dates[0].split(\'T\')[0] : null,\n' +
'            billing_period_end: endDates.length ? endDates[endDates.length - 1].split(\'T\')[0] : null,\n' +
'        });\n' +
'\n' +
'        // Auto-update ledger for this vendor + reconcile this upload\n' +
'        let ledgerResult = null;\n' +
'        try {\n' +
'            await regenerateLedgerForVendor(env, vendor);\n' +
'            ledgerResult = await reconcileLedgerForUpload(env, uploadId);\n' +
'        } catch (recErr) {\n' +
'            console.error(\'Ledger reconciliation error:\', recErr);\n' +
'            ledgerResult = { error: String(recErr) };\n' +
'        }\n' +
'\n' +
'        return new Response(JSON.stringify({\n' +
'            upload_id: uploadId,\n' +
'            ledger: ledgerResult,\n';

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

console.log('Applying patches:');
strReplace('routes', ROUTES_OLD, ROUTES_NEW);
strReplace('handlers (insert before auditOneLine)', PRE_AUDIT_OLD, PRE_AUDIT_NEW);
strReplace('auto-trigger from bill upload', TRIGGER_OLD, TRIGGER_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');