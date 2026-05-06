// _fix_bulk_sim_action.js — rewrite bulkSimAction to use sim-action-modal with
// per-SIM line results, matching the bulkRetryActivation / bulkQuery pattern.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Locate the current bulkSimAction function and slice it out.
const fnStart = content.indexOf('        async function bulkSimAction(action) {');
if (fnStart === -1) { console.error('PATCH FAILED: bulkSimAction not found'); process.exit(1); }
let i = fnStart + 1, depth = 0, seenOpen = false;
while (i < content.length) {
  const c = content[i];
  if (c === '{') { depth++; seenOpen = true; }
  else if (c === '}') { depth--; if (seenOpen && depth === 0) { i++; break; } }
  i++;
}
const before = content.slice(0, fnStart);
const after  = content.slice(i);

// Escape tokens for the outer getHTML template literal:
//   \` = escaped backtick, \${ = escaped expression, \\n = escaped-newline escape
const BT = '\\' + '`';
const DS = '\\' + '${';
const NL = '\\' + '\\' + 'n';

const fn =
  '        async function bulkSimAction(action) {\n' +
  '            const simIds = [...document.querySelectorAll(\'.sim-cb:checked\')].map(cb => parseInt(cb.value));\n' +
  '            if (simIds.length === 0) return;\n' +
  '            let confirmMsg;\n' +
  '            if (action === \'rotate\') {\n' +
  '                confirmMsg = ' + BT + 'Rotate ' + DS + 'simIds.length} SIMs?' + NL + NL + '\\u26A0\\uFE0F This will force-rotate every selected SIM \\u2014 including any already rotated today. Duplicate rotations risk your AT&T account and require resellers to update the MDN each time.' + BT + ';\n' +
  '            } else {\n' +
  '                confirmMsg = ' + BT + 'Run ' + DS + 'action} on ' + DS + 'simIds.length} SIM(s)?' + BT + ';\n' +
  '            }\n' +
  '            if (!(await showConfirm(\'Run Action\', confirmMsg))) return;\n' +
  '\n' +
  '            const extraBody = action === \'rotate\' ? { force: true } : {};\n' +
  '\n' +
  '            // Open the shared bulk result modal once; append a line per SIM as we go.\n' +
  '            const output = document.getElementById(\'sim-action-output\');\n' +
  '            document.getElementById(\'sim-action-title\').textContent = \'Bulk \' + action + \' — \' + simIds.length + \' SIMs\';\n' +
  '            output.textContent = \'Starting...\';\n' +
  '            output.classList.remove(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
  '            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
  '\n' +
  '            window.__bulkCancel = false;\n' +
  '            showBulkCancelButton();\n' +
  '            let ok = 0, fail = 0, cancelled = 0;\n' +
  '            const lines = [];\n' +
  '            for (const simId of simIds) {\n' +
  '                if (window.__bulkCancel) {\n' +
  '                    cancelled = simIds.length - ok - fail;\n' +
  '                    break;\n' +
  '                }\n' +
  '                try {\n' +
  '                    const res = await fetch(API_BASE + \'/sim-action\', {\n' +
  '                        method: \'POST\',\n' +
  '                        headers: { \'Content-Type\': \'application/json\' },\n' +
  '                        body: JSON.stringify(Object.assign({ sim_id: simId, action }, extraBody))\n' +
  '                    });\n' +
  '                    const result = await res.json();\n' +
  '                    if (result.ok) {\n' +
  '                        ok++;\n' +
  '                        const msg = result.detail && result.detail.message ? result.detail.message : (result.message || \'\');\n' +
  '                        lines.push(\'SIM #\' + simId + \': OK\' + (msg ? \' — \' + msg : \'\'));\n' +
  '                    } else {\n' +
  '                        fail++;\n' +
  '                        const err = result.error || (result.detail && result.detail.error) || \'unknown\';\n' +
  '                        lines.push(\'SIM #\' + simId + \': FAILED — \' + err);\n' +
  '                    }\n' +
  '                } catch (e) {\n' +
  '                    fail++;\n' +
  '                    lines.push(\'SIM #\' + simId + \': EXCEPTION — \' + (e && e.message ? e.message : e));\n' +
  '                }\n' +
  '                output.textContent = lines.join(\'' + NL + '\') + \'' + NL + NL + 'Processing... (\' + (ok + fail) + \'/\' + simIds.length + \')\';\n' +
  '            }\n' +
  '            hideBulkCancelButton();\n' +
  '            const summary = \'Done: \' + ok + \' OK\' + (fail ? \', \' + fail + \' failed\' : \'\') + (cancelled ? \', \' + cancelled + \' cancelled\' : \'\');\n' +
  '            output.textContent = summary + \'' + NL + NL + '\' + lines.join(\'' + NL + '\');\n' +
  '            loadSims(true);\n' +
  '        }';

content = before + fn + after;

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched: bulkSimAction now uses sim-action-modal with per-SIM line output.');
