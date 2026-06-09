// INC-23 follow-up — replace native browser dialogs with in-dashboard
// showConfirm() + showToast() per the operator's hard UI rule. Targets the
// reviewer-panel controls added in §I.2 (remediatorRunNow,
// remediatorToggleKillSwitch).

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

function replace(oldStr, newStr, label) {
  if (!content.includes(oldStr)) {
    console.error('PATCH FAILED [' + label + ']: old string not found.');
    process.exit(1);
  }
  if (content.indexOf(oldStr) !== content.lastIndexOf(oldStr)) {
    console.error('PATCH FAILED [' + label + ']: old string not unique.');
    process.exit(1);
  }
  content = content.replace(oldStr, newStr);
  console.log('OK   [' + label + ']');
}

// 1) remediatorRunNow — sync window.confirm → async showConfirm modal.
const OLD_RUN_NOW = `        async function remediatorRunNow() {
            if (!confirm('Trigger an immediate Auto-Remediator main tick now?\\\\n\\\\nThis runs the same logic as the 2-hour cron once. Reviewer kill-switch must be enabled or the tick will short-circuit.')) return;`;

const NEW_RUN_NOW = `        async function remediatorRunNow() {
            const ok = await showConfirm(
                'Run Auto-Remediator tick now?',
                'Triggers an immediate main tick — the same logic the 2-hour cron runs. If the reviewer kill-switch is off, the tick short-circuits.'
            );
            if (!ok) return;`;

replace(OLD_RUN_NOW, NEW_RUN_NOW, 'remediatorRunNow: showConfirm');

// 2) remediatorToggleKillSwitch — sync window.confirm → async showConfirm.
const OLD_TOGGLE = `        async function remediatorToggleKillSwitch(enabled) {
            const verb = enabled ? 'RESUME' : 'PAUSE';
            if (!confirm(verb + ' the Auto-Remediator?\\\\n\\\\n' + (enabled
                ? 'This re-enables the 2-hour cron. The next scheduled tick will process queued bad rentals.'
                : 'This disables the 2-hour cron. Already-running attempts finish; no new actions will be taken until you resume.'))) return;
            try {
                const resp = await fetch(API_BASE + '/remediator/kill-switch', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ enabled, actor: 'dashboard' }),
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                await loadRemediatorStatus();
            } catch (e) {
                alert('Toggle failed: ' + (e && e.message ? e.message : String(e)));
            }
        }`;

const NEW_TOGGLE = `        async function remediatorToggleKillSwitch(enabled) {
            const verb = enabled ? 'Resume' : 'Pause';
            const msg = enabled
                ? 'Re-enables the 2-hour cron. The next scheduled tick will process queued bad rentals.'
                : 'Disables the 2-hour cron. Already-running attempts finish; no new actions will be taken until you resume.';
            const ok = await showConfirm(verb + ' the Auto-Remediator?', msg);
            if (!ok) return;
            try {
                const resp = await fetch(API_BASE + '/remediator/kill-switch', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ enabled, actor: 'dashboard' }),
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                await loadRemediatorStatus();
                showToast('Auto-Remediator ' + (enabled ? 'resumed' : 'paused'), 'success');
            } catch (e) {
                showToast('Toggle failed: ' + (e && e.message ? e.message : String(e)), 'error');
            }
        }`;

replace(OLD_TOGGLE, NEW_TOGGLE, 'remediatorToggleKillSwitch: showConfirm + showToast');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
