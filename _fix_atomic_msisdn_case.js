// _fix_atomic_msisdn_case.js — ATOMIC returns msisdn (lowercase), not MSISDN
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src/dashboard/index.js');
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace(/\r\n/g, '\n');

// 1. Backend: fall back to lowercase msisdn
const OLD1 = `          mdn: wr2.Result.MSISDN || null,`;
const NEW1 = `          mdn: wr2.Result.MSISDN || wr2.Result.msisdn || null,`;
if (!content.includes(OLD1)) { console.error('PATCH FAILED: OLD1 not found'); process.exit(1); }
content = content.replace(OLD1, NEW1);
console.log('1. backend mdn field fixed');

// 2. Frontend display: fall back to lowercase msisdn
const OLD2 = `                            if (r.MSISDN) fmtd += '<span class="text-blue-400">MSISDN:</span> ' + r.MSISDN + '<br>';`;
const NEW2 = `                            if (r.MSISDN || r.msisdn) fmtd += '<span class="text-blue-400">MSISDN:</span> ' + (r.MSISDN || r.msisdn) + '<br>';`;
if (!content.includes(OLD2)) { console.error('PATCH FAILED: OLD2 not found'); process.exit(1); }
content = content.replace(OLD2, NEW2);
console.log('2. frontend MSISDN display fixed');

content = content.replace(/\n/g, '\r\n');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done.');
