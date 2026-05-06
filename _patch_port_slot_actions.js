// Patch: add Lock / Unlock / Switch SIM action buttons per slot in port-detail modal
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ── 1. Add "Actions" <th> to the port detail table header ──────────────────
const TH_OLD = '                            <th class="pb-2">Operator</th>\n                        </tr>';
const TH_NEW = '                            <th class="pb-2">Operator</th>\n                            <th class="pb-2 pl-3">Actions</th>\n                        </tr>';

if (!content.includes(TH_OLD)) { console.error('ERROR: TH anchor not found'); process.exit(1); }
content = content.replace(TH_OLD, TH_NEW);
console.log('✓ Actions <th> added');

// ── 2. Add action buttons <td> per slot row ────────────────────────────────
// In the source the inner template literal variables are escaped as \${...}
// p.port appears as \${p.port} in the raw file string
const TD_OLD = "                                    <td class=\"py-2 text-gray-300\">\\${p.operator || '---'}</td>\n                                </tr>";

const TD_NEW =
  "                                    <td class=\"py-2 text-gray-300\">\\${p.operator || '---'}</td>\n" +
  "                                    <td class=\"py-2 pl-3 whitespace-nowrap\">\n" +
  "                                        <button onclick=\"gwSlotAction('lock','\\${p.port}')\" class=\"px-2 py-1 text-xs bg-orange-700 hover:bg-orange-600 text-white rounded transition mr-1\" title=\"Lock SIM slot\">Lock</button>\n" +
  "                                        <button onclick=\"gwSlotAction('unlock','\\${p.port}')\" class=\"px-2 py-1 text-xs bg-green-700 hover:bg-green-600 text-white rounded transition mr-1\" title=\"Unlock SIM slot\">Unlock</button>\n" +
  "                                        <button onclick=\"gwSlotAction('switch','\\${p.port}')\" class=\"px-2 py-1 text-xs bg-purple-700 hover:bg-purple-600 text-white rounded transition\" title=\"Switch to this SIM slot\">Switch</button>\n" +
  "                                    </td>\n" +
  "                                </tr>";

if (!content.includes(TD_OLD)) { console.error('ERROR: TD anchor not found'); process.exit(1); }
content = content.replace(TD_OLD, TD_NEW);
console.log('✓ Action buttons <td> added per slot row');

// ── 3. Add gwSlotAction() function after hideGwModal ──────────────────────
const FN_OLD = `        function hideGwModal(modalId) {
            document.getElementById(modalId).classList.add('hidden');
        }`;

const FN_NEW =
  `        function hideGwModal(modalId) {\n` +
  `            document.getElementById(modalId).classList.add('hidden');\n` +
  `        }\n` +
  `\n` +
  `        // Direct slot actions from port-detail modal (lock / unlock / switch-sim)\n` +
  `        async function gwSlotAction(action, port) {\n` +
  `            const gatewayId = getSelectedGatewayId();\n` +
  `            if (!gatewayId) { showToast('No gateway selected', 'error'); return; }\n` +
  `            const label = action === 'switch' ? 'Switch SIM on' : (action.charAt(0).toUpperCase() + action.slice(1));\n` +
  `            if (!confirm(label + ' slot ' + port + '?')) return;\n` +
  `            showToast(label + ' ' + port + '...', 'info');\n` +
  `            try {\n` +
  `                const endpoint = action === 'switch' ? 'switch-sim' : action;\n` +
  `                const resp = await fetch(API_BASE + '/skyline/' + endpoint, {\n` +
  `                    method: 'POST',\n` +
  `                    headers: { 'Content-Type': 'application/json' },\n` +
  `                    body: JSON.stringify({ gateway_id: gatewayId, port })\n` +
  `                });\n` +
  `                const result = await resp.json();\n` +
  `                showToast(result.ok ? (result.message || label + ' OK') : ('Error: ' + result.error), result.ok ? 'success' : 'error');\n` +
  `                if (result.ok) setTimeout(loadPortStatus, 2000);\n` +
  `            } catch (e) {\n` +
  `                showToast('Error: ' + e.message, 'error');\n` +
  `            }\n` +
  `        }`;

if (!content.includes(FN_OLD)) { console.error('ERROR: function anchor not found'); process.exit(1); }
content = content.replace(FN_OLD, FN_NEW);
console.log('✓ gwSlotAction() function added');

// Convert back to CRLF and write
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written (CRLF)');
