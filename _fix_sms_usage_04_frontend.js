// _fix_sms_usage_04_frontend.js
// Add TAB_ROUTES entry, PAGE_TITLES entry, switchTab dispatch, and the four
// frontend load/render functions for the SMS Usage tab.
//
// The target functions live INSIDE getHTML()'s template literal, but none of
// them contain a backtick or a ${ — we use plain-quote strings and + concat
// throughout — so no `\`` / `\${` escaping is needed in the inserted code.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// ---- 1. TAB_ROUTES entry ----
const ROUTES_OLD = "            'billing': '/billing',\n            'guide': '/guide',";
const ROUTES_NEW =
  "            'billing': '/billing',\n" +
  "            'sms-usage': '/sms-usage',\n" +
  "            'guide': '/guide',";
if (!content.includes(ROUTES_OLD)) {
  console.error('PATCH FAILED: TAB_ROUTES anchor not found.');
  process.exit(1);
}
if (content.includes("'sms-usage': '/sms-usage'")) {
  console.error('PATCH FAILED: sms-usage route already present.');
  process.exit(1);
}
content = content.replace(ROUTES_OLD, () => ROUTES_NEW);

// ---- 2. PAGE_TITLES entry ----
const TITLES_OLD = "billing: 'Billing', guide: 'Guide'";
const TITLES_NEW = "billing: 'Billing', 'sms-usage': 'SMS Usage', guide: 'Guide'";
if (!content.includes(TITLES_OLD)) {
  console.error('PATCH FAILED: PAGE_TITLES anchor not found.');
  process.exit(1);
}
if (content.includes("'sms-usage': 'SMS Usage'")) {
  console.error('PATCH FAILED: sms-usage page title already present.');
  process.exit(1);
}
content = content.replace(TITLES_OLD, () => TITLES_NEW);

// ---- 3. switchTab dispatch ----
const DISPATCH_OLD = "            if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }";
const DISPATCH_NEW =
  "            if (tabName === 'billing') { loadMappings(); loadBillingResellers(); loadInvoiceHistory(); loadWingHistory(); }\n" +
  "            if (tabName === 'sms-usage') loadSmsUsage();";
if (!content.includes(DISPATCH_OLD)) {
  console.error('PATCH FAILED: switchTab dispatch anchor not found.');
  process.exit(1);
}
if (content.includes("tabName === 'sms-usage'")) {
  console.error('PATCH FAILED: sms-usage dispatch already present.');
  process.exit(1);
}
content = content.replace(DISPATCH_OLD, () => DISPATCH_NEW);

// ---- 4. Append SMS Usage frontend functions before the "End D3" comment ----
// Uses ONLY single/double quotes and + concatenation; zero backticks, zero ${}.
const FN_ANCHOR = "        // ── End D3 ───────────────────────────────────────────────────────────\n    </script>";

const FN_BODY = [
  "        // ── SMS Usage Analytics ─────────────────────────────────────────────",
  "        let smsUsageChartInstance = null;",
  "        let smsUsagePollTimer = null;",
  "",
  "        async function loadSmsUsage(force) {",
  "            try {",
  "                const url = API_BASE + '/sms-usage' + (force ? '?nocache=' + Date.now() : '');",
  "                const r = await fetch(url);",
  "                if (!r.ok) throw new Error('HTTP ' + r.status);",
  "                const data = await r.json();",
  "                if (data.error) throw new Error(data.error + (data.detail ? ': ' + data.detail : ''));",
  "                renderSmsUsageCards(data);",
  "                renderSmsTrend(data.trend || []);",
  "                renderWingLeaderboards(data);",
  "                startSmsUsagePoll();",
  "            } catch (e) {",
  "                if (typeof showToast === 'function') showToast('SMS Usage load failed: ' + e.message, 'error');",
  "                else console.error('SMS Usage load failed:', e);",
  "            }",
  "        }",
  "",
  "        function startSmsUsagePoll() {",
  "            if (smsUsagePollTimer) return;",
  "            smsUsagePollTimer = setInterval(function() {",
  "                const tabEl = document.getElementById('tab-sms-usage');",
  "                if (!tabEl || tabEl.classList.contains('hidden')) return;",
  "                if (document.hidden) return;",
  "                loadSmsUsage(false);",
  "            }, 120000);",
  "        }",
  "",
  "        function renderSmsUsageCards(data) {",
  "            const w = data.wing || {};",
  "            const v = data.vendors || [];",
  "            const simCount = w.wing_sim_count || 0;",
  "            const smsTotal = w.wing_sms_total || 0;",
  "            const hardPool = simCount * 750;",
  "            const softTarget = simCount * 25;",
  "            const pctUsed = hardPool > 0 ? (smsTotal / hardPool) * 100 : 0;",
  "",
  "            const cycleStart = data.cycle_start;",
  "            const today = data.today;",
  "            const cs = new Date(cycleStart + 'T00:00:00Z');",
  "            const td = new Date(today + 'T00:00:00Z');",
  "            const endOfMonth = new Date(Date.UTC(cs.getUTCFullYear(), cs.getUTCMonth() + 1, 0));",
  "            const daysInCycle = endOfMonth.getUTCDate();",
  "            const daysElapsed = Math.max(1, Math.round((td - cs) / 86400000) + 1);",
  "            const daysRemaining = Math.max(0, daysInCycle - daysElapsed);",
  "            const projectedEom = Math.round(smsTotal / daysElapsed * daysInCycle);",
  "            const projectedPct = hardPool > 0 ? (projectedEom / hardPool) * 100 : 0;",
  "            const overageNow = Math.max(0, smsTotal - hardPool);",
  "            const overageProj = Math.max(0, projectedEom - hardPool);",
  "            const estCost = (simCount * 6) + overageNow * 0.01;",
  "            const projCost = (simCount * 6) + overageProj * 0.01;",
  "",
  "            const fmt = function(n) { return (n || 0).toLocaleString(); };",
  "            const setText = function(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; };",
  "",
  "            setText('sms-usage-cycle-label', 'Cycle ' + cycleStart + ' \\u2192 ' + today);",
  "            setText('sms-usage-wing-count', fmt(simCount));",
  "            setText('sms-usage-wing-pool-label', 'Pool ' + fmt(smsTotal) + ' / ' + fmt(hardPool));",
  "            setText('sms-usage-wing-avg', (w.wing_avg !== undefined && w.wing_avg !== null) ? Number(w.wing_avg).toFixed(2) : '\\u2014');",
  "            setText('sms-usage-wing-minmax', 'min ' + (w.wing_min || 0) + ', max ' + (w.wing_max || 0));",
  "            setText('sms-usage-wing-pct', pctUsed.toFixed(2) + '%');",
  "            setText('sms-usage-wing-projection', 'Projected: ' + fmt(projectedEom) + ' (' + projectedPct.toFixed(1) + '%)');",
  "            setText('sms-usage-wing-cost', '$' + estCost.toFixed(2));",
  "            setText('sms-usage-wing-overage', 'Projected total: $' + projCost.toFixed(2));",
  "",
  "            const fill = document.getElementById('sms-usage-wing-poolbar-fill');",
  "            if (fill) {",
  "                fill.style.width = Math.min(100, pctUsed) + '%';",
  "                fill.classList.remove('bg-green-500', 'bg-yellow-500', 'bg-red-500');",
  "                if (pctUsed >= 100) fill.classList.add('bg-red-500');",
  "                else if (pctUsed >= 80) fill.classList.add('bg-yellow-500');",
  "                else fill.classList.add('bg-green-500');",
  "            }",
  "            const softPct = hardPool > 0 ? Math.min(100, (softTarget / hardPool) * 100) : 0;",
  "            const softEl = document.getElementById('sms-usage-wing-poolbar-soft');",
  "            if (softEl) softEl.style.left = softPct + '%';",
  "            setText('sms-usage-wing-poolbar-label', fmt(smsTotal) + ' / ' + fmt(hardPool));",
  "            setText('sms-usage-wing-soft-target', fmt(softTarget));",
  "            setText('sms-usage-wing-hard-target', fmt(hardPool));",
  "",
  "            setText('sms-usage-info-start', cycleStart);",
  "            setText('sms-usage-info-today', today);",
  "            setText('sms-usage-info-elapsed', daysElapsed);",
  "            setText('sms-usage-info-remaining', daysRemaining);",
  "            setText('sms-usage-info-projection', fmt(projectedEom));",
  "            setText('sms-usage-info-proj-pct', projectedPct.toFixed(1) + '%');",
  "",
  "            const tbody = document.getElementById('sms-usage-vendor-tbody');",
  "            if (tbody) {",
  "                if (!v.length) {",
  "                    tbody.innerHTML = '<tr><td colspan=\"4\" class=\"px-3 py-3 text-center text-gray-500\">No data</td></tr>';",
  "                } else {",
  "                    tbody.innerHTML = v.map(function(row) {",
  "                        const n = row.active_sim_count || 0;",
  "                        const avg = n > 0 ? (row.sms_count / n) : 0;",
  "                        return '<tr class=\"border-b border-dark-700\"><td class=\"px-3 py-2 text-white\">' + row.vendor +",
  "                            '</td><td class=\"px-3 py-2 text-right text-gray-300\">' + fmt(n) +",
  "                            '</td><td class=\"px-3 py-2 text-right text-white\">' + fmt(row.sms_count) +",
  "                            '</td><td class=\"px-3 py-2 text-right text-gray-300\">' + avg.toFixed(2) + '</td></tr>';",
  "                    }).join('');",
  "                }",
  "            }",
  "        }",
  "",
  "        function renderSmsTrend(trend) {",
  "            const byDate = {};",
  "            const vendorsSeen = {};",
  "            trend.forEach(function(r) {",
  "                if (!byDate[r.d]) byDate[r.d] = {};",
  "                byDate[r.d][r.v] = r.s;",
  "                vendorsSeen[r.v] = true;",
  "            });",
  "            const labels = Object.keys(byDate).sort();",
  "            const vendorList = Object.keys(vendorsSeen);",
  "            const palette = { wing_iot: '#60a5fa', atomic: '#f59e0b', teltik: '#a78bfa', helix: '#34d399' };",
  "            const datasets = vendorList.map(function(v) {",
  "                const color = palette[v] || '#9ca3af';",
  "                return {",
  "                    label: v,",
  "                    data: labels.map(function(d) { return byDate[d][v] || 0; }),",
  "                    borderColor: color,",
  "                    backgroundColor: color + '33',",
  "                    tension: 0.25,",
  "                    fill: false,",
  "                    pointRadius: 2,",
  "                };",
  "            });",
  "            const canvas = document.getElementById('sms-usage-trend-canvas');",
  "            if (!canvas) return;",
  "            if (typeof Chart === 'undefined') {",
  "                const c = canvas.getContext('2d');",
  "                c.fillStyle = '#9ca3af';",
  "                c.font = '14px sans-serif';",
  "                c.fillText('Chart.js not loaded yet. Reload page.', 10, 24);",
  "                return;",
  "            }",
  "            const ctx = canvas.getContext('2d');",
  "            if (smsUsageChartInstance) smsUsageChartInstance.destroy();",
  "            smsUsageChartInstance = new Chart(ctx, {",
  "                type: 'line',",
  "                data: { labels: labels, datasets: datasets },",
  "                options: {",
  "                    responsive: true,",
  "                    maintainAspectRatio: false,",
  "                    interaction: { mode: 'index', intersect: false },",
  "                    scales: {",
  "                        y: { beginAtZero: true, ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.05)' } },",
  "                        x: { ticks: { color: '#9ca3af' }, grid: { display: false } },",
  "                    },",
  "                    plugins: {",
  "                        legend: { labels: { color: '#d1d5db' } },",
  "                        tooltip: { mode: 'index', intersect: false },",
  "                    },",
  "                },",
  "            });",
  "        }",
  "",
  "        function renderWingLeaderboards(data) {",
  "            const top = data.wing_top || [];",
  "            const bot = data.wing_bottom || [];",
  "            const simsCache = (typeof tableState !== 'undefined' && tableState.sims && tableState.sims.data) ? tableState.sims.data : [];",
  "            const simById = {};",
  "            simsCache.forEach(function(s) { simById[s.id] = s; });",
  "",
  "            const buildRow = function(row) {",
  "                const s = simById[row.sim_id];",
  "                const iccid = (s && s.iccid) ? s.iccid : '\\u2014';",
  "                return '<tr class=\"border-b border-dark-700\"><td class=\"px-3 py-2 text-white\">#' + row.sim_id +",
  "                    '</td><td class=\"px-3 py-2 text-gray-300 font-mono text-xs\">' + iccid +",
  "                    '</td><td class=\"px-3 py-2 text-right text-white\">' + (row.sms || 0).toLocaleString() + '</td></tr>';",
  "            };",
  "",
  "            const empty = '<tr><td colspan=\"3\" class=\"px-3 py-3 text-center text-gray-500\">No data</td></tr>';",
  "            const topBody = document.getElementById('sms-usage-top-tbody');",
  "            const botBody = document.getElementById('sms-usage-bottom-tbody');",
  "            if (topBody) topBody.innerHTML = top.length ? top.map(buildRow).join('') : empty;",
  "            if (botBody) botBody.innerHTML = bot.length ? bot.map(buildRow).join('') : empty;",
  "        }",
  "        // ── End SMS Usage Analytics ─────────────────────────────────────────",
  "",
  "        // ── End D3 ───────────────────────────────────────────────────────────\n    </script>",
].join('\n');

if (!content.includes(FN_ANCHOR)) {
  console.error('PATCH FAILED: End D3 / </script> anchor not found.');
  process.exit(1);
}
if (content.includes('async function loadSmsUsage(')) {
  console.error('PATCH FAILED: loadSmsUsage already present.');
  process.exit(1);
}
// Sanity guard: no stray backticks or ${ in the frontend body (they would break
// the outer getHTML() template literal).
if (FN_BODY.indexOf('`') !== -1 || FN_BODY.indexOf('${') !== -1) {
  console.error('PATCH FAILED: frontend body contains backtick or ${ — would corrupt getHTML() template.');
  process.exit(1);
}
content = content.replace(FN_ANCHOR, () => FN_BODY);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch 4 applied: TAB_ROUTES/PAGE_TITLES/switchTab dispatch + 4 frontend functions.');
