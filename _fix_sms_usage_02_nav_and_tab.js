// _fix_sms_usage_02_nav_and_tab.js
// Add sidebar nav link and empty SMS Usage tab-content div between Billing and Guide.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. Nav link insertion ----
const NAV_OLD =
  '                    <span class="text-sm">Billing</span>\n' +
  '                </a>\n' +
  '                <a href="/guide"';

const NAV_NEW =
  '                    <span class="text-sm">Billing</span>\n' +
  '                </a>\n' +
  '                <a href="/sms-usage" onclick="event.preventDefault();switchTab(\'sms-usage\')" data-tab="sms-usage" class="sidebar-btn w-full flex items-center gap-3 px-6 py-3 border-l-2 border-transparent text-dark-400 hover:text-dark-100 hover:bg-dark-800/50 transition-all duration-200" title="SMS Usage">\n' +
  '                    <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3v18h18M7 15l4-4 4 4 5-5"></path></svg>\n' +
  '                    <span class="text-sm">SMS Usage</span>\n' +
  '                </a>\n' +
  '                <a href="/guide"';

if (!content.includes(NAV_OLD)) {
  console.error('PATCH FAILED: nav anchor not found.');
  process.exit(1);
}
if (content.includes('data-tab="sms-usage"')) {
  console.error('PATCH FAILED: nav link already present.');
  process.exit(1);
}
content = content.replace(NAV_OLD, () => NAV_NEW);

// ---- 2. Tab content insertion ----
const TAB_OLD = '            <!-- Guide Tab -->';
const TAB_NEW =
  '            <!-- SMS Usage Tab -->\n' +
  '            <div id="tab-sms-usage" class="tab-content hidden">\n' +
  '                <div class="flex items-center justify-between mb-6">\n' +
  '                    <h2 class="text-xl font-bold text-white">SMS Usage Analytics</h2>\n' +
  '                    <div class="flex items-center gap-3">\n' +
  '                        <span id="sms-usage-cycle-label" class="text-xs text-gray-500"></span>\n' +
  '                        <button id="sms-usage-refresh-btn" onclick="loadSmsUsage(true)" class="px-3 py-1.5 text-sm bg-accent hover:bg-green-600 text-white rounded-lg transition">Refresh</button>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '\n' +
  '                <!-- Row 1: four stat cards -->\n' +
  '                <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <div class="text-xs text-gray-500 uppercase mb-1">Wing SIMs active</div>\n' +
  '                        <div class="text-2xl font-bold text-white" id="sms-usage-wing-count">&mdash;</div>\n' +
  '                        <div class="text-xs text-gray-400 mt-1" id="sms-usage-wing-pool-label">Pool 0 / 0</div>\n' +
  '                    </div>\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <div class="text-xs text-gray-500 uppercase mb-1">Wing avg / SIM (MTD)</div>\n' +
  '                        <div class="text-2xl font-bold text-white" id="sms-usage-wing-avg">&mdash;</div>\n' +
  '                        <div class="text-xs text-gray-400 mt-1" id="sms-usage-wing-minmax">min &mdash;, max &mdash;</div>\n' +
  '                    </div>\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <div class="text-xs text-gray-500 uppercase mb-1">Wing pool used</div>\n' +
  '                        <div class="text-2xl font-bold text-white" id="sms-usage-wing-pct">&mdash;</div>\n' +
  '                        <div class="text-xs text-gray-400 mt-1" id="sms-usage-wing-projection">Projected: &mdash;</div>\n' +
  '                    </div>\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <div class="text-xs text-gray-500 uppercase mb-1">Wing est. cost MTD</div>\n' +
  '                        <div class="text-2xl font-bold text-white" id="sms-usage-wing-cost">&mdash;</div>\n' +
  '                        <div class="text-xs text-gray-400 mt-1" id="sms-usage-wing-overage">Overage: &mdash;</div>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '\n' +
  '                <!-- Row 2: pool utilization bar -->\n' +
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">\n' +
  '                    <div class="flex items-center justify-between mb-2">\n' +
  '                        <h3 class="text-sm font-semibold text-white">Wing Pool Utilization</h3>\n' +
  '                        <span class="text-xs text-gray-400" id="sms-usage-wing-poolbar-label">0 / 0</span>\n' +
  '                    </div>\n' +
  '                    <div class="relative w-full h-4 bg-dark-900 rounded-full overflow-hidden">\n' +
  '                        <div id="sms-usage-wing-poolbar-fill" class="absolute left-0 top-0 h-full bg-green-500 transition-all" style="width:0%"></div>\n' +
  '                        <div id="sms-usage-wing-poolbar-soft" class="absolute top-0 h-full w-px bg-yellow-300" style="left:0%"></div>\n' +
  '                    </div>\n' +
  '                    <div class="flex items-center justify-between mt-2 text-xs text-gray-500">\n' +
  '                        <span>Soft target (25/SIM avg): <span id="sms-usage-wing-soft-target">&mdash;</span></span>\n' +
  '                        <span>Hard pool (750/SIM): <span id="sms-usage-wing-hard-target">&mdash;</span></span>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '\n' +
  '                <!-- Row 3: 30-day trend chart -->\n' +
  '                <div class="bg-dark-800 rounded-xl p-5 border border-dark-600 mb-6">\n' +
  '                    <h3 class="text-sm font-semibold text-white mb-3">Inbound SMS — last 30 days</h3>\n' +
  '                    <div style="position:relative;height:280px"><canvas id="sms-usage-trend-canvas"></canvas></div>\n' +
  '                </div>\n' +
  '\n' +
  '                <!-- Row 4: vendor totals + cycle info -->\n' +
  '                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <h3 class="text-sm font-semibold text-white mb-3">By vendor (MTD)</h3>\n' +
  '                        <div class="overflow-x-auto">\n' +
  '                            <table class="w-full">\n' +
  '                                <thead><tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">\n' +
  '                                    <th class="px-3 py-2 font-medium">Vendor</th>\n' +
  '                                    <th class="px-3 py-2 font-medium text-right">SIMs</th>\n' +
  '                                    <th class="px-3 py-2 font-medium text-right">SMS</th>\n' +
  '                                    <th class="px-3 py-2 font-medium text-right">Avg / SIM</th>\n' +
  '                                </tr></thead>\n' +
  '                                <tbody id="sms-usage-vendor-tbody" class="text-sm">\n' +
  '                                    <tr><td colspan="4" class="px-3 py-3 text-center text-gray-500">Loading…</td></tr>\n' +
  '                                </tbody>\n' +
  '                            </table>\n' +
  '                        </div>\n' +
  '                    </div>\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <h3 class="text-sm font-semibold text-white mb-3">Cycle info</h3>\n' +
  '                        <dl class="text-sm space-y-2">\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Cycle start</dt><dd class="text-white" id="sms-usage-info-start">&mdash;</dd></div>\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Today (EST)</dt><dd class="text-white" id="sms-usage-info-today">&mdash;</dd></div>\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Days elapsed</dt><dd class="text-white" id="sms-usage-info-elapsed">&mdash;</dd></div>\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Days remaining</dt><dd class="text-white" id="sms-usage-info-remaining">&mdash;</dd></div>\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Projected EOM Wing SMS</dt><dd class="text-white" id="sms-usage-info-projection">&mdash;</dd></div>\n' +
  '                            <div class="flex justify-between"><dt class="text-gray-500">Projected pool %</dt><dd class="text-white" id="sms-usage-info-proj-pct">&mdash;</dd></div>\n' +
  '                        </dl>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '\n' +
  '                <!-- Row 5: top / bottom Wing leaderboards -->\n' +
  '                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <h3 class="text-sm font-semibold text-white mb-3">Top 10 Wing SIMs this cycle</h3>\n' +
  '                        <div class="overflow-x-auto">\n' +
  '                            <table class="w-full">\n' +
  '                                <thead><tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">\n' +
  '                                    <th class="px-3 py-2 font-medium">SIM</th>\n' +
  '                                    <th class="px-3 py-2 font-medium">ICCID</th>\n' +
  '                                    <th class="px-3 py-2 font-medium text-right">SMS</th>\n' +
  '                                </tr></thead>\n' +
  '                                <tbody id="sms-usage-top-tbody" class="text-sm">\n' +
  '                                    <tr><td colspan="3" class="px-3 py-3 text-center text-gray-500">Loading…</td></tr>\n' +
  '                                </tbody>\n' +
  '                            </table>\n' +
  '                        </div>\n' +
  '                    </div>\n' +
  '                    <div class="bg-dark-800 rounded-xl p-5 border border-dark-600">\n' +
  '                        <h3 class="text-sm font-semibold text-white mb-3">Bottom 10 Wing SIMs this cycle</h3>\n' +
  '                        <div class="overflow-x-auto">\n' +
  '                            <table class="w-full">\n' +
  '                                <thead><tr class="text-left text-xs text-gray-500 uppercase border-b border-dark-600">\n' +
  '                                    <th class="px-3 py-2 font-medium">SIM</th>\n' +
  '                                    <th class="px-3 py-2 font-medium">ICCID</th>\n' +
  '                                    <th class="px-3 py-2 font-medium text-right">SMS</th>\n' +
  '                                </tr></thead>\n' +
  '                                <tbody id="sms-usage-bottom-tbody" class="text-sm">\n' +
  '                                    <tr><td colspan="3" class="px-3 py-3 text-center text-gray-500">Loading…</td></tr>\n' +
  '                                </tbody>\n' +
  '                            </table>\n' +
  '                        </div>\n' +
  '                    </div>\n' +
  '                </div>\n' +
  '            </div>\n' +
  '\n' +
  '            <!-- Guide Tab -->';

if (!content.includes(TAB_OLD)) {
  console.error('PATCH FAILED: Guide Tab anchor not found.');
  process.exit(1);
}
if (content.includes('id="tab-sms-usage"')) {
  console.error('PATCH FAILED: tab-sms-usage already present.');
  process.exit(1);
}
content = content.replace(TAB_OLD, () => TAB_NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch 2 applied: nav link + tab content inserted.');
