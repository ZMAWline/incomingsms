// _fix_sim_status_filter.js
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');

// Normalize to LF
content = content.replace(/\r\n/g, '\n');

const OLD = `<select id="filter-status" onchange="loadSims(true)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All (except cancelled)</option>
                                    <option value="all">All (include cancelled)</option>
                                    <option value="active">Active</option>
                                    <option value="provisioning">Provisioning</option>
                                    <option value="pending">Pending</option>
                                    <option value="suspended">Suspended</option>
                                    <option value="canceled">Cancelled</option>
                                    <option value="error">Error</option>
                                </select>`;

const NEW = `<select id="filter-status" onchange="loadSims(true)" class="text-sm bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-gray-300 focus:outline-none focus:border-accent">
                                    <option value="">All (except cancelled)</option>
                                    <option value="all">All (include cancelled)</option>
                                    <option value="active">Active</option>
                                    <option value="provisioning">Provisioning</option>
                                    <option value="pending">Pending</option>
                                    <option value="suspended">Suspended</option>
                                    <option value="canceled">Cancelled</option>
                                    <option value="error">Error</option>
                                    <option value="helix_timeout">Helix Timeout</option>
                                    <option value="data_mismatch">Data Mismatch</option>
                                </select>`;

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: old string not found. File may have changed.');
  process.exit(1);
}

content = content.replace(OLD, NEW);

// Convert back to CRLF
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
