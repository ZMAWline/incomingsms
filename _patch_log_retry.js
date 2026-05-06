// Patch: add per-log-entry Retry button in SIM API logs popup
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── 1. Add Retry button inside each failed log entry ─────────────────────────
// In the source file the inner template literal uses \${ and \` (escaped for outer template)
// We append a Retry button after the error <p> and before the closing </div>\`;

const LOG_TD_OLD =
  "                        \\${log.error ? \\`<p class=\"text-xs text-red-400 mt-1\">Error: \\${log.error}</p>\\` : ''}\n" +
  "                    </div>\n" +
  "                    \\`;";

const LOG_TD_NEW =
  "                        \\${log.error ? \\`<p class=\"text-xs text-red-400 mt-1\">Error: \\${log.error}</p>\\` : ''}\n" +
  "                        \\${(!log.response_ok || log.error) ? \\`<div class=\"mt-2\"><button onclick=\"retryLogStep('\\${log.step}')\" class=\"px-2 py-1 text-xs bg-amber-600 hover:bg-amber-700 text-white rounded transition\">&#8635; Retry</button></div>\\` : ''}\n" +
  "                    </div>\n" +
  "                    \\`;";

if (!content.includes(LOG_TD_OLD)) { console.error('ERROR: log entry anchor not found'); process.exit(1); }
content = content.replace(LOG_TD_OLD, LOG_TD_NEW);
console.log('✓ Retry button added to failed log entries');

// ── 2. Add retryLogStep() function after loadSimActionLogs ───────────────────
const FN_OLD = "        function toggleAllSims(checkbox) {";

const FN_NEW =
  "        // Retry a failed Helix API log step for the currently-viewed SIM\n" +
  "        function retryLogStep(step) {\n" +
  "            if (!currentSimActionId) { showToast('No SIM selected', 'error'); return; }\n" +
  "            var actionMap = {\n" +
  "                'mdn_change': 'rotate',\n" +
  "                'ota_refresh': 'ota_refresh',\n" +
  "                'retry_activation': 'retry_activation'\n" +
  "            };\n" +
  "            var action = actionMap[step] || 'fix';\n" +
  "            simAction(currentSimActionId, action);\n" +
  "        }\n" +
  "\n" +
  "        function toggleAllSims(checkbox) {";

if (!content.includes(FN_OLD)) { console.error('ERROR: function anchor not found'); process.exit(1); }
content = content.replace(FN_OLD, FN_NEW);
console.log('✓ retryLogStep() function added');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written (CRLF)');
