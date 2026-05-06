// _fix_sms_usage_cycle_day.js
// Wing billing cycle is 5th-to-4th, not 1st-to-end-of-month.
// Flip BILLING_CYCLE_ANCHOR_DAY from 1 to 5.
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

const OLD = 'const BILLING_CYCLE_ANCHOR_DAY = 1;';
const NEW = 'const BILLING_CYCLE_ANCHOR_DAY = 5;';

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: BILLING_CYCLE_ANCHOR_DAY = 1 anchor not found.');
  process.exit(1);
}
if (content.includes(NEW)) {
  console.error('PATCH FAILED: already set to 5.');
  process.exit(1);
}
content = content.replace(OLD, () => NEW);

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patch applied: BILLING_CYCLE_ANCHOR_DAY 1 -> 5 (Wing 5th-to-4th cycle).');
