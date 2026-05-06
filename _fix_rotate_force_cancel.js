// _fix_rotate_force_cancel.js
// Dashboard patches for MDN rotation redesign:
//   1. handleSimAction backend proxy: pass `force` to mdn-rotator
//   2. simAction client: update rotate confirmation text + pass force:true for rotate
//   3. bulkSimAction: update confirmation text; cancel flag + break loop on cancel
//   4. sim-action-modal: add a Cancel button (hidden by default; shown during bulk runs)
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

function applyReplace(tag, oldStr, newStr) {
  if (!content.includes(oldStr)) {
    console.error(`PATCH FAILED (${tag}): old string not found.`);
    process.exit(1);
  }
  content = content.replace(oldStr, newStr);
  console.log(`✓ ${tag}`);
}

// 1) handleSimAction backend proxy — pass `force` through to mdn-rotator
const OLD_1 =
  "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false, imei_strategy: body.imei_strategy ?? null })";
const NEW_1 =
  "      body: JSON.stringify({ sim_id, action, gateway_id: body.gateway_id ?? null, port: body.port ?? null, new_imei: body.new_imei ?? null, auto_imei: body.auto_imei ?? false, imei_strategy: body.imei_strategy ?? null, force: body.force === true })";
applyReplace('1-handleSimAction pass force', OLD_1, NEW_1);

// 2) simAction client — replace the rotate confirmation + add force:true for rotate.
// Original single-line:
//   } else if (!skipConfirm && !(await showConfirm('Run Action', `Run ${action} on SIM #${simId}?`))) return;
// We use string concat for the old/new (both contain backticks and ${}).
const BT = '\\' + '`';      // produces \` in the file (escaped backtick inside getHTML template)
const DS = '\\' + '${';      // produces \${ in the file

const OLD_2 =
  "            } else if (!skipConfirm && !(await showConfirm('Run Action', " + BT + "Run " + DS + "action} on SIM #" + DS + "simId}?" + BT + "))) return;";
const NEW_2 =
  "            } else if (action === 'rotate') {\n" +
  "                // Force-rotate warning — per-SIM manual rotate bypasses the daily dedup guard\n" +
  "                if (!skipConfirm) {\n" +
  "                    const ok = await showConfirm('Force-rotate SIM?', " + BT + "Rotate SIM #" + DS + "simId}?\\n\\n\\u26A0\\uFE0F This will force-rotate even if already rotated today. Reseller will receive the new MDN via webhook." + BT + ");\n" +
  "                    if (!ok) return;\n" +
  "                }\n" +
  "                extraBody = Object.assign({}, extraBody, { force: true });\n" +
  "            } else if (!skipConfirm && !(await showConfirm('Run Action', " + BT + "Run " + DS + "action} on SIM #" + DS + "simId}?" + BT + "))) return;";
applyReplace('2-simAction rotate confirm + force', OLD_2, NEW_2);

// 3) bulkSimAction — update confirmation text for rotate specifically; add cancel flag + break.
const OLD_3 =
  "        async function bulkSimAction(action) {\n" +
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (simIds.length === 0) return;\n" +
  "            if (!(await showConfirm('Run Action', " + BT + "Run " + DS + "action} on " + DS + "simIds.length} SIM(s)?" + BT + "))) return;\n" +
  "            for (const id of simIds) {\n" +
  "                await simAction(id, action, true);\n" +
  "            }\n" +
  "            loadSims(true);\n" +
  "        }";
const NEW_3 =
  "        async function bulkSimAction(action) {\n" +
  "            const simIds = [...document.querySelectorAll('.sim-cb:checked')].map(cb => parseInt(cb.value));\n" +
  "            if (simIds.length === 0) return;\n" +
  "            let confirmMsg;\n" +
  "            if (action === 'rotate') {\n" +
  "                confirmMsg = " + BT + "Rotate " + DS + "simIds.length} SIMs?\\n\\n\\u26A0\\uFE0F This will force-rotate every selected SIM \\u2014 including any already rotated today. Duplicate rotations risk your AT&T account and require resellers to update the MDN each time." + BT + ";\n" +
  "            } else {\n" +
  "                confirmMsg = " + BT + "Run " + DS + "action} on " + DS + "simIds.length} SIM(s)?" + BT + ";\n" +
  "            }\n" +
  "            if (!(await showConfirm('Run Action', confirmMsg))) return;\n" +
  "            window.__bulkCancel = false;\n" +
  "            showBulkCancelButton();\n" +
  "            const extraBody = action === 'rotate' ? { force: true } : {};\n" +
  "            let done = 0;\n" +
  "            for (const id of simIds) {\n" +
  "                if (window.__bulkCancel) {\n" +
  "                    showToast(" + BT + "Cancelled at " + DS + "done}/" + DS + "simIds.length}" + BT + ", 'info');\n" +
  "                    break;\n" +
  "                }\n" +
  "                await simAction(id, action, true, extraBody);\n" +
  "                done++;\n" +
  "            }\n" +
  "            hideBulkCancelButton();\n" +
  "            loadSims(true);\n" +
  "        }\n" +
  "\n" +
  "        function showBulkCancelButton() {\n" +
  "            const btn = document.getElementById('sim-action-cancel');\n" +
  "            if (btn) { btn.classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Cancel remaining'; }\n" +
  "        }\n" +
  "        function hideBulkCancelButton() {\n" +
  "            const btn = document.getElementById('sim-action-cancel');\n" +
  "            if (btn) { btn.classList.add('hidden'); btn.disabled = false; btn.textContent = 'Cancel remaining'; }\n" +
  "        }\n" +
  "        function onBulkCancelClick() {\n" +
  "            window.__bulkCancel = true;\n" +
  "            const btn = document.getElementById('sim-action-cancel');\n" +
  "            if (btn) { btn.disabled = true; btn.textContent = 'Cancelling\\u2026'; }\n" +
  "        }";
applyReplace('3-bulkSimAction cancel + force', OLD_3, NEW_3);

// 4) sim-action-modal footer — add Cancel button before Close
const OLD_4 =
  '            <div class="px-5 py-4 border-t border-dark-600 flex justify-end">\n' +
  '                <button onclick="hideSimActionModal()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>\n' +
  '            </div>\n' +
  '        </div>\n' +
  '    </div>\n' +
  '    <!-- Slot Picker Modal -->';
const NEW_4 =
  '            <div class="px-5 py-4 border-t border-dark-600 flex justify-end gap-2">\n' +
  '                <button id="sim-action-cancel" onclick="onBulkCancelClick()" class="hidden px-4 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed">Cancel remaining</button>\n' +
  '                <button onclick="hideSimActionModal()" class="px-4 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-white rounded-lg transition">Close</button>\n' +
  '            </div>\n' +
  '        </div>\n' +
  '    </div>\n' +
  '    <!-- Slot Picker Modal -->';
applyReplace('4-sim-action-modal cancel button', OLD_4, NEW_4);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied.');
