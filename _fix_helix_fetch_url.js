// _fix_helix_fetch_url.js — restore missing URL args in queryHelix + queryHelixBulk fetch calls
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// We need \` and \${ as the actual file characters (escaped for inside template literal)
const BT = '\\' + '`';       // \`  (backslash + backtick)
const DS = '\\' + '${';      // \${ (backslash + dollar + brace)

// Fix 1: queryHelix() fetch — unique context: mobility_subscription_id: subId
const OLD1 = 'const response = await fetch(, {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ mobility_subscription_id: subId })';
const NEW1 = 'const response = await fetch(' + BT + DS + 'API_BASE}/helix-query' + BT + ', {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ mobility_subscription_id: subId })';

if (!content.includes(OLD1)) {
  console.error('PATCH FAILED: helix-query fetch not found');
  process.exit(1);
}
content = content.replace(OLD1, NEW1);
console.log('Fixed queryHelix() fetch URL');

// Fix 2: queryHelixBulk() fetch — unique context: limit: 100, offset: offset || 0
const OLD2 = 'const response = await fetch(, {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ limit: 100, offset: offset || 0 })';
const NEW2 = 'const response = await fetch(' + BT + DS + 'API_BASE}/helix-query-bulk' + BT + ', {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ limit: 100, offset: offset || 0 })';

if (!content.includes(OLD2)) {
  console.error('PATCH FAILED: helix-query-bulk fetch not found');
  process.exit(1);
}
content = content.replace(OLD2, NEW2);
console.log('Fixed queryHelixBulk() fetch URL');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied successfully.');
