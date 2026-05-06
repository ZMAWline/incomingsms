// Patch C3+C4+C5: Helix UI quarantine + backend route guards + Fix-SIM hide.
// Backend: 3 route guards (Worker fetch handler, lines 89/93/182).
// Frontend: init block that disables/hides Helix UI when HELIX_ENABLED=false.
// Frontend: gate queryHelix/queryHelixBulk/queryHelixSubId/bulkQuery at function entry.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');
const before = content;

// ============================================================
// BACKEND: Gate 3 Helix routes when HELIX_ENABLED !== 'true'
// ============================================================

// Route 1: /api/helix-query
const OLD_R1 = "    if (url.pathname === '/api/helix-query') {\n" +
               "      return handleHelixQuery(request, env, corsHeaders);\n" +
               "    }";
const NEW_R1 = "    if (url.pathname === '/api/helix-query') {\n" +
               "      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});\n" +
               "      return handleHelixQuery(request, env, corsHeaders);\n" +
               "    }";
if (!content.includes(OLD_R1)) { console.error('PATCH FAILED: route 1 not found'); process.exit(1); }
content = content.replace(OLD_R1, NEW_R1);

// Route 2: /api/helix-query-bulk
const OLD_R2 = "    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {\n" +
               "      return handleHelixQueryBulk(request, env, corsHeaders);\n" +
               "    }";
const NEW_R2 = "    if (url.pathname === '/api/helix-query-bulk' && request.method === 'POST') {\n" +
               "      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});\n" +
               "      return handleHelixQueryBulk(request, env, corsHeaders);\n" +
               "    }";
if (!content.includes(OLD_R2)) { console.error('PATCH FAILED: route 2 not found'); process.exit(1); }
content = content.replace(OLD_R2, NEW_R2);

// Route 3: /api/trigger-blimei-sweep
const OLD_R3 = "    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {";
const NEW_R3 = "    if (url.pathname === '/api/trigger-blimei-sweep' && request.method === 'POST') {\n" +
               "      if (env.HELIX_ENABLED !== 'true') return new Response(JSON.stringify({error:'helix_disabled'}), {status:503, headers:{...corsHeaders,'Content-Type':'application/json'}});";
if (!content.includes(OLD_R3)) { console.error('PATCH FAILED: route 3 not found'); process.exit(1); }
content = content.replace(OLD_R3, NEW_R3);

// ============================================================
// FRONTEND: Gate queryHelix* functions at entry
// ============================================================

// Gate queryHelixSubId
const OLD_QS = "        function queryHelixSubId(subId) {";
const NEW_QS = "        function queryHelixSubId(subId) {\n" +
               "            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }";
if (!content.includes(OLD_QS)) { console.error('PATCH FAILED: queryHelixSubId not found'); process.exit(1); }
content = content.replace(OLD_QS, NEW_QS);

// Gate queryHelix
const OLD_QH = "        async function queryHelix() {";
const NEW_QH = "        async function queryHelix() {\n" +
               "            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }";
if (!content.includes(OLD_QH)) { console.error('PATCH FAILED: queryHelix not found'); process.exit(1); }
content = content.replace(OLD_QH, NEW_QH);

// Gate queryHelixBulk
const OLD_QB = "        async function queryHelixBulk(offset) {";
const NEW_QB = "        async function queryHelixBulk(offset) {\n" +
               "            if (!window.HELIX_ENABLED) { showToast('Helix is disabled', 'warning'); return; }";
if (!content.includes(OLD_QB)) { console.error('PATCH FAILED: queryHelixBulk not found'); process.exit(1); }
content = content.replace(OLD_QB, NEW_QB);

// ============================================================
// FRONTEND: Helix UI init block — runs after loadData/initTabFromUrl
// Removes/disables Helix UI elements when HELIX_ENABLED=false.
// ============================================================

const OLD_INIT = "        loadData();\n" +
                 "        setInterval(loadData, 3600000);\n" +
                 "        initTabFromUrl();\n" +
                 "    </script>";
const NEW_INIT = "        loadData();\n" +
                 "        setInterval(loadData, 3600000);\n" +
                 "        initTabFromUrl();\n" +
                 "\n" +
                 "        // Helix UI quarantine — hide/disable Helix-specific controls when HELIX_ENABLED=false\n" +
                 "        if (!window.HELIX_ENABLED) {\n" +
                 "            // Activate modal: remove Helix option\n" +
                 "            document.querySelectorAll('#activate-vendor option[value=\"helix\"]').forEach(o => o.remove());\n" +
                 "            // Carrier query modal: remove Helix options\n" +
                 "            document.querySelectorAll('#carrier-query-vendor option[value=\"helix\"]').forEach(o => o.remove());\n" +
                 "            // SIMs vendor filter: rename to indicate disabled\n" +
                 "            document.querySelectorAll('#filter-vendor option[value=\"helix\"]').forEach(o => { o.textContent = 'Helix (disabled)'; });\n" +
                 "            // Hide Bulk Query All SIMs button (Helix-only)\n" +
                 "            const bulkBtn = document.getElementById('helix-bulk-btn');\n" +
                 "            if (bulkBtn) bulkBtn.style.display = 'none';\n" +
                 "        }\n" +
                 "    </script>";

if (!content.includes(OLD_INIT)) { console.error('PATCH FAILED: init block not found'); process.exit(1); }
content = content.replace(OLD_INIT, NEW_INIT);

if (content === before) { console.error('ERROR: no replacements made'); process.exit(1); }
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch C3+C4+C5 applied:');
console.log('  Backend: 3 Helix routes return 503 when disabled');
console.log('  Frontend: queryHelix/Bulk/SubId gated with HELIX_ENABLED check');
console.log('  Frontend: Helix options removed from Activate + Query dropdowns at init');
console.log('  Frontend: Vendor filter Helix renamed to "Helix (disabled)"');
console.log('  Frontend: Bulk Query All SIMs button hidden');
