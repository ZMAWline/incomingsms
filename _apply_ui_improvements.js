import { readFileSync, writeFileSync } from 'fs';

const FILE = 'src/dashboard/index.js';
let content = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');

const BT = '\\`';   // represents \` as it appears in the file
const DS = '\\${';  // represents \${ as it appears in the file

function patch(old, nw, desc) {
    if (!content.includes(old)) {
        throw new Error(`NOT FOUND: ${desc}\nSearching for: ${JSON.stringify(old.slice(0, 120))}`);
    }
    const count = content.split(old).length - 1;
    if (count > 1) console.warn(`  WARN: ${count} occurrences for "${desc}" — replacing first only`);
    content = content.replace(old, nw);
    console.log(`  ✓ ${desc}`);
}

function patchAll(old, nw, desc) {
    if (!content.includes(old)) {
        throw new Error(`NOT FOUND: ${desc}\nSearching for: ${JSON.stringify(old.slice(0, 120))}`);
    }
    const count = content.split(old).length - 1;
    content = content.split(old).join(nw);
    console.log(`  ✓ ${desc} (${count}x)`);
}

// ═══════════════════════════════════════════════════════════════
// PART 1 — LIGHT MODE
// ═══════════════════════════════════════════════════════════════

console.log('\n[PA] Tailwind colors → CSS vars');
patch(
`                        dark: {
                            950: '#050507',
                            900: '#09090b',
                            800: '#18181b',
                            700: '#27272a',
                            600: '#3f3f46',
                            500: '#52525b',
                            400: '#a1a1aa',
                            300: '#d4d4d8',
                            200: '#e4e4e7',
                            100: '#f4f4f5',
                        },
                        accent: {
                            DEFAULT: '#3b82f6',
                            hover: '#2563eb',
                            glow: 'rgba(59, 130, 246, 0.5)'
                        },
                        surface: {
                            DEFAULT: '#18181b',
                            hover: '#27272a',
                        }`,
`                        dark: {
                            950: 'rgb(var(--dark-950) / <alpha-value>)',
                            900: 'rgb(var(--dark-900) / <alpha-value>)',
                            800: 'rgb(var(--dark-800) / <alpha-value>)',
                            700: 'rgb(var(--dark-700) / <alpha-value>)',
                            600: 'rgb(var(--dark-600) / <alpha-value>)',
                            500: 'rgb(var(--dark-500) / <alpha-value>)',
                            400: 'rgb(var(--dark-400) / <alpha-value>)',
                            300: 'rgb(var(--dark-300) / <alpha-value>)',
                            200: 'rgb(var(--dark-200) / <alpha-value>)',
                            100: 'rgb(var(--dark-100) / <alpha-value>)',
                        },
                        accent: {
                            DEFAULT: '#3b82f6',
                            hover: '#2563eb',
                            glow: 'rgba(59, 130, 246, 0.5)'
                        },
                        surface: {
                            DEFAULT: 'rgb(var(--dark-800) / <alpha-value>)',
                            hover: 'rgb(var(--dark-700) / <alpha-value>)',
                        }`,
'Tailwind dark colors + surface → CSS vars'
);

console.log('\n[PB] Add CSS variables + light mode rules to <style>');
patch(
`    <style>
        * { font-family: 'Inter', system-ui, sans-serif; }`,
`    <style>
        :root {
            --dark-950: 5 5 7;
            --dark-900: 9 9 11;
            --dark-800: 24 24 27;
            --dark-700: 39 39 42;
            --dark-600: 63 63 70;
            --dark-500: 82 82 91;
            --dark-400: 161 161 170;
            --dark-300: 212 212 216;
            --dark-200: 228 228 231;
            --dark-100: 244 244 245;
        }
        html.light {
            --dark-950: 255 255 255;
            --dark-900: 248 250 252;
            --dark-800: 241 245 249;
            --dark-700: 226 232 240;
            --dark-600: 203 213 225;
            --dark-500: 100 116 139;
            --dark-400: 71 85 105;
            --dark-300: 51 65 85;
            --dark-200: 30 41 59;
            --dark-100: 15 23 42;
        }
        html.light .text-white { color: rgb(var(--dark-100)) !important; }
        html.light .sidebar-btn.text-white { color: #3b82f6 !important; background-color: rgba(59,130,246,0.1) !important; border-left-color: #3b82f6 !important; }
        html.light ::-webkit-scrollbar-track { background: rgb(var(--dark-800)); }
        html.light ::-webkit-scrollbar-thumb { background: rgb(var(--dark-600)); border-radius: 3px; }
        * { font-family: 'Inter', system-ui, sans-serif; }`,
'CSS vars :root + html.light overrides'
);

console.log('\n[PC] Add toggleLightMode() + IIFE to head script');
patch(
`        function handleConfirm(confirmed) {
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            if (confirmPromiseResolver) {
                confirmPromiseResolver(confirmed);
                confirmPromiseResolver = null;
            }
        }

        tailwind.config = {`,
`        function handleConfirm(confirmed) {
            const modal = document.getElementById('confirm-modal');
            if (modal) {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }
            if (confirmPromiseResolver) {
                confirmPromiseResolver(confirmed);
                confirmPromiseResolver = null;
            }
        }

        function toggleLightMode() {
            const isLight = document.documentElement.classList.toggle('light');
            localStorage.setItem('theme', isLight ? 'light' : 'dark');
            const sun = document.getElementById('theme-icon-sun');
            const moon = document.getElementById('theme-icon-moon');
            if (sun) sun.classList.toggle('hidden', isLight);
            if (moon) moon.classList.toggle('hidden', !isLight);
        }
        (function() {
            if (localStorage.getItem('theme') === 'light') {
                document.documentElement.classList.add('light');
            }
        })();

        tailwind.config = {`,
'toggleLightMode() + localStorage IIFE'
);

console.log('\n[PD] Add theme toggle button to header');
patch(
`                <div class="flex items-center gap-4">
                    <span id="last-updated" class="text-xs text-dark-500"></span>
                    <div class="w-2 h-2 bg-accent rounded-full animate-pulse" title="Connected"></div>
                </div>`,
`                <div class="flex items-center gap-4">
                    <button id="theme-toggle" onclick="toggleLightMode()" class="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700/50 transition" title="Toggle light mode">
                        <svg id="theme-icon-sun" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"/></svg>
                        <svg id="theme-icon-moon" class="w-5 h-5 hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
                    </button>
                    <span id="last-updated" class="text-xs text-dark-500"></span>
                    <div class="w-2 h-2 bg-accent rounded-full animate-pulse" title="Connected"></div>
                </div>`,
'Sun/moon theme toggle button in header'
);

// ═══════════════════════════════════════════════════════════════
// PART 2 — REPLACE confirm() → showConfirm()
// ═══════════════════════════════════════════════════════════════

console.log('\n[Confirms]');

// Line 6133 - sendSimOnline (2-space indent)
patch(
    'if (!confirm(' + BT + 'Send number.online webhook for ' + DS + 'phoneNumber}?' + BT + ')) {',
    'if (!(await showConfirm(\'Send Webhook\', ' + BT + 'Send number.online webhook for ' + DS + 'phoneNumber}?' + BT + '))) {',
    'sendSimOnline confirm'
);

// Line 6252 - rotateSpecificSims
patch(
    'if (!confirm(' + BT + 'Rotate ' + DS + 'iccids.length} SIM(s)? This will assign new phone numbers immediately.' + BT + ')) {',
    'if (!(await showConfirm(\'Rotate SIMs\', ' + BT + 'Rotate ' + DS + 'iccids.length} SIM(s)? This will assign new phone numbers immediately.' + BT + '))) {',
    'rotateSpecificSims confirm'
);

// Line 6332 - runWorker
patch(
    'if (!confirm(' + BT + 'Run ' + DS + 'workerName}?' + BT + ')) {',
    'if (!(await showConfirm(\'Run Worker\', ' + BT + 'Run ' + DS + 'workerName}?' + BT + '))) {',
    'runWorker confirm'
);

// Line 6424 - activateSims
patch(
    'if (!confirm(' + BT + 'Are you sure you want to activate ' + DS + 'sims.length} SIM(s)? This will call the Helix API.' + BT + ')) {',
    'if (!(await showConfirm(\'Activate SIMs\', ' + BT + 'Are you sure you want to activate ' + DS + 'sims.length} SIM(s)? This will call the Helix API.' + BT + '))) {',
    'activateSims confirm'
);

// Line 6469 - cancelSims
patch(
    'if (!confirm(' + BT + 'Are you sure you want to cancel ' + DS + 'iccids.length} SIM(s)? This action cannot be undone.' + BT + ')) {',
    'if (!(await showConfirm(\'Cancel SIMs\', ' + BT + 'Are you sure you want to cancel ' + DS + 'iccids.length} SIM(s)? This action cannot be undone.' + BT + '))) {',
    'cancelSims confirm'
);

// Line 6535 - suspendSims
patch(
    'if (!confirm(' + BT + 'Are you sure you want to suspend ' + DS + 'simIds.length} SIM(s)?' + BT + ')) {',
    'if (!(await showConfirm(\'Suspend SIMs\', ' + BT + 'Are you sure you want to suspend ' + DS + 'simIds.length} SIM(s)?' + BT + '))) {',
    'suspendSims confirm'
);

// Line 6600 - restoreSims
patch(
    'if (!confirm(' + BT + 'Are you sure you want to restore ' + DS + 'simIds.length} SIM(s)?' + BT + ')) {',
    'if (!(await showConfirm(\'Restore SIMs\', ' + BT + 'Are you sure you want to restore ' + DS + 'simIds.length} SIM(s)?' + BT + '))) {',
    'restoreSims confirm'
);

// Line 6975 - gwSlotAction
patch(
    "if (!confirm(label + ' slot ' + port + '?')) return;",
    "if (!(await showConfirm('Gateway Action', label + ' slot ' + port + '?'))) return;",
    'gwSlotAction confirm'
);

// Line 7087 - gwSetImei
patch(
    'if (!confirm(' + BT + 'Set IMEI ' + DS + 'imei} on port ' + DS + 'port}?' + BT + ')) return;',
    'if (!(await showConfirm(\'Set IMEI\', ' + BT + 'Set IMEI ' + DS + 'imei} on port ' + DS + 'port}?' + BT + '))) return;',
    'gwSetImei confirm'
);

// Line 7125 - gwRunCommand
patch(
    'if (!confirm(' + BT + DS + 'gwCurrentCommand} port ' + DS + 'port}?' + BT + ')) return;',
    'if (!(await showConfirm(\'Port Command\', ' + BT + DS + 'gwCurrentCommand} port ' + DS + 'port}?' + BT + '))) return;',
    'gwRunCommand confirm'
);

// Line 7170 - fixSims
patch(
    'if (!confirm(' + BT + 'Fix ' + DS + 'simIds.length} SIM(s)? This will change IMEI and run OTA/Cancel/Resume.' + BT + ')) return;',
    'if (!(await showConfirm(\'Fix SIMs\', ' + BT + 'Fix ' + DS + 'simIds.length} SIM(s)? This will change IMEI and run OTA/Cancel/Resume.' + BT + '))) return;',
    'fixSims confirm'
);

// Line 7253 - retireImei
patch(
    "if (!confirm('Retire this IMEI? It will no longer be available for allocation.')) return;",
    "if (!(await showConfirm('Retire IMEI', 'Retire this IMEI? It will no longer be available for allocation.'))) return;",
    'retireImei confirm'
);

// Line 7596 - resolveError
patch(
    "if (!confirm('Mark this error as resolved?')) return;",
    "if (!(await showConfirm('Resolve Error', 'Mark this error as resolved?'))) return;",
    'resolveError confirm'
);

// Line 7623 - bulkResolveErrors
patch(
    'if (!confirm(' + BT + 'Mark ' + DS + 'ids.length} error(s) as resolved?' + BT + ')) return;',
    'if (!(await showConfirm(\'Resolve Errors\', ' + BT + 'Mark ' + DS + 'ids.length} error(s) as resolved?' + BT + '))) return;',
    'bulkResolveErrors confirm'
);

// Line 7819 - simAction
patch(
    'if (!skipConfirm && !confirm(' + BT + 'Run ' + DS + 'action} on SIM #' + DS + 'simId}?' + BT + ')) return;',
    'if (!skipConfirm && !(await showConfirm(\'Run Action\', ' + BT + 'Run ' + DS + 'action} on SIM #' + DS + 'simId}?' + BT + '))) return;',
    'simAction confirm'
);

// Lines 8086 + 8567 - bulkSimAction + bulkErrorAction (identical, replace both)
patchAll(
    'if (!confirm(' + BT + 'Run ' + DS + 'action} on ' + DS + 'simIds.length} SIM(s)?' + BT + ')) return;',
    'if (!(await showConfirm(\'Run Action\', ' + BT + 'Run ' + DS + 'action} on ' + DS + 'simIds.length} SIM(s)?' + BT + '))) return;',
    'bulkSimAction + bulkErrorAction confirm'
);

// Line 8096 - bulkResetToProvisioning
patch(
    'if (!confirm(' + BT + 'Reset ' + DS + 'simIds.length} SIM(s) to provisioning? The details-finalizer cron will re-process and correct ICCID mappings.' + BT + ')) return;',
    'if (!(await showConfirm(\'Reset SIMs\', ' + BT + 'Reset ' + DS + 'simIds.length} SIM(s) to provisioning? The details-finalizer cron will re-process and correct ICCID mappings.' + BT + '))) return;',
    'bulkResetToProvisioning confirm'
);

// Line 8197 - bulkSendOnline
patch(
    "if (!confirm('Send number.online webhook for ' + eligible.length + ' SIM(s)?')) return;",
    "if (!(await showConfirm('Send Webhooks', 'Send number.online webhook for ' + eligible.length + ' SIM(s)?'))) return;",
    'bulkSendOnline confirm'
);

// Line 8214 - unassignReseller
patch(
    "if (!confirm('Unassign this SIM from its reseller? This stops webhooks and billing for this line.')) return;",
    "if (!(await showConfirm('Unassign SIM', 'Unassign this SIM from its reseller? This stops webhooks and billing for this line.'))) return;",
    'unassignReseller confirm'
);

// Line 8511 - bulkModifyImei
patch(
    "if (!confirm((isAuto ? 'Auto-assign new IMEI from pool' : 'Change IMEI to ' + manualImei) + ' for ' + simIds.length + ' SIM(s)?')) return;",
    "if (!(await showConfirm('Change IMEI', (isAuto ? 'Auto-assign new IMEI from pool' : 'Change IMEI to ' + manualImei) + ' for ' + simIds.length + ' SIM(s)?'))) return;",
    'bulkModifyImei confirm'
);

// Line 8545 - bulkUnassignReseller
patch(
    "if (!confirm('Unassign ' + simIds.length + ' SIM(s) from their resellers? This stops webhooks and billing.')) return;",
    "if (!(await showConfirm('Unassign SIMs', 'Unassign ' + simIds.length + ' SIM(s) from their resellers? This stops webhooks and billing.'))) return;",
    'bulkUnassignReseller confirm'
);

// Line 8795 - confirmChangeImei (manual)
patch(
    "if (!confirm('Change IMEI for SIM ' + ctx.simId + ' to ' + newImei + '?')) return;",
    "if (!(await showConfirm('Change IMEI', 'Change IMEI for SIM ' + ctx.simId + ' to ' + newImei + '?'))) return;",
    'confirmChangeImei manual confirm'
);

// Line 8797 - confirmChangeImei (auto)
patch(
    "if (!confirm('Auto-pick an available IMEI from pool and apply to SIM ' + ctx.simId + '?')) return;",
    "if (!(await showConfirm('Change IMEI', 'Auto-pick an available IMEI from pool and apply to SIM ' + ctx.simId + '?'))) return;",
    'confirmChangeImei auto confirm'
);

// Line 8921 - unretireImei
patch(
    "if (!confirm('Restore this IMEI to available stock?')) return;",
    "if (!(await showConfirm('Restore IMEI', 'Restore this IMEI to available stock?'))) return;",
    'unretireImei confirm'
);

// Line 9028 - deleteMapping
patch(
    'if (!confirm("Delete this entry?")) return;',
    'if (!(await showConfirm(\'Delete Entry\', "Delete this entry?"))) return;',
    'deleteMapping confirm'
);

// ═══════════════════════════════════════════════════════════════
// PART 3 — REPLACE alert() → showToast()
// ═══════════════════════════════════════════════════════════════

console.log('\n[Alerts]');

// Line 8105 - bulkResetToProvisioning success
patch(
    'alert(' + BT + 'Reset ' + DS + 'data.reset} SIM(s) to provisioning. The details-finalizer cron will re-process them shortly.' + BT + ');',
    'showToast(' + BT + 'Reset ' + DS + 'data.reset} SIM(s) to provisioning. Cron will re-process shortly.' + BT + ", 'success');",
    'bulkReset success alert'
);

// Line 8108 - bulkResetToProvisioning error
patch(
    "alert('Error: ' + (data.error || 'Unknown error'));",
    "showToast('Error: ' + (data.error || 'Unknown error'), 'error');",
    'bulkReset error alert'
);

// Line 8111 - bulkResetToProvisioning catch
patch(
    "alert('Error: ' + e.message);",
    "showToast('Error: ' + e.message, 'error');",
    'bulkReset catch alert'
);

// Line 8118 - showBulkSendSmsModal
patch(
    "alert('Select at least one SIM first');",
    "showToast('Select at least one SIM first', 'error');",
    'showBulkSendSmsModal alert'
);

// Line 8132 - runBulkSendSms no sims
patch(
    "if (selectedIds.length === 0) { alert('No SIMs selected'); return; }",
    "if (selectedIds.length === 0) { showToast('No SIMs selected', 'error'); return; }",
    'runBulkSendSms no sims alert'
);

// Line 8134 - runBulkSendSms no message
patch(
    "if (!message) { alert('Please enter a message'); return; }",
    "if (!message) { showToast('Please enter a message', 'error'); return; }",
    'runBulkSendSms no message alert'
);

// Line 8509 - bulkModifyImei invalid IMEI
patch(
    "if (!/^\\d{15}$/.test(manualImei)) { alert('Enter a valid 15-digit IMEI'); return; }",
    "if (!/^\\d{15}$/.test(manualImei)) { showToast('Enter a valid 15-digit IMEI', 'error'); return; }",
    'bulkModifyImei invalid IMEI alert'
);

// Line 8690 - fixIncompatibleImei missing context
patch(
    "if (!ctx || !ctx.imei || !ctx.gatewayId || !ctx.port) { alert('Missing context for fix'); return; }",
    "if (!ctx || !ctx.imei || !ctx.gatewayId || !ctx.port) { showToast('Missing context for fix', 'error'); return; }",
    'fixIncompatibleImei missing context alert'
);

// Line 8709 - fixIncompatibleImei catch
patch(
    "alert('Fix error: ' + err);",
    "showToast('Fix error: ' + err, 'error');",
    'fixIncompatibleImei catch alert'
);

// Line 8725 - runBulkImeiCheck no imeis
patch(
    "if (imeis.length === 0) { alert('Enter at least one IMEI'); return; }",
    "if (imeis.length === 0) { showToast('Enter at least one IMEI', 'error'); return; }",
    'runBulkImeiCheck no imeis alert'
);

// Line 8749 - runBulkImeiCheck catch
patch(
    "alert('Check error: ' + err);",
    "showToast('Check error: ' + err, 'error');",
    'runBulkImeiCheck catch alert'
);

// Line 8790 - confirmChangeImei missing context
patch(
    "if (!ctx) { alert('No SIM context'); return; }",
    "if (!ctx) { showToast('No SIM context', 'error'); return; }",
    'confirmChangeImei missing ctx alert'
);

// Line 8794 - confirmChangeImei invalid IMEI
patch(
    "if (!/^\\d{15}$/.test(newImei)) { alert('Enter a valid 15-digit IMEI or use Auto'); return; }",
    "if (!/^\\d{15}$/.test(newImei)) { showToast('Enter a valid 15-digit IMEI or use Auto', 'error'); return; }",
    'confirmChangeImei invalid IMEI alert'
);

// Line 8826 - confirmChangeImei catch
patch(
    "alert('Change IMEI error: ' + err);",
    "showToast('Change IMEI error: ' + err, 'error');",
    'confirmChangeImei catch alert'
);

// ═══════════════════════════════════════════════════════════════
// WRITE BACK WITH CRLF
// ═══════════════════════════════════════════════════════════════

const result = content.replace(/\n/g, '\r\n');
writeFileSync(FILE, result, 'utf8');
console.log('\nDone! Written to', FILE);
