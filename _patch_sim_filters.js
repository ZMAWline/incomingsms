// Patch: add "Not rotated today" and "No SMS 12h" quick filters to SIMs view
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF for reliable string matching
content = content.replace(/\r\n/g, '\n');

// ── 1. HTML: add filter-special select after the gateway select ──────────────
const HTML_OLD = `                                <select id="filter-gateway" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Gateways</option>
                                </select>
                                <label class="text-xs text-gray-500 flex items-center gap-1">Activated`;

const HTML_NEW = `                                <select id="filter-gateway" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All Gateways</option>
                                </select>
                                <select id="filter-special" onchange="renderSims()" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">No Quick Filter</option>
                                    <option value="not_rotated_today">Not rotated today</option>
                                    <option value="no_sms_12h">No SMS in 12h</option>
                                </select>
                                <label class="text-xs text-gray-500 flex items-center gap-1">Activated`;

if (!content.includes(HTML_OLD)) {
  console.error('ERROR: HTML anchor not found');
  process.exit(1);
}
content = content.replace(HTML_OLD, HTML_NEW);
console.log('✓ HTML filter select added');

// ── 2. renderSims(): add special filter logic before genericSort ──────────────
const JS_OLD = `  data = genericSort(data, state.sortKey, state.sortDir);

  const tbody = document.getElementById('sims-table');`;

const JS_NEW = `  const specialFilter = document.getElementById('filter-special') && document.getElementById('filter-special').value;
  if (specialFilter === 'not_rotated_today') {
    const todayUTC = new Date().toISOString().slice(0, 10);
    data = data.filter(function(s) { return !s.last_mdn_rotated_at || s.last_mdn_rotated_at.slice(0, 10) < todayUTC; });
  } else if (specialFilter === 'no_sms_12h') {
    const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
    data = data.filter(function(s) { return !s.last_sms_received || new Date(s.last_sms_received).getTime() < cutoff12h; });
  }
  data = genericSort(data, state.sortKey, state.sortDir);

  const tbody = document.getElementById('sims-table');`;

if (!content.includes(JS_OLD)) {
  console.error('ERROR: JS anchor not found');
  process.exit(1);
}
content = content.replace(JS_OLD, JS_NEW);
console.log('✓ renderSims filter logic added');

// Convert back to CRLF and write
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('✓ File written (CRLF)');
