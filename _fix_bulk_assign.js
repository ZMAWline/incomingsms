const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. Add toolbar button before Unassign Reseller ----
const TOOLBAR_OLD =
  '                    <button onclick="bulkUnassignReseller()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Unassign Reseller</button>';
const TOOLBAR_NEW =
  '                    <button onclick="bulkAssignReseller()" class="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition">Assign Reseller</button>\n' +
  TOOLBAR_OLD;
if (!content.includes(TOOLBAR_OLD)) throw new Error('TOOLBAR_OLD not found');
content = content.replace(TOOLBAR_OLD, TOOLBAR_NEW);
console.log('Toolbar button added');

// ---- 2. Add bulkAssignReseller function before bulkUnassignReseller ----
const FN_MARKER = '        async function bulkUnassignReseller() {';
if (!content.includes(FN_MARKER)) throw new Error('FN_MARKER not found');

const BULK_ASSIGN_FN =
  '        async function bulkAssignReseller() {\n' +
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  '            if (simIds.length === 0) return;\n' +
  "            const sel = document.getElementById('filter-reseller');\n" +
  '            const opts = [...sel.options].filter(o => o.value);\n' +
  '            if (opts.length === 0) {\n' +
  "                showToast('No resellers available', 'error');\n" +
  '                return;\n' +
  '            }\n' +
  "            const existing = document.getElementById('assign-reseller-modal');\n" +
  '            if (existing) existing.remove();\n' +
  '\n' +
  "            const modal = document.createElement('div');\n" +
  "            modal.id = 'assign-reseller-modal';\n" +
  "            modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';\n" +
  "            const box = document.createElement('div');\n" +
  "            box.className = 'bg-gray-800 rounded-xl shadow-xl w-80 p-6';\n" +
  "            const titleEl = document.createElement('h3');\n" +
  "            titleEl.className = 'text-lg font-semibold text-white mb-1';\n" +
  "            titleEl.textContent = 'Assign to Reseller';\n" +
  "            const subtitle = document.createElement('p');\n" +
  "            subtitle.className = 'text-xs text-gray-400 mb-4';\n" +
  "            subtitle.textContent = simIds.length + ' SIM(s) selected';\n" +
  "            const select = document.createElement('select');\n" +
  "            select.className = 'w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-gray-300';\n" +
  '            opts.forEach(function(o) {\n' +
  "                const opt = document.createElement('option');\n" +
  '                opt.value = o.value;\n' +
  '                opt.textContent = o.text;\n' +
  '                select.appendChild(opt);\n' +
  '            });\n' +
  "            const btnRow = document.createElement('div');\n" +
  "            btnRow.className = 'flex gap-2 justify-end mt-4';\n" +
  "            const cancelBtn = document.createElement('button');\n" +
  "            cancelBtn.className = 'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition';\n" +
  "            cancelBtn.textContent = 'Cancel';\n" +
  '            cancelBtn.onclick = function() { modal.remove(); };\n' +
  "            const assignBtn = document.createElement('button');\n" +
  "            assignBtn.className = 'px-3 py-1.5 text-sm bg-green-700 hover:bg-green-800 text-white rounded transition';\n" +
  "            assignBtn.textContent = 'Assign';\n" +
  '            assignBtn.onclick = async function() {\n' +
  '                const resellerId = parseInt(select.value);\n' +
  '                modal.remove();\n' +
  '                let assigned = 0, failed = 0;\n' +
  '                for (const simId of simIds) {\n' +
  '                    try {\n' +
  "                        const resp = await fetch(API_BASE + '/assign-reseller', {\n" +
  "                            method: 'POST',\n" +
  "                            headers: { 'Content-Type': 'application/json' },\n" +
  '                            body: JSON.stringify({ sim_id: simId, reseller_id: resellerId })\n' +
  '                        });\n' +
  '                        const result = await resp.json();\n' +
  '                        if (result.ok) assigned++; else failed++;\n' +
  '                    } catch (err) {\n' +
  '                        failed++;\n' +
  '                    }\n' +
  '                }\n' +
  "                if (failed) showToast(assigned + ' assigned, ' + failed + ' failed', 'error');\n" +
  "                else showToast(assigned + ' SIM(s) assigned to reseller', 'success');\n" +
  '                loadSims(true);\n' +
  '            };\n' +
  '            btnRow.appendChild(cancelBtn);\n' +
  '            btnRow.appendChild(assignBtn);\n' +
  '            box.appendChild(titleEl);\n' +
  '            box.appendChild(subtitle);\n' +
  '            box.appendChild(select);\n' +
  '            box.appendChild(btnRow);\n' +
  '            modal.appendChild(box);\n' +
  '            document.body.appendChild(modal);\n' +
  '        }\n\n';

content = content.replace(FN_MARKER, BULK_ASSIGN_FN + FN_MARKER);
console.log('bulkAssignReseller function added');

// ---- Write back with CRLF ----
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done!');
