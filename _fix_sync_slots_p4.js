// _fix_sync_slots_p4.js — fix unescaped backticks in syncGatewaySlots function
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// The broken function has raw backticks on these two lines:
//   const res = await fetch(`${API_BASE}/...`, {
//   showToast(`Synced ${data.synced} ...`, 'success');
// Inside getHTML()'s outer template literal, these must be \` and \${

const OLD =
  "                const res = await fetch(`${API_BASE}/sync-gateway-slots`, {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  "                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),\n" +
  "                });\n" +
  "                const data = await res.json();\n" +
  "                if (!res.ok || !data.ok) {\n" +
  "                    showToast(data.error || 'Sync failed', 'error');\n" +
  "                    return;\n" +
  "                }\n" +
  "                showToast(`Synced ${data.synced} slots (${data.not_found} SIMs not in DB)`, 'success');";

const NEW =
  "                const res = await fetch(\\`\\${API_BASE}/sync-gateway-slots\\`, {\n" +
  "                    method: 'POST',\n" +
  "                    headers: { 'Content-Type': 'application/json' },\n" +
  "                    body: JSON.stringify({ gateway_id: parseInt(gatewayId) }),\n" +
  "                });\n" +
  "                const data = await res.json();\n" +
  "                if (!res.ok || !data.ok) {\n" +
  "                    showToast(data.error || 'Sync failed', 'error');\n" +
  "                    return;\n" +
  "                }\n" +
  "                showToast(\\`Synced \\${data.synced} slots (\\${data.not_found} SIMs not in DB)\\`, 'success');";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: broken template literal lines not found');
  // Show snippet around the function to debug
  const idx = content.indexOf('async function syncGatewaySlots');
  if (idx !== -1) console.error('Function found at index:', idx, '\nSnippet:\n', content.slice(idx, idx + 600));
  process.exit(1);
}

content = content.replace(OLD, NEW);
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fix applied: backticks escaped in syncGatewaySlots');
