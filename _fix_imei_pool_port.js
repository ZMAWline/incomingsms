const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let src = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

// --- 1. Normalize port in the set-imei intercept ---
const OLD1 = `        const { gateway_id, port, imei: newImei } = requestBodyParsed;
        if (gateway_id && port && newImei) {
          // 1. Retire old IMEI on this gateway/port (if any)
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.\${gateway_id}&port=eq.\${encodeURIComponent(port)}&status=eq.in_use&imei=neq.\${newImei}\``;

const NEW1 = `        const { gateway_id, port, imei: newImei } = requestBodyParsed;
        const normPort = normalizeImeiPoolPort(port);
        if (gateway_id && port && newImei) {
          // 1. Retire old IMEI on this gateway/port (if any)
          await fetch(\`\${env.SUPABASE_URL}/rest/v1/imei_pool?gateway_id=eq.\${gateway_id}&port=eq.\${encodeURIComponent(normPort)}&status=eq.in_use&imei=neq.\${newImei}\``;

if (!src.includes(OLD1)) { console.error('PATCH 1 not found'); process.exit(1); }
src = src.replace(OLD1, NEW1);
console.log('Patch 1 applied: normalize port for retire query');

// --- 2. Use normPort in the upsert ---
const OLD2 = `              port: port,\n              notes:`;
const NEW2 = `              port: normPort,\n              notes:`;

if (!src.includes(OLD2)) { console.error('PATCH 2 not found'); process.exit(1); }
src = src.replace(OLD2, NEW2);
console.log('Patch 2 applied: use normPort in upsert');

// --- 3. Add helper function before the intercept handler (near end of worker module) ---
const HELPER_FN = `
function normalizeImeiPoolPort(port) {
  if (!port) return port;
  const dotMatch = port.match(/^(\\d+)\\.(\\d+)$/);
  if (dotMatch) return dotMatch[1] + '.' + String(parseInt(dotMatch[2])).padStart(2, '0');
  const letterToSlot = { A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8 };
  const letterMatch = port.match(/^(\\d+)([A-Ha-h])$/);
  if (letterMatch) return letterMatch[1] + '.' + String(letterToSlot[letterMatch[2].toUpperCase()] || 1).padStart(2, '0');
  return port;
}
`;

// Insert before the export default line
const EXPORT_MARKER = 'export default {';
if (!src.includes(EXPORT_MARKER)) { console.error('Export marker not found'); process.exit(1); }
src = src.replace(EXPORT_MARKER, HELPER_FN + EXPORT_MARKER);
console.log('Patch 3 applied: added normalizeImeiPoolPort helper');

// Write back with CRLF
fs.writeFileSync(filePath, src.replace(/\n/g, '\r\n'), 'utf8');
console.log('Done. File written.');
