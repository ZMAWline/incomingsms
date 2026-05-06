// Add loadResellerKeys() call to the billing tab loader.
const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

const OLD = "loadLedgerMonths(); }";
const NEW = "loadLedgerMonths(); loadResellerKeys(); }";

if (!content.includes(OLD)) {
  console.error('PATCH FAILED: tab anchor not found.');
  process.exit(1);
}
const occ = content.split(OLD).length - 1;
if (occ !== 1) {
  console.error('PATCH FAILED: expected 1 occurrence, found ' + occ);
  process.exit(1);
}
content = content.replace(OLD, NEW);
content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Hooked loadResellerKeys into billing tab loader.');
