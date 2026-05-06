// _fix_reseller_combine_and_bulk_delete.js
// Combines Assign Reseller / Assign + Notify / Unassign Reseller into a single
// "Reseller…" button that opens a 3-option chooser modal, plus adds a
// "Delete SIMs" bulk button + bulkDeleteSims() handler.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

content = content.replace(/\r\n/g, '\n');

// === Patch 1: Replace 3 reseller buttons with 1 chooser button ===
const OLD_BTNS =
'                    <button onclick="bulkAssignReseller()" class="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition">Assign Reseller</button>\n' +
'                    <button onclick="bulkAssignResellerAndNotify()" class="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded transition">Assign + Notify</button>\n' +
'                    <button onclick="bulkUnassignReseller()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Unassign Reseller</button>';

const NEW_BTN =
'                    <button onclick="showBulkResellerActionModal()" class="px-3 py-1.5 text-xs bg-green-700 hover:bg-green-800 text-white rounded transition">Reseller…</button>';

if (!content.includes(OLD_BTNS)) {
  console.error('PATCH 1 FAILED: 3-button reseller block not found.');
  process.exit(1);
}
content = content.replace(OLD_BTNS, NEW_BTN);

// === Patch 2: Add "Delete SIMs" button after Retry Activation ===
const OLD_RETRY =
'                    <button onclick="bulkRetryActivation()" class="px-3 py-1.5 text-xs bg-pink-600 hover:bg-pink-700 text-white rounded transition">Retry Activation</button>\n' +
'                </div>';

const NEW_RETRY =
'                    <button onclick="bulkRetryActivation()" class="px-3 py-1.5 text-xs bg-pink-600 hover:bg-pink-700 text-white rounded transition">Retry Activation</button>\n' +
'                    <button onclick="bulkDeleteSims()" class="px-3 py-1.5 text-xs bg-red-700 hover:bg-red-800 text-white rounded transition">Delete SIMs</button>\n' +
'                </div>';

if (!content.includes(OLD_RETRY)) {
  console.error('PATCH 2 FAILED: Retry Activation closing block not found.');
  process.exit(1);
}
content = content.replace(OLD_RETRY, NEW_RETRY);

// === Patch 3: Insert showBulkResellerActionModal() and bulkDeleteSims() before bulkErrorAction() ===
const ANCHOR = '        async function bulkErrorAction(action) {';
if (!content.includes(ANCHOR)) {
  console.error('PATCH 3 FAILED: bulkErrorAction anchor not found.');
  process.exit(1);
}

// New code lives inside getHTML's outer template literal in the dashboard.
// Rules: only single-quoted strings (no backticks, no ${ }), and where the
// browser JS needs '\n' the source must contain '\\n' (two chars: \ + n) so
// the outer template literal evaluates it to '\n'. In this patch script the
// JS literal '\\\\n' produces the 3-byte sequence \ + \ + n on disk.
const NEW_FUNCS =
'        function showBulkResellerActionModal() {\n' +
'            const simIds = [...document.querySelectorAll(\'.sim-cb:checked\')].map(cb => parseInt(cb.value));\n' +
'            if (simIds.length === 0) {\n' +
'                showToast(\'Select at least one SIM first\', \'error\');\n' +
'                return;\n' +
'            }\n' +
'            const existing = document.getElementById(\'bulk-reseller-action-modal\');\n' +
'            if (existing) existing.remove();\n' +
'            const modal = document.createElement(\'div\');\n' +
'            modal.id = \'bulk-reseller-action-modal\';\n' +
'            modal.className = \'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4\';\n' +
'            const box = document.createElement(\'div\');\n' +
'            box.className = \'bg-gray-800 rounded-xl shadow-xl w-80 p-6\';\n' +
'            const titleEl = document.createElement(\'h3\');\n' +
'            titleEl.className = \'text-lg font-semibold text-white mb-1\';\n' +
'            titleEl.textContent = \'Reseller Action\';\n' +
'            const subtitle = document.createElement(\'p\');\n' +
'            subtitle.className = \'text-xs text-gray-400 mb-4\';\n' +
'            subtitle.textContent = simIds.length + \' SIM(s) selected\';\n' +
'            const optionsWrap = document.createElement(\'div\');\n' +
'            optionsWrap.className = \'flex flex-col gap-2\';\n' +
'            const opts = [\n' +
'                { label: \'Assign Reseller\', cls: \'bg-green-700 hover:bg-green-800\', fn: \'bulkAssignReseller\' },\n' +
'                { label: \'Assign + Notify\', cls: \'bg-green-600 hover:bg-green-700\', fn: \'bulkAssignResellerAndNotify\' },\n' +
'                { label: \'Unassign Reseller\', cls: \'bg-purple-600 hover:bg-purple-700\', fn: \'bulkUnassignReseller\' }\n' +
'            ];\n' +
'            opts.forEach(function(o) {\n' +
'                const btn = document.createElement(\'button\');\n' +
'                btn.className = \'w-full px-3 py-2 text-sm text-white rounded transition \' + o.cls;\n' +
'                btn.textContent = o.label;\n' +
'                btn.onclick = function() {\n' +
'                    modal.remove();\n' +
'                    window[o.fn]();\n' +
'                };\n' +
'                optionsWrap.appendChild(btn);\n' +
'            });\n' +
'            const cancelRow = document.createElement(\'div\');\n' +
'            cancelRow.className = \'mt-4 flex justify-end\';\n' +
'            const cancelBtn = document.createElement(\'button\');\n' +
'            cancelBtn.className = \'px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 text-gray-300 rounded transition\';\n' +
'            cancelBtn.textContent = \'Cancel\';\n' +
'            cancelBtn.onclick = function() { modal.remove(); };\n' +
'            cancelRow.appendChild(cancelBtn);\n' +
'            box.appendChild(titleEl);\n' +
'            box.appendChild(subtitle);\n' +
'            box.appendChild(optionsWrap);\n' +
'            box.appendChild(cancelRow);\n' +
'            modal.appendChild(box);\n' +
'            document.body.appendChild(modal);\n' +
'        }\n' +
'\n' +
'        async function bulkDeleteSims() {\n' +
'            const simIds = [...document.querySelectorAll(\'.sim-cb:checked\')].map(cb => parseInt(cb.value));\n' +
'            if (simIds.length === 0) return;\n' +
'            if (!(await showConfirm(\'Delete SIMs\', \'Permanently delete \' + simIds.length + \' SIM(s)? This deletes all SMS history and CANNOT be undone.\'))) return;\n' +
'            const output = document.getElementById(\'sim-action-output\');\n' +
'            document.getElementById(\'sim-action-title\').textContent = \'Bulk Delete — \' + simIds.length + \' SIMs\';\n' +
'            output.textContent = \'Starting...\';\n' +
'            output.classList.remove(\'hidden\');\n' +
'            document.getElementById(\'sim-action-logs-section\').classList.add(\'hidden\');\n' +
'            document.getElementById(\'sim-action-modal\').classList.remove(\'hidden\');\n' +
'            window.__bulkCancel = false;\n' +
'            showBulkCancelButton();\n' +
'            let deleted = 0, failed = 0, cancelled = 0;\n' +
'            const lines = [];\n' +
'            for (const simId of simIds) {\n' +
'                if (window.__bulkCancel) { cancelled = simIds.length - deleted - failed; break; }\n' +
'                try {\n' +
'                    const resp = await fetch(API_BASE + \'/delete-sim\', {\n' +
'                        method: \'POST\',\n' +
'                        headers: { \'Content-Type\': \'application/json\' },\n' +
'                        body: JSON.stringify({ sim_id: simId })\n' +
'                    });\n' +
'                    const result = await resp.json();\n' +
'                    if (result.ok) {\n' +
'                        deleted++;\n' +
'                        lines.push(\'SIM #\' + simId + \': deleted\');\n' +
'                    } else {\n' +
'                        failed++;\n' +
'                        lines.push(\'SIM #\' + simId + \': FAILED — \' + (result.error || \'unknown\'));\n' +
'                    }\n' +
'                } catch (e) {\n' +
'                    failed++;\n' +
'                    lines.push(\'SIM #\' + simId + \': EXCEPTION — \' + (e && e.message ? e.message : e));\n' +
'                }\n' +
'                output.textContent = lines.join(\'\\\\n\') + \'\\\\n\\\\nProcessing... (\' + (deleted + failed) + \'/\' + simIds.length + \')\';\n' +
'            }\n' +
'            hideBulkCancelButton();\n' +
'            const summary = \'Done: \' + deleted + \' deleted\' + (failed ? \', \' + failed + \' failed\' : \'\') + (cancelled ? \', \' + cancelled + \' cancelled\' : \'\');\n' +
'            output.textContent = summary + \'\\\\n\\\\n\' + lines.join(\'\\\\n\');\n' +
'            loadSims(true);\n' +
'        }\n' +
'\n';

content = content.replace(ANCHOR, NEW_FUNCS + ANCHOR);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
