const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'src/dashboard/index.js');
let src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// The broken line has \n and \t in regex inside getHTML() template literal — they get processed into actual chars
// Replace with a safe split that uses only literal chars (no escape sequences)
const OLD = 'const terms = query.split(/[\\n,;\\t]+/).map(t => t.trim().toLowerCase()).filter(Boolean);';
const NEW  = 'const terms = query.split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);';

if (!src.includes(OLD)) { console.error('target not found'); process.exit(1); }
src = src.replace(OLD, NEW);

fs.writeFileSync(file, src.replace(/\n/g, '\r\n'));
console.log('done');
