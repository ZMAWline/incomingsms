// _fix_audit_cleanup.js
// Removes the leftover original auditOneLine function + the stray `.` artifact
// caused by the previous patch's brace-counter walking into a comment.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// The block to remove: trailing `.` on the new function's closing brace + the entire OLD function.
// Anchor on the unique sequence of: end-of-new-fn `}`, then `.`, then the OLD function's signature.
const BAD_BLOCK_OLD =
'    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price };\n' +
'}.\n' +
'function auditOneLine({ row, sim, history, fromDate }) {\n' +
'    const price = parseFloat(row[\'Price\'] || \'0\');\n' +
'    const planId = (row[\'Bypassed Plan ID\'] || \'\').trim() || null;\n' +
'    const knownRate = planId && PLAN_RATES[planId] != null ? PLAN_RATES[planId] : null;\n' +
'\n' +
'    if (!sim) {\n' +
'        return { discrepancyType: \'unknown_iccid\', discrepancyDetail: `ICCID ${row[\'Subscription Iccid\'] || \'(blank)\'} not found in our system`, expectedPrice: 0 };\n' +
'    }\n' +
'\n' +
'    if (NON_BILLABLE_TERMINAL_STATUSES.has((sim.status || \'\').toLowerCase())) {\n' +
'        const canceledAt = findCancelTimestamp(history);\n' +
'        if (canceledAt && fromDate && new Date(canceledAt) < fromDate) {\n' +
'            const dt = new Date(canceledAt).toISOString().split(\'T\')[0];\n' +
'            return { discrepancyType: \'canceled_before_period\', discrepancyDetail: `SIM was ${sim.status} as of ${dt}, before bill period start`, expectedPrice: 0 };\n' +
'        }\n' +
'        // No history record but currently canceled — assume canceled before period (safe flag)\n' +
'        if (!canceledAt) {\n' +
'            return { discrepancyType: \'canceled_before_period\', discrepancyDetail: `SIM is ${sim.status} (no cancel-date record); flag for review`, expectedPrice: 0 };\n' +
'        }\n' +
'    }\n' +
'\n' +
'    if (knownRate != null && Math.abs(price - knownRate) > 0.01) {\n' +
'        return { discrepancyType: \'rate_mismatch\', discrepancyDetail: `Plan ${planId} expected $${knownRate.toFixed(2)} but charged $${price.toFixed(2)}`, expectedPrice: knownRate };\n' +
'    }\n' +
'\n' +
'    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price };\n' +
'}';

const BAD_BLOCK_NEW =
'    return { discrepancyType: null, discrepancyDetail: null, expectedPrice: knownRate != null ? knownRate : price };\n' +
'}';

if (!content.includes(BAD_BLOCK_OLD)) {
    console.error('CLEANUP FAILED: bad-block anchor not found.');
    process.exit(1);
}
if (content.split(BAD_BLOCK_OLD).length > 2) {
    console.error('CLEANUP FAILED: bad-block anchor not unique.');
    process.exit(1);
}
content = content.replace(BAD_BLOCK_OLD, () => BAD_BLOCK_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Cleanup applied.');