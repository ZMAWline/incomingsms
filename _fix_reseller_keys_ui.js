// _fix_reseller_keys_ui.js
// Add "Reseller API Keys" UI section to billing tab + JS handlers.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// Escaping helpers for content that lives inside getHTML's outer template literal
const BT = '\\' + '`';   // produces \` in the file
const DS = '\\' + '${';  // produces \${ in the file

// ---------- 1. HTML section ----------------------------------------------

const HTML_ANCHOR = "                <!-- Invoice Generator -->";

const HTML_SECTION =
  "                <!-- Reseller API Keys -->\n" +
  "                <div class=\"bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6\">\n" +
  "                    <div class=\"flex items-center justify-between mb-3\">\n" +
  "                        <h3 class=\"text-lg font-semibold text-white\">Reseller API Keys</h3>\n" +
  "                    </div>\n" +
  "                    <p class=\"text-xs text-gray-500 mb-4\">Generate a key per reseller to grant read-only access to the customer portal at <span class=\"text-gray-300\">reseller-portal.zalmen-531.workers.dev</span>. Each key shows full data scoped to that reseller only.</p>\n" +
  "                    <div class=\"flex flex-wrap items-end gap-3 mb-4\">\n" +
  "                        <div class=\"flex flex-col gap-1\">\n" +
  "                            <label class=\"text-xs text-gray-500 uppercase\">Reseller</label>\n" +
  "                            <select id=\"rkey-reseller\" class=\"text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 min-w-56\"><option value=\"\">Loading…</option></select>\n" +
  "                        </div>\n" +
  "                        <button onclick=\"generateResellerKey()\" class=\"px-4 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition\">Generate Key</button>\n" +
  "                    </div>\n" +
  "                    <div class=\"overflow-x-auto\">\n" +
  "                        <table class=\"w-full\">\n" +
  "                            <thead>\n" +
  "                                <tr class=\"text-left text-xs text-gray-500 uppercase border-b border-dark-600\">\n" +
  "                                    <th class=\"px-4 py-3 font-medium\">Reseller</th>\n" +
  "                                    <th class=\"px-4 py-3 font-medium\">Key</th>\n" +
  "                                    <th class=\"px-4 py-3 font-medium\">Status</th>\n" +
  "                                    <th class=\"px-4 py-3 font-medium\">Created</th>\n" +
  "                                    <th class=\"px-4 py-3 font-medium\">Actions</th>\n" +
  "                                </tr>\n" +
  "                            </thead>\n" +
  "                            <tbody id=\"reseller-keys-table\" class=\"text-sm\">\n" +
  "                                <tr><td colspan=\"5\" class=\"px-4 py-4 text-center text-gray-500\">Loading...</td></tr>\n" +
  "                            </tbody>\n" +
  "                        </table>\n" +
  "                    </div>\n" +
  "                </div>\n" +
  "\n" +
  HTML_ANCHOR;

if (!content.includes(HTML_ANCHOR)) {
  console.error('PATCH FAILED: Invoice Generator anchor not found.');
  process.exit(1);
}
if (content.includes('id="reseller-keys-table"')) {
  console.log('Reseller-keys section already present, skipping HTML insert.');
} else {
  content = content.replace(HTML_ANCHOR, HTML_SECTION);
  console.log('Inserted Reseller API Keys HTML section.');
}

// ---------- 2. JS handlers (inside getHTML template) ---------------------

const JS_ANCHOR = "        async function loadMappings() {";

const JS_HANDLERS =
  "        async function loadResellerKeys() {\n" +
  "            try {\n" +
  "                const [keysResp, mapsResp] = await Promise.all([\n" +
  "                    fetch(" + BT + DS + "API_BASE}/reseller-keys" + BT + "),\n" +
  "                    fetch(" + BT + DS + "API_BASE}/qbo-mappings" + BT + "),\n" +
  "                ]);\n" +
  "                const keys = await keysResp.json();\n" +
  "                const maps = await mapsResp.json();\n" +
  "                const sel = document.getElementById('rkey-reseller');\n" +
  "                sel.innerHTML = '<option value=\"\">Choose reseller…</option>' + (Array.isArray(maps) ? maps : []).map(m => '<option value=\"' + m.reseller_id + '\">' + (m.resellers?.name || m.qbo_display_name || ('reseller_id ' + m.reseller_id)) + '</option>').join('');\n" +
  "                const tbody = document.getElementById('reseller-keys-table');\n" +
  "                if (!Array.isArray(keys) || keys.length === 0) {\n" +
  "                    tbody.innerHTML = '<tr><td colspan=\"5\" class=\"px-4 py-4 text-center text-gray-500\">No keys yet</td></tr>';\n" +
  "                    return;\n" +
  "                }\n" +
  "                tbody.innerHTML = keys.map(k => '<tr class=\"border-b border-dark-700\">' +\n" +
  "                    '<td class=\"px-4 py-3 text-gray-300\">' + (k.reseller_name || ('reseller_id ' + k.reseller_id)) + '</td>' +\n" +
  "                    '<td class=\"px-4 py-3 text-gray-400 font-mono text-xs\">' + k.api_key_masked + '</td>' +\n" +
  "                    '<td class=\"px-4 py-3\">' + (k.enabled ? '<span class=\"text-green-400\">enabled</span>' : '<span class=\"text-gray-500\">revoked</span>') + '</td>' +\n" +
  "                    '<td class=\"px-4 py-3 text-gray-500 text-xs\">' + (k.created_at ? new Date(k.created_at).toISOString().slice(0,10) : '') + '</td>' +\n" +
  "                    '<td class=\"px-4 py-3\">' + (k.enabled ? '<button onclick=\"revokeResellerKey(' + k.id + ')\" class=\"text-xs text-red-400 hover:text-red-300\">Revoke</button>' : '') + '</td>' +\n" +
  "                    '</tr>').join('');\n" +
  "            } catch (e) {\n" +
  "                console.error('loadResellerKeys', e);\n" +
  "                showToast('Failed to load reseller keys', 'error');\n" +
  "            }\n" +
  "        }\n" +
  "\n" +
  "        async function generateResellerKey() {\n" +
  "            const resellerId = document.getElementById('rkey-reseller').value;\n" +
  "            if (!resellerId) { showToast('Pick a reseller first', 'error'); return; }\n" +
  "            const ok = await showConfirm('Generate API Key', 'A new API key will be created for this reseller. The plaintext key is shown once and cannot be retrieved later. Continue?');\n" +
  "            if (!ok) return;\n" +
  "            try {\n" +
  "                const resp = await fetch(" + BT + DS + "API_BASE}/reseller-keys" + BT + ", {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  "                    body: JSON.stringify({ reseller_id: parseInt(resellerId, 10) }),\n" +
  "                });\n" +
  "                const data = await resp.json();\n" +
  "                if (!resp.ok) { showToast('Generate failed: ' + (data.error || resp.status), 'error'); return; }\n" +
  "                const magicLink = 'https://reseller-portal.zalmen-531.workers.dev/login?key=' + encodeURIComponent(data.api_key);\n" +
  "                const html = '<div class=\"bg-dark-700 rounded-lg p-4 mb-3\"><div class=\"text-xs text-gray-500 uppercase mb-1\">API Key (shown once)</div><div class=\"text-accent font-mono break-all text-sm\">' + data.api_key + '</div></div>' +\n" +
  "                    '<div class=\"bg-dark-700 rounded-lg p-4\"><div class=\"text-xs text-gray-500 uppercase mb-1\">Magic Link (deliver to reseller)</div><div class=\"text-blue-300 font-mono break-all text-xs\">' + magicLink + '</div></div>' +\n" +
  "                    '<div class=\"text-xs text-gray-500 mt-3 italic\">' + (data.note || '') + '</div>';\n" +
  "                showResultModal('Reseller key generated', html, [\n" +
  "                    { label: 'Copy key', action: () => navigator.clipboard.writeText(data.api_key).then(() => showToast('Key copied','info')) },\n" +
  "                    { label: 'Copy link', action: () => navigator.clipboard.writeText(magicLink).then(() => showToast('Link copied','info')) },\n" +
  "                ]);\n" +
  "                loadResellerKeys();\n" +
  "            } catch (e) {\n" +
  "                showToast('Generate failed: ' + e.message, 'error');\n" +
  "            }\n" +
  "        }\n" +
  "\n" +
  "        async function revokeResellerKey(id) {\n" +
  "            const ok = await showConfirm('Revoke Key', 'Revoking will immediately invalidate this key for the reseller. Continue?');\n" +
  "            if (!ok) return;\n" +
  "            try {\n" +
  "                const resp = await fetch(" + BT + DS + "API_BASE}/reseller-keys/revoke" + BT + ", {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  "                    body: JSON.stringify({ id }),\n" +
  "                });\n" +
  "                if (!resp.ok) { showToast('Revoke failed', 'error'); return; }\n" +
  "                showToast('Key revoked', 'success');\n" +
  "                loadResellerKeys();\n" +
  "            } catch (e) {\n" +
  "                showToast('Revoke failed: ' + e.message, 'error');\n" +
  "            }\n" +
  "        }\n" +
  "\n" +
  "        function showResultModal(title, bodyHtml, buttons) {\n" +
  "            const root = document.getElementById('toast') ? document.body : document.body;\n" +
  "            const wrap = document.createElement('div');\n" +
  "            wrap.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';\n" +
  "            const btnHtml = (buttons || []).map((b, i) => '<button data-i=\"' + i + '\" class=\"rkey-btn px-3 py-2 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition\">' + b.label + '</button>').join(' ');\n" +
  "            wrap.innerHTML = '<div class=\"bg-dark-800 border border-dark-600 rounded-xl max-w-2xl w-full p-6\"><h3 class=\"text-lg font-semibold text-white mb-3\">' + title + '</h3>' + bodyHtml + '<div class=\"flex justify-end gap-2 mt-4\">' + btnHtml + ' <button id=\"rkey-close\" class=\"px-3 py-2 text-sm bg-dark-600 hover:bg-dark-500 text-gray-200 rounded-lg transition\">Close</button></div></div>';\n" +
  "            root.appendChild(wrap);\n" +
  "            wrap.querySelectorAll('.rkey-btn').forEach(b => b.addEventListener('click', () => { (buttons[b.dataset.i].action || (()=>{}))(); }));\n" +
  "            wrap.querySelector('#rkey-close').addEventListener('click', () => wrap.remove());\n" +
  "        }\n" +
  "\n" +
  JS_ANCHOR;

if (!content.includes(JS_ANCHOR)) {
  console.error('PATCH FAILED: loadMappings anchor not found.');
  process.exit(1);
}
if (content.includes('async function loadResellerKeys()')) {
  console.log('loadResellerKeys already present, skipping JS insert.');
} else {
  content = content.replace(JS_ANCHOR, JS_HANDLERS);
  console.log('Inserted reseller-keys JS handlers.');
}

// ---------- 3. Hook into billing-tab loader ------------------------------

const TAB_OLD = "if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); loadPlanRates(); loadBillingLedgerSummary(); loadLedgerMonths(); }";
const TAB_NEW = "if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadBillAuditHistory(); loadPlanRates(); loadBillingLedgerSummary(); loadLedgerMonths(); loadResellerKeys(); }";

if (!content.includes(TAB_OLD)) {
  console.error('PATCH FAILED: billing tab loader anchor not found.');
  process.exit(1);
}
if (content.includes('loadResellerKeys();')) {
  console.log('Billing tab already calls loadResellerKeys, skipping.');
} else {
  content = content.replace(TAB_OLD, TAB_NEW);
  console.log('Hooked loadResellerKeys into billing tab loader.');
}

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
