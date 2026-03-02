#!/usr/bin/env node
// Patches _rebuild_all.js to fix the missing comma at step 2b
const fs = require('fs');
const filePath = require('path').join(__dirname, '_rebuild_all.js');

let content = fs.readFileSync(filePath, 'utf8');

// Before the insertAfterLine for 2b, add a line that appends comma to the gateway_name line
const marker = "offset += insertAfterLine(simFormatLine, [";
const idx = content.indexOf(marker);
if (idx === -1) throw new Error('Cannot find step 2b insertAfterLine');

const patch = `// Fix: add comma to gateway_name line since we're inserting after it
lines[simFormatLine - 1] = lines[simFormatLine - 1].replace(
  "gateway_name: sim.gateways?.name || null",
  "gateway_name: sim.gateways?.name || null,"
);
`;

content = content.slice(0, idx) + patch + content.slice(idx);
fs.writeFileSync(filePath, content, 'utf8');
console.log('Patched _rebuild_all.js: added comma fix at step 2b');
