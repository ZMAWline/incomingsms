const fs = require('fs');
const raw = fs.readFileSync('src/dashboard/index.js', 'utf8');
const src = raw.replace(/\r\n/g, '\n');
let out = src;

// ── 1. Backend: add force to body parse and URL ──────────────────────────────
out = out.replace(
  'const body = await request.json();\n    const limit = body.limit || null;',
  'const body = await request.json();\n    const limit = body.limit || null;\n    const force = body.force || false;'
);

out = out.replace(
  "const workerUrl = limit\n      ? `https://worker/run?secret=${encodeURIComponent(config.secret)}&limit=${limit}`\n      : `https://worker/run?secret=${encodeURIComponent(config.secret)}`;",
  "let workerUrl = limit\n      ? 'https://worker/run?secret=' + encodeURIComponent(config.secret) + '&limit=' + limit\n      : 'https://worker/run?secret=' + encodeURIComponent(config.secret);\n    if (force) workerUrl += '&force=true';"
);

// ── 2. Frontend: replace reseller-sync button onclick ────────────────────────
out = out.replace(
  "onclick=\"runWorker('reseller-sync')\"",
  'onclick="showResellerSyncModal()"'
);

// ── 3. Add reseller-sync modal HTML (just before closing </div> of workers section)
//    Find a unique anchor: the workers section help text
const MODAL_HTML = `
                    <!-- Reseller Sync Modal -->
                    <div id="reseller-sync-modal" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center z-50">
                        <div class="bg-dark-800 border border-dark-600 rounded-xl p-6 w-full max-w-sm shadow-2xl">
                            <h3 class="text-lg font-semibold text-white mb-4">Reseller Sync</h3>
                            <p class="text-sm text-gray-400 mb-4">Send <code class="bg-dark-900 px-1 rounded text-accent">number.online</code> webhooks to resellers for all active SIMs with verified numbers.</p>
                            <label class="flex items-center gap-3 cursor-pointer mb-6">
                                <input type="checkbox" id="reseller-sync-force" class="w-4 h-4 rounded accent-amber-500">
                                <div>
                                    <span class="text-sm font-medium text-white">Skip dedup (force re-send)</span>
                                    <p class="text-xs text-gray-500">Re-send even if already notified today</p>
                                </div>
                            </label>
                            <div class="flex gap-3">
                                <button onclick="hideResellerSyncModal()" class="flex-1 px-4 py-2 bg-dark-600 hover:bg-dark-500 text-white rounded-lg text-sm transition">Cancel</button>
                                <button onclick="doResellerSync()" class="flex-1 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm font-medium transition">Run Sync</button>
                            </div>
                        </div>
                    </div>`;

// Insert before the first occurrence of <!-- Reseller Sync Modal --> marker (if exists) or after workers content
// Find the closing tag of the workers card to insert the modal before it
const ANCHOR = '<div id="reseller-sync-modal"';
if (!out.includes(ANCHOR)) {
  // Insert modal HTML after the workers section description text
  const insertAfter = "Send webhooks to resellers</p>\n                            </div>\n                        </button>";
  if (!out.includes(insertAfter)) {
    console.log('[FAIL] modal insert anchor not found');
    process.exit(1);
  }
  out = out.replace(insertAfter, insertAfter + MODAL_HTML);
}

// ── 4. Add JS functions for the modal ────────────────────────────────────────
const JS_FUNCTIONS = `
        function showResellerSyncModal() {
            document.getElementById('reseller-sync-force').checked = false;
            document.getElementById('reseller-sync-modal').classList.remove('hidden');
        }

        function hideResellerSyncModal() {
            document.getElementById('reseller-sync-modal').classList.add('hidden');
        }

        async function doResellerSync() {
            const force = document.getElementById('reseller-sync-force').checked;
            hideResellerSyncModal();
            showToast('Running reseller-sync' + (force ? ' (force)' : '') + '...', 'info');
            try {
                const response = await fetch(API_BASE + '/run/reseller-sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force })
                });
                const result = await response.json();
                if (response.ok) {
                    const msg = 'Reseller sync done: ' + (result.synced || 0) + ' sent, ' + (result.skipped || 0) + ' skipped, ' + (result.errors || 0) + ' errors';
                    showToast(msg, 'success');
                    loadData();
                } else {
                    showToast('Error: ' + (result.error || 'unknown'), 'error');
                }
            } catch (e) {
                showToast('Error running reseller-sync', 'error');
                console.error(e);
            }
        }

`;

// Insert before the existing runWorker function
const BEFORE = 'async function runWorker(workerName) {';
if (!out.includes(BEFORE)) { console.log('[FAIL] runWorker anchor not found'); process.exit(1); }
out = out.replace(BEFORE, JS_FUNCTIONS + '        ' + BEFORE);

// ── Write back with CRLF ─────────────────────────────────────────────────────
fs.writeFileSync('src/dashboard/index.js', out.replace(/\n/g, '\r\n'));
console.log('Patch applied.');

// ── Verify ───────────────────────────────────────────────────────────────────
if (out.includes('const force = body.force || false;')) console.log('[OK] backend force param');
else console.log('[FAIL] backend force param');

if (out.includes("let workerUrl = limit")) console.log('[OK] backend URL force append');
else console.log('[FAIL] backend URL force append');

if (out.includes('showResellerSyncModal()')) console.log('[OK] button onclick replaced');
else console.log('[FAIL] button onclick');

if (out.includes('reseller-sync-modal')) console.log('[OK] modal HTML inserted');
else console.log('[FAIL] modal HTML');

if (out.includes('doResellerSync')) console.log('[OK] JS functions added');
else console.log('[FAIL] JS functions');
