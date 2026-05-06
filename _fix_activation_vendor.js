// Fix activation vendor - server was incorrectly using document.getElementById
const fs = require('fs');
const path = require('path');

const dashPath = path.join(__dirname, 'src', 'dashboard', 'index.js');
let content = fs.readFileSync(dashPath, 'utf8');

const changes = [];

// 1. Server-side: extract vendor from request body (add after sims extraction)
const serverExtractOld = `const sims = body.sims || [];

    if (!Array.isArray(sims)`;

const serverExtractNew = `const sims = body.sims || [];
    const vendor = body.vendor || 'atomic';

    if (!Array.isArray(sims)`;

if (content.includes(serverExtractOld)) {
  content = content.replace(serverExtractOld, serverExtractNew);
  changes.push('1. Server: extract vendor from request body');
} else if (content.includes(serverExtractOld.replace(/\n/g, '\r\n'))) {
  content = content.replace(serverExtractOld.replace(/\n/g, '\r\n'), serverExtractNew.replace(/\n/g, '\r\n'));
  changes.push('1. Server: extract vendor from request body');
} else {
  console.error('ERROR: Could not find server sims extraction');
  process.exit(1);
}

// 2. Server-side: fix the JSON.stringify to use body.vendor (broken from previous patch)
const serverJsonOld = `body: JSON.stringify({ sims, vendor: document.getElementById('activate-vendor').value })`;
const serverJsonNew = `body: JSON.stringify({ sims, vendor })`;

if (content.includes(serverJsonOld)) {
  content = content.replace(serverJsonOld, serverJsonNew);
  changes.push('2. Server: use vendor variable instead of document.getElementById');
} else {
  console.error('ERROR: Could not find server JSON.stringify');
  process.exit(1);
}

// 3. Client-side: add vendor to fetch body
const clientJsonOld = `body: JSON.stringify({ sims })`;
const clientJsonNew = `body: JSON.stringify({ sims, vendor: document.getElementById('activate-vendor').value })`;

if (content.includes(clientJsonOld)) {
  content = content.replace(clientJsonOld, clientJsonNew);
  changes.push('3. Client: add vendor to fetch body');
} else {
  console.error('ERROR: Could not find client JSON.stringify');
  process.exit(1);
}

fs.writeFileSync(dashPath, content, 'utf8');

console.log('Activation vendor fix applied!');
changes.forEach(c => console.log('  ' + c));
