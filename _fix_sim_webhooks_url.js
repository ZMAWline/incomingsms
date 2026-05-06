// _fix_sim_webhooks_url.js — fix double /api/ in viewSimWebhooks fetch URL.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const BT = '\\' + '`';
const DS = '\\' + '${';

const OLD = 'const res = await fetch(' + BT + DS + 'API_BASE}/api/sim-webhooks?sim_id=' + DS + 'simId}' + BT + ');';
const NEW = 'const res = await fetch(' + BT + DS + 'API_BASE}/sim-webhooks?sim_id=' + DS + 'simId}' + BT + ');';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: fetch line not found.');
  process.exit(1);
}
content = content.replace(OLD, NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched: API_BASE/sim-webhooks (no double /api/).');
