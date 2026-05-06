// Patch D2: Unify bulk Retry to show per-SIM results in sim-action-modal.
// Old: fire-and-forget loop with toast-only summary.
// New: opens sim-action-modal, appends per-SIM status lines, loads logs at end.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const before = content;

const OLD = "        async function bulkRetryActivation() {\n" +
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (simIds.length === 0) { showToast('Select at least one SIM', 'error'); return; }\n" +
  "            if (!(await showConfirm('Retry Activation', 'Retry activation for ' + simIds.length + ' SIM(s)?'))) return;\n" +
  "            showToast('Retrying activation for ' + simIds.length + ' SIM(s)...', 'info');\n" +
  "            let success = 0, failed = 0;\n" +
  "            for (const simId of simIds) {\n" +
  "                try {\n" +
  "                    const res = await fetch(API_BASE + '/sim-action', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  "                        body: JSON.stringify({ sim_id: simId, action: 'retry_activation' })\n" +
  "                    });\n" +
  "                    const result = await res.json();\n" +
  "                    if (result.ok) success++;\n" +
  "                    else failed++;\n" +
  "                } catch (e) {\n" +
  "                    failed++;\n" +
  "                }\n" +
  "            }\n" +
  "            showToast(success + ' success, ' + failed + ' failed', failed > 0 ? 'warning' : 'success');\n" +
  "            loadSims(true);\n" +
  "        }";

const NEW = "        async function bulkRetryActivation() {\n" +
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (simIds.length === 0) { showToast('Select at least one SIM', 'error'); return; }\n" +
  "            if (!(await showConfirm('Retry Activation', 'Retry activation for ' + simIds.length + ' SIM(s)?'))) return;\n" +
  "\n" +
  "            // Show results in sim-action-modal (same modal per-row Retry uses)\n" +
  "            const output = document.getElementById('sim-action-output');\n" +
  "            document.getElementById('sim-action-title').textContent = 'Bulk Retry — ' + simIds.length + ' SIMs';\n" +
  "            output.textContent = 'Starting...';\n" +
  "            output.classList.remove('hidden');\n" +
  "            document.getElementById('sim-action-logs-section').classList.add('hidden');\n" +
  "            document.getElementById('sim-action-modal').classList.remove('hidden');\n" +
  "\n" +
  "            let success = 0, failed = 0;\n" +
  "            const lines = [];\n" +
  "            for (const simId of simIds) {\n" +
  "                try {\n" +
  "                    const res = await fetch(API_BASE + '/sim-action', {\n" +
  "                        method: 'POST',\n" +
  "                        headers: { 'Content-Type': 'application/json' },\n" +
  "                        body: JSON.stringify({ sim_id: simId, action: 'retry_activation' })\n" +
  "                    });\n" +
  "                    const result = await res.json();\n" +
  "                    if (result.ok) {\n" +
  "                        success++;\n" +
  "                        lines.push('SIM #' + simId + ': OK');\n" +
  "                    } else {\n" +
  "                        failed++;\n" +
  "                        lines.push('SIM #' + simId + ': FAILED — ' + (result.error || 'unknown'));\n" +
  "                    }\n" +
  "                } catch (e) {\n" +
  "                    failed++;\n" +
  "                    lines.push('SIM #' + simId + ': ERROR — ' + e.message);\n" +
  "                }\n" +
  "                output.textContent = lines.join('\\\\n') + '\\\\n\\\\nProcessing... (' + (success + failed) + '/' + simIds.length + ')';\n" +
  "            }\n" +
  "            output.textContent = lines.join('\\\\n') + '\\\\n\\\\nDone: ' + success + ' success, ' + failed + ' failed';\n" +
  "            showToast(success + ' success, ' + failed + ' failed', failed > 0 ? 'warning' : 'success');\n" +
  "            loadSims(true);\n" +
  "        }";

if (!content.includes(OLD)) { console.error('PATCH FAILED: bulkRetryActivation not found'); process.exit(1); }
content = content.replace(OLD, NEW);

if (content === before) { console.error('ERROR: no replacements made'); process.exit(1); }
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch D2 applied: bulk Retry now shows per-SIM results in modal');
