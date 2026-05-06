// _fix_atomic_activate.js
// Fix 1: activateSims() toast uses wrong field names (result.processed/result.errors)
//         bulk-activator actually returns { queued, validation_errors, ... }
// Fix 2: API log entries in SIM modal are missing a vendor badge (ATOMIC / HELIX / etc.)

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ─── Fix 1: Toast message in activateSims() ───────────────────────────────────
// Bulk-activator /activate returns: { ok, queued, validation_errors, attempted, run_id }
// The frontend was using result.processed (undefined) and result.errors (undefined)

const BT = '\\' + '`';
const DS = '\\' + '${';

const OLD1 = (
  '                    showToast(' + BT + 'Activated ' + DS + 'result.processed} SIM(s), ' + DS + 'result.errors} error(s)' + BT + ',\n' +
  '                        result.errors > 0 ? \'error\' : \'success\');'
);

const NEW1 = (
  '                    showToast(' + BT + 'Queued ' + DS + 'result.queued} SIM(s) for activation' + DS + 'result.validation_errors > 0 ? \', \' + result.validation_errors + \' validation error(s)\' : \'\'}\' + \'\'' + BT + ',\n' +
  '                        (result.validation_errors || 0) > 0 ? \'error\' : \'success\');'
);

// Actually let's build this more carefully without nested complexity
// The toast string we want in the file is:
// showToast(`Queued ${result.queued} SIM(s) for activation${result.validation_errors > 0 ? `, ${result.validation_errors} validation error(s)` : ''}`,
//     (result.validation_errors || 0) > 0 ? 'error' : 'success');
//
// But nested template literals inside the outer getHTML template are messy.
// Let's use a simpler non-nested approach:

const OLD1_SIMPLE = (
  "                    showToast(" + BT + "Activated " + DS + "result.processed} SIM(s), " + DS + "result.errors} error(s)" + BT + ",\n" +
  "                        result.errors > 0 ? 'error' : 'success');"
);

// New: just show queued count, and validation errors if any
// In the file this will look like:
// showToast(`Queued ${result.queued} SIM(s) for activation` + (result.validation_errors > 0 ? `, ${result.validation_errors} validation error(s)` : ''),
//     (result.validation_errors || 0) > 0 ? 'error' : 'success');
//
// But we can't use a backtick inside the outer template literal without escaping.
// Safe approach: build a plain string without inner template literals.

const NEW1_SIMPLE = (
  "                    showToast('Queued ' + (result.queued || 0) + ' SIM(s) for activation' + (result.validation_errors > 0 ? ', ' + result.validation_errors + ' validation error(s)' : ''),\n" +
  "                        (result.validation_errors || 0) > 0 ? 'error' : 'success');"
);

if (!content.includes(OLD1_SIMPLE)) {
  console.error('PATCH 1 FAILED: old string not found.');
  console.error('Expected to find:');
  console.error(JSON.stringify(OLD1_SIMPLE));
  process.exit(1);
}
content = content.replace(OLD1_SIMPLE, NEW1_SIMPLE);
console.log('Patch 1 applied: fixed activateSims() toast field names.');

// ─── Fix 2: Add vendor badge to API log entries in loadSimActionLogs() ─────────
// Add a colored vendor badge after the step badge in each log entry

const OLD2 = (
  "                                <span class=\"text-xs font-semibold text-blue-400\">" + DS + "log.step || '-'}</span>\n" +
  "                                <span class=\"text-xs " + DS + "statusColor} font-mono\">HTTP " + DS + "log.response_status || '?'}</span>"
);

const NEW2 = (
  "                                <span class=\"text-xs font-semibold text-blue-400\">" + DS + "log.step || '-'}</span>\n" +
  "                                " + DS + "log.vendor ? '<span class=\"text-xs font-semibold ' + ({atomic:'text-orange-400',wing_iot:'text-green-400',helix:'text-purple-400',teltik:'text-pink-400'}[log.vendor] || 'text-gray-400') + '\">' + log.vendor.toUpperCase() + '</span>' : ''}\n" +
  "                                <span class=\"text-xs " + DS + "statusColor} font-mono\">HTTP " + DS + "log.response_status || '?'}</span>"
);

if (!content.includes(OLD2)) {
  console.error('PATCH 2 FAILED: old string not found.');
  console.error('Expected to find:');
  console.error(JSON.stringify(OLD2));
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Patch 2 applied: added vendor badge to API log entries.');

// ─── Write back with CRLF ─────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('File written successfully.');
