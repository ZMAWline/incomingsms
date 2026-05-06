// _fix_guide_updates.js — reflect session changes in the Guide page
'use strict';
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

function apply(label, OLD, NEW) {
  if (!content.includes(OLD)) {
    console.error('PATCH FAILED (' + label + '): anchor not found.');
    process.exit(1);
  }
  content = content.replace(OLD, NEW);
  console.log('✓ ' + label);
}

// ── 1. TOC: add "API Tester" link after "Workers Page" ────────────────────────
apply('TOC: API Tester link',
  '<a href="#" onclick="event.preventDefault();document.getElementById(\'guide-workers\').scrollIntoView({behavior:\'smooth\'})" class="text-accent hover:underline">Workers Page</a>',
  '<a href="#" onclick="event.preventDefault();document.getElementById(\'guide-workers\').scrollIntoView({behavior:\'smooth\'})" class="text-accent hover:underline">Workers Page</a>\n                        <a href="#" onclick="event.preventDefault();document.getElementById(\'guide-api-tester\').scrollIntoView({behavior:\'smooth\'})" class="text-accent hover:underline">API Tester</a>'
);

// ── 2. SIMs Page > Per-Row Actions: add Delete ────────────────────────────────
apply('SIMs per-row: add Delete',
  '<li><span class="text-white">Unassign Reseller</span> &mdash; Remove reseller assignment</li>',
  '<li><span class="text-white">Unassign Reseller</span> &mdash; Remove reseller assignment</li>\n                                <li><span class="text-white">Delete</span> &mdash; Permanently delete the SIM and all its history (sim_numbers, inbound_sms, reseller_sims, sim_status_history). Cannot be undone. Child rows are cleaned up first; <code class="bg-dark-900 px-1 rounded text-accent">system_errors.sim_id</code> is nullified so error history is preserved.</li>'
);

// ── 3. SIMs Page > Bulk Actions: add shift-click tip + ATOMIC Query note ──────
apply('SIMs bulk: shift-click + ATOMIC split',
  '<h4 class="text-white font-medium mb-1">Bulk Actions (select via checkboxes)</h4>\n                            <p>Select multiple SIMs using checkboxes, then use the bulk action buttons. Supported: OTA Refresh, Rotate MDN, Fix SIM, Cancel, Resume, Unassign Reseller, Send SMS.</p>',
  '<h4 class="text-white font-medium mb-1">Bulk Actions (select via checkboxes)</h4>\n                            <p>Select multiple SIMs using checkboxes, then use the bulk action buttons. Supported: OTA Refresh, Rotate MDN, Fix SIM, Cancel, Resume, Unassign Reseller, Send SMS, Query.</p>\n                            <p class="mt-2"><span class="text-white font-medium">Shift-click</span>: click one checkbox, then hold <kbd class="bg-dark-900 px-1.5 py-0.5 rounded text-xs border border-dark-500">Shift</kbd> and click another &mdash; every row between them is set to the state of the second click. Works in the current rendered order (after sort/filter).</p>\n                            <p class="mt-2"><span class="text-white font-medium">Query (bulk action)</span>: auto-routes per SIM based on <code class="bg-dark-900 px-1 rounded text-accent">sims.vendor</code>. Helix SIMs query the Helix subscriber details API (by Sub ID); ATOMIC SIMs query ATOMIC <code class="bg-dark-900 px-1 rounded text-accent">subsriberInquiry</code> (by ICCID or MDN). The modal vendor select distinguishes the two &mdash; Helix and ATOMIC are separate options.</p>'
);

// ── 4. Gateway Page: add Export Table + Import IMEIs + Sync Slots actions ─────
apply('Gateway: Export Table action',
  '<h4 class="text-white font-medium mb-1">Per-port actions</h4>\n                            <ul class="list-disc list-inside space-y-1 ml-2">\n                                <li><span class="text-white">Lock</span> &mdash; Locks the port to prevent SIM switching</li>\n                                <li><span class="text-white">Unlock</span> &mdash; Unlocks the port for SIM switching</li>\n                                <li><span class="text-white">Reboot</span> &mdash; Reboots the port\'s cellular module</li>\n                                <li><span class="text-white">Reset</span> &mdash; Factory resets the port configuration</li>\n                                <li><span class="text-white">Switch SIM</span> &mdash; Triggers SIM rotation on multi-slot ports</li>\n                            </ul>',
  '<h4 class="text-white font-medium mb-1">Per-port actions</h4>\n                            <ul class="list-disc list-inside space-y-1 ml-2">\n                                <li><span class="text-white">Lock</span> &mdash; Locks the port to prevent SIM switching</li>\n                                <li><span class="text-white">Unlock</span> &mdash; Unlocks the port for SIM switching</li>\n                                <li><span class="text-white">Reboot</span> &mdash; Reboots the port\'s cellular module</li>\n                                <li><span class="text-white">Reset</span> &mdash; Factory resets the port configuration</li>\n                                <li><span class="text-white">Switch SIM</span> &mdash; Triggers SIM rotation on multi-slot ports</li>\n                            </ul>\n                        </div>\n                        <div class="mt-2">\n                            <h4 class="text-white font-medium mb-1">Gateway-wide actions</h4>\n                            <ul class="list-disc list-inside space-y-1 ml-2">\n                                <li><span class="text-white">Switch SIM</span> &mdash; Bulk-switches SIMs across all ports on the selected gateway</li>\n                                <li><span class="text-white">IMEI</span> &mdash; Opens the IMEI modal (per-slot IMEI set / read)</li>\n                                <li><span class="text-white">Reboot / Lock / Unlock</span> &mdash; Gateway-wide versions of the per-port commands</li>\n                                <li><span class="text-white">Import IMEIs</span> &mdash; Reads every slot\'s IMEI from the gateway via <code class="bg-dark-900 px-1 rounded text-accent">/port-info?all_slots=1</code> and inserts new rows into <code class="bg-dark-900 px-1 rounded text-accent">imei_pool</code> (DB is authoritative for existing slots; any mismatch is reported as a discrepancy). Also links <code class="bg-dark-900 px-1 rounded text-accent">imei_pool.sim_id</code> for active slots and backfills <code class="bg-dark-900 px-1 rounded text-accent">sims.imei</code> / <code class="bg-dark-900 px-1 rounded text-accent">sims.current_imei_pool_id</code>.</li>\n                                <li><span class="text-white">Sync Slots</span> &mdash; Reconciles <code class="bg-dark-900 px-1 rounded text-accent">sims.gateway_id</code> and <code class="bg-dark-900 px-1 rounded text-accent">sims.port</code> against what the gateway reports (useful after a physical SIM swap).</li>\n                                <li><span class="text-white">Export Table</span> &mdash; Scans the gateway and downloads a CSV of every slot with <span class="text-white">Port, Slot, Slot Letter, ICCID, IMEI, Number, Operator, Signal, SIM Status, State</span>. Use for inventory snapshots or diffing against the DB. Filename: <code class="bg-dark-900 px-1 rounded text-accent">gateway_&lt;label&gt;_&lt;timestamp&gt;.csv</code>.</li>\n                            </ul>'
);

// ── 5. MDN Rotation: manual note covers all vendors including ATOMIC ──────────
apply('MDN rotation: manual covers ATOMIC',
  '<h4 class="text-white font-medium mb-1">Manual rotation</h4>\n                            <p>Click <span class="text-white">Rotate MDN</span> on a SIM row, or use the bulk action. The same flow runs but only for the selected SIM(s).</p>',
  '<h4 class="text-white font-medium mb-1">Manual rotation</h4>\n                            <p>Click <span class="text-white">Rotate MDN</span> on a SIM row, or use the bulk action. The same flow runs but only for the selected SIM(s). Manual rotation is vendor-aware: <span class="text-white">Helix</span> SIMs use the Helix MDN-change flow above; <span class="text-white">ATOMIC</span> SIMs call <code class="bg-dark-900 px-1 rounded text-accent">swapMSISDN</code> with the SIM\'s current MDN + a ZIP (defaults to <code class="bg-dark-900 px-1 rounded text-accent">HX_ZIP</code>), then read the new MSISDN back (from the swap response or a follow-up <code class="bg-dark-900 px-1 rounded text-accent">subsriberInquiry</code>). DB writes and <code class="bg-dark-900 px-1 rounded text-accent">number.online</code> webhook are identical regardless of vendor. <span class="text-amber-400">Note:</span> the nightly cron queue currently only rotates Helix SIMs &mdash; ATOMIC SIMs rotate only via the manual action until the queue consumer is ported.</p>'
);

// ── 6. Add new guide-api-tester section after guide-workers ───────────────────
const workersEndAnchor = '                <!-- Gateway Page -->\n                <div id="guide-gateway"';
apply('API Tester: new guide section',
  workersEndAnchor,
  '                <!-- API Tester -->\n                <div id="guide-api-tester" class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">\n                    <h3 class="text-lg font-semibold text-white mb-3">API Tester</h3>\n                    <div class="text-sm text-gray-300 space-y-3">\n                        <p>Ad-hoc HTTP tester that routes requests through the dashboard worker\'s relay. Useful for debugging carrier API calls, webhook payloads, or any endpoint that can only be reached via the relay (Cloudflare Workers cannot reach CF-proxied origins directly &mdash; see <code class="bg-dark-900 px-1 rounded text-accent">agent/constraints.md &sect;11</code>).</p>\n                        <div class="mt-2">\n                            <h4 class="text-white font-medium mb-1">Presets</h4>\n                            <p>One-click templates that fill method, URL, and default headers. Current presets: <span class="text-white">ATOMIC</span>, <span class="text-white">Wing IoT</span>, <span class="text-white">Teltik</span>, <span class="text-white">Helix</span>, <span class="text-white">Custom</span> (clears fields). Select a preset, then edit the body as needed.</p>\n                        </div>\n                        <div class="mt-2">\n                            <h4 class="text-white font-medium mb-1">Flow</h4>\n                            <ol class="list-decimal list-inside space-y-1 ml-2">\n                                <li>Browser <code class="bg-dark-900 px-1 rounded text-accent">POST /api/relay-test</code> with <code class="bg-dark-900 px-1 rounded text-accent">{method, url, headers, body}</code></li>\n                                <li>Dashboard worker calls <code class="bg-dark-900 px-1 rounded text-accent">relayFetch(env, url, init)</code>, which rewrites to <code class="bg-dark-900 px-1 rounded text-accent">relay.zmawsolutions.com/&lt;url&gt;</code> with the <code class="bg-dark-900 px-1 rounded text-accent">x-relay-key</code> header</li>\n                                <li>Response status / headers / body are returned to the tester UI (always HTTP 200 from the worker &mdash; even for 4xx/5xx from the remote &mdash; so the structured result is always visible)</li>\n                            </ol>\n                        </div>\n                        <div class="mt-2">\n                            <h4 class="text-white font-medium mb-1">Scope</h4>\n                            <p>No restriction to carrier URLs &mdash; any reachable URL can be tested. This is a superuser-grade tool; use it only for debugging.</p>\n                        </div>\n                    </div>\n                </div>\n\n                ' + workersEndAnchor.trim()
);

// ── Write back with CRLF ──────────────────────────────────────────────────────
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
