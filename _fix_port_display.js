// _fix_port_display.js
// Normalize port display: some SIMs in DB have old letter-format ("13C"),
// some have dot-notation ("13.03"). Show all consistently as dot-notation.
// Adds normalizePortDisplay() and applies it to all port display sites.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ─── FIX 1: Add normalizePortDisplay() function near the _sdOta wrappers ───
const OLD_OTA = "        function _sdOta() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, 'ota_refresh'); }";
const NEW_OTA =
  "        function normalizePortDisplay(p) {\n" +
  "            if (!p) return p;\n" +
  "            var d = p.match(/^(\\d+)\\.(\\d+)$/);\n" +
  "            if (d) return d[1] + '.' + String(parseInt(d[2])).padStart(2, '0');\n" +
  "            var l = p.match(/^(\\d+)([A-Ha-h])$/i);\n" +
  "            if (l) return l[1] + '.' + String(l[2].toUpperCase().charCodeAt(0) - 64).padStart(2, '0');\n" +
  "            return p;\n" +
  "        }\n" +
  "        function _sdOta() { if (_sdCurrentSim) simAction(_sdCurrentSim.id, 'ota_refresh'); }";

if (!content.includes(OLD_OTA)) { console.error('FIX 1 FAILED'); process.exit(1); }
content = content.replace(OLD_OTA, NEW_OTA);
console.log('Fix 1 (normalizePortDisplay fn) applied.');

// ─── FIX 2: gatewayDisplay in renderSims — dot notation ───────────────────
// Change \${sim.port || ''} to \${normalizePortDisplay(sim.port) || ''}
const OLD2 = '\\${sim.port || \'\'}';
const NEW2 = '\\${normalizePortDisplay(sim.port) || \'\'}';
if (!content.includes(OLD2)) { console.error('FIX 2 FAILED: port dot-notation display'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('Fix 2 (gatewayDisplay dot-notation port) applied.');

// ─── FIX 3: gatewayDisplay fallback (no gateway_code path) ────────────────
// Change (sim.port || '-') to (normalizePortDisplay(sim.port) || '-')
const OLD3 = '(sim.port || \'-\'));';
const NEW3 = '(normalizePortDisplay(sim.port) || \'-\'));';
if (!content.includes(OLD3)) { console.error('FIX 3 FAILED: port fallback display'); process.exit(1); }
content = content.replace(OLD3, NEW3);
console.log('Fix 3 (gatewayDisplay fallback port) applied.');

// ─── FIX 4: gatewayPort in renderSimDetailDetails ─────────────────────────
const OLD4 = "var gatewayPort = (sim.gateway_name || sim.gateway_code || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + sim.port : '');";
const NEW4 = "var gatewayPort = (sim.gateway_name || sim.gateway_code || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + normalizePortDisplay(sim.port) : '');";
if (!content.includes(OLD4)) { console.error('FIX 4 FAILED: gatewayPort variable'); process.exit(1); }
content = content.replace(OLD4, NEW4);
console.log('Fix 4 (detail modal gatewayPort) applied.');

// ─── FIX 5: port in renderSimDetailImei ───────────────────────────────────
const OLD5 = "(sim.gateway_name || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + sim.port : '') || '-'";
const NEW5 = "(sim.gateway_name || (sim.gateway_id ? 'GW#' + sim.gateway_id : '')) + (sim.port ? ' / ' + normalizePortDisplay(sim.port) : '') || '-'";
if (!content.includes(OLD5)) { console.error('FIX 5 FAILED: IMEI tab port'); process.exit(1); }
content = content.replace(OLD5, NEW5);
console.log('Fix 5 (IMEI tab port) applied.');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
