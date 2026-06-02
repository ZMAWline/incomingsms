// _fix_bad_rentals_tab.js — INC-3 Phase 1: add Bad Rentals tab to dashboard
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable search/replace
content = content.replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// PATCH 1: Add "Bad Rentals" nav item after the errors nav item in the sidebar.
// We insert after the closing </a> of the errors nav item.
// ---------------------------------------------------------------------------

const OLD_NAV = '                <a href="/rotation-reviews" onclick="event.preventDefault();switchTab(\'rotation-reviews\')" data-tab="rotation-reviews" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Rotation Reviews">';

const NEW_NAV =
  '                <a href="/bad-rentals" onclick="event.preventDefault();switchTab(\'bad-rentals\')" data-tab="bad-rentals" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Bad Rentals">\n' +
  '                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"></path></svg>\n' +
  '                    <span class="text-sm">Bad Rentals</span>\n' +
  '                    <span id="bad-rentals-badge" class="hidden ml-auto min-w-[16px] h-4 bg-amber-500 rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1">0</span>\n' +
  '                </a>\n' +
  '                <a href="/rotation-reviews" onclick="event.preventDefault();switchTab(\'rotation-reviews\')" data-tab="rotation-reviews" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="Rotation Reviews">';

if (!content.includes(OLD_NAV)) {
  console.error('PATCH 1 FAILED: rotation-reviews nav anchor not found.');
  process.exit(1);
}
content = content.replace(OLD_NAV, NEW_NAV);
console.log('Patch 1 (sidebar nav) applied.');

// ---------------------------------------------------------------------------
// PATCH 2: Add the Bad Rentals content panel before the Billing Tab comment.
// ---------------------------------------------------------------------------

const OLD_PANEL = '            <!-- Billing Tab -->\n            <div id="tab-invoicing" class="tab-content hidden">';

// Build the tab panel. Uses string concatenation for any embedded backtick/$ so
// the patch-dashboard escaping rules are satisfied.
const BT = '\\' + '`';
const DS = '\\' + '${';

const NEW_PANEL =
  '            <!-- Bad Rentals Tab (INC-3 Phase 1) -->\n' +
  '            <div id="tab-bad-rentals" class="tab-content hidden">\n' +
  '                <div class="flex items-center justify-between mb-6">\n' +
  '                    <div>\n' +
  '                        <h1 class="text-2xl font-bold text-dark-100">Bad Rental Reports</h1>\n' +
  '                        <p class="text-dark-400 text-sm mt-1">Open reports from resellers about non-working rentals. Operator-only view.</p>\n' +
  '                    </div>\n' +
  '                    <button onclick="loadBadRentals()" class="px-3 py-2 text-sm bg-dark-700 border border-dark-500 rounded-lg text-gray-300 hover:bg-dark-600 transition">Refresh</button>\n' +
  '                </div>\n' +
  '                <div id="bad-rentals-status" class="text-dark-400 text-sm mb-4"></div>\n' +
  '                <div id="bad-rentals-table-wrap" class="overflow-x-auto rounded-lg border border-dark-600">\n' +
  '                    <table class="w-full text-sm text-left">\n' +
  '                        <thead class="bg-dark-700 text-dark-300 text-xs uppercase">\n' +
  '                            <tr>\n' +
  '                                <th class="px-4 py-3 font-medium">Report ID</th>\n' +
  '                                <th class="px-4 py-3 font-medium">Reseller</th>\n' +
  '                                <th class="px-4 py-3 font-medium">MDN (E.164)</th>\n' +
  '                                <th class="px-4 py-3 font-medium">Reason</th>\n' +
  '                                <th class="px-4 py-3 font-medium">Status</th>\n' +
  '                                <th class="px-4 py-3 font-medium">SIM ID</th>\n' +
  '                                <th class="px-4 py-3 font-medium">Rental ID</th>\n' +
  '                                <th class="px-4 py-3 font-medium">Received</th>\n' +
  '                            </tr>\n' +
  '                        </thead>\n' +
  '                        <tbody id="bad-rentals-tbody" class="divide-y divide-dark-700 text-dark-200">\n' +
  '                            <tr><td colspan="8" class="px-4 py-8 text-center text-dark-400">Loading&hellip;</td></tr>\n' +
  '                        </tbody>\n' +
  '                    </table>\n' +
  '                </div>\n' +
  '                <p class="text-xs text-dark-500 mt-4">To triage: use existing rotate/port-reset/replace tools. Status updates go in rental_report_events (operator notes coming in Phase 2).</p>\n' +
  '            </div>\n' +
  '\n' +
  '\n' +
  '            <!-- Billing Tab -->\n' +
  '            <div id="tab-invoicing" class="tab-content hidden">';

if (!content.includes(OLD_PANEL)) {
  console.error('PATCH 2 FAILED: Billing Tab comment anchor not found.');
  process.exit(1);
}
content = content.replace(OLD_PANEL, NEW_PANEL);
console.log('Patch 2 (content panel) applied.');

// ---------------------------------------------------------------------------
// PATCH 3: Wire up switchTab to call loadBadRentals() on tab switch.
// Insert after the errors tab handler.
// ---------------------------------------------------------------------------

const OLD_SWITCH = "            if (tabName === 'errors') loadErrors();";
const NEW_SWITCH =
  "            if (tabName === 'errors') loadErrors();\n" +
  "            if (tabName === 'bad-rentals') loadBadRentals();";

if (!content.includes(OLD_SWITCH)) {
  console.error('PATCH 3 FAILED: switchTab errors line not found.');
  process.exit(1);
}
content = content.replace(OLD_SWITCH, NEW_SWITCH);
console.log('Patch 3 (switchTab) applied.');

// ---------------------------------------------------------------------------
// PATCH 4: Add loadBadRentals() function.
// Insert near loadErrors() — find that function and insert before it.
// ---------------------------------------------------------------------------

const LOAD_ERRORS_MARKER = '        async function loadErrors() {';
if (!content.includes(LOAD_ERRORS_MARKER)) {
  console.error('PATCH 4 FAILED: loadErrors function not found.');
  process.exit(1);
}

// We build the function body using concatenation to avoid any escaping issues.
const LOAD_BAD_RENTALS_FN =
  '        async function loadBadRentals() {\n' +
  '            const badge = document.getElementById(\'bad-rentals-badge\');\n' +
  '            const status = document.getElementById(\'bad-rentals-status\');\n' +
  '            const tbody = document.getElementById(\'bad-rentals-tbody\');\n' +
  '            if (!tbody) return;\n' +
  '            tbody.innerHTML = \'<tr><td colspan="8" class="px-4 py-8 text-center text-dark-400">Loading&hellip;</td></tr>\';\n' +
  '            if (status) status.textContent = \'\';\n' +
  '            try {\n' +
  '                const url = SUPABASE_URL + \'/rest/v1/rental_reports\' +\n' +
  '                    \'?select=id,reseller_id,e164,reason_code,reason_note,status,sim_id,rental_id,received_at,triaged_at,resellers(name)\' +\n' +
  '                    \'&status=in.(received,in_triage)&order=received_at.desc&limit=200\';\n' +
  '                const resp = await fetch(url, {\n' +
  '                    headers: {\n' +
  '                        apikey: SUPABASE_SERVICE_ROLE_KEY,\n' +
  '                        Authorization: \'Bearer \' + SUPABASE_SERVICE_ROLE_KEY,\n' +
  '                        Accept: \'application/json\',\n' +
  '                    }\n' +
  '                });\n' +
  '                if (!resp.ok) throw new Error(\'Supabase \' + resp.status);\n' +
  '                const rows = await resp.json();\n' +
  '                if (!Array.isArray(rows) || rows.length === 0) {\n' +
  '                    tbody.innerHTML = \'<tr><td colspan="8" class="px-4 py-8 text-center text-dark-400">No open bad-rental reports.</td></tr>\';\n' +
  '                    if (badge) { badge.textContent = \'0\'; badge.classList.add(\'hidden\'); }\n' +
  '                    if (status) status.textContent = \'\';\n' +
  '                    return;\n' +
  '                }\n' +
  '                if (badge) { badge.textContent = rows.length; badge.classList.remove(\'hidden\'); }\n' +
  '                if (status) status.textContent = rows.length + \' open report\' + (rows.length === 1 ? \'\' : \'s\') + \' (received or in triage)\';\n' +
  '                const fmtDt = s => s ? new Date(s).toLocaleString(\'en-US\', {month:\'short\',day:\'2-digit\',hour:\'2-digit\',minute:\'2-digit\',hour12:false}) : \'—\';\n' +
  '                tbody.innerHTML = rows.map(r => {\n' +
  '                    const resellerName = (r.resellers && r.resellers.name) ? r.resellers.name : (r.reseller_id || \'—\');\n' +
  '                    const statusBadge = r.status === \'in_triage\'\n' +
  '                        ? \'<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-blue-500/20 text-blue-300">In triage</span>\'\n' +
  '                        : \'<span class="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-amber-500/20 text-amber-300">Received</span>\';\n' +
  '                    const simLink = r.sim_id\n' +
  '                        ? \'<a onclick="event.stopPropagation();switchTab(&quot;sims&quot;)" class="text-accent hover:text-green-400 cursor-pointer">\' + r.sim_id + \'</a>\'\n' +
  '                        : \'—\';\n' +
  '                    return \'<tr class="hover:bg-dark-700/40">\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-300 font-mono text-xs">\' + r.id + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-200">\' + resellerName + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 font-mono text-cyan-300">\' + (r.e164 || \'—\') + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-300 text-xs" title="\' + (r.reason_note || \'\') + \'">\' + (r.reason_code || \'—\') + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3">\' + statusBadge + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-300 font-mono text-xs">\' + simLink + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-300 font-mono text-xs">\' + (r.rental_id != null ? r.rental_id : \'—\') + \'</td>\' +\n' +
  '                        \'<td class="px-4 py-3 text-dark-400 text-xs">\' + fmtDt(r.received_at) + \'</td>\' +\n' +
  '                    \'</tr>\';\n' +
  '                }).join(\'\');\n' +
  '            } catch(e) {\n' +
  '                tbody.innerHTML = \'<tr><td colspan="8" class="px-4 py-4 text-center text-red-400">Error loading reports: \' + e.message + \'</td></tr>\';\n' +
  '                console.error(\'[loadBadRentals]\', e);\n' +
  '            }\n' +
  '        }\n' +
  '\n' +
  '        async function loadErrors() {';

content = content.replace(LOAD_ERRORS_MARKER, LOAD_BAD_RENTALS_FN);
console.log('Patch 4 (loadBadRentals function) applied.');

// ---------------------------------------------------------------------------
// Write back with CRLF
// ---------------------------------------------------------------------------
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('All patches applied successfully.');
