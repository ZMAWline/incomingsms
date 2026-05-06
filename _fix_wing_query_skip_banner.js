// Surface db_skip_reason in the dashboard's Wing IoT query result banner.
// When the backend skips DB sync (because the SIM is on ABIR not NON ABIR),
// show a warning in the existing banner + toast.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Note: file contains literal ⚠ (6 chars: backslash u 2 6 A 0) and \\n
// (4 chars: backslash backslash n). Escape both as \\u26A0 and \\\\n in the
// template literal so they round-trip correctly.
const OLD =
`                    const wdu = result.db_update;
                    if (wdu && wdu.found) {
                        const wdLines = [];
                        if (wdu.status_updated) wdLines.push('Status: ' + wdu.previous_status + ' → active');
                        if (wdu.mdn_updated) wdLines.push('MDN: ' + (wdu.mdn_old || '(none)') + ' → ' + wdu.mdn_new);
                        if (wdLines.length > 0) {
                            document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Auto-Synced';
                            document.getElementById('helix-db-update-output').textContent = wdLines.join('\\\\n');
                            document.getElementById('helix-db-update-banner').classList.remove('hidden');
                        }
                    }
                    resultDiv.classList.remove('hidden');`;

const NEW =
`                    const wdu = result.db_update;
                    if (wdu && wdu.found) {
                        const wdLines = [];
                        if (wdu.status_updated) wdLines.push('Status: ' + wdu.previous_status + ' → active');
                        if (wdu.mdn_updated) wdLines.push('MDN: ' + (wdu.mdn_old || '(none)') + ' → ' + wdu.mdn_new);
                        if (wdLines.length > 0) {
                            document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Auto-Synced';
                            document.getElementById('helix-db-update-output').textContent = wdLines.join('\\\\n');
                            document.getElementById('helix-db-update-banner').classList.remove('hidden');
                        }
                    } else if (result.db_skip_reason) {
                        document.getElementById('helix-db-update-title').textContent = '\\u26A0 DB Sync Skipped';
                        document.getElementById('helix-db-update-output').textContent = result.db_skip_reason;
                        document.getElementById('helix-db-update-banner').classList.remove('hidden');
                        showToast('DB not synced — SIM is on wrong plan', 'warning');
                    }
                    resultDiv.classList.remove('hidden');`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found.');
  console.error('First 200 chars of OLD:');
  console.error(JSON.stringify(OLD.slice(0, 200)));
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
