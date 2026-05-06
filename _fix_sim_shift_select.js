// _fix_sim_shift_select.js — add shift-click range selection to SIM checkboxes
'use strict';
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ── Change 1: add onclick handler to each SIM row checkbox ───────────────────
// Source file contains the literal chars value="\${sim.id}" (backslash is source-level
// escape for the inner template literal). Match exactly.
const OLD_CB = '<input type="checkbox" class="sim-cb accent-green-500" value="\\${sim.id}" onchange="updateSimActionBar()">';
const NEW_CB = '<input type="checkbox" class="sim-cb accent-green-500" value="\\${sim.id}" onclick="handleSimCbClick(event, this)" onchange="updateSimActionBar()">';

if (!content.includes(OLD_CB)) {
  console.error('PATCH FAILED: sim-cb anchor not found.');
  process.exit(1);
}
content = content.replace(OLD_CB, NEW_CB);
console.log('✓ onclick handler added to sim-cb input');

// ── Change 2: insert handleSimCbClick before toggleAllSims ───────────────────
const OLD_TOGGLE = '        function toggleAllSims(checkbox) {';
if (!content.includes(OLD_TOGGLE)) {
  console.error('PATCH FAILED: toggleAllSims anchor not found.');
  process.exit(1);
}

// Shift-click range selection:
//   - Remember the last clicked checkbox's index.
//   - On shift-click, set every checkbox between the previous and current index to
//     the new checked state of THIS checkbox.
//   - Call updateSimActionBar() directly because programmatic .checked = X does not
//     fire onchange on the other checkboxes.
const NEW_FN =
  '        let lastSimCbIndex = -1;\n' +
  '        function handleSimCbClick(event, cb) {\n' +
  '            const all = Array.from(document.querySelectorAll(\'.sim-cb\'));\n' +
  '            const idx = all.indexOf(cb);\n' +
  '            if (event.shiftKey && lastSimCbIndex !== -1 && lastSimCbIndex !== idx) {\n' +
  '                const start = Math.min(lastSimCbIndex, idx);\n' +
  '                const end = Math.max(lastSimCbIndex, idx);\n' +
  '                const state = cb.checked;\n' +
  '                for (let i = start; i <= end; i++) {\n' +
  '                    if (all[i]) all[i].checked = state;\n' +
  '                }\n' +
  '                updateSimActionBar();\n' +
  '                // Prevent text selection artefacts from shift-click\n' +
  '                if (window.getSelection) window.getSelection().removeAllRanges();\n' +
  '            }\n' +
  '            lastSimCbIndex = idx;\n' +
  '        }\n\n' +
  OLD_TOGGLE;

content = content.replace(OLD_TOGGLE, NEW_FN);
console.log('✓ handleSimCbClick function inserted');

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
