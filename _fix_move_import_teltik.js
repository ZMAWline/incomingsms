// _fix_move_import_teltik.js
// Move the "Import Teltik" button from the bulk SIM action toolbar to the Workers page,
// styled as a card matching the other worker cards.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// 1. Remove the small button from the bulk SIM action toolbar.
const OLD_BULK_BTN = `                    <button onclick="bulkModifyImei()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded transition">Modify IMEI</button>
                    <button onclick="importTeltik()" class="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-700 text-white rounded transition">Import Teltik</button>
                    <button onclick="showBulkSetStatusModal()" class="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition">Set Status</button>`;

const NEW_BULK_BTN = `                    <button onclick="bulkModifyImei()" class="px-3 py-1.5 text-xs bg-violet-600 hover:bg-violet-700 text-white rounded transition">Modify IMEI</button>
                    <button onclick="showBulkSetStatusModal()" class="px-3 py-1.5 text-xs bg-gray-600 hover:bg-gray-500 text-white rounded transition">Set Status</button>`;

if (!content.includes(OLD_BULK_BTN)) {
  console.error('PATCH FAILED: bulk-action Import Teltik button block not found.');
  process.exit(1);
}
content = content.replace(OLD_BULK_BTN, NEW_BULK_BTN);

// 2. Add the new card on the Workers page, right after the Reseller Sync card,
//    before the "Reseller Sync Modal" comment.
const OLD_WORKERS_ANCHOR = `                        <button onclick="showResellerSyncModal()" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-teal-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Reseller Sync</p>
                                <p class="text-xs text-gray-400">Send webhooks to resellers</p>
                            </div>
                        </button>
                    <!-- Reseller Sync Modal -->`;

const NEW_WORKERS_ANCHOR = `                        <button onclick="showResellerSyncModal()" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-teal-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Reseller Sync</p>
                                <p class="text-xs text-gray-400">Send webhooks to resellers</p>
                            </div>
                        </button>
                        <button onclick="importTeltik()" class="flex items-center gap-4 p-4 rounded-lg bg-dark-700 hover:bg-dark-600 border border-dark-500 transition text-left">
                            <div class="w-12 h-12 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                                <svg class="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                            </div>
                            <div>
                                <p class="font-medium text-white">Import Teltik</p>
                                <p class="text-xs text-gray-400">Fetch all Teltik lines &amp; upsert</p>
                            </div>
                        </button>
                    <!-- Reseller Sync Modal -->`;

if (!content.includes(OLD_WORKERS_ANCHOR)) {
  console.error('PATCH FAILED: workers-page anchor not found.');
  process.exit(1);
}
content = content.replace(OLD_WORKERS_ANCHOR, NEW_WORKERS_ANCHOR);

// Sanity: ensure exactly one importTeltik() onclick remains in the markup.
const occurrences = (content.match(/onclick="importTeltik\(\)"/g) || []).length;
if (occurrences !== 1) {
  console.error('PATCH FAILED: expected exactly 1 importTeltik() onclick after patch, found ' + occurrences);
  process.exit(1);
}

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
