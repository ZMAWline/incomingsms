const fs = require('fs');

const file = 'src/dashboard/index.js';
let content = fs.readFileSync(file, 'utf8');
const normalized = content.replace(/\r\n/g, '\n');

// 1. Add button to toolbar (after Resume button)
const OLD_BTN =
  `                    <button onclick="bulkSimAction('resume')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>`;

const NEW_BTN =
  `                    <button onclick="bulkSimAction('resume')" class="px-3 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded transition">Resume</button>\n` +
  `                    <button onclick="bulkSendOnline()" class="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white rounded transition">Send Online</button>`;

// 2. Add bulkSendOnline() after bulkSimAction()
const OLD_FUNC =
  `        async function unassignReseller(simId) {`;

const NEW_FUNC =
  `        async function bulkSendOnline() {\n` +
  `            const selectedIds = new Set([...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value)));\n` +
  `            const eligible = tableState.sims.data.filter(s =>\n` +
  `                selectedIds.has(s.id) && s.phone_number && s.reseller_id && s.status === 'active'\n` +
  `            );\n` +
  `            if (eligible.length === 0) {\n` +
  `                showToast('No eligible SIMs selected (must be active with phone and reseller)', 'error');\n` +
  `                return;\n` +
  `            }\n` +
  `            if (!confirm('Send number.online webhook for ' + eligible.length + ' SIM(s)?')) return;\n` +
  `            let ok = 0, fail = 0;\n` +
  `            for (const sim of eligible) {\n` +
  `                try {\n` +
  `                    const resp = await fetch(API_BASE + '/sim-online', {\n` +
  `                        method: 'POST',\n` +
  `                        headers: { 'Content-Type': 'application/json' },\n` +
  `                        body: JSON.stringify({ sim_id: sim.id })\n` +
  `                    });\n` +
  `                    const result = await resp.json();\n` +
  `                    if (resp.ok && result.ok) { ok++; } else { fail++; }\n` +
  `                } catch { fail++; }\n` +
  `            }\n` +
  `            showToast(ok + ' sent' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success');\n` +
  `        }\n` +
  `\n` +
  `        async function unassignReseller(simId) {`;

if (!normalized.includes(OLD_BTN)) { console.error('ERROR: button anchor not found'); process.exit(1); }
if (!normalized.includes(OLD_FUNC)) { console.error('ERROR: function anchor not found'); process.exit(1); }

const result = normalized
  .replace(OLD_BTN, NEW_BTN)
  .replace(OLD_FUNC, NEW_FUNC)
  .replace(/\n/g, '\r\n');

fs.writeFileSync(file, result);
console.log('Patched');
