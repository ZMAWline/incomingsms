// _fix_assign_notify_progress.js
// Make Bulk "Assign + Notify" use the shared sim-action-modal for live progress,
// matching how bulkSimAction() already does it (per-SIM lines + cancel button).
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

const OLD_LINES = [
  "            assignBtn.onclick = async function() {",
  "                const resellerId = parseInt(select.value);",
  "                modal.remove();",
  "                let assigned = 0, notified = 0, failed = 0;",
  "                for (const simId of simIds) {",
  "                    try {",
  "                        const resp = await fetch(API_BASE + '/assign-reseller', {",
  "                            method: 'POST',",
  "                            headers: { 'Content-Type': 'application/json' },",
  "                            body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })",
  "                        });",
  "                        const result = await resp.json();",
  "                        if (result.ok) {",
  "                            assigned++;",
  "                            const simData = tableState.sims.data.find(s => s.id === simId);",
  "                            if (simData && simData.status === 'active' && simData.phone_number) {",
  "                                try {",
  "                                    const onlineResp = await fetch(API_BASE + '/sim-online', {",
  "                                        method: 'POST',",
  "                                        headers: { 'Content-Type': 'application/json' },",
  "                                        body: JSON.stringify({ sim_id: simId })",
  "                                    });",
  "                                    const onlineResult = await onlineResp.json();",
  "                                    if (onlineResp.ok && onlineResult.ok) notified++;",
  "                                } catch (e) {}",
  "                            }",
  "                        } else { failed++; }",
  "                    } catch (e) { failed++; }",
  "                }",
  "                const msg = assigned + ' assigned, ' + notified + ' notified' + (failed ? ', ' + failed + ' failed' : '');",
  "                showToast(msg, failed ? 'error' : 'success');",
  "                loadSims(true);",
  "            };",
];
const OLD = OLD_LINES.join('\n');

// In the file we want '\\n' (3 source bytes: backslash, backslash, n) so that
// after the outer getHTML() template-literal eval the browser-side JS contains
// '\n' (a real newline at runtime). In a double-quoted JS string, '\\\\' is 2 backslashes.
const NEW_LINES = [
  "            assignBtn.onclick = async function() {",
  "                const resellerId = parseInt(select.value);",
  "                modal.remove();",
  "                // Open shared bulk progress modal so user can track per-SIM result",
  "                const output = document.getElementById('sim-action-output');",
  "                document.getElementById('sim-action-title').textContent = 'Bulk Assign + Notify — ' + simIds.length + ' SIMs';",
  "                output.textContent = 'Starting...';",
  "                output.classList.remove('hidden');",
  "                document.getElementById('sim-action-logs-section').classList.add('hidden');",
  "                document.getElementById('sim-action-modal').classList.remove('hidden');",
  "                window.__bulkCancel = false;",
  "                showBulkCancelButton();",
  "                let assigned = 0, notified = 0, failed = 0, cancelled = 0;",
  "                const lines = [];",
  "                for (const simId of simIds) {",
  "                    if (window.__bulkCancel) { cancelled = simIds.length - assigned - failed; break; }",
  "                    try {",
  "                        const resp = await fetch(API_BASE + '/assign-reseller', {",
  "                            method: 'POST',",
  "                            headers: { 'Content-Type': 'application/json' },",
  "                            body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })",
  "                        });",
  "                        const result = await resp.json();",
  "                        if (result.ok) {",
  "                            assigned++;",
  "                            const simData = tableState.sims.data.find(s => s.id === simId);",
  "                            if (simData && simData.status === 'active' && simData.phone_number) {",
  "                                try {",
  "                                    const onlineResp = await fetch(API_BASE + '/sim-online', {",
  "                                        method: 'POST',",
  "                                        headers: { 'Content-Type': 'application/json' },",
  "                                        body: JSON.stringify({ sim_id: simId })",
  "                                    });",
  "                                    const onlineResult = await onlineResp.json();",
  "                                    if (onlineResp.ok && onlineResult.ok) {",
  "                                        notified++;",
  "                                        lines.push('SIM #' + simId + ': assigned + notified');",
  "                                    } else {",
  "                                        lines.push('SIM #' + simId + ': assigned, notify FAILED — ' + (onlineResult.error || onlineResp.status));",
  "                                    }",
  "                                } catch (e) {",
  "                                    lines.push('SIM #' + simId + ': assigned, notify EXCEPTION — ' + (e && e.message ? e.message : e));",
  "                                }",
  "                            } else {",
  "                                lines.push('SIM #' + simId + ': assigned (skipped notify — not active or no number)');",
  "                            }",
  "                        } else {",
  "                            failed++;",
  "                            lines.push('SIM #' + simId + ': FAILED — ' + (result.error || 'unknown'));",
  "                        }",
  "                    } catch (e) {",
  "                        failed++;",
  "                        lines.push('SIM #' + simId + ': EXCEPTION — ' + (e && e.message ? e.message : e));",
  "                    }",
  "                    output.textContent = lines.join('\\\\n') + '\\\\n\\\\nProcessing... (' + (assigned + failed) + '/' + simIds.length + ')';",
  "                }",
  "                hideBulkCancelButton();",
  "                const summary = 'Done: ' + assigned + ' assigned, ' + notified + ' notified' + (failed ? ', ' + failed + ' failed' : '') + (cancelled ? ', ' + cancelled + ' cancelled' : '');",
  "                output.textContent = summary + '\\\\n\\\\n' + lines.join('\\\\n');",
  "                loadSims(true);",
  "            };",
];
const NEW = NEW_LINES.join('\n');

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: OLD block not found in dashboard/index.js.');
  process.exit(1);
}
const occurrences = content.split(OLD).length - 1;
if (occurrences !== 1) {
  console.error('PATCH FAILED: expected 1 OLD block, found ' + occurrences);
  process.exit(1);
}
content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
