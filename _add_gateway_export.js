'use strict';
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');

let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// ── 1. Add "Export Table" button after Sync Slots button ──────────────────────
const syncSlotsBtn =
  '                        <button onclick="syncGatewaySlots()" id="gw-sync-slots-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">\n' +
  '                            <div class="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center group-hover:bg-indigo-500/30 transition">\n' +
  '                                <svg class="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582 4 8 4s8 1.79 8 4"></path></svg>\n' +
  '                            </div>\n' +
  '                            <span class="text-xs text-gray-300">Sync Slots</span>\n' +
  '                        </button>';

if (!content.includes(syncSlotsBtn)) throw new Error('Sync Slots button anchor not found');

const exportBtn =
  '\n                        <button onclick="exportGatewayTable()" id="gw-export-btn" class="flex flex-col items-center gap-2 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition group">\n' +
  '                            <div class="w-10 h-10 rounded-lg bg-emerald-500/20 flex items-center justify-center group-hover:bg-emerald-500/30 transition">\n' +
  '                                <svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>\n' +
  '                            </div>\n' +
  '                            <span class="text-xs text-gray-300">Export Table</span>\n' +
  '                        </button>';

content = content.replace(syncSlotsBtn, syncSlotsBtn + exportBtn);
console.log('✓ Export button added to Gateway Actions');

// ── 2. Add exportGatewayTable() frontend function after loadPortStatus ────────
const anchorFn = '        const SLOT_TO_LETTER = { \'01\':\'A\', \'02\':\'B\', \'03\':\'C\', \'04\':\'D\', \'05\':\'E\', \'06\':\'F\', \'07\':\'G\', \'08\':\'H\' };';
if (!content.includes(anchorFn)) throw new Error('SLOT_TO_LETTER anchor not found');

// Newline char produced inline via String.fromCharCode(10) to avoid template-literal
// escape-sequence headaches (the whole frontend JS lives inside a JS template literal
// in getHTML(); real \n chars in the source become actual newlines, so we use fromCharCode).
const exportFn =
  '        async function exportGatewayTable() {\n' +
  '            const gwSelect = document.getElementById(\'gw-select\');\n' +
  '            const gatewayId = gwSelect.value;\n' +
  '            if (!gatewayId) {\n' +
  '                showToast(\'Select a gateway first\', \'error\');\n' +
  '                return;\n' +
  '            }\n' +
  '            const gwLabel = gwSelect.options[gwSelect.selectedIndex]?.text || gatewayId;\n' +
  '            const btn = document.getElementById(\'gw-export-btn\');\n' +
  '            const origHtml = btn.innerHTML;\n' +
  '            btn.disabled = true;\n' +
  '            btn.innerHTML = \'<span class="text-xs text-gray-400">Scanning...</span>\';\n' +
  '            try {\n' +
  '                const response = await fetch(API_BASE + \'/skyline/port-info?gateway_id=\' + encodeURIComponent(gatewayId) + \'&all_slots=1\');\n' +
  '                const result = await response.json();\n' +
  '                if (!result.ok) {\n' +
  '                    showToast(\'Gateway scan failed: \' + (result.error || \'unknown\'), \'error\');\n' +
  '                    return;\n' +
  '                }\n' +
  '                const ports = result.ports || [];\n' +
  '                if (!ports.length) {\n' +
  '                    showToast(\'No slots returned from gateway\', \'error\');\n' +
  '                    return;\n' +
  '                }\n' +
  '                const NL = String.fromCharCode(10);\n' +
  '                const esc = (v) => {\n' +
  '                    if (v == null) return \'\';\n' +
  '                    const s = String(v);\n' +
  '                    return /[",\\n\\r]/.test(s) ? \'"\' + s.replace(/"/g, \'""\') + \'"\' : s;\n' +
  '                };\n' +
  '                const header = [\'Port\',\'Slot\',\'Slot Letter\',\'ICCID\',\'IMEI\',\'Number\',\'Operator\',\'Signal\',\'SIM Status\',\'State\'];\n' +
  '                const lines = [header.join(\',\')];\n' +
  '                for (const p of ports) {\n' +
  '                    const portStr = p.port || \'\';\n' +
  '                    const m = portStr.match(/^(\\d+)\\.(\\d+)$/);\n' +
  '                    const portNum = m ? m[1] : portStr;\n' +
  '                    const slotNum = m ? m[2] : \'\';\n' +
  '                    const slotLetter = SLOT_TO_LETTER[slotNum] || slotNum;\n' +
  '                    lines.push([\n' +
  '                        esc(portNum),\n' +
  '                        esc(slotNum),\n' +
  '                        esc(slotLetter),\n' +
  '                        esc(p.iccid || \'\'),\n' +
  '                        esc(p.imei || \'\'),\n' +
  '                        esc(p.number || \'\'),\n' +
  '                        esc(p.operator || \'\'),\n' +
  '                        esc(p.signal != null ? p.signal : \'\'),\n' +
  '                        esc(p.sim_status || \'\'),\n' +
  '                        esc(p.st != null ? p.st : \'\'),\n' +
  '                    ].join(\',\'));\n' +
  '                }\n' +
  '                const csv = lines.join(NL) + NL;\n' +
  '                const blob = new Blob([csv], { type: \'text/csv;charset=utf-8;\' });\n' +
  '                const url = URL.createObjectURL(blob);\n' +
  '                const a = document.createElement(\'a\');\n' +
  '                const safeLabel = gwLabel.replace(/[^a-z0-9]/gi, \'_\');\n' +
  '                const ts = new Date().toISOString().replace(/[:.]/g, \'-\').slice(0, 19);\n' +
  '                a.href = url;\n' +
  '                a.download = \'gateway_\' + safeLabel + \'_\' + ts + \'.csv\';\n' +
  '                a.click();\n' +
  '                URL.revokeObjectURL(url);\n' +
  '                showToast(\'Exported \' + ports.length + \' slots\', \'success\');\n' +
  '            } catch (err) {\n' +
  '                showToast(\'Export error: \' + err, \'error\');\n' +
  '                console.error(err);\n' +
  '            } finally {\n' +
  '                btn.disabled = false;\n' +
  '                btn.innerHTML = origHtml;\n' +
  '            }\n' +
  '        }\n\n';

content = content.replace(anchorFn, exportFn + anchorFn);
console.log('✓ exportGatewayTable() function added');

// ── Write back ────────────────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done. Syntax-check next.');
