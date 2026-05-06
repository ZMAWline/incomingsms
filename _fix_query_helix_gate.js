// _fix_query_helix_gate.js
// Move the HELIX_ENABLED guard from the top of queryHelix() into only the Helix branch,
// so ATOMIC and Wing IoT queries work when Helix is disabled.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Remove the top-level HELIX_ENABLED guard from queryHelix()
const OLD1 = "        async function queryHelix() {\n            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }\n            const vendor = document.getElementById('carrier-query-vendor').value;";
const NEW1 = "        async function queryHelix() {\n            const vendor = document.getElementById('carrier-query-vendor').value;";

if (!content.includes(OLD1)) {
  console.error('PATCH FAILED: old string #1 (top-level HELIX_ENABLED guard) not found.');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);

// 2. Add HELIX_ENABLED guard to the Helix-only code path (after the ATOMIC return)
const OLD2 = "            // Helix query (original)\n            try {";
const NEW2 = "            // Helix query (original)\n            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }\n            try {";

if (!content.includes(OLD2)) {
  console.error('PATCH FAILED: old string #2 (Helix query section) not found.');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
