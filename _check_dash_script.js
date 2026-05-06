'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const src = fs.readFileSync('src/dashboard/index.js', 'utf8');

// Find getHTML function using brace matching
const startIdx = src.indexOf('function getHTML()');
if (startIdx === -1) { console.error('getHTML not found'); process.exit(1); }

// Eval just the getHTML function by wrapping in a module
const wrapped = `
${src.slice(startIdx)}
module.exports = getHTML;
`.replace(/export default[\s\S]*$/, '');

fs.writeFileSync('_gethtml_tmp.js', wrapped);

let getHTML;
try {
  getHTML = require('./_gethtml_tmp.js');
} catch(e) {
  console.error('Failed to load getHTML:', e.message);
  process.exit(1);
}

const html = getHTML();

// Extract largest script block
const scriptBlocks = [];
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) scriptBlocks.push(m[1]);
scriptBlocks.sort((a,b) => b.length - a.length);

if (!scriptBlocks.length) { console.error('No script blocks found'); process.exit(1); }

fs.writeFileSync('_dash_script_extracted.js', scriptBlocks[0]);
console.log('Extracted', scriptBlocks[0].length, 'chars');

// Syntax check
try {
  execSync('node --input-type=module --check < _dash_script_extracted.js', { stdio: 'pipe' });
  console.log('Browser script syntax OK');
} catch(e) {
  console.error('Browser script syntax ERROR:');
  console.error(e.stderr?.toString() || e.message);
}
