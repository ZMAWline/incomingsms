// _fix_plan_rates_endpoints.js
// Adds plan_rates CRUD endpoints + replaces hardcoded PLAN_RATES const with DB lookup.
// Safe: each splice is anchored on a unique string; bails if any anchor is missing.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const NEW_HANDLERS = fs.readFileSync(path.join(__dirname, '_patch_plan_rates_handlers.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const NEW_AUDIT = fs.readFileSync(path.join(__dirname, '_patch_plan_rates_audit.js'), 'utf8').replace(/\r\n/g, '\n').trimEnd();

// ── 1) Add 4 routes after the bill-audit routes ─────────────────────────────
const ROUTES_OLD =
'    if (url.pathname === \'/api/bill-audit/backfill-cancel-dates\' && request.method === \'POST\') {\n' +
'      return handleBackfillCancelDates(env, corsHeaders);\n' +
'    }\n';
const ROUTES_NEW =
'    if (url.pathname === \'/api/bill-audit/backfill-cancel-dates\' && request.method === \'POST\') {\n' +
'      return handleBackfillCancelDates(env, corsHeaders);\n' +
'    }\n' +
'\n' +
'    if (url.pathname === \'/api/plan-rates\' && request.method === \'GET\') {\n' +
'      return handlePlanRatesList(env, corsHeaders);\n' +
'    }\n' +
'    if (url.pathname === \'/api/plan-rates\' && request.method === \'POST\') {\n' +
'      return handlePlanRatesCreate(request, env, corsHeaders);\n' +
'    }\n' +
'    if (url.pathname.startsWith(\'/api/plan-rates/\') && request.method === \'PATCH\') {\n' +
'      return handlePlanRatesUpdate(request, env, corsHeaders, url);\n' +
'    }\n' +
'    if (url.pathname.startsWith(\'/api/plan-rates/\') && request.method === \'DELETE\') {\n' +
'      return handlePlanRatesDelete(env, corsHeaders, url);\n' +
'    }\n';

// ── 2) Replace PLAN_RATES const + comment block with new handlers ───────────
const HANDLERS_OLD =
'// ── Billing Audit (vendor-agnostic, non-prorated) ───────────────────────────\n' +
'//\n' +
'// Rate map keyed on Wing\'s "Bypassed Plan ID" column. Add entries as you\n' +
'// confirm them on real bills. Lines whose plan ID is NOT in this map skip\n' +
'// the rate-mismatch check (other checks still run).\n' +
'const PLAN_RATES = {\n' +
'    \'796\': 5.00, // ATT 35MB HX (Helix)\n' +
'};';

// ── 3) Replace auditOneLine to take ratesByVendor ───────────────────────────
const AUDIT_OLD =
'// Apply the five audit checks to one parsed row. Returns { discrepancyType, discrepancyDetail, expectedPrice }.\n' +
'function auditOneLine({ row, sim, history, fromDate }) {\n' +
'    const price = parseFloat(row[\'Price\'] || \'0\');\n' +
'    const planId = (row[\'Bypassed Plan ID\'] || \'\').trim() || null;\n' +
'    const knownRate = planId && PLAN_RATES[planId] != null ? PLAN_RATES[planId] : null;';

// We replace the WHOLE auditOneLine function. Anchor on the first 5 lines (unique enough);
// then we positionally take from there to the closing brace of the function.
function replaceFunctionByAnchor(src, anchorStartFragment, replacement) {
    const startIdx = src.indexOf(anchorStartFragment);
    if (startIdx === -1) return null;
    // Find end of function — match braces from the function body opening
    let i = src.indexOf('{', startIdx);
    if (i === -1) return null;
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
        i++;
    }
    if (i >= src.length) return null;
    return src.slice(0, startIdx) + replacement + src.slice(i + 1);
}

// ── 4) Add ratesByVendor load + thread it into auditOneLine call (upload) ───
const UPLOAD_LOAD_OLD =
'        const [upload] = await sbPost(env, \'bill_audit_uploads\', { filename, vendor, total_rows: rows.length, status: \'processing\' });\n' +
'        const uploadId = upload.id;\n' +
'\n' +
'        const allSims = await sbGet(env, \'sims?select=id,iccid,status&limit=10000\');';
const UPLOAD_LOAD_NEW =
'        const [upload] = await sbPost(env, \'bill_audit_uploads\', { filename, vendor, total_rows: rows.length, status: \'processing\' });\n' +
'        const uploadId = upload.id;\n' +
'\n' +
'        const ratesByVendor = await loadActiveRates(env);\n' +
'        const allSims = await sbGet(env, \'sims?select=id,iccid,status&limit=10000\');';

const UPLOAD_CALL_OLD =
'            const audit = auditOneLine({ row, sim, history, fromDate });\n' +
'\n' +
'            billedIccids.add(iccid);';
const UPLOAD_CALL_NEW =
'            const audit = auditOneLine({ row, sim, history, fromDate, vendor, ratesByVendor });\n' +
'\n' +
'            billedIccids.add(iccid);';

// ── 5) Add ratesByVendor load + thread it into auditOneLine call (recompute) ─
const RECOMPUTE_LOAD_OLD =
'        const allSims = await sbGet(env, \'sims?select=id,iccid,status&limit=10000\');\n' +
'        const simsByIccid = {};\n' +
'        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });\n' +
'\n' +
'        const summary = [];';
const RECOMPUTE_LOAD_NEW =
'        const ratesByVendor = await loadActiveRates(env);\n' +
'        const allSims = await sbGet(env, \'sims?select=id,iccid,status&limit=10000\');\n' +
'        const simsByIccid = {};\n' +
'        (allSims || []).forEach(s => { simsByIccid[s.iccid] = s; });\n' +
'\n' +
'        const summary = [];';

const RECOMPUTE_CALL_OLD =
'                const audit = auditOneLine({ row, sim, history: sim ? (historyBySimId[sim.id] || []) : [], fromDate });';
const RECOMPUTE_CALL_NEW =
'                const audit = auditOneLine({ row, sim, history: sim ? (historyBySimId[sim.id] || []) : [], fromDate, vendor: l.vendor || upload.vendor, ratesByVendor });';

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
strReplace('handlers (PLAN_RATES const → loadActiveRates + CRUD)', HANDLERS_OLD, NEW_HANDLERS);
{
    const replaced = replaceFunctionByAnchor(content, AUDIT_OLD, NEW_AUDIT);
    if (!replaced) { console.error('PATCH FAILED: auditOneLine anchor not found'); process.exit(1); }
    content = replaced;
    console.log('  ✓ auditOneLine');
}
strReplace('upload load rates', UPLOAD_LOAD_OLD, UPLOAD_LOAD_NEW);
strReplace('upload audit call', UPLOAD_CALL_OLD, UPLOAD_CALL_NEW);
strReplace('recompute load rates', RECOMPUTE_LOAD_OLD, RECOMPUTE_LOAD_NEW);
strReplace('recompute audit call', RECOMPUTE_CALL_OLD, RECOMPUTE_CALL_NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');