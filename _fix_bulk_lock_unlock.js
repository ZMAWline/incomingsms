// _fix_bulk_lock_unlock.js
// Adds "Lock Failed" and "Unlock Locked" bulk-action buttons to the Gateway Actions panel.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── PATCH 1: Add two buttons after the existing Unlock button ──────────────
const OLD_BTN =
`                        <button onclick="showGwCommandModal('unlock')" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition">
                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Unlock</span>
                        </button>
                        <button onclick="importGatewayImeis()"`;

if (!content.includes(OLD_BTN)) {
  console.error('PATCH 1 FAILED: unlock button anchor not found.');
  process.exit(1);
}

const NEW_BTN =
`                        <button onclick="showGwCommandModal('unlock')" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition">
                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Unlock</span>
                        </button>
                        <button onclick="lockFailedRegistration()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-rose-500/20 flex items-center justify-center group-hover:bg-rose-500/30 transition">
                                <svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Lock Failed</span>
                        </button>
                        <button onclick="unlockAllLocked()" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">
                            <div class="w-10 h-10 rounded-lg bg-teal-500/20 flex items-center justify-center group-hover:bg-teal-500/30 transition">
                                <svg class="w-5 h-5 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"></path></svg>
                            </div>
                            <span class="text-xs text-gray-300">Unlock Locked</span>
                        </button>
                        <button onclick="importGatewayImeis()"`;

content = content.replace(OLD_BTN, NEW_BTN);

// ── PATCH 2: Add bulk JS functions before // --- Fix SIM --- ─────────────
const OLD_JS = `        // --- Fix SIM ---
        function showFixSimModal() {`;

if (!content.includes(OLD_JS)) {
  console.error('PATCH 2 FAILED: Fix SIM anchor not found.');
  process.exit(1);
}

const NEW_JS =
`        async function lockFailedRegistration() {
            const gatewayId = getSelectedGatewayId();
            if (!gatewayId) { showToast('Select a gateway first', 'error'); return; }
            if (!window.portData) { showToast('Load port status first', 'error'); return; }
            const failed = window.portData.filter(function(p) { return p.st === 6; });
            if (!failed.length) { showToast('No registration-failed ports found', 'info'); return; }
            if (!(await showConfirm('Lock Failed Registrations', 'Lock ' + failed.length + ' port(s) with failed registration?'))) return;
            let ok = 0, err = 0;
            for (const p of failed) {
                try {
                    const res = await fetch(API_BASE + '/skyline/lock', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ gateway_id: gatewayId, port: p.port })
                    });
                    const r = await res.json();
                    if (r.ok) ok++; else err++;
                } catch (e) { err++; }
            }
            showToast('Locked ' + ok + ' port(s)' + (err ? ', ' + err + ' failed' : ''), ok ? 'success' : 'error');
            setTimeout(loadPortStatus, 3000);
        }

        async function unlockAllLocked() {
            const gatewayId = getSelectedGatewayId();
            if (!gatewayId) { showToast('Select a gateway first', 'error'); return; }
            if (!window.portData) { showToast('Load port status first', 'error'); return; }
            const locked = window.portData.filter(function(p) { return p.st === 7 || p.st === 8 || p.st === 12; });
            if (!locked.length) { showToast('No locked ports found', 'info'); return; }
            if (!(await showConfirm('Unlock All Locked', 'Unlock ' + locked.length + ' locked port(s)?'))) return;
            let ok = 0, err = 0;
            for (const p of locked) {
                try {
                    const res = await fetch(API_BASE + '/skyline/unlock', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ gateway_id: gatewayId, port: p.port })
                    });
                    const r = await res.json();
                    if (r.ok) ok++; else err++;
                } catch (e) { err++; }
            }
            showToast('Unlocked ' + ok + ' port(s)' + (err ? ', ' + err + ' failed' : ''), ok ? 'success' : 'error');
            setTimeout(loadPortStatus, 3000);
        }

        // --- Fix SIM ---
        function showFixSimModal() {`;

content = content.replace(OLD_JS, NEW_JS);

// Write back with CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
